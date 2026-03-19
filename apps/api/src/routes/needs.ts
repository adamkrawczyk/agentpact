import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { Deps } from "./types.js";
import { createNeedSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey } from "./utils.js";

async function audit(sql: Sql<Record<string, unknown>>, actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, _deps: Deps, recomputeMatches: () => Promise<number>): Promise<void> {
  app.post("/api/needs", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = createNeedSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const deadlineAt = body.deadlineAt ?? null;
    const location = body.location ?? null;

    const [need] = await sql`
      INSERT INTO needs (
        agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at, fulfillment_type, location
      ) VALUES (
        ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
        ${budgetMin}, ${budgetMax}, ${body.currency}, ${JSON.stringify(body.acceptanceCriteria)}::jsonb, ${deadlineAt}, ${body.fulfillmentType}, ${location as any}::jsonb
      ) RETURNING *
    `;

    await audit(sql, body.agentId, "need.create", "need", need.id, idem, body);
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after need.create"));
    return reply.code(201).send(need);
  });

  app.patch("/api/needs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createNeedSchema.partial().parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [existingNeed] = await sql`SELECT agent_id FROM needs WHERE id = ${id}`;
    if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const title = body.title ?? null;
    const descriptionMd = body.descriptionMd ?? null;
    const category = body.category ?? null;
    const tags = body.tags ?? null;
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const acceptanceCriteria = body.acceptanceCriteria ? JSON.stringify(body.acceptanceCriteria) : null;
    const deadlineAt = body.deadlineAt ?? null;
    const fulfillmentType = body.fulfillmentType ?? null;
    const location = body.location ?? null;
    const [need] = await sql`
      UPDATE needs SET
        title = COALESCE(${title}, title),
        description_md = COALESCE(${descriptionMd}, description_md),
        category = COALESCE(${category}, category),
        tags = COALESCE(${tags}, tags),
        budget_min = COALESCE(${budgetMin}, budget_min),
        budget_max = COALESCE(${budgetMax}, budget_max),
        acceptance_criteria = COALESCE(${acceptanceCriteria}::jsonb, acceptance_criteria),
        deadline_at = COALESCE(${deadlineAt}, deadline_at),
        fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
        location = COALESCE(${location as any}::jsonb, location),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after need.update"));
    return need;
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
    return need;
  });

  app.get("/api/needs", async (request) => {
    const q = request.query as { query?: string; tags?: string };
    const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
    const query = `%${q.query ?? ""}%`;
    const rows = await sql`
      SELECT * FROM needs
      WHERE status = 'open'
        AND (title ILIKE ${query} OR description_md ILIKE ${query})
        AND (${tags.length} = 0 OR tags && ${tags})
      ORDER BY created_at DESC
      LIMIT 200
    `;
    return rows;
  });

  app.get("/api/needs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [need] = await sql`SELECT * FROM needs WHERE id = ${id}`;
    if (!need) return reply.code(404).send({ error: "Need not found" });
    return need;
  });
}
