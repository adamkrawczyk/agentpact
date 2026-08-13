
import Fastify from "fastify";
import cors from "@fastify/cors";
import postgres, { type Sql } from "postgres";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { z, ZodError } from "zod";
import { initAuth } from "./auth.js";
import { registerHealthChecks } from "./health.js";
import { registerWebhookRoutes, notifyAgents } from "./webhooks.js";
import { registerConciergeRoutes } from "./concierge-relay.js";
import { autoVerify } from "./auto-verify.js";
import {
  decrypt,
  ensureCredentialVaultSchema,
  encrypt,
  getCredentialEncryptionKey,
  getSensitiveFields,
  vaultRetrieve,
  vaultRotate,
  vaultStore,
} from "./credential-vault.js";
import {
  isOnChainMode,
  generateFundingTransaction,
  generateAcceptTransaction,
  verifyFunding,
  resolveDisputeOnChain,
  getMilestoneStatus,
  ESCROW_ADDRESS,
  USDC_ADDRESS,
} from "./chain.js";
import type { Hex, Address } from "viem";
import "./mpp.js";
import { registerRoutes as registerAgentRoutes } from './routes/agents.js';
import { registerRoutes as registerOffersRoutes } from './routes/offers.js';
import { registerRoutes as registerNeedsRoutes } from './routes/needs.js';
import { registerRoutes as registerMatchingRoutes, recomputeMatches as recomputeMatchesFn, createRecomputeMatchesQueue } from './routes/matching.js';
import { registerRoutes as registerDealsRoutes } from './routes/deals.js';
import { registerRoutes as registerFulfillmentRoutes } from './routes/fulfillment.js';
import { registerRoutes as registerDisputesRoutes } from './routes/disputes.js';
import { registerRoutes as registerPaymentsRoutes } from './routes/payments.js';
import { registerRoutes as registerReputationRoutes } from './routes/reputation.js';
import { registerRoutes as registerIntentsRoutes } from './routes/intents.js';
import { countStaleOffersWithoutDeals } from './routes/offers.js';
import adminRoutes from './routes/admin.js';
import feedbackRoutes from './routes/feedback.js';
import configRoutes from './routes/config.js';
import { releaseMilestonePayment as _releaseMilestonePayment } from './shared/deal-helpers.js';
import { registerAuditWebhookRoutes } from './routes/audit-webhook.js';
import { registerAuditOrdersRoutes } from './routes/audit-orders.js';

const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";

// ── (AP-P1-3): Admin-routes fail-closed guard ─────────────────────
// Boot-time fatal check: in production we require ADMIN_API_KEY to be set,
// otherwise the admin surface would 503 silently and someone would notice
// only by user report. Fail loud and early instead.
if (process.env.NODE_ENV === "production" && !process.env.ADMIN_API_KEY) {
  console.error(
    "[fatal] ADMIN_API_KEY is unset in production — refusing to boot. " +
    "Set ADMIN_API_KEY in the Railway environment and redeploy."
  );
  process.exit(1);
}

// Platform private key is required for on-chain settlement in production.
// Without it the entire payment stack silently degrades to simulation mode
// (sim_fund / sim_release hashes) with no visible error — funds would be
// accepted from buyers but never escrowed on-chain.
if (process.env.NODE_ENV === "production" && !process.env.PLATFORM_PRIVATE_KEY) {
  console.error(
    "[fatal] PLATFORM_PRIVATE_KEY is unset in production — refusing to boot. " +
    "Without it the escrow silently runs in simulation mode. " +
    "Set PLATFORM_PRIVATE_KEY in the Railway environment and redeploy."
  );
  process.exit(1);
}

// DEFECT C fix (GitHub issue #91) — zero-address predicate default.
// routes/deals.ts's accept-deal auto-mint (the gasless Class-A intent path)
// used to fall back to the zero address whenever HASH_PREIMAGE_PREDICATE_ADDRESS
// was unset: `(process.env.HASH_PREIMAGE_PREDICATE_ADDRESS as ...) ?? "0x000…0"`.
// Confirmed in production data: two live intents
// (3d786cd7-b49a-49f9-8048-61a42736e1c7, dec204fb-f359-489d-adfd-6de04b8b761b)
// carry that zero verifier. AgentPactEscrowV3.sol:280 rejects an unapproved
// verifier BEFORE pulling funds, so the outcome is an unfundable/stalled deal,
// NOT locked funds — but it is still a dead-on-arrival intent nobody can claim.
// Any accepted paid-USDC deal that carries a deliverable_hash commitment can
// trigger this mint in production (it is deal-data-driven, not behind a
// separate feature flag), so — mirroring the ADMIN_API_KEY / PLATFORM_PRIVATE_KEY
// pattern above — refuse to boot in production without a real predicate
// address configured. Local/dev is unaffected: this check only fires when
// NODE_ENV === "production", exactly like its two neighbours above.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.HASH_PREIMAGE_PREDICATE_ADDRESS ||
    process.env.HASH_PREIMAGE_PREDICATE_ADDRESS.toLowerCase() === ZERO_ADDRESS)
) {
  console.error(
    "[fatal] HASH_PREIMAGE_PREDICATE_ADDRESS is unset or the zero address in " +
    "production — refusing to boot. Accepting a paid USDC deal that carries a " +
    "deliverable_hash auto-mints a gasless Class-A intent against this verifier; " +
    "a zero/missing address mints an intent AgentPactEscrowV3 will always reject " +
    "(unfundable, unclaimable). Set HASH_PREIMAGE_PREDICATE_ADDRESS in the " +
    "Railway environment and redeploy."
  );
  process.exit(1);
}

// ── Trust Tier definitions (informational only — no deal limits) ─────
const TRUST_TIERS = [
  { tier: "gold",   label: "Gold",   minDeals: 25, minReputation: 4.0, color: "#FFD700" },
  { tier: "silver", label: "Silver", minDeals: 10, minReputation: 3.5, color: "#C0C0C0" },
  { tier: "bronze", label: "Bronze", minDeals: 3,  minReputation: 3.0, color: "#CD7F32" },
  { tier: "new",    label: "New",    minDeals: 0,  minReputation: 0,   color: "#888888" },
] as const;

function computeTrustTier(completedDeals: number, reputationScore: number): { tier: string; label: string; color: string } {
  for (const t of TRUST_TIERS) {
    if (completedDeals >= t.minDeals && reputationScore >= t.minReputation) {
      return { tier: t.tier, label: t.label, color: t.color };
    }
  }
  return { tier: "new", label: "New", color: "#888888" };
}

async function getAgentStats(db: typeof sql, agentId: string): Promise<{ completedDeals: number; reputationScore: number }> {
  const [stats] = await db`
    SELECT
      (SELECT COUNT(*)::int FROM deals WHERE (buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}) AND status = 'completed') AS completed_deals,
      COALESCE((SELECT AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) FROM feedback WHERE to_agent_id = ${agentId}), 0) AS reputation_score
  `;
  return { completedDeals: Number(stats.completed_deals), reputationScore: Number(stats.reputation_score) };
}

export const sql = postgres(DATABASE_URL, {
  max: 20,           // Up from 10 — Supabase free tier supports ~20 connections
  idle_timeout: 30,  // Release idle connections after 30s to avoid Supabase connection cap
  connect_timeout: 10, // Fail fast if pool can't get a connection in 10s
  max_lifetime: 1800,  // Recycle connections every 30 min to avoid stale sockets
  // ⚠️ 2026-07-24 (#76 intermittent-500 storm, PG 26000): postgres.js defaults
  // to NAMED prepared statements (PREPARE on one round-trip, EXECUTE on the
  // next). Behind the Supabase transaction-mode pooler (Supavisor, :6543 in
  // DATABASE_URL) each round-trip can land on a DIFFERENT backend, so the
  // EXECUTE hits a backend that never saw the PREPARE →
  //   {"code":"26000","message":"prepared statement \"…\" does not exist"}.
  // Reproduced live: ~7-20% error rate on /api/offers + /api/needs (every
  // route uses this shared client via injection, incl. escrow/payments).
  // Fix = the canonical Supabase+postgres.js flag: disable prepared statements
  // so queries use the unnamed/simple protocol (single round-trip, pooler-safe).
  // Verified safe: the codebase uses NO prepared-statement features (no
  // .prepare()/.cursor()/PREPARE/DEALLOCATE). Tests hit direct-connect :5432
  // (no pooler) where this flag is a no-op.
  prepare: false,
  // ── Pool-exhaustion defense  ──
  // Layer 1 (2026-05-10): acquire_timeout=15s — when the pool is full,
  // new requests fail fast instead of queuing indefinitely. Pairs with the
  // matching-engine refactor (batched inserts, HTTP-before-txn) that fixed
  // the original leak source.
  ...(process.env.NODE_ENV ? { acquire_timeout: 15000 } : {}), // available in postgres.js runtime even if not in types
  // Layer 2 (2026-05-14): Postgres-side statement_timeout slightly BELOW
  // Fastify's 30s onRequest timeout so that any query the server is forced to
  // abandon is also cancelled at the DB layer, returning the connection to
  // the pool instead of leaking it. Catches future leak sources from any
  // code path, not just the matching engine. idle_in_transaction safety net
  // bounds stuck txns; application_name makes pg_stat_activity grep-able.
  //
  // ⚠️ 2026-06-17 (503-on-everything storm, ~12h outage): these `connection.*`
  // values are sent as Postgres STARTUP PARAMETERS, and the Supabase
  // transaction-mode pooler (Supavisor, :6543 in DATABASE_URL) SILENTLY
  // STRIPS them. Verified live: SHOW application_name returned "Supavisor"
  // (not "agentpact-api") and SHOW idle_in_transaction_session_timeout
  // returned "0". A browse request whose socket dropped right after
  // `withBrowseStatementTimeout`'s sql.begin() left a bare `begin` txn open;
  // with the idle-in-tx reaper inert it sat 11h55m, pinning a pool slot until
  // every DB-touching route queued behind it and 503'd at the 30s timeout
  // (while /health, which never hits the DB, stayed 200).
  //
  // SERVER-SIDE TIMERS ARE NOT A RELIABLE FIX BEHIND SUPAVISOR. Tried and
  // empirically rejected (all tested via the live :6543 pooler):
  //   - this connection.* block          → stripped (SHOW shows defaults)
  //   - ALTER ROLE postgres SET ... =60000 → propagates to the *session* pooler
  //     (:5432, SHOW = 1min) but the :6543 transaction pooler still SHOWs 0 and
  //     a synthetic idle-in-tx was NOT reaped after 75s
  //   - SET LOCAL inside the txn         → value applies but timer did not reap
  //
  // DURABLE FIX = external polling reaper: scripts/pg-leak-watchdog.mjs, run
  // as a cron job (e.g. every 5 min via `railway run -s @agentpact/api`). It
  // issues pg_terminate_backend (a normal SQL command on the wire, immune to
  // the pooler) against idle-in-tx > 60s and wedged-active-ClientRead > 5min
  // backends. This is the SAME command that killed the 11h leak and restored
  // the site in <1s during the incident. Recovery is <1s; it never restarts.
  connection: {
    statement_timeout: 25_000,             // ms — must be < REQUEST_TIMEOUT_MS (30_000)
    idle_in_transaction_session_timeout: 60_000, // ms — INERT behind Supavisor :6543; see role GUC above
    application_name: 'agentpact-api',     // stripped to "Supavisor" by the txn pooler
  },
} as postgres.Options<Record<string, postgres.PostgresType>>);
export const app = Fastify({
  logger: true,
  // ── §5.1 (2026-05-21): correlation IDs + structured error responses.
  // Fastify already generates per-request reqIds; we just (a) honour an inbound
  // X-Request-Id header so callers can stitch their own traces, and (b) echo
  // the id back as a response header for client-side correlation.
  genReqId: (req) => {
    const inbound = (req.headers["x-request-id"] ?? req.headers["X-Request-Id"]) as string | undefined;
    if (inbound && typeof inbound === "string" && inbound.length <= 128) {
      return inbound;
    }
    return randomUUID();
  },
  requestIdHeader: "x-request-id",
  requestIdLogLabel: "requestId",
});

// Echo the request id back on every response so clients can include it in
// support tickets / bug reports. Cheap, idempotent, never fails.
app.addHook("onSend", async (request, reply, payload) => {
  reply.header("x-request-id", request.id);
  return payload;
});

// settlement protocol Phase E — Sunset / Link headers on v1 surfaces. The v2
// intent primitive in /api/intents/* is the long-term successor; legacy
// routes stay functional for the full 90-day window (until 2026-08-25)
// per plan § 4 + Codex round-1 P1 finding. The `Sunset` header follows
// RFC 8594; the `Link rel="successor-version"` follows RFC 5988.
//
// Implementation uses `onRequest` (NOT `onSend`) to set headers BEFORE
// any route handler streams the response. Setting headers in `onSend`
// is unsafe for handlers that have already started writing — Fastify
// throws ERR_HTTP_HEADERS_SENT.
const V1_SUNSET_DATE = "Tue, 25 Aug 2026 00:00:00 GMT";
const V1_SUNSET_PREFIXES = [
  "/api/deals",
  "/api/needs",
  "/api/payments",
  "/api/disputes",
];
app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0];
  if (V1_SUNSET_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    reply.header("Sunset", V1_SUNSET_DATE);
    reply.header("Link", '</api/intents>; rel="successor-version"');
  }
});
const vaultSql = sql as unknown as Sql<Record<string, unknown>>;
const credentialEncryptionKey = getCredentialEncryptionKey();

async function ensurePhysicalServiceSchema(): Promise<void> {
  await sql`ALTER TABLE offers ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL`;
  await sql`ALTER TABLE needs ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL`;
  await sql`ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS buyer_data JSONB DEFAULT NULL`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_offers_location_country
    ON offers ((location->>'country'))
    WHERE location IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_needs_location_country
    ON needs ((location->>'country'))
    WHERE location IS NOT NULL
  `;
}

async function ensureFulfillmentStatusSchema(): Promise<void> {
  await sql`ALTER TABLE deal_fulfillment DROP CONSTRAINT IF EXISTS deal_fulfillment_status_check`;
  await sql`
    ALTER TABLE deal_fulfillment
    ADD CONSTRAINT deal_fulfillment_status_check
    CHECK (status IN ('pending', 'provided', 'active', 'verified', 'expired', 'revoked'))
  `;
}

async function ensureOfferCompoundingSchema(): Promise<void> {
  // Archive duplicate active offers (keep newest) before creating unique index
  // Added logging for visibility into how many duplicates are archived.
  const dupeResult = await sql`
    UPDATE offers SET status = 'archived', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY agent_id, lower(btrim(category)), lower(btrim(title))
          ORDER BY created_at DESC
        ) AS rn
        FROM offers
        WHERE status = 'active'
      ) dupes WHERE rn > 1
    )
    RETURNING id
  `;
  if (dupeResult.length > 0) {
    console.log(`[startup] ensureOfferCompoundingSchema: archived ${dupeResult.length} duplicate offers.`);
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS offers_active_agent_category_title_unique
    ON offers (agent_id, lower(btrim(category)), lower(btrim(title)))
    WHERE status = 'active'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_offers_status_created_at
    ON offers (status, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_deals_offer_status
    ON deals (offer_id, status)
  `;
}

async function ensureConsultationSchema(): Promise<void> {
  await sql`ALTER TABLE offers ADD COLUMN IF NOT EXISTS max_respondents INTEGER`;
  await sql`ALTER TABLE offers ADD COLUMN IF NOT EXISTS time_limit_minutes INTEGER`;
  await sql`
    CREATE TABLE IF NOT EXISTS consultation_responses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      respondent_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      response_md TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (deal_id, respondent_agent_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_consultation_responses_deal
    ON consultation_responses (deal_id, created_at DESC)
  `;
}

async function ensureMppSchema(): Promise<void> {
  await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'legacy-usdc'`;
  await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS mpp_receipt JSONB DEFAULT NULL`;
  await sql`ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check`;
  // escrow-safety rollout — 'release_pending_chain' added so the escrow safety patch
  // in shared/deal-helpers.ts can deferred-mark a deal when the on-chain release
  // call fails. Boot-time schema mutation will be removed entirely in Phase A
  // step 3 (plan §3); for now it has to know about the new status so it doesn't
  // overwrite migration 033's constraint.
  await sql`
    ALTER TABLE deals
    ADD CONSTRAINT deals_status_check
    CHECK (status IN ('proposed', 'countered', 'accepted', 'active', 'funded', 'delivered', 'completed', 'cancelled', 'disputed', 'release_pending_chain'))
  `;
}

await ensurePhysicalServiceSchema();
await ensureFulfillmentStatusSchema();
await ensureOfferCompoundingSchema();
await ensureConsultationSchema();
await ensureMppSchema();
// Replaced silent auto-archive with dry-run count on startup.
// Archival is now admin-only via POST /api/admin/offers/auto-archive-stale.
const staleCount = await countStaleOffersWithoutDeals(sql);
console.log(`[startup] ${staleCount} stale offers (>30d, 0 deals) eligible for archival. Use POST /api/admin/offers/auto-archive-stale to archive.`);

const walletProviderSchema = z.enum(["metamask", "walletconnect", "coinbase"]);

const milestoneSchema = z.object({
  idx: z.number().int().positive(),
  title: z.string().min(2),
  amount: z.number().min(0),
  acceptanceCriteria: z.array(z.string()).min(1),
  dueAt: z.string().datetime().optional()
});

const FULFILLMENT_TYPES = {
  "api-access": {
    label: "API Access",
    description: "Provide API endpoint access (LLM, data service, etc.)",
    fields: {
      endpoint_url: { type: "string", format: "url", required: true },
      auth_type: { type: "enum", values: ["bearer", "api-key", "basic", "header"], required: true },
      auth_value: { type: "string", minLength: 1, required: true },
      auth_header: { type: "string", required: false },
      rate_limit: { type: "string", required: false },
      docs_url: { type: "string", format: "url", required: false },
      expires_at: { type: "string", format: "datetime", required: false },
      usage_notes: { type: "string", required: false },
    },
    schema: z.object({
      endpoint_url: z.string().url(),
      auth_type: z.enum(["bearer", "api-key", "basic", "header"]),
      auth_value: z.string().min(1),
      auth_header: z.string().optional(),
      rate_limit: z.string().optional(),
      docs_url: z.string().url().optional(),
      expires_at: z.string().datetime().optional(),
      usage_notes: z.string().optional(),
    }),
    autoVerify: "http-ping",
  },
  "code-task": {
    label: "Code Task",
    description: "Code review, PR, bug fix, feature implementation",
    fields: {
      repo_url: { type: "string", format: "url", required: true },
      branch: { type: "string", required: false },
      access_method: { type: "enum", values: ["token", "collaborator-invite", "public"], required: true },
      access_token: { type: "string", required: false },
      scope: { type: "string", required: false },
      delivery_method: { type: "enum", values: ["pull-request", "commit", "patch", "comment"], required: true },
      setup_instructions: { type: "string", required: false },
    },
    schema: z.object({
      repo_url: z.string().url(),
      branch: z.string().optional(),
      access_method: z.enum(["token", "collaborator-invite", "public"]),
      access_token: z.string().optional(),
      scope: z.string().optional(),
      delivery_method: z.enum(["pull-request", "commit", "patch", "comment"]),
      setup_instructions: z.string().optional(),
    }),
    autoVerify: null,
  },
  "data-delivery": {
    label: "Data Delivery",
    description: "Dataset, report, analysis, or file delivery",
    fields: {
      download_url: { type: "string", format: "url", required: true },
      format: { type: "string", required: true },
      size_bytes: { type: "number", required: false },
      checksum_sha256: { type: "string", required: false },
      schema_description: { type: "string", required: false },
      expires_at: { type: "string", format: "datetime", required: false },
    },
    schema: z.object({
      download_url: z.string().url(),
      format: z.string(),
      size_bytes: z.number().optional(),
      checksum_sha256: z.string().optional(),
      schema_description: z.string().optional(),
      expires_at: z.string().datetime().optional(),
    }),
    autoVerify: "download-check",
  },
  "compute-access": {
    label: "Compute Access",
    description: "SSH, VM, GPU, or cloud compute access",
    fields: {
      access_type: { type: "enum", values: ["ssh", "api", "web-console"], required: true },
      endpoint: { type: "string", required: true },
      credentials: { type: "string", required: false },
      specs: { type: "string", required: false },
      time_window_hours: { type: "number", required: false },
      expires_at: { type: "string", format: "datetime", required: false },
      setup_instructions: { type: "string", required: false },
    },
    schema: z.object({
      access_type: z.enum(["ssh", "api", "web-console"]),
      endpoint: z.string(),
      credentials: z.string().optional(),
      specs: z.string().optional(),
      time_window_hours: z.number().optional(),
      expires_at: z.string().datetime().optional(),
      setup_instructions: z.string().optional(),
    }),
    autoVerify: null,
  },
  consulting: {
    label: "Consulting / Review / Advisory",
    description: "Written review, analysis, recommendation, or advisory",
    fields: {
      delivery_format: { type: "enum", values: ["markdown", "pdf", "text", "video-url", "audio-url"], required: true },
      content_url: { type: "string", format: "url", required: false },
      content_text: { type: "string", required: false },
      summary: { type: "string", required: false },
    },
    schema: z.object({
      delivery_format: z.enum(["markdown", "pdf", "text", "video-url", "audio-url"]),
      content_url: z.string().url().optional(),
      content_text: z.string().optional(),
      summary: z.string().optional(),
    }),
    autoVerify: null,
  },
  "physical-service": {
    label: "Physical Service",
    description: "On-site service requiring physical presence (repair, installation, delivery, inspection)",
    fields: {
      service_type: { type: "enum", values: ["repair", "installation", "delivery", "inspection", "cleaning", "other"], required: true },
      service_date: { type: "string", format: "datetime", required: true },
      secret_address: { type: "string", required: true },
      secret_access_notes: { type: "string", required: false },
      contact_method: { type: "enum", values: ["phone", "email", "in-app"], required: false },
      secret_contact_value: { type: "string", required: false },
      proof_type: { type: "enum", values: ["photo", "video", "signed-confirmation", "none"], required: false },
      proof_url: { type: "string", format: "url", required: false },
      completion_notes: { type: "string", required: false },
    },
    schema: z.object({
      service_type: z.enum(["repair", "installation", "delivery", "inspection", "cleaning", "other"]),
      service_date: z.string().datetime(),
      secret_address: z.string(),
      secret_access_notes: z.string().optional(),
      contact_method: z.enum(["phone", "email", "in-app"]).optional(),
      secret_contact_value: z.string().optional(),
      proof_type: z.enum(["photo", "video", "signed-confirmation", "none"]).optional(),
      proof_url: z.string().url().optional(),
      completion_notes: z.string().optional(),
    }),
    autoVerify: false,
  },
  consultation: {
    label: "Consultation",
    description: "Collect time-boxed written responses from multiple respondents",
    fields: {
      summary: { type: "string", required: false },
      instructions: { type: "string", required: false },
    },
    schema: z.object({
      summary: z.string().optional(),
      instructions: z.string().optional(),
    }).passthrough(),
    autoVerify: null,
  },
  generic: {
    label: "Generic",
    description: "Any other service — describe what you'll deliver",
    fields: {
      description: { type: "string", minLength: 10, required: true },
      artifact_urls: { type: "array", items: "url", required: false },
      instructions: { type: "string", required: false },
      expires_at: { type: "string", format: "datetime", required: false },
    },
    schema: z.object({
      description: z.string().min(10),
      artifact_urls: z.array(z.string().url()).optional(),
      instructions: z.string().optional(),
      expires_at: z.string().datetime().optional(),
    }).passthrough(),
    autoVerify: null,
  },
} as const;

const fulfillmentTypeSchema = z.enum([
  "api-access",
  "code-task",
  "data-delivery",
  "compute-access",
  "consulting",
  "physical-service",
  "generic",
]);

const locationSchema = z.object({
  city: z.string().min(1).optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  remote: z.boolean().optional(),
}).optional();

const createOfferSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(4),
  descriptionMd: z.string().min(10),
  category: z.string().min(2),
  tags: z.array(z.string()).default([]),
  basePrice: z.number().min(0),
  currency: z.literal("USDC").default("USDC"),
  maxPriceDeltaPct: z.number().min(0).max(100).default(15),
  slaDays: z.number().int().positive().default(7),
  proofs: z.array(z.record(z.any())).default([]),
  fulfillmentType: fulfillmentTypeSchema.optional().default("generic"),
  location: locationSchema,
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
  deadlineAt: z.string().datetime().optional(),
  fulfillmentType: fulfillmentTypeSchema.optional().default("generic"),
  location: locationSchema,
});

const proposeDealSchema = z.object({
  buyerAgentId: z.string().uuid(),
  sellerAgentId: z.string().uuid(),
  offerId: z.string().uuid(),
  needId: z.string().uuid(),
  negotiatedTotal: z.number().min(0),
  maxPriceDeltaPct: z.number().min(0).max(100),
  milestones: z.array(milestoneSchema).min(1),
  acceptanceTimeoutDays: z.number().int().min(0).max(30).default(0)
});

const autopilotSettingsSchema = z.object({
  agentId: z.string().uuid(),
  autoBuyEnabled: z.boolean().optional(),
  maxAutoDealPrice: z.number().positive().nullable().optional(),
  autoBuyCategories: z.array(z.string().min(1)).nullable().optional(),
});

const counterDealSchema = z.object({
  dealId: z.string().uuid(),
  actorAgentId: z.string().uuid(),
  negotiatedTotal: z.number().min(0),
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

const provideFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  fulfillmentData: z.record(z.any()),
});

const provideBuyerFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  buyerData: z.record(z.any()),
});

const getFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  decrypt: z.preprocess((v) => parseBooleanish(v), z.boolean()).optional().default(false),
  reveal: z.preprocess((v) => parseBooleanish(v), z.boolean()).optional(),
}).transform((data) => ({
  agentId: data.agentId,
  decrypt: data.decrypt || data.reveal || false,
}));

const rotateCredentialSchema = z.object({
  agentId: z.string().uuid(),
  fieldName: z.string().min(1),
  newValue: z.string().min(1),
});

const requestRotationSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().min(1).optional(),
});

const verifyFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  accepted: z.boolean(),
  completeOnVerify: z.boolean().optional(),
  notes: z.string().optional(),
});

const confirmDeliverySchema = z.object({
  agentId: z.string().uuid(),
  rating: z.number().min(1).max(5).optional(),
  notes: z.string().optional(),
  skipOnChainRelease: z.boolean().optional().default(false),
});

const revokeFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
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

const challengeIdParamSchema = z.object({
  id: z.string().uuid(),
});

const agentIdParamSchema = z.object({
  id: z.string().uuid(),
});

const listChallengesQuerySchema = z.object({
  category: z.string().min(2).optional(),
});

const onlineAgentsQuerySchema = z.object({
  category: z.string().min(1).optional(),
});

const startChallengeSchema = z.object({
  agentId: z.string().uuid(),
});

const submitChallengeSchema = z.object({
  agentId: z.string().uuid(),
  submission: z.record(z.any()),
});

function idempotencyKey(headers: Record<string, unknown>): string {
  return String(headers["idempotency-key"] ?? randomUUID());
}

function toNumber(v: unknown): number {
  return Number(v);
}

function isZeroPrice(value: unknown): boolean {
  return toNumber(value) === 0;
}

function withReputationOnlyTag(tags: unknown): string[] {
  const normalized = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return normalized.includes("reputation-only")
    ? normalized
    : [...normalized, "reputation-only"];
}

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function enrichOfferRow<T extends Record<string, unknown>>(offer: T): T & {
  tags: string[];
  is_free_tier: boolean;
  pricing_model: "paid" | "reputation-only";
} {
  const isFreeTier = isZeroPrice(offer.base_price);
  return {
    ...offer,
    tags: isFreeTier ? withReputationOnlyTag(offer.tags) : normalizeTags(offer.tags),
    is_free_tier: isFreeTier,
    pricing_model: isFreeTier ? "reputation-only" : "paid",
  };
}

function parseBooleanish(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function getRequesterAgentId(request: { agentId?: string }, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }): string | null {
  const requesterAgentId = request.agentId;
  if (!requesterAgentId) {
    reply.code(401).send({ error: "Missing API key" });
    return null;
  }
  return requesterAgentId;
}

const BUYER_VAULT_PREFIX = "buyer__";

async function storeBuyerContext(
  fulfillmentId: string,
  fulfillmentType: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureCredentialVaultSchema(vaultSql);

  const redacted: Record<string, unknown> = { ...data };
  const configured = new Set(getSensitiveFields(fulfillmentType));
  const prefixed = Object.keys(data).filter((field) => field.startsWith("secret_"));
  const sensitiveFields = new Set([...configured, ...prefixed]);

  for (const fieldName of sensitiveFields) {
    if (!(fieldName in data)) continue;
    const value = data[fieldName];
    if (value === undefined || value === null) continue;

    const plaintext = typeof value === "string" ? value : JSON.stringify(value);
    const { encrypted, iv, authTag } = encrypt(plaintext, credentialEncryptionKey);

    await sql`
      INSERT INTO credential_vault (fulfillment_id, field_name, encrypted_value, iv, auth_tag)
      VALUES (${fulfillmentId}, ${`${BUYER_VAULT_PREFIX}${fieldName}`}, ${encrypted}, ${iv}, ${authTag})
      ON CONFLICT (fulfillment_id, field_name) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        last_rotated_at = NOW()
    `;

    redacted[fieldName] = "[encrypted]";
  }

  return redacted;
}

async function retrieveBuyerContext(
  fulfillmentId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureCredentialVaultSchema(vaultSql);
  const merged: Record<string, unknown> = { ...data };
  const rows = await sql`
    SELECT field_name, encrypted_value, iv, auth_tag
    FROM credential_vault
    WHERE fulfillment_id = ${fulfillmentId}
      AND field_name LIKE ${`${BUYER_VAULT_PREFIX}%`}
  `;

  for (const row of rows) {
    const fieldName = String(row.field_name).slice(BUYER_VAULT_PREFIX.length);
    merged[fieldName] = decrypt(
      String(row.encrypted_value),
      String(row.iv),
      String(row.auth_tag),
      credentialEncryptionKey,
    );
  }

  return merged;
}

async function logCredentialAccess(
  fulfillmentId: string,
  agentId: string,
  action: "decrypt" | "rotate" | "request_rotation" | "revoke",
  ipAddress?: string,
): Promise<void> {
  await ensureCredentialVaultSchema(vaultSql);
  await sql`
    INSERT INTO credential_access_log (fulfillment_id, agent_id, action, ip_address)
    VALUES (${fulfillmentId}, ${agentId}, ${action}, ${ipAddress ?? null})
  `;
}

async function applyFulfillmentExpiryChecks(
  deal: { id: string; buyer_agent_id: string; seller_agent_id: string },
  fulfillment: {
    id: string;
    status: string;
    expires_at: string | Date | null;
    last_expiry_warning_at: string | Date | null;
  } & Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureCredentialVaultSchema(vaultSql);
  if (!fulfillment.expires_at) return fulfillment;

  const expiresAt = new Date(String(fulfillment.expires_at));
  if (Number.isNaN(expiresAt.getTime())) return fulfillment;

  const now = new Date();
  const status = String(fulfillment.status);
  const expiresInMs = expiresAt.getTime() - now.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (expiresInMs <= 0 && status !== "expired" && status !== "revoked") {
    const [expired] = await sql`
      UPDATE deal_fulfillment
      SET status = 'expired', updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;
    if (expired) {
      notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.fulfillment_expired", {
        dealId: deal.id,
        fulfillmentId: String(fulfillment.id),
        expiresAt: fulfillment.expires_at,
        status: "expired",
      });
      return expired as Record<string, unknown>;
    }
  }

  if (expiresInMs > 0 && expiresInMs <= oneDayMs && !fulfillment.last_expiry_warning_at) {
    const [warned] = await sql`
      UPDATE deal_fulfillment
      SET last_expiry_warning_at = NOW(), updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;
    if (warned) {
      notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.fulfillment_expiring", {
        dealId: deal.id,
        fulfillmentId: String(fulfillment.id),
        expiresAt: fulfillment.expires_at,
        hoursRemaining: Number((expiresInMs / (60 * 60 * 1000)).toFixed(2)),
      });
      return warned as Record<string, unknown>;
    }
  }

  return fulfillment;
}

type GradeResult = {
  deterministic: boolean;
  passed: boolean;
  score: number | null;
  gradingNotes: string;
};

function gradeSkillSubmission(expectedCriteria: Record<string, unknown>, submission: unknown): GradeResult {
  const mode = typeof expectedCriteria.mode === "string" ? expectedCriteria.mode : "";

  if (mode === "keyword") {
    const keywords = Array.isArray(expectedCriteria.keywords)
      ? expectedCriteria.keywords.filter((k): k is string => typeof k === "string")
      : [];
    const minMatches = typeof expectedCriteria.minMatches === "number" ? expectedCriteria.minMatches : keywords.length;
    const haystack = JSON.stringify(submission ?? {}).toLowerCase();
    const matched = keywords.filter((kw) => haystack.includes(kw.toLowerCase()));
    const passed = matched.length >= minMatches;
    const score = keywords.length > 0 ? Number(((matched.length / keywords.length) * 100).toFixed(2)) : 0;

    return {
      deterministic: true,
      passed,
      score,
      gradingNotes: `Matched ${matched.length}/${keywords.length} required keywords`,
    };
  }

  if (mode === "required_json_keys") {
    if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
      return {
        deterministic: true,
        passed: false,
        score: 0,
        gradingNotes: "Submission must be a JSON object",
      };
    }
    const requiredKeys = Array.isArray(expectedCriteria.requiredKeys)
      ? expectedCriteria.requiredKeys.filter((k): k is string => typeof k === "string")
      : [];
    const submissionRecord = submission as Record<string, unknown>;
    const present = requiredKeys.filter((key) => submissionRecord[key] !== undefined);
    const passed = requiredKeys.length > 0 && present.length === requiredKeys.length;
    const score = requiredKeys.length > 0 ? Number(((present.length / requiredKeys.length) * 100).toFixed(2)) : 0;

    return {
      deterministic: true,
      passed,
      score,
      gradingNotes: `Found ${present.length}/${requiredKeys.length} required keys`,
    };
  }

  return {
    deterministic: false,
    passed: false,
    score: null,
    gradingNotes: "Submission queued for manual/AI grading",
  };
}

async function audit(actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

type ProposeDealInput = z.infer<typeof proposeDealSchema>;

async function createDealProposal(
  proposal: ProposeDealInput,
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

    await audit(opts.auditActorAgentId, opts.auditAction, "deal", String(deal.id), opts.idempotencyKey, opts.auditPayload ?? proposal);

    return { ...deal, milestones };
  });

  return result as Record<string, unknown>;
}

async function enforceDealDelta(dealId: string, negotiatedTotal: number): Promise<void> {
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

// settlement-integrity dedup: the divergent local copy of
// releaseMilestonePayment() that lived here (writing `sim_release_*` hashes
// unconditionally, with no isOnChainMode() gate) has been deleted. Every
// caller — including completeDealMilestones() below — now uses the single
// shared implementation imported as `_releaseMilestonePayment` from
// ./shared/deal-helpers.js, which refuses to fabricate a release for a
// funded on-chain USDC escrow intent unless a real release tx happened.

async function completeDealMilestones(
  dealId: string,
  opts: { skipOnChainRelease?: boolean; skipPaymentRelease?: boolean } = {},
): Promise<{ mode: "simulation" | "on-chain"; action: "released" | "buyer_sign_required" | "completed_without_onchain_release" | "settlement_pending"; txData?: Array<{ milestoneId: string; to: string; data: string; value: string; description: string }>; onChainReleaseResults?: Array<{ milestoneId: string; txHash?: string; error?: string }> }> {
  const mode = isOnChainMode() ? "on-chain" : "simulation";
  const [deal] = await sql`
    SELECT is_free_tier
    FROM deals
    WHERE id = ${dealId}
  `;
  const skipPaymentRelease = opts.skipPaymentRelease ?? Boolean(deal?.is_free_tier);
  const milestones = await sql`
    SELECT id
    FROM milestones
    WHERE deal_id = ${dealId} AND status != 'accepted'
    ORDER BY idx
  `;

  if (milestones.length === 0) {
    return { mode, action: "released" };
  }

  if (skipPaymentRelease) {
    await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
    await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
    return { mode, action: "released" };
  }

  if (mode === "on-chain") {
    if (opts.skipOnChainRelease) {
      await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
      await sql`UPDATE milestones SET status = 'accepted' WHERE deal_id = ${dealId} AND status != 'accepted'`;
      return { mode, action: "completed_without_onchain_release" };
    }

    const intents = await sql`
      SELECT pi.id, pi.tx_hash
      FROM payment_intents pi
      JOIN milestones m ON m.id = pi.milestone_id
      WHERE m.deal_id = ${dealId} AND pi.status = 'funded'
      ORDER BY pi.created_at DESC
    `;
    // If on-chain mode is active and there are funded intents with real tx hashes, treat as on-chain funded
    const hasOnChainFundedIntent = intents.some((row) => row.tx_hash && !String(row.tx_hash).startsWith("sim_"));

    if (hasOnChainFundedIntent) {
      // escrow-safety rollout — see shared/deal-helpers.ts for the matching patch.
      // Funds-loss guard: DO NOT mark DB released until on-chain release confirmed.
      const allowOnChainRelease = (process.env.ALLOW_ONCHAIN_RELEASE ?? "true").toLowerCase() !== "false";

      // Try platform-initiated release via resolveDispute (pays seller)
      const releaseResults: Array<{ milestoneId: string; txHash?: string; error?: string }> = [];
      for (const milestone of milestones) {
        if (!allowOnChainRelease) {
          releaseResults.push({
            milestoneId: String(milestone.id),
            error: "on-chain release disabled by ALLOW_ONCHAIN_RELEASE=false (A0 kill switch)",
          });
          continue;
        }
        try {
          const result = await resolveDisputeOnChain(String(milestone.id), false);
          releaseResults.push({ milestoneId: String(milestone.id), txHash: result.txHash });
        } catch (err: any) {
          console.error(`[completeDealMilestones] On-chain release failed for ${milestone.id}: ${err.message}`);
          releaseResults.push({ milestoneId: String(milestone.id), error: err.message });
        }
      }

      const allReleased = releaseResults.every(r => r.txHash);

      if (allReleased) {
        // Happy path — converge DB state.
        await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
        await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
        await sql`UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ANY(${milestones.map(m => String(m.id))}) AND status = 'funded'`;

        return {
          mode,
          action: "released",
          onChainReleaseResults: releaseResults,
        };
      }

      // Failure path — DB stays at release_pending_chain, payment_intents stay funded.
      console.error(
        `[completeDealMilestones] On-chain release deferred for deal ${dealId}: ${releaseResults.filter(r => !r.txHash).length}/${releaseResults.length} milestones failed on-chain. DB state held at release_pending_chain.`,
      );

      await sql`UPDATE deals SET status = 'release_pending_chain', updated_at = NOW() WHERE id = ${dealId}`;

      try {
        await sql`
          INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
          VALUES (
            NULL,
            'chain.release_failed',
            'deal',
            ${dealId},
            ${`chain-release-failed-${dealId}-${Date.now()}`},
            ${JSON.stringify({ dealId, results: releaseResults, allowOnChainRelease })}::jsonb
          )
        `;
      } catch (auditErr: any) {
        console.error(`[completeDealMilestones] audit_log insert failed for ${dealId}: ${auditErr?.message ?? String(auditErr)}`);
      }

      return {
        mode,
        action: "buyer_sign_required",
        txData: releaseResults.filter(r => !r.txHash).map(r => {
          const txData = generateAcceptTransaction(r.milestoneId);
          return {
            milestoneId: r.milestoneId,
            to: txData.to,
            data: txData.calldata,
            value: "0",
            description: "Accept milestone on-chain and release escrowed funds (platform release failed, buyer must sign)",
          };
        }),
        onChainReleaseResults: releaseResults,
      };
    }
  }

  // payment-methods rollout — silent-$0 phantom-complete guard.
  // In on-chain mode (prod, since 2026-06-03 RPC_URL+PLATFORM_PRIVATE_KEY went
  // live), a FEE-BEARING deal must never be marked 'completed' unless real money
  // actually moved. Reaching this fall-through means hasOnChainFundedIntent was
  // false — i.e. no real on-chain funded intent. We additionally allow a real
  // Stripe-funded intent (the P1 fiat rail) as legitimate money movement. If a
  // fee-bearing deal has NEITHER, completing it would (a) phantom-complete at $0
  // and (b) inject a fake 'payment.release' feeAmount audit row that pollutes
  // auditedPlatformFeeRevenue. Hold the deal at 'delivered' instead.
  //
  // COVERAGE, not existence (Codex MUST-FIX 2026-06-03): we must prove EVERY
  // not-yet-accepted milestone is backed by real money. A LIMIT 1 existence check
  // would let ONE funded milestone mask other unfunded tranches in a multi-
  // milestone deal — the tail below force-accepts ALL milestones, stranding
  // seller value on the unpaid ones. So we count milestones that LACK a
  // qualifying real-money intent; if any exist, hold the whole deal.
  //
  // RECOVERY (Codex MUST-FIX 2026-06-03): this guard mutates ONLY deals.status →
  // 'delivered'; it never touches milestone status. The milestones remain at
  // 'in_progress' (set at accept), which /api/payments/create-intent accepts for
  // funding (payments.ts: status IN ('in_progress','pending')). So a held deal is
  // fully recoverable: buyer funds the milestone(s), then re-runs close/confirm
  // (both accept deal.status='delivered'), which re-enters here, now finds real
  // money, and completes properly. Verified by the recover-by-funding test.
  if (mode === "on-chain" && !skipPaymentRelease) {
    const [unbacked] = await sql`
      SELECT COUNT(*)::int AS n
      FROM milestones m
      WHERE m.deal_id = ${dealId}
        AND m.status != 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM payment_intents pi
          WHERE pi.milestone_id = m.id
            AND pi.status IN ('funded', 'released')
            AND (
              (pi.tx_hash IS NOT NULL AND pi.tx_hash NOT LIKE 'sim_%')
              OR (pi.payment_provider = 'stripe' AND pi.stripe_payment_intent_id IS NOT NULL)
            )
        )
    `;
    if (Number(unbacked?.n ?? 0) > 0) {
      console.warn(
        `[completeDealMilestones] settlement_pending: fee-bearing deal ${dealId} has ${unbacked.n} milestone(s) with no real-money funded intent in on-chain mode. Holding at 'delivered' (no phantom complete, no fake fee). Milestones stay fundable.`,
      );
      await sql`UPDATE deals SET status = 'delivered', updated_at = NOW() WHERE id = ${dealId} AND status != 'completed'`;
      return { mode, action: "settlement_pending" };
    }
  }

  // settlement-integrity dedup: use the single shared implementation (which
  // refuses to fabricate sim_release_* hashes for on-chain-funded escrow
  // intents) instead of a local divergent copy. Mirror the same defensive
  // handling as shared/deal-helpers.ts's completeDealMilestones(): never
  // force-complete the deal if a milestone release was refused.
  let anyReleaseRefused = false;
  for (const milestone of milestones) {
    const releaseResult = await _releaseMilestonePayment(String(milestone.id));
    if (releaseResult.action === "buyer_sign_required") {
      anyReleaseRefused = true;
    }
  }

  if (anyReleaseRefused) {
    console.warn(
      `[completeDealMilestones] settlement_pending: deal ${dealId} had a milestone refuse release (buyer_sign_required) in the fall-through tail. Holding, not force-completing.`,
    );
    await sql`UPDATE deals SET status = 'delivered', updated_at = NOW() WHERE id = ${dealId} AND status != 'completed'`;
    return { mode, action: "settlement_pending" };
  }

  // Ensure deal and milestones are always transitioned to completed/accepted,
  // even when no funded payment_intent exists (e.g. intent never created or already
  // released upstream). Without this explicit UPDATE the deal stays stuck at 'delivered'.
  await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId} AND status != 'completed'`;
  await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;

  return { mode, action: "released" };
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
  keyGenerator: (request) => request.headers['x-api-key'] as string || request.ip
});

// ── Request timeout middleware (prevent hung requests from blocking the pool) ──
const REQUEST_TIMEOUT_MS = 30_000; // 30s hard limit per request
app.addHook('onRequest', async (_request, reply) => {
  const timer = setTimeout(() => {
    if (!reply.sent) {
      app.log.warn({ url: _request.url, method: _request.method }, 'Request timeout — forcing 503');
      reply.code(503).send({ error: 'Request timeout — server is under load, please retry' });
    }
  }, REQUEST_TIMEOUT_MS);
  // Clear timer when response finishes (success or error)
  reply.raw.on('finish', () => clearTimeout(timer));
  reply.raw.on('close', () => clearTimeout(timer));
});

// ── Connection pool health endpoint ──
app.get('/health/pool', async (_request, reply) => {
  // postgres.js exposes pool stats via the tagged-template function object
  const pool = sql as unknown as Record<string, unknown>;
  // 3-second bounded canary so this endpoint can NEVER hang — the whole point
  // of /health/pool is to give an external watchdog a deterministic signal,
  // even when the pool is exhausted. Without this race, the endpoint inherits
  // the 30s onRequest timeout and 503s along with everything else.
  const canary = await Promise.race([
    sql`SELECT 1 AS ok`.then(() => 'ok' as const).catch((e: Error) => `error: ${e.message}` as string),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
  ]);
  const payload = {
    maxConnections: 20,
    note: 'postgres.js does not expose live pool stats via public API; check Supabase dashboard for active connections',
    timestamp: new Date().toISOString(),
    // Canary query to verify pool is not exhausted (bounded to 3s)
    canary,
    ...(typeof pool.totalCount === 'number' ? {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    } : {}),
  };
  if (canary !== 'ok') {
    return reply.code(503).send(payload);
  }
  return payload;
});

await initAuth(app);
registerWebhookRoutes(app, sql);
registerConciergeRoutes(app, sql as unknown as Sql<Record<string, unknown>>);

app.addHook("preHandler", async (request, reply) => {
  const routePath = (request.url.split("?")[0] ?? request.url);
  const publicRoutes = new Set(["/health", "/api/health", "/api/config", "/api/auth/register", "/api/auth/verify", "/api/auth/nonce"]);

  if (publicRoutes.has(routePath) || routePath.startsWith("/api/health")) {
    return;
  }

  // Public read-only routes: anything under /api/public/ or GET requests to browsable endpoints
  if (routePath.startsWith("/api/public/")) {
    return;
  }

  const exactPublicGetRoutes = new Set([
    "/api/matches/recommendations",
    "/api/agents/online",
    "/api/fulfillment/types",
    "/api/intents/discover",
  ]);
  const prefixPublicGetRoutes = [
    "/api/offers",
    "/api/categories",
    "/api/needs",
    "/api/deals",
    "/api/agents",
    "/api/leaderboard",
    "/api/skills",
    "/api/reputation",
    "/api/intents",
  ];
  const isConsultationResponsesRoute = /^\/api\/deals\/[^/]+\/consultation-responses$/.test(routePath);
  if (
    request.method === "GET" &&
    !isConsultationResponsesRoute &&
    (exactPublicGetRoutes.has(routePath) || prefixPublicGetRoutes.some(r => routePath === r || routePath.startsWith(r + "/")))
  ) {
    return;
  }

  // Cron/admin endpoints use their own auth (X-Admin-Key) or are intentionally public
  if (routePath.startsWith("/api/admin/")) {
    return;
  }

  // Concierge relay endpoints — admin/cron accessible (uses queue/relay triggers)
  if (routePath.startsWith("/api/concierge/relay") && request.method === "POST") {
    return;
  }
  if (routePath.startsWith("/api/concierge/queue-") && request.method === "POST") {
    return;
  }
  if (routePath === "/api/concierge/stats" && request.method === "GET") {
    return;
  }
  if (routePath === "/api/concierge/run-full-cycle" && request.method === "POST") {
    return;
  }

  // Auto-complete timeout endpoint — admin-key or cron-secret only
  if (routePath.match(/^\/api\/deals\/[^/]+\/fulfillment\/auto-complete$/) && request.method === "POST") {
    const adminKey = (request.headers as Record<string, string>)["x-admin-key"];
    const cronSecret = (request.headers as Record<string, string>)["x-cron-secret"];
    if (adminKey === process.env.ADMIN_API_KEY || cronSecret === process.env.CRON_SECRET) {
      return; // authenticated admin/cron — skip agent auth
    }
    // Fall through to normal agent auth (reject if no agent key)
  }

  // Dispute-timeout sweep — operator/cron surface (not an agent surface),
  // gated the SAME way as the auto-complete endpoint above and the
  // routes/admin.ts sweepers: admin-key or cron-secret only. The route
  // handler itself (routes/disputes.ts) re-checks ADMIN_API_KEY, so this is
  // defense-in-depth — but without this exemption a legitimate cron caller
  // would ALSO need a registered agent API key just to reach that check,
  // unlike every other admin/cron surface in this file.
  if (routePath === "/api/disputes/resolve-timeouts" && request.method === "POST") {
    const adminKey = (request.headers as Record<string, string>)["x-admin-key"];
    const cronSecret = (request.headers as Record<string, string>)["x-cron-secret"];
    if (adminKey === process.env.ADMIN_API_KEY || cronSecret === process.env.CRON_SECRET) {
      return; // authenticated admin/cron — skip agent auth
    }
    // Fall through to normal agent auth (reject if no agent key); the route
    // handler's own admin-key check still applies even for an authenticated agent.
  }

  if (routePath === "/api/autopilot/run" && request.method === "POST") {
    return;
  }

  // ── audit-order rollout: audit vertical — public Stripe webhook + admin-keyed order routes
  // Both handle their own auth internally (sig verify / ADMIN_API_KEY).
  if (routePath.startsWith("/api/audit/")) {
    return;
  }

  if (routePath.startsWith("/api/")) {
    await app.authenticate(request, reply);
  }
});

// ── Route module registrations  ─────────────────────────
{
  const _sql = sql as unknown as import('postgres').Sql<Record<string, unknown>>;
  const deps = {
    computeTrustTier,
    getAgentStats,
    notifyAgents,
    autoVerify,
    FULFILLMENT_TYPES,
    PLATFORM_FEE_PCT,
    PLATFORM_WALLET,
    credentialEncryptionKey,
    vaultSql,
    TRUST_TIERS,
    completeDealMilestones,
    storeBuyerContext,
    retrieveBuyerContext,
  };
  const _recomputeMatches = createRecomputeMatchesQueue(() => recomputeMatchesFn(app, _sql), {
    onError: (err) => app.log.error({ err }, "scheduled recomputeMatches failed"),
    onEvent: (event, details) => app.log.info({ event, ...details }, "matching queue event"),
  });
  registerHealthChecks(app, sql, { matchingQueueStatus: _recomputeMatches.status });

  await registerAgentRoutes(app, _sql, deps);
  await registerOffersRoutes(app, _sql, deps, _recomputeMatches.scheduleRecompute);
  await registerNeedsRoutes(app, _sql, deps, _recomputeMatches.scheduleRecompute);
  await registerMatchingRoutes(app, _sql, deps, _recomputeMatches);
  await registerDealsRoutes(app, _sql, deps);
  await registerFulfillmentRoutes(app, _sql, deps);
  await registerDisputesRoutes(app, _sql, deps, _releaseMilestonePayment);
  await registerPaymentsRoutes(app, _sql, deps, _releaseMilestonePayment);
  await registerReputationRoutes(app, _sql, deps);
  // settlement protocol Phase E: AgentPact v2 intent surface.
  await registerIntentsRoutes(app, _sql, deps);
  await app.register(adminRoutes);
  await app.register(feedbackRoutes);
  await app.register(configRoutes);
  await registerAuditWebhookRoutes(app, _sql);
  await registerAuditOrdersRoutes(app, _sql);
}

// ── §5.1 (2026-05-21): structured error responses. Every error response
// carries { error, code, requestId } so agent-side log analysis / retry logic
// can branch on a stable machine-readable code instead of regex-matching the
// message string. Codes intentionally namespaced (VALIDATION_*, DB_*, CHAIN_*,
// HTTP_*) so we can grow the taxonomy without breaking clients.
app.setErrorHandler((error: { validation?: unknown; statusCode?: number; message?: string; name?: string; code?: string; issues?: unknown }, request, reply) => {
  const err = error as Record<string, unknown>;
  const requestId = request.id;
  // ZodError detection: duck-typing (instanceof fails with ESM dual packages)
  const issues = err.issues;
  const isZod = Array.isArray(issues) && issues.length > 0 && typeof (issues[0] as any)?.path !== 'undefined'
    || err.name === 'ZodError' || err.validation;
  if (isZod) {
    app.log.warn({ err: { name: err.name, message: err.message }, requestId }, 'validation error');
    return reply.code(400).send({
      error: 'Validation error',
      code: 'VALIDATION_FAILED',
      details: issues ?? err.validation,
      requestId,
    });
  }
  if (typeof error.code === "string" && error.code.startsWith("23")) {
    // 23xxx — Postgres integrity constraint violation (unique, FK, NOT NULL, check)
    return reply.code(400).send({
      error: error.message ?? "Invalid request",
      code: 'DB_CONSTRAINT_VIOLATION',
      requestId,
    });
  }
  if (typeof error.code === "string" && error.code.startsWith("22")) {
    // 22xxx — Postgres data exception (numeric overflow, invalid text repr, etc.)
    return reply.code(400).send({
      error: error.message ?? "Invalid request",
      code: 'DB_DATA_EXCEPTION',
      requestId,
    });
  }
  if (error.code === "57014") {
    // Postgres statement_timeout — pairs with the 25s connection-level limit
    return reply.code(504).send({
      error: "Query timed out, please retry",
      code: 'DB_STATEMENT_TIMEOUT',
      requestId,
    });
  }
  const statusCode = error.statusCode ?? 500;
  const message = statusCode < 500 ? (error.message ?? 'Unknown error') : 'Internal server error';
  const code = statusCode === 401 ? 'AUTH_REQUIRED'
    : statusCode === 403 ? 'AUTH_FORBIDDEN'
    : statusCode === 404 ? 'NOT_FOUND'
    : statusCode === 409 ? 'CONFLICT'
    : statusCode === 429 ? 'RATE_LIMITED'
    : statusCode >= 500 ? 'INTERNAL_ERROR'
    : 'BAD_REQUEST';
  if (statusCode >= 500) {
    app.log.error({ err: error, requestId }, 'unhandled server error');
  }
  reply.code(statusCode).send({ error: message, code, requestId });
});

// Fallback: catch ZodErrors that slip through setErrorHandler
app.addHook('onError', async (request, reply, error) => {
  const err = error as unknown as Record<string, unknown>;
  if (Array.isArray(err.issues) || err.name === 'ZodError') {
    void reply.code(400).send({
      error: 'Validation error',
      code: 'VALIDATION_FAILED',
      details: err.issues,
      requestId: request.id,
    });
    return;
  }
});

export const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
};
