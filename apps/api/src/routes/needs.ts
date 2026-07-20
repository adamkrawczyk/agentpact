import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { Deps } from "./types.js";
import { createNeedSchema, parseAndValidateTags, validateAndTruncateQuery } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, withBrowseStatementTimeout, checkListingPayable, enrichNeedRow } from "./utils.js";

const DEFAULT_BROWSE_LIMIT = 200;
const MAX_BROWSE_LIMIT = 200;
const MAX_BROWSE_OFFSET = 1000;

function boundedInteger(value: string | undefined, defaultValue: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

async function audit(sql: Sql<Record<string, unknown>>, actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

async function auditBestEffort(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  action: string,
  objectType: string,
  objectId: string | null,
  payload: unknown,
): Promise<void> {
  try {
    await audit(sql, null, action, objectType, objectId, `metrics:${action}:${Date.now()}`, payload);
  } catch (err) {
    app.log.warn({ err, action, objectType, objectId }, "metrics audit insert failed");
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, _deps: Deps, scheduleRecompute: () => void): Promise<void> {
  app.post("/api/needs", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = createNeedSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    // payment-methods rolloutc — payability creation gate (Layer 1). A 'usdc' need
    // requires the buyer to have a wallet to fund escrow from; 'stripe'/'both'
    // is "coming soon" until STRIPE_RAIL_ENABLED (P1d).
    const [payAgent] = await sql`
      SELECT owner_wallet_address FROM agents WHERE id = ${body.agentId}
    `;
    const payable = checkListingPayable(body.acceptedPaymentMethods, {
      walletAddress: payAgent?.owner_wallet_address ?? null,
    });
    if (!payable.ok) {
      return reply.code(400).send({ error: payable.message });
    }

    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const deadlineAt = body.deadlineAt ?? null;
    const location = body.location ?? null;

    const [need] = await sql`
      INSERT INTO needs (
        agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at, fulfillment_type, location, accepted_payment_methods
      ) VALUES (
        ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
        ${budgetMin}, ${budgetMax}, ${body.currency}, ${body.acceptanceCriteria as any}::jsonb, ${deadlineAt}, ${body.fulfillmentType}, ${location as any}::jsonb, ${body.acceptedPaymentMethods}
      ) RETURNING *
    `;

    await audit(sql, body.agentId, "need.create", "need", need.id, idem, body);
    scheduleRecompute();
    return reply.code(201).send(enrichNeedRow(need as Record<string, unknown>));
  });

  app.patch("/api/needs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createNeedSchema.partial().parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [existingNeed] = await sql`SELECT n.agent_id, a.owner_wallet_address FROM needs n JOIN agents a ON a.id = n.agent_id WHERE n.id = ${id}`;
    if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    // payment-methods rolloutc — payability gate on rail CHANGE (only when set).
    if (body.acceptedPaymentMethods !== undefined) {
      const payable = checkListingPayable(body.acceptedPaymentMethods, {
        walletAddress: existingNeed.owner_wallet_address ?? null,
      });
      if (!payable.ok) {
        return reply.code(400).send({ error: payable.message });
      }
    }
    const title = body.title ?? null;
    const descriptionMd = body.descriptionMd ?? null;
    const category = body.category ?? null;
    const tags = body.tags ?? null;
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const acceptanceCriteria = body.acceptanceCriteria ?? null;
    const deadlineAt = body.deadlineAt ?? null;
    const fulfillmentType = body.fulfillmentType ?? null;
    const location = body.location ?? null;
    const acceptedPaymentMethods = body.acceptedPaymentMethods ?? null;
    const [need] = await sql`
      UPDATE needs SET
        title = COALESCE(${title}, title),
        description_md = COALESCE(${descriptionMd}, description_md),
        category = COALESCE(${category}, category),
        tags = COALESCE(${tags}, tags),
        budget_min = COALESCE(${budgetMin}, budget_min),
        budget_max = COALESCE(${budgetMax}, budget_max),
        acceptance_criteria = COALESCE(${acceptanceCriteria as any}::jsonb, acceptance_criteria),
        deadline_at = COALESCE(${deadlineAt}, deadline_at),
        fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
        location = COALESCE(${location as any}::jsonb, location),
        accepted_payment_methods = COALESCE(${acceptedPaymentMethods}, accepted_payment_methods),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    scheduleRecompute();
    return enrichNeedRow(need as Record<string, unknown>);
  });

  app.post("/api/needs/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [existingNeed] = await sql`SELECT agent_id FROM needs WHERE id = ${id}`;
    if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const [need] = await sql`UPDATE needs SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return enrichNeedRow(need as Record<string, unknown>);
  });

  app.get("/api/needs", async (request, reply) => {
    const startedAt = process.hrtime.bigint();
    const raw = request.query as Record<string, string | undefined> ?? {};
    const { tags, error: tagsError } = parseAndValidateTags(raw.tags);
    if (tagsError) return reply.code(400).send({ error: tagsError });
    const search = validateAndTruncateQuery(raw.query);
    const query = `%${search}%`;
    const limit = boundedInteger(raw.limit, DEFAULT_BROWSE_LIMIT, 1, MAX_BROWSE_LIMIT);
    const offset = boundedInteger(raw.offset, 0, 0, MAX_BROWSE_OFFSET);

    const rows = await withBrowseStatementTimeout(sql, async (querySql) => search
      ? await querySql`
      SELECT * FROM needs
      WHERE status = 'open'
        AND (title ILIKE ${query} OR description_md ILIKE ${query})
        AND (${tags.length} = 0 OR tags && ${tags})
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `
      : await querySql`
      SELECT * FROM needs
      WHERE status = 'open'
        AND (${tags.length} = 0 OR tags && ${tags})
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);
    void auditBestEffort(app, sql, "browse.latency", "endpoint", null, {
      endpoint: "/api/needs",
      method: "GET",
      durationMs: elapsedMs(startedAt),
      resultCount: rows.length,
      hasQuery: search.length > 0,
      hasTags: tags.length > 0,
      limit,
      offset,
    }).catch((err) => app.log.warn({ err }, "audit insert failed"));
    return rows.map((row) => enrichNeedRow(row as Record<string, unknown>));
  });

  app.get("/api/needs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [need] = await sql`SELECT * FROM needs WHERE id = ${id}`;
    if (!need) return reply.code(404).send({ error: "Need not found" });
    return enrichNeedRow(need as Record<string, unknown>);
  });
}
