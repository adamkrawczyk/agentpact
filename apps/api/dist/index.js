import Fastify from "fastify";
import cors from "@fastify/cors";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { initAuth } from "./auth.js";
import { registerHealthChecks } from "./health.js";
const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";
// ── Trust Tier definitions (informational only — no deal limits) ─────
const TRUST_TIERS = [
    { tier: "gold", label: "Gold", minDeals: 25, minReputation: 4.0, color: "#FFD700" },
    { tier: "silver", label: "Silver", minDeals: 10, minReputation: 3.5, color: "#C0C0C0" },
    { tier: "bronze", label: "Bronze", minDeals: 3, minReputation: 3.0, color: "#CD7F32" },
    { tier: "new", label: "New", minDeals: 0, minReputation: 0, color: "#888888" },
];
function computeTrustTier(completedDeals, reputationScore) {
    for (const t of TRUST_TIERS) {
        if (completedDeals >= t.minDeals && reputationScore >= t.minReputation) {
            return { tier: t.tier, label: t.label, color: t.color };
        }
    }
    return { tier: "new", label: "New", color: "#888888" };
}
async function getAgentStats(db, agentId) {
    const [stats] = await db `
    SELECT
      (SELECT COUNT(*)::int FROM deals WHERE (buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}) AND status = 'completed') AS completed_deals,
      COALESCE((SELECT AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) FROM feedback WHERE to_agent_id = ${agentId}), 0) AS reputation_score
  `;
    return { completedDeals: Number(stats.completed_deals), reputationScore: Number(stats.reputation_score) };
}
export const sql = postgres(DATABASE_URL, { max: 10 });
export const app = Fastify({ logger: true });
const walletProviderSchema = z.enum(["metamask", "walletconnect", "coinbase"]);
const milestoneSchema = z.object({
    idx: z.number().int().positive(),
    title: z.string().min(2),
    amount: z.number().positive(),
    acceptanceCriteria: z.array(z.string()).min(1),
    dueAt: z.string().datetime().optional()
});
const createOfferSchema = z.object({
    agentId: z.string().uuid(),
    title: z.string().min(4),
    descriptionMd: z.string().min(10),
    category: z.string().min(2),
    tags: z.array(z.string()).default([]),
    basePrice: z.number().positive(),
    currency: z.literal("USDC").default("USDC"),
    maxPriceDeltaPct: z.number().min(0).max(100).default(15),
    slaDays: z.number().int().positive().default(7),
    proofs: z.array(z.record(z.any())).default([])
});
const createNeedSchema = z.object({
    agentId: z.string().uuid(),
    title: z.string().min(4),
    descriptionMd: z.string().min(10),
    category: z.string().min(2),
    tags: z.array(z.string()).default([]),
    budgetMin: z.number().positive().optional(),
    budgetMax: z.number().positive().optional(),
    currency: z.literal("USDC").default("USDC"),
    acceptanceCriteria: z.array(z.string()).default([]),
    deadlineAt: z.string().datetime().optional()
});
const proposeDealSchema = z.object({
    buyerAgentId: z.string().uuid(),
    sellerAgentId: z.string().uuid(),
    offerId: z.string().uuid(),
    needId: z.string().uuid(),
    negotiatedTotal: z.number().positive(),
    maxPriceDeltaPct: z.number().min(0).max(100),
    milestones: z.array(milestoneSchema).min(1),
    acceptanceTimeoutDays: z.number().int().min(1).max(30).default(7)
});
const counterDealSchema = z.object({
    dealId: z.string().uuid(),
    actorAgentId: z.string().uuid(),
    negotiatedTotal: z.number().positive(),
    milestones: z.array(milestoneSchema).min(1)
});
const createPaymentIntentSchema = z.object({
    milestoneId: z.string().uuid(),
    buyerAgentId: z.string().uuid(),
    walletProvider: walletProviderSchema,
    buyerWalletAddress: z.string().min(4),
    chain: z.string().default("base")
});
const submitDeliverySchema = z.object({
    milestoneId: z.string().uuid(),
    submittedBy: z.string().uuid(),
    artifacts: z.array(z.object({ type: z.string(), url: z.string().url(), hash: z.string().optional() })).min(1),
    notes: z.string().optional()
});
const verifyDeliverySchema = z.object({
    milestoneId: z.string().uuid(),
    buyerAgentId: z.string().uuid(),
    accepted: z.boolean(),
    verificationNotes: z.string().optional()
});
const feedbackSchema = z.object({
    dealId: z.string().uuid(),
    fromAgentId: z.string().uuid(),
    toAgentId: z.string().uuid(),
    ratingQuality: z.number().int().min(1).max(5),
    ratingTimeliness: z.number().int().min(1).max(5),
    ratingCommunication: z.number().int().min(1).max(5),
    ratingAccuracy: z.number().int().min(1).max(5),
    comment: z.string().optional()
});
const disputeSchema = z.object({
    dealId: z.string().uuid(),
    milestoneId: z.string().uuid(),
    openedBy: z.string().uuid(),
    reason: z.string().min(5),
    evidence: z.array(z.record(z.any())).default([])
});
function idempotencyKey(headers) {
    return String(headers["idempotency-key"] ?? randomUUID());
}
function toNumber(v) {
    return Number(v);
}
async function audit(actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
async function recomputeMatches() {
    const offers = await sql `SELECT * FROM offers WHERE status = 'active'`;
    const needs = await sql `SELECT * FROM needs WHERE status = 'open'`;
    let writes = 0;
    for (const offer of offers) {
        for (const need of needs) {
            const overlap = offer.tags.filter((t) => need.tags.includes(t));
            if (overlap.length === 0)
                continue;
            const budgetFit = need.budget_max === null || need.budget_max === undefined
                ? 1
                : Math.max(0, 1 - Math.abs(toNumber(offer.base_price) - toNumber(need.budget_max)) / Math.max(toNumber(need.budget_max), 1));
            const tagScore = Math.min(1, overlap.length / Math.max(offer.tags.length, 1));
            const score = Number((0.7 * tagScore + 0.3 * budgetFit).toFixed(3));
            await sql `
        INSERT INTO matches (offer_id, need_id, score, reason_json)
        VALUES (${offer.id}, ${need.id}, ${score}, ${JSON.stringify({ overlap, budgetFit })}::jsonb)
        ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score, reason_json = EXCLUDED.reason_json
      `;
            writes += 1;
        }
    }
    return writes;
}
async function enforceDealDelta(dealId, negotiatedTotal) {
    const [deal] = await sql `
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
    const delta = Math.abs(negotiatedTotal - base) / base;
    if (delta > maxDelta) {
        throw new Error("Counter exceeds max negotiation delta");
    }
}
async function releaseMilestonePayment(milestoneId) {
    const [payment] = await sql `
    SELECT * FROM payment_intents
    WHERE milestone_id = ${milestoneId} AND status = 'funded'
    ORDER BY created_at DESC LIMIT 1
  `;
    if (!payment)
        return;
    const gross = toNumber(payment.amount);
    const sellerAmount = Number((gross * (100 - PLATFORM_FEE_PCT) / 100).toFixed(6));
    const feeAmount = Number((gross - sellerAmount).toFixed(6));
    await sql.begin(async (txn) => {
        await txn.unsafe(`
        UPDATE payment_intents
        SET status = 'released', released_at = NOW(), updated_at = NOW(), tx_hash = $1
        WHERE id = $2
      `, [`release_${randomUUID().slice(0, 8)}`, payment.id]);
        await txn.unsafe(`
        UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = $1
      `, [milestoneId]);
        await txn.unsafe(`
        UPDATE deals SET status = 'completed', updated_at = NOW()
        WHERE id = (SELECT deal_id FROM milestones WHERE id = $1)
      `, [milestoneId]);
        await txn.unsafe(`
        INSERT INTO audit_log (action, object_type, object_id, payload_json)
        VALUES ('payment.release', 'milestone', $1, $2::jsonb)
      `, [milestoneId, JSON.stringify({ gross, sellerAmount, feeAmount, platformWallet: PLATFORM_WALLET })]);
    });
}
await app.register(cors, {
    origin: process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(",").map(s => s.trim())
        : [
            "http://localhost:3000",
            "https://agentpact.xyz",
            "https://www.agentpact.xyz"
        ],
    credentials: true
});
await app.register(import('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1'],
    keyGenerator: (request) => request.headers['x-api-key'] || request.ip
});
await initAuth(app);
registerHealthChecks(app, sql);
app.addHook("preHandler", async (request, reply) => {
    const routePath = (request.url.split("?")[0] ?? request.url);
    const publicRoutes = new Set(["/health", "/api/auth/register", "/api/auth/verify"]);
    if (publicRoutes.has(routePath)) {
        return;
    }
    // Public read-only routes: anything under /api/public/ or GET requests to browsable endpoints
    if (routePath.startsWith("/api/public/")) {
        return;
    }
    const publicGetRoutes = ["/api/offers", "/api/needs", "/api/matches/recommendations", "/api/deals", "/api/agents", "/api/leaderboard"];
    if (request.method === "GET" && publicGetRoutes.some(r => routePath === r || routePath.startsWith(r + "/"))) {
        return;
    }
    if (routePath.startsWith("/api/")) {
        await app.authenticate(request, reply);
    }
});
app.post("/api/agents", async (request, reply) => {
    const body = z
        .object({
        handle: z.string().min(3),
        displayName: z.string().min(2),
        ownerWalletAddress: z.string().min(4),
        walletProvider: walletProviderSchema,
        autoBuyEnabled: z.boolean().default(false)
    })
        .parse(request.body);
    const [agent] = await sql `
    INSERT INTO agents (handle, display_name, owner_wallet_address, wallet_provider, auto_buy_enabled)
    VALUES (${body.handle}, ${body.displayName}, ${body.ownerWalletAddress}, ${body.walletProvider}, ${body.autoBuyEnabled})
    ON CONFLICT (handle) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      owner_wallet_address = EXCLUDED.owner_wallet_address,
      wallet_provider = EXCLUDED.wallet_provider,
      auto_buy_enabled = EXCLUDED.auto_buy_enabled
    RETURNING *
  `;
    return reply.code(201).send(agent);
});
app.get("/api/agents/:id", async (request, reply) => {
    const { id } = request.params;
    const [agent] = await sql `SELECT * FROM agents WHERE id = ${id}`;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    const [reputation] = await sql `
    SELECT
      COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score,
      COUNT(*)::int AS review_count
    FROM feedback
    WHERE to_agent_id = ${id}
  `;
    const agentStats = await getAgentStats(sql, id);
    const trustTier = computeTrustTier(agentStats.completedDeals, agentStats.reputationScore);
    return {
        ...agent,
        reputation: {
            score: Number(reputation.score ?? 0),
            reviewCount: Number(reputation.review_count ?? 0)
        },
        trustTier
    };
});
app.get("/api/agents/:id/reputation", async (request) => {
    const { id } = request.params;
    const [aggregate] = await sql `
    SELECT
      COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score,
      COUNT(*)::int AS review_count
    FROM feedback
    WHERE to_agent_id = ${id}
  `;
    return {
        agentId: id,
        score: Number(aggregate.score ?? 0),
        reviewCount: Number(aggregate.review_count ?? 0)
    };
});
app.post("/api/offers", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = createOfferSchema.parse(request.body);
    const [offer] = await sql `
    INSERT INTO offers (
      agent_id, title, description_md, category, tags, base_price, currency, max_price_delta_pct, sla_days, proofs_json
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags}, ${body.basePrice},
      ${body.currency}, ${body.maxPriceDeltaPct}, ${body.slaDays}, ${JSON.stringify(body.proofs)}::jsonb
    )
    RETURNING *
  `;
    await audit(body.agentId, "offer.create", "offer", offer.id, idem, body);
    await recomputeMatches();
    return reply.code(201).send(offer);
});
app.patch("/api/offers/:id", async (request) => {
    const { id } = request.params;
    const body = createOfferSchema.partial().parse(request.body);
    const title = body.title ?? null;
    const descriptionMd = body.descriptionMd ?? null;
    const category = body.category ?? null;
    const tags = body.tags ?? null;
    const basePrice = body.basePrice ?? null;
    const maxPriceDeltaPct = body.maxPriceDeltaPct ?? null;
    const slaDays = body.slaDays ?? null;
    const proofsJson = body.proofs ? JSON.stringify(body.proofs) : null;
    const [offer] = await sql `
    UPDATE offers SET
      title = COALESCE(${title}, title),
      description_md = COALESCE(${descriptionMd}, description_md),
      category = COALESCE(${category}, category),
      tags = COALESCE(${tags}, tags),
      base_price = COALESCE(${basePrice}, base_price),
      max_price_delta_pct = COALESCE(${maxPriceDeltaPct}, max_price_delta_pct),
      sla_days = COALESCE(${slaDays}, sla_days),
      proofs_json = COALESCE(${proofsJson}::jsonb, proofs_json),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
    await recomputeMatches();
    return offer;
});
app.post("/api/offers/:id/archive", async (request) => {
    const { id } = request.params;
    const [offer] = await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return offer;
});
app.get("/api/offers", async (request) => {
    const q = request.query;
    const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
    const query = `%${q.query ?? ""}%`;
    const min = q.minPrice ? Number(q.minPrice) : 0;
    const max = q.maxPrice ? Number(q.maxPrice) : Number.MAX_SAFE_INTEGER;
    const rows = await sql `
    SELECT * FROM offers
    WHERE status = 'active'
      AND (title ILIKE ${query} OR description_md ILIKE ${query})
      AND base_price BETWEEN ${min} AND ${max}
      AND (${tags.length} = 0 OR tags && ${tags})
    ORDER BY created_at DESC
    LIMIT 200
  `;
    return rows;
});
app.get("/api/offers/:id", async (request, reply) => {
    const { id } = request.params;
    const [offer] = await sql `SELECT * FROM offers WHERE id = ${id}`;
    if (!offer)
        return reply.code(404).send({ error: "Offer not found" });
    return offer;
});
app.post("/api/needs", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = createNeedSchema.parse(request.body);
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const deadlineAt = body.deadlineAt ?? null;
    const [need] = await sql `
    INSERT INTO needs (
      agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
      ${budgetMin}, ${budgetMax}, ${body.currency}, ${JSON.stringify(body.acceptanceCriteria)}::jsonb, ${deadlineAt}
    ) RETURNING *
  `;
    await audit(body.agentId, "need.create", "need", need.id, idem, body);
    await recomputeMatches();
    return reply.code(201).send(need);
});
app.patch("/api/needs/:id", async (request) => {
    const { id } = request.params;
    const body = createNeedSchema.partial().parse(request.body);
    const title = body.title ?? null;
    const descriptionMd = body.descriptionMd ?? null;
    const category = body.category ?? null;
    const tags = body.tags ?? null;
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const acceptanceCriteria = body.acceptanceCriteria ? JSON.stringify(body.acceptanceCriteria) : null;
    const deadlineAt = body.deadlineAt ?? null;
    const [need] = await sql `
    UPDATE needs SET
      title = COALESCE(${title}, title),
      description_md = COALESCE(${descriptionMd}, description_md),
      category = COALESCE(${category}, category),
      tags = COALESCE(${tags}, tags),
      budget_min = COALESCE(${budgetMin}, budget_min),
      budget_max = COALESCE(${budgetMax}, budget_max),
      acceptance_criteria = COALESCE(${acceptanceCriteria}::jsonb, acceptance_criteria),
      deadline_at = COALESCE(${deadlineAt}, deadline_at),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
    await recomputeMatches();
    return need;
});
app.post("/api/needs/:id/archive", async (request) => {
    const { id } = request.params;
    const [need] = await sql `UPDATE needs SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return need;
});
app.get("/api/needs", async (request) => {
    const q = request.query;
    const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
    const query = `%${q.query ?? ""}%`;
    const rows = await sql `
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
    const { id } = request.params;
    const [need] = await sql `SELECT * FROM needs WHERE id = ${id}`;
    if (!need)
        return reply.code(404).send({ error: "Need not found" });
    return need;
});
app.get("/api/matches/recommendations", async (request) => {
    const q = request.query;
    const limit = Number(q.limit ?? 20);
    const rows = await sql `
    SELECT m.*, o.title AS offer_title, n.title AS need_title
    FROM matches m
    JOIN offers o ON o.id = m.offer_id
    JOIN needs n ON n.id = m.need_id
    WHERE (${q.agentId ?? null}::uuid IS NULL OR o.agent_id = ${q.agentId ?? null}::uuid OR n.agent_id = ${q.agentId ?? null}::uuid)
    ORDER BY m.score DESC
    LIMIT ${limit}
  `;
    return rows;
});
app.post("/api/matches/recompute", async () => {
    const writes = await recomputeMatches();
    return { matchesUpserted: writes };
});
app.post("/api/alerts/subscribe", async (request, reply) => {
    const body = z
        .object({
        agentId: z.string().uuid(),
        kind: z.enum(["offers", "needs"]),
        filter: z.record(z.any()),
        webhookUrl: z.string().url().optional()
    })
        .parse(request.body);
    const webhookUrl = body.webhookUrl ?? null;
    const [subscription] = await sql `
    INSERT INTO alert_subscriptions (agent_id, kind, filter_json, webhook_url)
    VALUES (${body.agentId}, ${body.kind}, ${JSON.stringify(body.filter)}::jsonb, ${webhookUrl})
    RETURNING *
  `;
    return reply.code(201).send(subscription);
});
app.post("/api/deals/propose", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = proposeDealSchema.parse(request.body);
    const result = await sql.begin(async (txn) => {
        const [deal] = await txn.unsafe(`
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days
        ) VALUES ($1, $2, $3, $4, 'proposed', $5, 'USDC', $6, $7)
        RETURNING *
      `, [body.buyerAgentId, body.sellerAgentId, body.offerId, body.needId, body.negotiatedTotal, body.maxPriceDeltaPct, body.acceptanceTimeoutDays]);
        const milestones = [];
        for (const milestone of body.milestones) {
            const dueAt = milestone.dueAt ?? null;
            const [ms] = await txn.unsafe(`
          INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6)
          RETURNING *
        `, [deal.id, milestone.idx, milestone.title, milestone.amount, JSON.stringify(milestone.acceptanceCriteria), dueAt]);
            milestones.push(ms);
        }
        await txn.unsafe(`
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)
      `, [deal.id, body.buyerAgentId, JSON.stringify(body)]);
        await audit(body.buyerAgentId, "deal.propose", "deal", deal.id, idem, body);
        return { ...deal, milestones };
    });
    return reply.code(201).send(result);
});
app.post("/api/deals/:id/counter", async (request) => {
    const { id } = request.params;
    const requestBody = request.body && typeof request.body === "object" ? request.body : {};
    const body = counterDealSchema.parse({ ...requestBody, dealId: id });
    await enforceDealDelta(id, body.negotiatedTotal);
    await sql.begin(async (txn) => {
        await txn.unsafe("DELETE FROM milestones WHERE deal_id = $1", [id]);
        for (const milestone of body.milestones) {
            const dueAt = milestone.dueAt ?? null;
            await txn.unsafe(`
          INSERT INTO milestones (deal_id, idx, title, amount, acceptance_criteria, due_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `, [id, milestone.idx, milestone.title, milestone.amount, JSON.stringify(milestone.acceptanceCriteria), dueAt]);
        }
        await txn.unsafe(`
        UPDATE deals
        SET status = 'countered', negotiated_total = $1, updated_at = NOW()
        WHERE id = $2
      `, [body.negotiatedTotal, id]);
        await txn.unsafe(`
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'counter', $3::jsonb)
      `, [id, body.actorAgentId, JSON.stringify(body)]);
    });
    return { ok: true };
});
app.post("/api/deals/:id/accept", async (request) => {
    const { id } = request.params;
    const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
    await sql.begin(async (txn) => {
        await txn.unsafe("UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1", [id]);
        await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
        await txn.unsafe(`
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'accept', $3::jsonb)
      `, [id, body.actorAgentId, JSON.stringify(body)]);
    });
    return { ok: true };
});
app.post("/api/deals/:id/cancel", async (request) => {
    const { id } = request.params;
    const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    await sql.begin(async (txn) => {
        await txn.unsafe("UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
        await txn.unsafe("UPDATE milestones SET status = 'cancelled' WHERE deal_id = $1", [id]);
        await txn.unsafe(`
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'cancel', $3::jsonb)
      `, [id, body.actorAgentId, JSON.stringify(body)]);
    });
    return { ok: true };
});
app.get("/api/deals", async (request) => {
    const q = request.query;
    const rows = await sql `
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
    const { id } = request.params;
    const [deal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    const milestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
    const events = await sql `SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
    return { ...deal, milestones, events };
});
app.post("/api/payments/create-intent", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = createPaymentIntentSchema.parse(request.body);
    const [milestone] = await sql `
    SELECT m.*, d.seller_agent_id, d.buyer_agent_id, d.status AS deal_status, a.owner_wallet_address AS seller_wallet_address
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    JOIN agents a ON a.id = d.seller_agent_id
    WHERE m.id = ${body.milestoneId}
  `;
    if (!milestone)
        return reply.code(404).send({ error: "Milestone not found" });
    if (!["in_progress", "pending"].includes(milestone.status)) {
        return reply.code(400).send({ error: `Milestone status ${milestone.status} cannot be funded` });
    }
    const [intent] = await sql `
    INSERT INTO payment_intents (
      milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
      buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address, tx_hash
    ) VALUES (
      ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id}, ${milestone.amount}, 'USDC', ${body.chain}, 'funded',
      ${body.walletProvider}, ${body.buyerWalletAddress}, ${milestone.seller_wallet_address}, ${PLATFORM_WALLET}, ${`fund_${randomUUID().slice(0, 8)}`}
    )
    RETURNING *
  `;
    await sql `UPDATE milestones SET status = 'funded' WHERE id = ${body.milestoneId}`;
    await audit(body.buyerAgentId, "payment.create_intent", "payment_intent", intent.id, idem, body);
    return reply.code(201).send({
        paymentIntentId: intent.id,
        status: intent.status,
        chain: intent.chain,
        amount: intent.amount,
        currency: "USDC",
        feePct: PLATFORM_FEE_PCT,
        platformWallet: PLATFORM_WALLET,
        provider: "usdc"
    });
});
app.get("/api/payments/status", async (request, reply) => {
    const q = request.query;
    if (!q.milestoneId && !q.paymentIntentId) {
        return reply.code(400).send({ error: "Provide milestoneId or paymentIntentId" });
    }
    const rows = await sql `
    SELECT * FROM payment_intents
    WHERE (${q.milestoneId ?? null}::uuid IS NULL OR milestone_id = ${q.milestoneId ?? null}::uuid)
      AND (${q.paymentIntentId ?? null}::uuid IS NULL OR id = ${q.paymentIntentId ?? null}::uuid)
    ORDER BY created_at DESC
  `;
    return rows;
});
app.post("/api/payments/release", async (request) => {
    const body = z.object({ milestoneId: z.string().uuid() }).parse(request.body);
    await releaseMilestonePayment(body.milestoneId);
    return { ok: true };
});
app.post("/api/payments/refund", async (request) => {
    const body = z.object({ paymentIntentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    await sql `
    UPDATE payment_intents
    SET status = 'refunded', updated_at = NOW(), tx_hash = ${`refund_${randomUUID().slice(0, 8)}`}
    WHERE id = ${body.paymentIntentId}
  `;
    return { ok: true };
});
app.post("/api/deliveries/submit", async (request, reply) => {
    const body = submitDeliverySchema.parse(request.body);
    const checksum = createHash("sha256").update(JSON.stringify(body.artifacts)).digest("hex");
    const notes = body.notes ?? null;
    const [delivery] = await sql `
    INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, verification_notes)
    VALUES (${body.milestoneId}, ${body.submittedBy}, ${JSON.stringify(body.artifacts)}::jsonb, ${checksum}, ${notes})
    RETURNING *
  `;
    await sql `UPDATE milestones SET status = 'delivered' WHERE id = ${body.milestoneId}`;
    await sql `
    UPDATE deals SET status = 'delivered', updated_at = NOW()
    WHERE id = (SELECT deal_id FROM milestones WHERE id = ${body.milestoneId})
  `;
    return reply.code(201).send(delivery);
});
app.post("/api/deliveries/verify", async (request, reply) => {
    const body = verifyDeliverySchema.parse(request.body);
    const verificationNotes = body.verificationNotes ?? null;
    if (!body.accepted) {
        await sql `
      UPDATE deliveries
      SET status = 'rejected', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
      WHERE milestone_id = ${body.milestoneId}
    `;
        await sql `UPDATE milestones SET status = 'in_progress' WHERE id = ${body.milestoneId}`;
        return reply.code(200).send({ accepted: false });
    }
    await sql `
    UPDATE deliveries
    SET status = 'verified', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
    WHERE milestone_id = ${body.milestoneId}
  `;
    await releaseMilestonePayment(body.milestoneId);
    return { accepted: true, payoutReleased: true };
});
app.post("/api/disputes/open", async (request, reply) => {
    const body = disputeSchema.parse(request.body);
    const [dispute] = await sql `
    INSERT INTO disputes (deal_id, milestone_id, opened_by, reason, evidence_json, expires_at)
    VALUES (
      ${body.dealId},
      ${body.milestoneId},
      ${body.openedBy},
      ${body.reason},
      ${JSON.stringify(body.evidence)}::jsonb,
      NOW() + INTERVAL '7 days'
    ) RETURNING *
  `;
    await sql `UPDATE milestones SET status = 'disputed' WHERE id = ${body.milestoneId}`;
    await sql `UPDATE deals SET status = 'disputed', updated_at = NOW() WHERE id = ${body.dealId}`;
    return reply.code(201).send(dispute);
});
app.post("/api/disputes/resolve-timeouts", async () => {
    const expired = await sql `
    UPDATE disputes
    SET status = 'timed_out', resolved_at = NOW()
    WHERE status = 'open' AND expires_at <= NOW()
    RETURNING *
  `;
    for (const dispute of expired) {
        await releaseMilestonePayment(dispute.milestone_id);
    }
    return { timedOutDisputes: expired.length };
});
app.post("/api/feedback", async (request, reply) => {
    const body = feedbackSchema.parse(request.body);
    const comment = body.comment ?? null;
    const [entry] = await sql `
    INSERT INTO feedback (
      deal_id, from_agent_id, to_agent_id,
      rating_quality, rating_timeliness, rating_communication, rating_accuracy, comment
    ) VALUES (
      ${body.dealId}, ${body.fromAgentId}, ${body.toAgentId},
      ${body.ratingQuality}, ${body.ratingTimeliness}, ${body.ratingCommunication}, ${body.ratingAccuracy}, ${comment}
    )
    ON CONFLICT (deal_id, from_agent_id, to_agent_id)
    DO UPDATE SET
      rating_quality = EXCLUDED.rating_quality,
      rating_timeliness = EXCLUDED.rating_timeliness,
      rating_communication = EXCLUDED.rating_communication,
      rating_accuracy = EXCLUDED.rating_accuracy,
      comment = EXCLUDED.comment
    RETURNING *
  `;
    const [aggregate] = await sql `
    SELECT COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score
    FROM feedback WHERE to_agent_id = ${body.toAgentId}
  `;
    await sql `UPDATE agents SET reputation_score = ${Number(aggregate.score)} WHERE id = ${body.toAgentId}`;
    return reply.code(201).send(entry);
});
app.get("/api/public/overview", async () => {
    const [stats] = await sql `
    SELECT
      (SELECT COUNT(*) FROM offers WHERE status = 'active')::int AS active_offers,
      (SELECT COUNT(*) FROM needs WHERE status = 'open')::int AS open_needs,
      (SELECT COUNT(*) FROM deals WHERE status IN ('active','delivered','completed'))::int AS live_deals,
      (SELECT COUNT(*) FROM agents)::int AS total_agents
  `;
    return stats;
});
// ── Leaderboard ──────────────────────────────────────────────────────
app.get("/api/leaderboard", async (request) => {
    const q = request.query;
    const sortBy = q.sortBy ?? "reputation";
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const period = q.period ?? "all";
    let periodFilter = "";
    if (period === "30d")
        periodFilter = "AND d.created_at >= NOW() - INTERVAL '30 days'";
    else if (period === "7d")
        periodFilter = "AND d.created_at >= NOW() - INTERVAL '7 days'";
    let orderClause = "reputation_score DESC";
    if (sortBy === "deals")
        orderClause = "completed_deals DESC";
    else if (sortBy === "volume")
        orderClause = "total_volume DESC";
    const rows = await sql.unsafe(`
    SELECT
      a.id AS agent_id,
      a.display_name AS name,
      a.created_at AS member_since,
      COALESCE(f.avg_score, 0) AS reputation_score,
      COALESCE(f.review_count, 0)::int AS review_count,
      COALESCE(ds.completed_deals, 0)::int AS completed_deals,
      COALESCE(ds.total_volume, 0) AS total_volume,
      COALESCE(ds.disputed_deals, 0)::int AS disputed_deals,
      COALESCE(ds.total_deals, 0)::int AS total_deals
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT
        AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) AS avg_score,
        COUNT(*)::int AS review_count
      FROM feedback WHERE to_agent_id = a.id
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE d.status = 'completed')::int AS completed_deals,
        COALESCE(SUM(d.negotiated_total) FILTER (WHERE d.status = 'completed'), 0) AS total_volume,
        COUNT(*) FILTER (WHERE d.status = 'disputed')::int AS disputed_deals,
        COUNT(*)::int AS total_deals
      FROM deals d
      WHERE (d.buyer_agent_id = a.id OR d.seller_agent_id = a.id)
        ${periodFilter}
    ) ds ON true
    ORDER BY ${orderClause}
    LIMIT ${limit}
  `);
    return rows.map((row, idx) => {
        const completedDeals = Number(row.completed_deals);
        const reputationScore = Number(Number(row.reputation_score).toFixed(2));
        const totalDeals = Number(row.total_deals);
        const disputedDeals = Number(row.disputed_deals);
        const trustTier = computeTrustTier(completedDeals, reputationScore);
        return {
            rank: idx + 1,
            agentId: row.agent_id,
            name: row.name,
            trustTier: trustTier.tier,
            reputationScore,
            reviewCount: Number(row.review_count),
            completedDeals,
            totalVolume: Number(Number(row.total_volume).toFixed(2)),
            disputeRate: totalDeals > 0 ? Number((disputedDeals / totalDeals).toFixed(4)) : 0,
            memberSince: row.member_since,
        };
    });
});
app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (error.validation) {
        return reply.code(400).send({ error: 'Validation error', details: error.validation });
    }
    const statusCode = error.statusCode ?? 500;
    const message = statusCode < 500 ? (error.message ?? 'Unknown error') : 'Internal server error';
    reply.code(statusCode).send({ error: message });
});
export const shutdown = async () => {
    await app.close();
    await sql.end({ timeout: 5 });
};
