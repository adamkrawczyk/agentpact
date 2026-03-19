import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./types.js";
import { proposeDealSchema, counterDealSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, isZeroPrice, toNumber } from "./utils.js";

async function audit(sql: Sql<Record<string, unknown>>, actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

async function createDealProposal(
  sql: Sql<Record<string, unknown>>,
  proposal: z.infer<typeof proposeDealSchema>,
  opts: {
    idempotencyKey: string;
    auditAction: string;
    auditActorAgentId: string | null;
    negotiationActorAgentId: string;
    auditPayload?: unknown;
  },
): Promise<Record<string, unknown>> {
  const isFreeTier = isZeroPrice(proposal.negotiatedTotal);
  const result = await sql.begin(async (txn) => {
    const [deal] = await txn.unsafe(
      `
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days, is_free_tier
        ) VALUES ($1, $2, $3, $4, $5, $6, 'USDC', $7, $8, $9)
        RETURNING *
      `,
      [
        proposal.buyerAgentId,
        proposal.sellerAgentId,
        proposal.offerId,
        proposal.needId,
        "proposed",
        proposal.negotiatedTotal,
        proposal.maxPriceDeltaPct,
        proposal.acceptanceTimeoutDays,
        isFreeTier,
      ]
    );

    const milestones = [];
    for (const milestone of proposal.milestones) {
      const dueAt = milestone.dueAt ?? null;
      const [ms] = await txn.unsafe(
        `
          INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at, status)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6, $7)
          RETURNING *
        `,
        [
          deal.id,
          milestone.idx,
          milestone.title,
          milestone.amount,
          JSON.stringify(milestone.acceptanceCriteria),
          dueAt,
          "pending",
        ]
      );
      milestones.push(ms);
    }

    await txn.unsafe(
      `
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)
      `,
      [deal.id, opts.negotiationActorAgentId, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    await txn.unsafe(
      `INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [opts.auditActorAgentId, opts.auditAction, "deal", String(deal.id), opts.idempotencyKey, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    return { ...deal, milestones };
  });

  return result as Record<string, unknown>;
}

async function enforceDealDelta(sql: Sql<Record<string, unknown>>, dealId: string, negotiatedTotal: number): Promise<void> {
  if (isZeroPrice(negotiatedTotal)) {
    return;
  }
  const [deal] = await sql`
    SELECT d.id, o.base_price, d.max_price_delta_pct
    FROM deals d
    JOIN offers o ON d.offer_id = o.id
    WHERE d.id = ${dealId}
  `;
  if (!deal) {
    throw new Error("Deal not found");
  }
  const maxDelta = toNumber(deal.max_price_delta_pct) / 100;
  const base = toNumber(deal.base_price);
  if (base === 0) {
    return;
  }
  const delta = Math.abs(negotiatedTotal - base) / base;
  if (delta > maxDelta) {
    throw new Error("Counter exceeds max negotiation delta");
  }
}

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, deps: Deps): Promise<void> {
  app.post("/api/deals/propose", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = proposeDealSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.buyerAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [offerOwner] = await sql`SELECT agent_id FROM offers WHERE id = ${body.offerId}`;
    if (!offerOwner || offerOwner.agent_id !== body.sellerAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const [needOwner] = await sql`SELECT agent_id FROM needs WHERE id = ${body.needId}`;
    if (!needOwner || needOwner.agent_id !== body.buyerAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    if (isZeroPrice(body.negotiatedTotal) && body.milestones.some((milestone) => !isZeroPrice(milestone.amount))) {
      return reply.code(400).send({ error: "Free-tier deals must use zero-value milestones" });
    }

    const result = await createDealProposal(sql, body, {
      idempotencyKey: idem,
      auditAction: "deal.propose",
      auditActorAgentId: body.buyerAgentId,
      negotiationActorAgentId: body.buyerAgentId,
      auditPayload: body,
    });

    deps.notifyAgents(sql, [body.sellerAgentId], "deal.proposed", {
      dealId: (result as Record<string, unknown>).id as string,
      buyerAgentId: body.buyerAgentId,
      sellerAgentId: body.sellerAgentId,
      negotiatedTotal: body.negotiatedTotal,
    });

    return reply.code(201).send(result);
  });

  app.post("/api/deals/:id/counter", async (request, reply) => {
    const { id } = request.params as { id: string };
    const requestBody = request.body && typeof request.body === "object" ? request.body : {};
    const body = counterDealSchema.parse({ ...requestBody, dealId: id });
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.actorAgentId !== deal.buyer_agent_id && body.actorAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    if (isZeroPrice(body.negotiatedTotal) && body.milestones.some((milestone) => !isZeroPrice(milestone.amount))) {
      return reply.code(400).send({ error: "Free-tier deals must use zero-value milestones" });
    }

    await enforceDealDelta(sql, id, body.negotiatedTotal);
    const isFreeTier = isZeroPrice(body.negotiatedTotal);

    await sql.begin(async (txn) => {
      await txn.unsafe("DELETE FROM milestones WHERE deal_id = $1", [id]);
      for (const milestone of body.milestones) {
        const dueAt = milestone.dueAt ?? null;
        await txn.unsafe(
          `
            INSERT INTO milestones (deal_id, idx, title, amount, acceptance_criteria, due_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          `,
          [id, milestone.idx, milestone.title, milestone.amount, JSON.stringify(milestone.acceptanceCriteria), dueAt]
        );
      }

      await txn.unsafe(
        `
          UPDATE deals
          SET status = 'countered', negotiated_total = $1, is_free_tier = $2, updated_at = NOW()
          WHERE id = $3
        `,
        [body.negotiatedTotal, isFreeTier, id]
      );

      await txn.unsafe(
        `
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'counter', $3::jsonb)
        `,
        [id, body.actorAgentId, JSON.stringify(body)]
      );
    });

    return { ok: true };
  });

  app.post("/api/deals/:id/accept", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT d.buyer_agent_id, d.seller_agent_id, d.status,
             COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type
      FROM deals d
      LEFT JOIN offers o ON o.id = d.offer_id
      WHERE d.id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (deal.status === 'active') {
      return { ok: true, note: "Deal already accepted" };
    }
    if (deal.status !== 'proposed' && deal.status !== 'countered') {
      return reply.code(409).send({ error: `Cannot accept deal in status '${deal.status}'` });
    }
    if (body.actorAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }

    try {
      await sql.begin(async (txn) => {
        const [updated] = await txn.unsafe(
          "UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1 AND status IN ('proposed', 'countered') RETURNING id",
          [id]
        );
        if (!updated) {
          throw new Error(`Deal ${id} status changed concurrently — accept aborted`);
        }
        await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
        await txn.unsafe(
          `
            INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (deal_id) DO NOTHING
          `,
          [id, deal.fulfillment_type],
        );
        await txn.unsafe(
          `
            INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
            VALUES ($1, $2, 'accept', $3::jsonb)
          `,
          [id, body.actorAgentId, JSON.stringify(body)]
        );
      });
    } catch (err) {
      app.log.error({ err, dealId: id }, "deal.accept transaction failed — deal status NOT changed");
      return reply.code(500).send({ error: "Failed to accept deal — please retry" });
    }

    deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.accepted", {
      dealId: id,
      acceptedBy: body.actorAgentId,
      fulfillmentType: deal.fulfillment_type,
      sellerActionRequired: "Provide fulfillment details via /api/deals/:id/fulfillment",
    });

    return { ok: true };
  });

  app.post("/api/deals/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }

    await sql.begin(async (txn) => {
      await txn.unsafe("UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
      await txn.unsafe("UPDATE milestones SET status = 'cancelled' WHERE deal_id = $1", [id]);
      await txn.unsafe(
        `
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'cancel', $3::jsonb)
        `,
        [id, body.actorAgentId, JSON.stringify(body)]
      );
    });

    if (deal) {
      deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.cancelled", {
        dealId: id,
        cancelledBy: body.actorAgentId,
        reason: body.reason,
      });
    }

    return { ok: true };
  });

  app.get("/api/deals", async (request) => {
    const q = request.query as { buyerAgentId?: string; sellerAgentId?: string; status?: string };
    const rows = await sql`
      SELECT d.*,
        (SELECT json_agg(m ORDER BY m.idx) FROM milestones m WHERE m.deal_id = d.id) AS milestones
      FROM deals d
      WHERE (${q.buyerAgentId ?? null}::uuid IS NULL OR d.buyer_agent_id = ${q.buyerAgentId ?? null}::uuid)
        AND (${q.sellerAgentId ?? null}::uuid IS NULL OR d.seller_agent_id = ${q.sellerAgentId ?? null}::uuid)
        AND (${q.status ?? null}::text IS NULL OR d.status = ${q.status ?? null}::text)
      ORDER BY d.created_at DESC
      LIMIT 200
    `;
    return rows;
  });

  app.get("/api/deals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [deal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    const milestones = await sql`SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
    const events = await sql`SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
    return { ...deal, milestones, events };
  });
}
