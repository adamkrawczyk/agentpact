// M3 — self-serve sellers + the x402 → escrow upgrade.
//
//   GET  /api/sellers/me/readiness       checklist with the exact next call per item
//   POST /api/sellers/me/x402-endpoints  register a public x402 endpoint (optional item)
//   GET  /api/sellers/me/x402-endpoints
//   POST /api/deals/:id/consume          seller middleware: "is this deal funded for me, ≥ price, unused?" — atomically marks it used
//   POST /api/deals/:id/consume/release  seller middleware: the handler failed, hand the undelivered deal back
//
// All routes are agent-authenticated (global preHandler + getRequesterAgentId).

import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import { getRequesterAgentId } from "./utils.js";
import { walletKey } from "../shared/qualifying.js";

/** A heartbeat counts as "reachable" for this long. */
const HEARTBEAT_FRESH_HOURS = 24;

const consumeSchema = z.object({
  // USDC base units (6 decimals) as a decimal-digit string: integer money only.
  priceBaseUnits: z.string().regex(/^[1-9]\d{0,30}$/, "priceBaseUnits must be a positive integer string (USDC base units)"),
  consumeKey: z.string().min(8).max(128),
  offerId: z.string().uuid().optional(),
  resource: z.string().max(2048).optional(),
});

const releaseSchema = z.object({ consumeKey: z.string().min(8).max(128) });

const endpointSchema = z.object({
  url: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "x402 endpoint must be https"),
  offerId: z.string().uuid().optional(),
});

type NextCall = { http: string; mcp?: string; body?: unknown; docs?: string };
type ReadinessItem = { id: string; required: boolean; done: boolean; detail: string; next: NextCall | null };

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>): Promise<void> {
  app.get("/api/sellers/me/readiness", async (request, reply) => {
    const agentId = getRequesterAgentId(request, reply);
    if (!agentId) return;

    const [agent] = await sql`
      SELECT a.id, a.handle, a.display_name, a.owner_wallet_address, a.last_seen_at,
        (a.last_seen_at IS NOT NULL AND a.last_seen_at > NOW() - make_interval(hours => ${HEARTBEAT_FRESH_HOURS})) AS heartbeat_fresh,
        EXISTS (SELECT 1 FROM agent_payout_routes r WHERE r.agent_id = a.id AND r.revoked_at IS NULL) AS has_payout_route,
        (SELECT count(*)::int FROM offers o WHERE o.agent_id = a.id AND o.status = 'active' AND o.base_price > 0) AS priced_offers,
        (SELECT count(*)::int FROM agent_webhooks w WHERE w.agent_id = a.id AND w.active) AS webhooks,
        (SELECT count(*)::int FROM seller_x402_endpoints e WHERE e.agent_id = a.id) AS x402_endpoints
      FROM agents a WHERE a.id = ${agentId}
    `;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    // /api/auth/register creates the row with this placeholder handle; a
    // seller has a profile once it chose its own (POST /api/agents).
    const profileDone = agent.handle !== `agent-${agentId}`;
    const wallet = walletKey(agent.owner_wallet_address as string | null);
    const payoutDone = wallet !== null || agent.has_payout_route === true;
    const offersDone = Number(agent.priced_offers) > 0;
    const webhooks = Number(agent.webhooks);
    const notifyDone = webhooks > 0 || agent.heartbeat_fresh === true;
    const x402Done = Number(agent.x402_endpoints) > 0;

    const items: ReadinessItem[] = [
      {
        id: "profile",
        required: true,
        done: profileDone,
        detail: profileDone ? `handle @${agent.handle}` : "Pick a public handle and display name buyers will see.",
        next: profileDone ? null : {
          http: "POST /api/agents",
          mcp: "agentpact.create_agent",
          body: { handle: "<your-handle>", displayName: "<Your Service>" },
        },
      },
      {
        id: "payout_destination",
        required: true,
        done: payoutDone,
        detail: payoutDone
          ? (wallet ? `paid to wallet ${wallet}` : "paid through a verified payout route")
          : "Tell AgentPact where your USDC goes: a Base wallet, or a verified cross-chain payout route.",
        next: payoutDone ? null : {
          http: `PATCH /api/agents/${agentId}/wallet`,
          body: { walletAddress: "0x<your Base address>" },
          docs: "Cross-chain payout instead: POST /api/agents/me/payout-routes/challenge, sign it, then POST /api/agents/me/payout-routes (MCP agentpact.set_payout_route).",
        },
      },
      {
        id: "priced_offer",
        required: true,
        done: offersDone,
        detail: offersDone ? `${agent.priced_offers} active priced offer(s)` : "List at least one service with a price > $0 (the offer buyers' escrow deals point at).",
        next: offersDone ? null : {
          http: "POST /api/offers",
          mcp: "agentpact.create_offer",
          body: {
            agentId, title: "<what you sell>", descriptionMd: "<what the buyer gets, in markdown>",
            category: "data", basePrice: 5, fulfillmentType: "api-access",
          },
        },
      },
      {
        id: "notifications",
        required: true,
        done: notifyDone,
        detail: webhooks > 0
          ? `${webhooks} active webhook(s)`
          : notifyDone ? `heartbeat seen within ${HEARTBEAT_FRESH_HOURS}h` : "Get told about new deals: register a webhook, or heartbeat at least daily.",
        next: notifyDone ? null : {
          http: "POST /api/webhooks",
          mcp: "agentpact.register_webhook",
          body: { url: "https://<your-service>/agentpact-webhook", events: ["deal.proposed", "deal.accepted"] },
          docs: `Or heartbeat: POST /api/agents/${agentId}/heartbeat (MCP agentpact.heartbeat).`,
        },
      },
      {
        id: "x402_endpoint",
        required: false,
        done: x402Done,
        detail: x402Done
          ? `${agent.x402_endpoints} x402 endpoint(s) registered`
          : "Optional: if you sell over x402, install @agentpact/x402-escrow and register the endpoint.",
        next: x402Done ? null : {
          http: "POST /api/sellers/me/x402-endpoints",
          body: { url: "https://<your-service>/<paid-route>", offerId: "<your offer id>" },
          docs: "npm i @agentpact/x402-escrow — see https://agentpact.xyz/sell",
        },
      },
    ];

    const required = items.filter((i) => i.required);
    const done = required.filter((i) => i.done).length;
    const firstTodo = items.find((i) => !i.done && i.required) ?? null;
    return {
      agentId,
      ready: done === required.length,
      progress: { done, required: required.length },
      nextStep: firstTodo ? firstTodo.id : null,
      items,
    };
  });

  app.post("/api/sellers/me/x402-endpoints", async (request, reply) => {
    const agentId = getRequesterAgentId(request, reply);
    if (!agentId) return;
    const parsed = endpointSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Validation error", code: "VALIDATION_FAILED", details: parsed.error.issues });
    const { url, offerId } = parsed.data;
    if (offerId) {
      const [offer] = await sql`SELECT agent_id FROM offers WHERE id = ${offerId}`;
      if (!offer) return reply.code(404).send({ error: "Offer not found" });
      if (offer.agent_id !== agentId) return reply.code(403).send({ error: "Offer belongs to another agent" });
    }
    const [row] = await sql`
      INSERT INTO seller_x402_endpoints (agent_id, url, offer_id)
      VALUES (${agentId}, ${url}, ${offerId ?? null})
      ON CONFLICT (agent_id, url) DO UPDATE
        SET offer_id = COALESCE(EXCLUDED.offer_id, seller_x402_endpoints.offer_id), updated_at = NOW()
      RETURNING id, url, offer_id, created_at, updated_at, (xmax = 0) AS inserted
    `;
    const { inserted, ...endpoint } = row;
    return reply.code(inserted ? 201 : 200).send(endpoint);
  });

  app.get("/api/sellers/me/x402-endpoints", async (request, reply) => {
    const agentId = getRequesterAgentId(request, reply);
    if (!agentId) return;
    const endpoints = await sql`
      SELECT id, url, offer_id, created_at, updated_at FROM seller_x402_endpoints
      WHERE agent_id = ${agentId} ORDER BY created_at
    `;
    return { endpoints };
  });

  app.post("/api/deals/:id/consume", async (request, reply) => {
    const agentId = getRequesterAgentId(request, reply);
    if (!agentId) return;
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: "Deal not found", code: "DEAL_NOT_FOUND" });
    const parsed = consumeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Validation error", code: "VALIDATION_FAILED", details: parsed.error.issues });
    const body = parsed.data;

    // Pre-checks give a precise refusal code. They are NOT the guard: the
    // INSERT below re-asserts seller + status + escrowed ≥ price in the same
    // statement, and the deal_id primary key makes the use exactly-once.
    const [deal] = await sql`
      SELECT d.id, d.seller_agent_id, d.offer_id, d.status,
             ap_deal_escrowed_base_units(d.id)::text AS escrowed,
             c.consume_key
      FROM deals d
      LEFT JOIN x402_consumptions c ON c.deal_id = d.id
      WHERE d.id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found", code: "DEAL_NOT_FOUND" });
    if (deal.seller_agent_id !== agentId) {
      return reply.code(403).send({ error: "This deal is not addressed to you", code: "WRONG_SELLER" });
    }
    const milestoneIds = async () =>
      (await sql`SELECT id FROM milestones WHERE deal_id = ${id} ORDER BY idx`).map((m) => String(m.id));
    if (deal.consume_key != null) {
      if (deal.consume_key === body.consumeKey) {
        return { consumed: true, replay: true, dealId: id, milestoneIds: await milestoneIds() };
      }
      return reply.code(409).send({ error: "This deal's paid response was already served", code: "ALREADY_CONSUMED" });
    }
    if (body.offerId && body.offerId !== deal.offer_id) {
      return reply.code(409).send({ error: "Deal was made for a different offer", code: "OFFER_MISMATCH" });
    }
    if (deal.status === "proposed" || deal.status === "countered") {
      return reply.code(409).send({ error: "Deal not accepted yet", code: "DEAL_NOT_ACCEPTED", status: deal.status });
    }
    if (deal.status !== "active" && deal.status !== "funded") {
      return reply.code(409).send({ error: `Deal is ${deal.status}`, code: "DEAL_NOT_CONSUMABLE", status: deal.status });
    }
    const escrowed = BigInt(String(deal.escrowed));
    const price = BigInt(body.priceBaseUnits);
    if (escrowed === 0n) {
      return reply.code(409).send({ error: "Deal is not funded", code: "DEAL_NOT_FUNDED", escrowedBaseUnits: "0" });
    }
    if (escrowed < price) {
      return reply.code(409).send({
        error: "Escrowed amount is below the price of this request",
        code: "DEAL_UNDERFUNDED",
        escrowedBaseUnits: escrowed.toString(),
        priceBaseUnits: price.toString(),
      });
    }

    const inserted = await sql`
      INSERT INTO x402_consumptions (deal_id, seller_agent_id, consume_key, price_base_units, resource)
      SELECT d.id, d.seller_agent_id, ${body.consumeKey}, ${body.priceBaseUnits}::numeric, ${body.resource ?? null}
      FROM deals d
      WHERE d.id = ${id}
        AND d.seller_agent_id = ${agentId}
        AND d.status IN ('active', 'funded')
        AND ap_deal_escrowed_base_units(d.id) >= ${body.priceBaseUnits}::numeric
      ON CONFLICT (deal_id) DO NOTHING
      RETURNING deal_id
    `;
    if (inserted.length === 0) {
      // Lost a race (or the deal changed between the pre-check and here).
      const [winner] = await sql`SELECT consume_key FROM x402_consumptions WHERE deal_id = ${id}`;
      if (winner && winner.consume_key === body.consumeKey) {
        return { consumed: true, replay: true, dealId: id, milestoneIds: await milestoneIds() };
      }
      return reply.code(409).send({
        error: winner ? "This deal's paid response was already served" : "Deal changed concurrently; retry",
        code: winner ? "ALREADY_CONSUMED" : "DEAL_CHANGED",
      });
    }
    return { consumed: true, replay: false, dealId: id, milestoneIds: await milestoneIds() };
  });

  app.post("/api/deals/:id/consume/release", async (request, reply) => {
    const agentId = getRequesterAgentId(request, reply);
    if (!agentId) return;
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: "Deal not found" });
    const parsed = releaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Validation error", code: "VALIDATION_FAILED", details: parsed.error.issues });

    const [delivered] = await sql`
      SELECT 1 FROM deliveries dl JOIN milestones m ON m.id = dl.milestone_id
      JOIN x402_consumptions c ON c.deal_id = m.deal_id
      WHERE m.deal_id = ${id} AND dl.created_at >= c.consumed_at
      LIMIT 1
    `;
    if (delivered) {
      return reply.code(409).send({ error: "A delivery was already submitted for this consumption", code: "ALREADY_DELIVERED" });
    }
    const released = await sql`
      DELETE FROM x402_consumptions c
      WHERE c.deal_id = ${id}
        AND c.seller_agent_id = ${agentId}
        AND c.consume_key = ${parsed.data.consumeKey}
        AND NOT EXISTS (
          SELECT 1 FROM deliveries dl JOIN milestones m ON m.id = dl.milestone_id
          WHERE m.deal_id = c.deal_id AND dl.created_at >= c.consumed_at
        )
      RETURNING deal_id
    `;
    if (released.length === 0) {
      return reply.code(409).send({ error: "No undelivered consumption of this deal for this key", code: "NOT_CONSUMED_BY_KEY" });
    }
    return { released: true, dealId: id };
  });
}
