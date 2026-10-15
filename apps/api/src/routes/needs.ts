import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { Deps } from "./types.js";
import { createNeedSchema, parseAndValidateTags, validateAndTruncateQuery, uuidParamSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, withBrowseStatementTimeout, checkListingPayable, enrichNeedRow } from "./utils.js";
import { sharesOwnerWallet } from "../shared/deal-guards.js";
import { attemptNeedResponseDelivery } from "../need-response-delivery.js";
import {
  LIVE_RESPONSE_STATUSES,
  NEED_RESPONSE_SOURCE,
  NEED_RESPONSES_PER_HOUR,
  composeResponseBody,
  respondToNeedSchema,
  sanitizeResponseMessage,
} from "../shared/need-responses.js";

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
    const { id } = uuidParamSchema.parse(request.params);
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
    const { id } = uuidParamSchema.parse(request.params);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [existingNeed] = await sql`SELECT agent_id FROM needs WHERE id = ${id}`;
    if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const [need] = await sql`UPDATE needs SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return enrichNeedRow(need as Record<string, unknown>);
  });

  // Seller-initiated response to an open need. Stores ONE concierge message to
  // the need owner and fires `need.response`. Creates no deal and moves no
  // money: the owner proceeds via POST /api/deals/propose. See
  // shared/need-responses.ts for the storage contract.
  app.post("/api/needs/:id/respond", async (request, reply) => {
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const { id: needId } = uuidParamSchema.parse(request.params);
    const body = respondToNeedSchema.parse(request.body ?? {});
    const message = sanitizeResponseMessage(body.message);
    const idem = idempotencyKey(request.headers as Record<string, unknown>);

    type Rejection = { kind: "reject"; status: number; body: Record<string, unknown> };
    const reject = (status: number, payload: Record<string, unknown>): Rejection => ({ kind: "reject", status, body: payload });

    // Everything that decides eligibility runs INSIDE the insert transaction
    // under row locks (FOR SHARE on the need, the offer and both agents), so a
    // need archived, an offer archived or an owner wallet changed while this
    // request is in flight cannot slip a stale response through: the writer
    // waits for us, or we wait for the writer and then see its result.
    const result = await sql.begin(async (tx) => {
      const [need] = await tx`
        SELECT n.id, n.agent_id, n.status, n.title, a.owner_wallet_address
        FROM needs n JOIN agents a ON a.id = n.agent_id
        WHERE n.id = ${needId}
        FOR SHARE OF n, a
      `;
      if (!need) return reject(404, { error: "Need not found", code: "need_not_found" });
      if (need.status !== "open") {
        return reject(409, {
          error: `This need is ${String(need.status)}, so it no longer takes responses`,
          code: "need_not_open",
          hint: "Only open needs take responses. Browse open needs with GET /api/needs.",
        });
      }
      if (need.agent_id === requesterAgentId) {
        return reject(409, {
          error: "You cannot respond to your own need",
          code: "own_need",
          hint: "Respond to a need posted by a different agent.",
        });
      }

      const [offer] = await tx`
        SELECT o.id, o.agent_id, o.status, o.title, o.base_price, o.currency,
               a.owner_wallet_address, a.handle, ap_wallet_key(a.owner_wallet_address) AS owner_key
        FROM offers o JOIN agents a ON a.id = o.agent_id
        WHERE o.id = ${body.offerId}
        FOR SHARE OF o, a
      `;
      if (!offer) return reject(404, { error: "Offer not found", code: "offer_not_found" });
      if (offer.agent_id !== requesterAgentId) {
        return reject(403, {
          error: "You can only respond with an offer you own",
          code: "not_offer_owner",
          hint: "Create your own offer first (POST /api/offers), then respond with its id.",
        });
      }
      if (offer.status !== "active") {
        return reject(409, {
          error: "This offer is archived, so it cannot answer a need",
          code: "offer_not_active",
          hint: "Respond with one of your active offers.",
        });
      }
      // Same-owner guard (honest_0710 class): agents of one owner wallet must not
      // court each other's needs. Unlike deal creation this applies at any price —
      // a response exists only to start a deal, and same-owner deals never count.
      if (sharesOwnerWallet(need.owner_wallet_address as string | null, offer.owner_wallet_address as string | null)) {
        return reject(409, {
          error: "You and the need owner belong to the same owner wallet",
          code: "same_owner",
          hint: "Responses are for agents of different owners. Same-owner deals never count toward reputation or trust tiers.",
        });
      }

      // Limits belong to the stable OWNER identity (ap_wallet_key of the seller's
      // owner wallet), not the agent id: several agents of one wallet share one
      // duplicate window and one hourly budget. An agent with an unknown or
      // placeholder wallet has NO owner identity, and falling back to its agent
      // id would hand every freshly registered zero-wallet agent its own quota
      // (50 agents = 50 responses to one buyer). So responding requires a real
      // owner wallet: no identity, no response.
      const ownerKey = (offer.owner_key as string | null) ?? null;
      if (!ownerKey) {
        return reject(403, {
          error: "Link a real owner wallet to your agent before responding to needs",
          code: "owner_wallet_required",
          hint: "Need responses are limited per owner wallet, so agents without one cannot respond. Set it with PATCH /api/agents/:id/wallet, then retry.",
        });
      }
      const lockKey = `owner:${ownerKey}`;
      // Serialise this owner's responses so the duplicate and rate checks below
      // cannot race a concurrent request from the same owner.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${"need-response:" + lockKey}))`;

      const [existing] = await tx`
        SELECT id, created_at FROM concierge_messages
        WHERE related_need_id = ${needId}
          AND message_type = 'match-suggestion'
          AND metadata->>'source' = ${NEED_RESPONSE_SOURCE}
          AND (metadata->>'seller_agent_id' = ${requesterAgentId}
               OR (${ownerKey}::text IS NOT NULL AND metadata->>'seller_owner_key' = ${ownerKey}::text))
          AND status IN ${tx(LIVE_RESPONSE_STATUSES as unknown as string[])}
        ORDER BY created_at ASC
        LIMIT 1
      `;
      if (existing) return { kind: "duplicate" as const, existing };

      const [window] = await tx`
        SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM concierge_messages
        WHERE message_type = 'match-suggestion'
          AND metadata->>'source' = ${NEED_RESPONSE_SOURCE}
          AND (metadata->>'seller_agent_id' = ${requesterAgentId}
               OR (${ownerKey}::text IS NOT NULL AND metadata->>'seller_owner_key' = ${ownerKey}::text))
          AND created_at > NOW() - INTERVAL '1 hour'
      `;
      if (Number(window.n) >= NEED_RESPONSES_PER_HOUR) {
        const retryAt = new Date(new Date(window.oldest as string).getTime() + 60 * 60 * 1000);
        return { kind: "rate_limited" as const, retryAt };
      }

      const metadata = {
        source: NEED_RESPONSE_SOURCE,
        seller_agent_id: requesterAgentId,
        seller_owner_key: ownerKey,
        need_id: needId,
        need_title: String(need.title),
        offer_id: body.offerId,
        offer_title: String(offer.title),
        offer_price: offer.base_price as string | number | null,
        currency: offer.currency as string | null,
        message,
      };
      const subject = `Response to your need: ${String(need.title)}`.slice(0, 200);
      const bodyMd = composeResponseBody({
        needId,
        needTitle: String(need.title),
        offerId: body.offerId,
        offerTitle: String(offer.title),
        basePrice: offer.base_price as string | number | null,
        currency: offer.currency as string | null,
        sellerAgentId: requesterAgentId,
        sellerHandle: (offer.handle as string | null) ?? null,
        message,
      });
      // Outbox: the row is committed `queued` (pending). It turns `sent` only
      // after a webhook accepted it (see need-response-delivery.ts); a response
      // is never marked sent ahead of delivery.
      const [row] = await tx`
        INSERT INTO concierge_messages (
          agent_id, message_type, priority, subject, body_md,
          related_offer_id, related_need_id, status, metadata
        ) VALUES (
          ${need.agent_id as string}, 'match-suggestion', 5, ${subject}, ${bodyMd},
          ${body.offerId}, ${needId}, 'queued', ${tx.json(metadata)}
        )
        RETURNING id, status, created_at
      `;
      // The audit entry commits with the response or not at all: an audit
      // failure rolls the whole response back so the seller can simply retry.
      await audit(tx as unknown as Sql<Record<string, unknown>>, requesterAgentId, "need.respond", "need", needId, idem, {
        responseId: String(row.id),
        offerId: body.offerId,
        hasMessage: message !== null,
      });
      return { kind: "created" as const, row, needAgentId: need.agent_id as string };
    });

    if (result.kind === "reject") return reply.code(result.status).send(result.body);
    if (result.kind === "duplicate") {
      return reply.code(409).send({
        error: "You already responded to this need",
        code: "duplicate_response",
        responseId: result.existing.id,
        hint: "One live response per seller owner per need. The need owner already has the earlier response.",
      });
    }
    if (result.kind === "rate_limited") {
      const retryAfterSec = Math.max(1, Math.ceil((result.retryAt.getTime() - Date.now()) / 1000));
      reply.header("retry-after", String(retryAfterSec));
      return reply.code(429).send({
        error: `Need response limit reached (${NEED_RESPONSES_PER_HOUR} per hour per owner wallet)`,
        code: "need_response_rate_limited",
        retryAfter: result.retryAt.toISOString(),
      });
    }

    const responseId = String(result.row.id);
    // Deliver after the commit without holding up the response. The committed
    // `queued` row is the durable record: if this attempt fails or the process
    // dies, the concierge relay retries it.
    setImmediate(() => {
      void attemptNeedResponseDelivery(sql, responseId, (obj, msg) => request.log.warn(obj, msg));
    });
    return reply.code(201).send({
      id: responseId,
      needId,
      offerId: body.offerId,
      sellerAgentId: requesterAgentId,
      message,
      createdAt: result.row.created_at,
      next: "The response is recorded and is being delivered to the need owner. No deal exists yet; the owner proposes one via POST /api/deals/propose.",
    });
  });

  // Owner-only list of seller responses to one need. Authenticated even
  // though GET /api/needs/* is otherwise public (see the preHandler in index.ts).
  app.get("/api/needs/:id/responses", async (request, reply) => {
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const { id: needId } = uuidParamSchema.parse(request.params);
    const [need] = await sql`SELECT agent_id FROM needs WHERE id = ${needId}`;
    if (!need) return reply.code(404).send({ error: "Need not found", code: "need_not_found" });
    if (need.agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Only the need owner can read its responses", code: "not_need_owner" });
    }
    const rows = await sql`
      SELECT cm.id, cm.related_offer_id AS offer_id, cm.metadata->>'seller_agent_id' AS seller_agent_id,
             cm.metadata->>'message' AS message, cm.status, cm.created_at,
             o.title AS offer_title, o.base_price AS offer_price, o.currency AS offer_currency, o.status AS offer_status,
             a.handle AS seller_handle
      FROM concierge_messages cm
      LEFT JOIN offers o ON o.id = cm.related_offer_id
      LEFT JOIN agents a ON a.id::text = cm.metadata->>'seller_agent_id'
      WHERE cm.related_need_id = ${needId}
        AND cm.agent_id = ${requesterAgentId}
        AND cm.message_type = 'match-suggestion'
        AND cm.metadata->>'source' = ${NEED_RESPONSE_SOURCE}
      ORDER BY cm.created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      needId,
      offerId: r.offer_id,
      sellerAgentId: r.seller_agent_id,
      sellerHandle: r.seller_handle,
      offerTitle: r.offer_title,
      offerPrice: r.offer_price,
      currency: r.offer_currency,
      offerStatus: r.offer_status,
      message: r.message,
      deliveryStatus: r.status,
      createdAt: r.created_at,
    }));
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
    const { id } = uuidParamSchema.parse(request.params);
    const [need] = await sql`SELECT * FROM needs WHERE id = ${id}`;
    if (!need) return reply.code(404).send({ error: "Need not found" });
    return enrichNeedRow(need as Record<string, unknown>);
  });
}
