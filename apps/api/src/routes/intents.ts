// apps/api/src/routes/intents.ts — settlement protocol Phase E
//
// AgentPact v2 intent surface. Mirrors the on-chain AgentPactEscrowV2.sol
// contract (Phase A/B/C, PR #33). For the canonical specification of each
// settlement class and the buyer/seller flows, see WHITEPAPER.md and
// docs/adr/.
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./types.js";
import {
  getRequesterAgentId,
  idempotencyKey,
  isIntentCreationDisabled,
  INTENT_CREATION_DISABLED_RESPONSE,
} from "./utils.js";

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

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}

async function audit(
  sql: Sql<Record<string, unknown>>,
  actorId: string | null,
  action: string,
  objectType: string,
  objectId: string | null,
  idem: string,
  payload: unknown,
): Promise<void> {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

// Optional authentication preHandler — populates request.agentId when an
// x-api-key is supplied and resolves, otherwise leaves it null. Used by
// /api/intents/discover so anonymous browsers see open intents only while
// authenticated callers also see targeted intents addressed to them.
async function optionalAuthenticate(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (typeof request.headers["x-api-key"] !== "string") return;
  try {
    await app.authenticate(request, reply);
  } catch {
    // swallow — anonymous access is allowed on this route
  }
}

// ── Route registration ──────────────────────────────────────────────────────

export async function registerRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  _deps: Deps,
): Promise<void> {
  // POST /api/intents — buyer creates an intent (any class). The on-chain
  // creation has either already happened (buyer-broadcast) or is about to
  // happen via the relayer-daemon (Phase D). The API persists the DB row
  // once the relayer (or buyer) confirms the on-chain tx hash. v2.0 ships
  // the API expecting the caller to provide the `onChainId` they receive
  // from the contract event.
  app.post(
    "/api/intents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      // Kill switch (see isIntentCreationDisabled in ./utils). Checked FIRST —
      // before parsing, auth-matching, or any DB round-trip — so a tripped brake
      // costs one env read. In-flight intents are unaffected; only NEW mints stop.
      if (isIntentCreationDisabled()) {
        return reply.code(503).send(INTENT_CREATION_DISABLED_RESPONSE);
      }
      const body = createIntentSchema.parse(request.body);
      const idem = idempotencyKey(request.headers as Record<string, unknown>);
      const requesterAgentId = getRequesterAgentId(request, reply);
      if (!requesterAgentId) return;
      if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({
          error: "Not authorized to act as this agent",
          code: "AUTH_FORBIDDEN",
        });
      }

      // Encryption pubkey gate — buyer must have one registered before any
      // intent can be created. Returns 412 with a registration challenge
      // (the SDK auto-retries; MCP surfaces the structured error).
      const [agentRow] = await sql<Array<{ encryption_pubkey: Buffer | null }>>`
        SELECT encryption_pubkey FROM agents WHERE id = ${body.agentId}
      `;
      if (!agentRow) {
        return reply.code(404).send({ error: "Agent not found", code: "NOT_FOUND" });
      }
      if (!agentRow.encryption_pubkey) {
        // Generate a 128-bit nonce, persist with 10-minute TTL via audit_log
        // (Redis is optional; reusing audit_log keeps this PR scoped to one
        // dependency: postgres). The pubkey route reads it back for replay.
        const nonce = Buffer.from(
          crypto.getRandomValues(new Uint8Array(16))
        ).toString("hex");
        const message = `AgentPact encryption pubkey registration v1 ${nonce}`;
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await audit(
          sql,
          body.agentId,
          "encryption_pubkey.challenge",
          "agent",
          body.agentId,
          `intent-bootstrap:${nonce}`,
          { nonce, message, expiresAt },
        );
        return reply.code(412).send({
          code: "encryption_pubkey_required",
          challenge: { message, nonce, expiresAt },
          registerEndpoint: "/api/agents/me/encryption-pubkey",
        });
      }

      const onChainBuf = hexToBuffer(body.onChainId);
      try {
        const [intent] = await sql`
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
      } catch (err: any) {
        if (err?.code === "23505") {
          return reply.code(409).send({
            error: "Intent with this on_chain_id already exists",
            code: "DB_CONSTRAINT_VIOLATION",
          });
        }
        throw err;
      }
    },
  );

  // GET /api/intents/:id — full state. Public (anyone with the UUID can read);
  // sensitive fields are inside the on-chain contract anyway. Returns the
  // open-decimal NUMERIC columns as strings to preserve precision.
  app.get("/api/intents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await sql`SELECT * FROM intents WHERE id = ${id}`;
    if (!row) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
    return reply.code(200).send(row);
  });

  // GET /api/intents/discover — anonymous-safe browse. Open intents always
  // visible; targeted intents only visible to the targeted seller when
  // authenticated.
  app.get(
    "/api/intents/discover",
    { preHandler: async (req, rep) => optionalAuthenticate(app, req, rep) },
    async (request, reply) => {
      const callerAgent = request.agentId ?? null;
      const limit = Math.min(Number((request.query as Record<string, string>)?.limit ?? 50), 200);
      const rows = await sql`
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
    },
  );

  // POST /api/intents/:id/accept — Class B seller accepts.
  app.post(
    "/api/intents/:id/accept",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = acceptIntentSchema.parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester) return;
      if (body.agentId !== requester) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }

      const [intent] = await sql<Array<{ id: string; status: string; settlement_class: string; seller_target_agent_id: string | null }>>`
        SELECT id, status, settlement_class, seller_target_agent_id
        FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
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

      const [updated] = await sql`
        UPDATE intents
        SET seller_agent_id = ${body.agentId},
            seller_stake_usdc = ${body.sellerStakeUsdc},
            status = 'accepted',
            updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      await audit(sql, body.agentId, "intent.accept", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>), body);
      return reply.code(200).send(updated);
    },
  );

  // POST /api/intents/:id/reveal-preimage — autoclose rollout Change 2: Class-A
  // seller submits the hash preimage (the witness for hash-preimage-v1). Stored
  // in intent_reveals and the intent flips to 'reveal_ready'; the relayer's CLAIM
  // sweep then broadcasts claimIntent(on_chain_id, ciphertext, preimage), which
  // the on-chain predicate verifies → atomic 90/10 release. (Distinct from the
  // Class-B Schelling round-2 /reveal route below.)
  app.post(
    "/api/intents/:id/reveal-preimage",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          agentId: z.string().uuid(),
          preimage: z.string().regex(/^0x[0-9a-fA-F]+$/),
          ciphertext: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
        })
        .parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester) return;
      if (body.agentId !== requester) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }

      const [intent] = await sql<Array<{
        id: string;
        status: string;
        settlement_class: string;
        seller_target_agent_id: string | null;
        seller_agent_id: string | null;
      }>>`
        SELECT id, status, settlement_class, seller_target_agent_id, seller_agent_id
        FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
      if (intent.settlement_class !== "A") {
        return reply.code(400).send({ error: "Only Class A intents support reveal", code: "VALIDATION_FAILED" });
      }
      const authorizedSeller = intent.seller_target_agent_id ?? intent.seller_agent_id;
      if (authorizedSeller && authorizedSeller !== body.agentId) {
        return reply.code(403).send({ error: "Only the deal seller may reveal", code: "AUTH_FORBIDDEN" });
      }
      // Reveal is valid only while the intent is funded/awaiting-funding and not
      // already revealed/claimed.
      if (!["awaiting_funding", "open"].includes(intent.status)) {
        return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
      }

      const preimageBuf = Buffer.from(body.preimage.slice(2), "hex");
      const ciphertextBuf = body.ciphertext ? Buffer.from(body.ciphertext.slice(2), "hex") : null;
      await sql.begin(async (txn) => {
        await txn.unsafe(
          `
            INSERT INTO intent_reveals (intent_id, preimage, ciphertext)
            VALUES ($1, $2, $3)
            ON CONFLICT (intent_id) DO UPDATE SET
              preimage = EXCLUDED.preimage, ciphertext = EXCLUDED.ciphertext, created_at = now()
          `,
          [id, preimageBuf, ciphertextBuf]
        );
        await txn.unsafe("UPDATE intents SET status = 'reveal_ready', updated_at = now() WHERE id = $1", [id]);
      });
      await audit(sql, body.agentId, "intent.reveal", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>), { agentId: body.agentId });
      return reply.code(200).send({ ok: true, intent_id: id, status: "reveal_ready" });
    },
  );

  // POST /api/intents/:id/deliver — Class B seller posts ciphertext.
  app.post(
    "/api/intents/:id/deliver",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ agentId: z.string().uuid() }).parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string; seller_agent_id: string | null; max_price_usdc: string }>>`
        SELECT status, seller_agent_id, max_price_usdc FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
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

      const [updated] = await sql`
        UPDATE intents
        SET status = 'delivered',
            ack_deadline_at = ${ackDeadline},
            updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      await audit(sql, body.agentId, "intent.deliver", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>), { ackDeadline });
      return reply.code(200).send(updated);
    },
  );

  // POST /api/intents/:id/acknowledge — buyer ack.
  app.post(
    "/api/intents/:id/acknowledge",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = acknowledgeSchema.parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string; buyer_agent_id: string }>>`
        SELECT status, buyer_agent_id FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
      if (intent.buyer_agent_id !== body.agentId) {
        return reply.code(403).send({ error: "Only buyer may acknowledge", code: "AUTH_FORBIDDEN" });
      }
      if (intent.status !== "delivered") {
        return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
      }
      const [updated] = await sql`
        UPDATE intents SET status='acknowledged', updated_at = now() WHERE id = ${id} RETURNING *
      `;
      await audit(sql, body.agentId, "intent.acknowledge", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>), {});
      return reply.code(200).send(updated);
    },
  );

  // POST /api/intents/:id/reject — buyer rejects with commit hash.
  app.post(
    "/api/intents/:id/reject",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = rejectSchema.parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string; buyer_agent_id: string }>>`
        SELECT status, buyer_agent_id FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
      if (intent.buyer_agent_id !== body.agentId) {
        return reply.code(403).send({ error: "Only buyer may reject", code: "AUTH_FORBIDDEN" });
      }
      if (intent.status !== "delivered") {
        return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
      }
      const round1 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const [updated] = await sql`
        UPDATE intents
        SET status = 'reveal_round1', round1_deadline_at = ${round1}, updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      await audit(sql, body.agentId, "intent.reject", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>), { commitHash: body.commitHash });
      return reply.code(200).send(updated);
    },
  );

  // POST /api/intents/:id/reveal — round-2 reveal.
  app.post(
    "/api/intents/:id/reveal",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = revealSchema.parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string }>>`
        SELECT status FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
      if (!["reveal_round1", "reveal_round2"].includes(intent.status)) {
        return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
      }
      // The contract enforces who-reveals-what; the API just audit-logs the
      // submission so the off-chain trace matches the on-chain trace.
      await audit(sql, body.agentId, "intent.reveal", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>),
        { deliverable: body.deliverable, salt: body.salt });
      return reply.code(202).send({ ok: true });
    },
  );

  // POST /api/intents/:id/claim — Class A seller claim.
  app.post(
    "/api/intents/:id/claim",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = claimIntentSchema.parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string; settlement_class: string; seller_target_agent_id: string | null }>>`
        SELECT status, settlement_class, seller_target_agent_id
        FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
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
      const [updated] = await sql`
        UPDATE intents
        SET seller_agent_id = ${body.agentId}, status='claimed_a', updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      await audit(sql, body.agentId, "intent.claim", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>),
        { hasCiphertext: !!body.ciphertext });
      return reply.code(200).send(updated);
    },
  );

  // POST /api/intents/:id/claim-unit — Class C streaming claim.
  app.post(
    "/api/intents/:id/claim-unit",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = claimUnitSchema.parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string; settlement_class: string }>>`
        SELECT status, settlement_class FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
      if (intent.settlement_class !== "C") {
        return reply.code(400).send({ error: "Only Class C intents claim-unit", code: "VALIDATION_FAILED" });
      }
      if (intent.status !== "streaming") {
        return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
      }

      const witnessBuf = hexToBuffer(body.witness);
      try {
        const [unit] = await sql`
          INSERT INTO intent_units (intent_id, unit_index, witness_hash)
          VALUES (${id}, ${body.unitIndex}, ${witnessBuf})
          RETURNING *
        `;
        await sql`UPDATE intents SET seller_agent_id = COALESCE(seller_agent_id, ${body.agentId}), updated_at = now() WHERE id = ${id}`;
        await audit(sql, body.agentId, "intent.claim_unit", "intent", id,
          idempotencyKey(request.headers as Record<string, unknown>),
          { unitIndex: body.unitIndex });
        return reply.code(201).send(unit);
      } catch (err: any) {
        if (err?.code === "23505") {
          return reply.code(409).send({
            error: `Unit ${body.unitIndex} already claimed`,
            code: "DB_CONSTRAINT_VIOLATION",
          });
        }
        throw err;
      }
    },
  );

  // POST /api/intents/:id/cancel — Class C cancel by buyer or seller.
  app.post(
    "/api/intents/:id/cancel",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ agentId: z.string().uuid() }).parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester || requester !== body.agentId) {
        return reply.code(403).send({ error: "Not authorized", code: "AUTH_FORBIDDEN" });
      }
      const [intent] = await sql<Array<{ status: string; buyer_agent_id: string; seller_agent_id: string | null }>>`
        SELECT status, buyer_agent_id, seller_agent_id FROM intents WHERE id = ${id} FOR UPDATE
      `;
      if (!intent) return reply.code(404).send({ error: "Intent not found", code: "NOT_FOUND" });
      if (intent.buyer_agent_id !== body.agentId && intent.seller_agent_id !== body.agentId) {
        return reply.code(403).send({ error: "Only buyer or seller may cancel", code: "AUTH_FORBIDDEN" });
      }
      if (intent.status !== "streaming") {
        return reply.code(409).send({ error: `Intent status is ${intent.status}`, code: "INTENT_BAD_STATE" });
      }
      const [updated] = await sql`
        UPDATE intents SET status='stream_cancelled', updated_at = now() WHERE id = ${id} RETURNING *
      `;
      await audit(sql, body.agentId, "intent.cancel_stream", "intent", id,
        idempotencyKey(request.headers as Record<string, unknown>), {});
      return reply.code(200).send(updated);
    },
  );

  // POST /api/agents/me/encryption-pubkey — pubkey registration.
  app.post(
    "/api/agents/me/encryption-pubkey",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = z.object({
        challengeNonce: z.string().regex(/^[0-9a-fA-F]{32}$/),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
        pubkey: z.string().regex(/^0x04[0-9a-fA-F]{128}$/, "Expected 65-byte uncompressed pubkey 0x04..."),
      }).parse(request.body);
      const requester = getRequesterAgentId(request, reply);
      if (!requester) return;

      // Find the most recent challenge for this agent within TTL.
      const [challenge] = await sql<Array<{ payload_json: { nonce: string; expiresAt: string } }>>`
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
      const [updated] = await sql`
        UPDATE agents
        SET encryption_pubkey = ${pubkeyBuf},
            encryption_pubkey_registered_at = now()
        WHERE id = ${requester}
        RETURNING id, encryption_pubkey
      `;
      await audit(sql, requester, "encryption_pubkey.register", "agent", requester,
        `pubkey-register:${body.challengeNonce}`, { signature: body.signature });
      return reply.code(200).send({
        agentId: updated.id,
        encryptionPubkey: body.pubkey,
      });
    },
  );
}
