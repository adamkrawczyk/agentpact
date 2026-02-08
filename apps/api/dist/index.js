// @ts-nocheck
import Fastify from "fastify";
import cors from "@fastify/cors";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";
const sql = postgres(DATABASE_URL, { max: 10 });
const app = Fastify({ logger: true });
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
        await txn `
      UPDATE payment_intents
      SET status = 'released', released_at = NOW(), updated_at = NOW(), tx_hash = ${`release_${randomUUID().slice(0, 8)}`}
      WHERE id = ${payment.id}
    `;
        await txn `
      UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = ${milestoneId}
    `;
        await txn `
      UPDATE deals SET status = 'completed', updated_at = NOW()
      WHERE id = (SELECT deal_id FROM milestones WHERE id = ${milestoneId})
    `;
        await txn `
      INSERT INTO audit_log (action, object_type, object_id, payload_json)
      VALUES (
        'payment.release',
        'milestone',
        ${milestoneId},
        ${JSON.stringify({ gross, sellerAmount, feeAmount, platformWallet: PLATFORM_WALLET })}::jsonb
      )
    `;
    });
}
await app.register(cors, { origin: true });
app.get("/health", async () => ({ ok: true, service: "agentpact-api" }));
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
    const [offer] = await sql `
    UPDATE offers SET
      title = COALESCE(${body.title}, title),
      description_md = COALESCE(${body.descriptionMd}, description_md),
      category = COALESCE(${body.category}, category),
      tags = COALESCE(${body.tags}, tags),
      base_price = COALESCE(${body.basePrice}, base_price),
      max_price_delta_pct = COALESCE(${body.maxPriceDeltaPct}, max_price_delta_pct),
      sla_days = COALESCE(${body.slaDays}, sla_days),
      proofs_json = COALESCE(${body.proofs ? JSON.stringify(body.proofs) : undefined}::jsonb, proofs_json),
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
    const [need] = await sql `
    INSERT INTO needs (
      agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
      ${body.budgetMin}, ${body.budgetMax}, ${body.currency}, ${JSON.stringify(body.acceptanceCriteria)}::jsonb, ${body.deadlineAt}
    ) RETURNING *
  `;
    await audit(body.agentId, "need.create", "need", need.id, idem, body);
    await recomputeMatches();
    return reply.code(201).send(need);
});
app.patch("/api/needs/:id", async (request) => {
    const { id } = request.params;
    const body = createNeedSchema.partial().parse(request.body);
    const [need] = await sql `
    UPDATE needs SET
      title = COALESCE(${body.title}, title),
      description_md = COALESCE(${body.descriptionMd}, description_md),
      category = COALESCE(${body.category}, category),
      tags = COALESCE(${body.tags}, tags),
      budget_min = COALESCE(${body.budgetMin}, budget_min),
      budget_max = COALESCE(${body.budgetMax}, budget_max),
      acceptance_criteria = COALESCE(${body.acceptanceCriteria ? JSON.stringify(body.acceptanceCriteria) : undefined}::jsonb, acceptance_criteria),
      deadline_at = COALESCE(${body.deadlineAt}, deadline_at),
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
    const [subscription] = await sql `
    INSERT INTO alert_subscriptions (agent_id, kind, filter_json, webhook_url)
    VALUES (${body.agentId}, ${body.kind}, ${JSON.stringify(body.filter)}::jsonb, ${body.webhookUrl})
    RETURNING *
  `;
    return reply.code(201).send(subscription);
});
app.post("/api/deals/propose", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = proposeDealSchema.parse(request.body);
    await sql.begin(async (txn) => {
        const [deal] = await txn `
      INSERT INTO deals (
        buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days
      ) VALUES (
        ${body.buyerAgentId}, ${body.sellerAgentId}, ${body.offerId}, ${body.needId}, 'proposed', ${body.negotiatedTotal}, 'USDC', ${body.maxPriceDeltaPct}, ${body.acceptanceTimeoutDays}
      )
      RETURNING *
    `;
        for (const milestone of body.milestones) {
            await txn `
        INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at)
        VALUES (${deal.id}, ${milestone.idx}, ${milestone.title}, ${milestone.amount}, 'USDC', ${JSON.stringify(milestone.acceptanceCriteria)}::jsonb, ${milestone.dueAt})
      `;
        }
        await txn `
      INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
      VALUES (${deal.id}, ${body.buyerAgentId}, 'propose', ${JSON.stringify(body)}::jsonb)
    `;
        await audit(body.buyerAgentId, "deal.propose", "deal", deal.id, idem, body);
    });
    return reply.code(201).send({ ok: true });
});
app.post("/api/deals/:id/counter", async (request) => {
    const { id } = request.params;
    const body = counterDealSchema.parse({ ...request.body, dealId: id });
    await enforceDealDelta(id, body.negotiatedTotal);
    await sql.begin(async (txn) => {
        await txn `DELETE FROM milestones WHERE deal_id = ${id}`;
        for (const milestone of body.milestones) {
            await txn `
        INSERT INTO milestones (deal_id, idx, title, amount, acceptance_criteria, due_at)
        VALUES (${id}, ${milestone.idx}, ${milestone.title}, ${milestone.amount}, ${JSON.stringify(milestone.acceptanceCriteria)}::jsonb, ${milestone.dueAt})
      `;
        }
        await txn `
      UPDATE deals
      SET status = 'countered', negotiated_total = ${body.negotiatedTotal}, updated_at = NOW()
      WHERE id = ${id}
    `;
        await txn `
      INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
      VALUES (${id}, ${body.actorAgentId}, 'counter', ${JSON.stringify(body)}::jsonb)
    `;
    });
    return { ok: true };
});
app.post("/api/deals/:id/accept", async (request) => {
    const { id } = request.params;
    const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
    await sql.begin(async (txn) => {
        await txn `UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = ${id}`;
        await txn `UPDATE milestones SET status = 'in_progress' WHERE deal_id = ${id} AND status = 'pending'`;
        await txn `
      INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
      VALUES (${id}, ${body.actorAgentId}, 'accept', ${JSON.stringify(body)}::jsonb)
    `;
    });
    return { ok: true };
});
app.post("/api/deals/:id/cancel", async (request) => {
    const { id } = request.params;
    const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    await sql.begin(async (txn) => {
        await txn `UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = ${id}`;
        await txn `UPDATE milestones SET status = 'cancelled' WHERE deal_id = ${id}`;
        await txn `
      INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
      VALUES (${id}, ${body.actorAgentId}, 'cancel', ${JSON.stringify(body)}::jsonb)
    `;
    });
    return { ok: true };
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
    const [delivery] = await sql `
    INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, verification_notes)
    VALUES (${body.milestoneId}, ${body.submittedBy}, ${JSON.stringify(body.artifacts)}::jsonb, ${checksum}, ${body.notes})
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
    if (!body.accepted) {
        await sql `
      UPDATE deliveries
      SET status = 'rejected', verified_at = NOW(), verification_notes = COALESCE(${body.verificationNotes}, verification_notes)
      WHERE milestone_id = ${body.milestoneId}
    `;
        await sql `UPDATE milestones SET status = 'in_progress' WHERE id = ${body.milestoneId}`;
        return reply.code(200).send({ accepted: false });
    }
    await sql `
    UPDATE deliveries
    SET status = 'verified', verified_at = NOW(), verification_notes = COALESCE(${body.verificationNotes}, verification_notes)
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
    const [entry] = await sql `
    INSERT INTO feedback (
      deal_id, from_agent_id, to_agent_id,
      rating_quality, rating_timeliness, rating_communication, rating_accuracy, comment
    ) VALUES (
      ${body.dealId}, ${body.fromAgentId}, ${body.toAgentId},
      ${body.ratingQuality}, ${body.ratingTimeliness}, ${body.ratingCommunication}, ${body.ratingAccuracy}, ${body.comment}
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
app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(400).send({ error: error.message });
});
const shutdown = async () => {
    await app.close();
    await sql.end({ timeout: 5 });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
app.listen({ port: PORT, host: HOST }).catch(async (error) => {
    app.log.error(error);
    await shutdown();
    process.exit(1);
});
