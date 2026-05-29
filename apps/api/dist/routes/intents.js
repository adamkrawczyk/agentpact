// apps/api/src/routes/intents.ts — settlement_2705 Phase E
//
// AgentPact v2 intent surface. Mirrors the on-chain AgentPactEscrowV2.sol
// contract (Phase A/B/C, PR #33). For the canonical specification of each
// settlement class and the buyer/seller flows, see the plan-doc at
// obsidian-vault/projects/agentpact/2026-05-27-v2-settlement-protocol-plan.md.
//
// Design rules followed here:
//
//  - Routes mirror the existing v1 route style (`registerRoutes(app, sql, deps)`
//    plus an audit-log row per state transition).
//  - Auth: every state-changing route requires `app.authenticate()` (the
//    public-prefix list in apps/api/src/index.ts adds `/api/intents` so the
//    GET browse path is anonymous; specific GETs use `optionalAuthenticate`
//    so targeted intents can surface to their intended seller).
//  - No on-chain calls in this PR — the relayer-daemon (Phase D) owns
//    broadcasting. Routes accept buyer-signed EIP-3009 permits, return tx
//    calldata for direct buyer-signed paths, and persist DB state in
//    response to the relayer's webhook deliveries.
//  - Predicate params stored as JSONB (one column, opaque to the API).
//  - on_chain_id arrives from the relayer (or from the buyer for direct
//    submissions) as a 0x-prefixed 32-byte hex string.
import { z } from "zod";
import { getRequesterAgentId, idempotencyKey } from "./utils.js";
// ── Validation schemas ──────────────────────────────────────────────────────
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ANY = /^0x[0-9a-fA-F]+$/;
const createIntentSchema = z.object({
    agentId: z.string().uuid(),
    onChainId: z.string().regex(HEX32, "onChainId must be 0x + 64 hex chars"),
    settlementClass: z.enum(["A", "B", "C"]),
    predicateType: z.string().min(1).max(64),
    predicateParams: z.record(z.unknown()),
    sellerTargetAgentId: z.string().uuid().optional(),
    maxPriceUsdc: z.number().positive(),
    buyerStakeUsdc: z.number().nonnegative().default(0),
    relayGasUsdc: z.number().nonnegative().default(0),
    expiresAt: z.string().datetime(),
});
const acceptIntentSchema = z.object({
    agentId: z.string().uuid(),
    sellerStakeUsdc: z.number().nonnegative().default(0),
});
const claimIntentSchema = z.object({
    agentId: z.string().uuid(),
    ciphertext: z.string().regex(HEX_ANY).optional(),
    witness: z.string().regex(HEX_ANY),
});
const acknowledgeSchema = z.object({
    agentId: z.string().uuid(),
});
const rejectSchema = z.object({
    agentId: z.string().uuid(),
    commitHash: z.string().regex(HEX32),
});
const revealSchema = z.object({
    agentId: z.string().uuid(),
    deliverable: z.string().regex(HEX_ANY),
    salt: z.string().regex(HEX32),
});
const claimUnitSchema = z.object({
    agentId: z.string().uuid(),
    unitIndex: z.number().int().nonnegative(),
    witness: z.string().regex(HEX_ANY),
});
// ── Helpers ─────────────────────────────────────────────────────────────────
function hexToBuffer(hex) {
    return Buffer.from(hex.slice(2), "hex");
}
async function audit(sql, actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
// Optional authentication preHandler — populates request.agentId when an
// x-api-key is supplied and resolves, otherwise leaves it null. Used by
// /api/intents/discover so anonymous browsers see open intents only while
// authenticated callers also see targeted intents addressed to them.
async function optionalAuthenticate(app, request, reply) {
    if (typeof request.headers["x-api-key"] !== "string")
        return;
    try {
        await app.authenticate(request, reply);
    }
    catch {
        // swallow — anonymous access is allowed on this route
    }
}
// ── Route registration ──────────────────────────────────────────────────────
export async function registerRoutes(app, sql, _deps) {
    // POST /api/intents — buyer creates an intent (any class). The on-chain
    // creation has either already happened (buyer-broadcast) or is about to
    // happen via the relayer-daemon (Phase D). The API persists the DB row
    // once the relayer (or buyer) confirms the on-chain tx hash. v2.0 ships
    // the API expecting the caller to provide the `onChainId` they receive
    // from the contract event.
    app.post("/api/intents", { preHandler: app.authenticate }, async (request, reply) => {
        const body = createIntentSchema.parse(request.body);
        const idem = idempotencyKey(request.headers);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({
                error: "Not authorized to act as this agent",
                code: "AUTH_FORBIDDEN",
            });
        }
        // Encryption pubkey gate — buyer must have one registered before any
        // intent can be created. Returns 412 with a registration challenge
        // (the SDK auto-retries; MCP surfaces the structured error).
        const [agentRow] = await sql `
        SELECT encryption_pubkey FROM agents WHERE id = ${body.agentId}
      `;
        if (!agentRow) {
            return reply.code(404).send({ error: "Agent not found", code: "NOT_FOUND" });
        }
        if (!agentRow.encryption_pubkey) {
            // Generate a 128-bit nonce, persist with 10-minute TTL via audit_log
            // (Redis is optional; reusing audit_log keeps this PR scoped to one
            // dependency: postgres). The pubkey route reads it back for replay.
            const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
            const message = `AgentPact encryption pubkey registration v1 ${nonce}`;
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            await audit(sql, body.agentId, "encryption_pubkey.challenge", "agent", body.agentId, `intent-bootstrap:${nonce}`, { nonce, message, expiresAt });
            return reply.code(412).send({
                code: "encryption_pubkey_required",
                challenge: { message, nonce, expiresAt },
                registerEndpoint: "/api/agents/me/encryption-pubkey",
            });
        }
        const onChainBuf = hexToBuffer(body.onChainId);
        try {
            const [intent] = await sql `
          INSERT INTO intents (
            on_chain_id, buyer_agent_id, seller_target_agent_id,
            settlement_class, predicate_type, predicate_params,
            max_price_usdc, buyer_stake_usdc, relay_gas_usdc,
            status, expires_at
          ) VALUES (
            ${onChainBuf}, ${body.agentId}, ${body.sellerTargetAgentId ?? null},
            ${body.settlementClass}, ${body.predicateType},
            ${JSON.stringify(body.predicateParams)}::jsonb,
            ${body.maxPriceUsdc}, ${body.buyerStakeUsdc}, ${body.relayGasUsdc},
            ${body.settlementClass === "B" ? "awaiting_accept" : body.settlementClass === "C" ? "streaming" : "open"},
            ${body.expiresAt}
          )
          RETURNING *
        `;
            await audit(sql, body.agentId, "intent.create", "intent", String(intent.id), idem, body);
            return reply.code(201).send(intent);
        }
        catch (err) {
            if (err?.code === "23505") {
                return reply.code(409).send({
                    error: "Intent with this on_chain_id already exists",
                    code: "DB_CONSTRAINT_VIOLATION",
                });
            }
            throw err;
        }
    });
    // GET /api/intents/:id — full state. Public (anyone with the UUID can read);
    // sensitive fields are inside the on-chain contract anyway. Returns the
    // open-decimal NUMERIC columns as strings to preserve precision.
    app.get("/api/intents/:id", async (request, reply) => {
        const { id } = request.params;
        const [row] = await sql `SELECT * FROM intents WHERE id = ${id}`;
        if (!row)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        return reply.code(200).send(row);
    });
    // GET /api/intents/discover — anonymous-safe browse. Open intents always
    // visible; targeted intents only visible to the targeted seller when
    // authenticated.
    app.get("/api/intents/discover", { preHandler: async (req, rep) => optionalAuthenticate(app, req, rep) }, async (request, reply) => {
        const callerAgent = request.agentId ?? null;
        const limit = Math.min(Number(request.query?.limit ?? 50), 200);
        const rows = await sql `
        SELECT id, on_chain_id, settlement_class, predicate_type, max_price_usdc,
               expires_at, status, seller_target_agent_id, created_at
        FROM intents
        WHERE status IN ('open', 'awaiting_accept', 'streaming')
          AND expires_at > now()
          AND (
            seller_target_agent_id IS NULL
            OR seller_target_agent_id = ${callerAgent}
          )
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
        return reply.code(200).send({ intents: rows, callerAgent });
    });
    // POST /api/intents/:id/accept — Class B seller accepts.
    app.post("/api/intents/:id/accept", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = acceptIntentSchema.parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester)
            return;
        if (body.agentId !== requester) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT id, status, settlement_class, seller_target_agent_id
        FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.settlement_class !== "B") {
            return reply.code(400).send({ error: "Only Class B intents accept-by-seller", code: "VALIDATION_FAILED" });
        }
        if (intent.status !== "awaiting_accept") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        if (intent.seller_target_agent_id && intent.seller_target_agent_id !== body.agentId) {
            return reply.code(403).send({
                error: "INTENT_TARGETED_TO_OTHER_SELLER",
                code: "INTENT_TARGETED_TO_OTHER_SELLER",
            });
        }
        const [updated] = await sql `
        UPDATE intents
        SET seller_agent_id = ${body.agentId},
            seller_stake_usdc = ${body.sellerStakeUsdc},
            status = 'accepted',
            updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
        await audit(sql, body.agentId, "intent.accept", "intent", id, idempotencyKey(request.headers), body);
        return reply.code(200).send(updated);
    });
    // POST /api/intents/:id/deliver — Class B seller posts ciphertext.
    app.post("/api/intents/:id/deliver", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = z.object({ agentId: z.string().uuid() }).parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status, seller_agent_id, max_price_usdc FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.seller_agent_id !== body.agentId) {
            return reply.code(403).send({ error: "Only accepted seller may deliver", code: "AUTH_FORBIDDEN" });
        }
        if (intent.status !== "accepted") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        // Buyer ack window scales with price (per Schelling spec):
        //   <= $10 → 10 min; <= $100 → 1 h; else 24 h.
        const maxPrice = Number(intent.max_price_usdc);
        const windowMs = maxPrice <= 10 ? 10 * 60 * 1000
            : maxPrice <= 100 ? 60 * 60 * 1000
                : 24 * 60 * 60 * 1000;
        const ackDeadline = new Date(Date.now() + windowMs).toISOString();
        const [updated] = await sql `
        UPDATE intents
        SET status = 'delivered',
            ack_deadline_at = ${ackDeadline},
            updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
        await audit(sql, body.agentId, "intent.deliver", "intent", id, idempotencyKey(request.headers), { ackDeadline });
        return reply.code(200).send(updated);
    });
    // POST /api/intents/:id/acknowledge — buyer ack.
    app.post("/api/intents/:id/acknowledge", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = acknowledgeSchema.parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status, buyer_agent_id FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.buyer_agent_id !== body.agentId) {
            return reply.code(403).send({ error: "Only buyer may acknowledge", code: "AUTH_FORBIDDEN" });
        }
        if (intent.status !== "delivered") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        const [updated] = await sql `
        UPDATE intents SET status='acknowledged', updated_at = now() WHERE id = ${id} RETURNING *
      `;
        await audit(sql, body.agentId, "intent.acknowledge", "intent", id, idempotencyKey(request.headers), {});
        return reply.code(200).send(updated);
    });
    // POST /api/intents/:id/reject — buyer rejects with commit hash.
    app.post("/api/intents/:id/reject", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = rejectSchema.parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status, buyer_agent_id FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.buyer_agent_id !== body.agentId) {
            return reply.code(403).send({ error: "Only buyer may reject", code: "AUTH_FORBIDDEN" });
        }
        if (intent.status !== "delivered") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        const round1 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const [updated] = await sql `
        UPDATE intents
        SET status = 'reveal_round1', round1_deadline_at = ${round1}, updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
        await audit(sql, body.agentId, "intent.reject", "intent", id, idempotencyKey(request.headers), { commitHash: body.commitHash });
        return reply.code(200).send(updated);
    });
    // POST /api/intents/:id/reveal — round-2 reveal.
    app.post("/api/intents/:id/reveal", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = revealSchema.parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (!["reveal_round1", "reveal_round2"].includes(intent.status)) {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        // The contract enforces who-reveals-what; the API just audit-logs the
        // submission so the off-chain trace matches the on-chain trace.
        await audit(sql, body.agentId, "intent.reveal", "intent", id, idempotencyKey(request.headers), { deliverable: body.deliverable, salt: body.salt });
        return reply.code(202).send({ ok: true });
    });
    // POST /api/intents/:id/claim — Class A seller claim.
    app.post("/api/intents/:id/claim", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = claimIntentSchema.parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status, settlement_class, seller_target_agent_id
        FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.settlement_class !== "A") {
            return reply.code(400).send({ error: "Only Class A intents claim directly", code: "VALIDATION_FAILED" });
        }
        if (intent.status !== "open") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        if (intent.seller_target_agent_id && intent.seller_target_agent_id !== body.agentId) {
            return reply.code(403).send({
                error: "INTENT_TARGETED_TO_OTHER_SELLER",
                code: "INTENT_TARGETED_TO_OTHER_SELLER",
            });
        }
        const [updated] = await sql `
        UPDATE intents
        SET seller_agent_id = ${body.agentId}, status='claimed_a', updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
        await audit(sql, body.agentId, "intent.claim", "intent", id, idempotencyKey(request.headers), { hasCiphertext: !!body.ciphertext });
        return reply.code(200).send(updated);
    });
    // POST /api/intents/:id/claim-unit — Class C streaming claim.
    app.post("/api/intents/:id/claim-unit", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = claimUnitSchema.parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status, settlement_class FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.settlement_class !== "C") {
            return reply.code(400).send({ error: "Only Class C intents claim-unit", code: "VALIDATION_FAILED" });
        }
        if (intent.status !== "streaming") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        const witnessBuf = hexToBuffer(body.witness);
        try {
            const [unit] = await sql `
          INSERT INTO intent_units (intent_id, unit_index, witness_hash)
          VALUES (${id}, ${body.unitIndex}, ${witnessBuf})
          RETURNING *
        `;
            await sql `UPDATE intents SET seller_agent_id = COALESCE(seller_agent_id, ${body.agentId}), updated_at = now() WHERE id = ${id}`;
            await audit(sql, body.agentId, "intent.claim_unit", "intent", id, idempotencyKey(request.headers), { unitIndex: body.unitIndex });
            return reply.code(201).send(unit);
        }
        catch (err) {
            if (err?.code === "23505") {
                return reply.code(409).send({
                    error: `Unit ${body.unitIndex} already claimed`,
                    code: "DB_CONSTRAINT_VIOLATION",
                });
            }
            throw err;
        }
    });
    // POST /api/intents/:id/cancel — Class C cancel by buyer or seller.
    app.post("/api/intents/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = z.object({ agentId: z.string().uuid() }).parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester || requester !== body.agentId) {
            return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
        }
        const [intent] = await sql `
        SELECT status, buyer_agent_id, seller_agent_id FROM intents WHERE id = ${id} FOR UPDATE
      `;
        if (!intent)
            return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
        if (intent.buyer_agent_id !== body.agentId && intent.seller_agent_id !== body.agentId) {
            return reply.code(403).send({ error: "Only buyer or seller may cancel", code: "AUTH_FORBIDDEN" });
        }
        if (intent.status !== "streaming") {
            return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
        }
        const [updated] = await sql `
        UPDATE intents SET status='stream_cancelled', updated_at = now() WHERE id = ${id} RETURNING *
      `;
        await audit(sql, body.agentId, "intent.cancel_stream", "intent", id, idempotencyKey(request.headers), {});
        return reply.code(200).send(updated);
    });
    // POST /api/agents/me/encryption-pubkey — pubkey registration.
    app.post("/api/agents/me/encryption-pubkey", { preHandler: app.authenticate }, async (request, reply) => {
        const body = z.object({
            challengeNonce: z.string().regex(/^[0-9a-fA-F]{32}$/),
            signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
            pubkey: z.string().regex(/^0x04[0-9a-fA-F]{128}$/, "Expected 65-byte uncompressed pubkey 0x04..."),
        }).parse(request.body);
        const requester = getRequesterAgentId(request, reply);
        if (!requester)
            return;
        // Find the most recent challenge for this agent within TTL.
        const [challenge] = await sql `
        SELECT payload_json FROM audit_log
        WHERE actor_agent_id = ${requester}
          AND action = 'encryption_pubkey.challenge'
          AND idempotency_key = ${`intent-bootstrap:${body.challengeNonce}`}
        ORDER BY created_at DESC
        LIMIT 1
      `;
        if (!challenge) {
            return reply.code(400).send({ code: "challenge_expired_or_unknown" });
        }
        if (new Date(challenge.payload_json.expiresAt) < new Date()) {
            return reply.code(400).send({ code: "challenge_expired_or_unknown" });
        }
        // NOTE: v2.0 trusts the client-supplied pubkey + signature pair. Signature
        // verification (`@noble/secp256k1`) + `derived_address ==
        // agent.wallet_address` assertion lands in a Phase E follow-up commit
        // because adding the dependency requires a workspace package install
        // step Adam should approve. The audit log row records the inbound
        // signature so the verification can be backfilled retroactively.
        const pubkeyBuf = hexToBuffer(body.pubkey);
        const [updated] = await sql `
        UPDATE agents
        SET encryption_pubkey = ${pubkeyBuf},
            encryption_pubkey_registered_at = now()
        WHERE id = ${requester}
        RETURNING id, encryption_pubkey
      `;
        await audit(sql, requester, "encryption_pubkey.register", "agent", requester, `pubkey-register:${body.challengeNonce}`, { signature: body.signature });
        return reply.code(200).send({
            agentId: updated.id,
            encryptionPubkey: body.pubkey,
        });
    });
}
