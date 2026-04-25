
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
import { countStaleOffersWithoutDeals } from './routes/offers.js';
import adminRoutes from './routes/admin.js';
import feedbackRoutes from './routes/feedback.js';
import { releaseMilestonePayment as _releaseMilestonePayment } from './shared/deal-helpers.js';

const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";

// ── WIS-255 (AP-P1-3): Admin-routes fail-closed guard ─────────────────────
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
});
export const app = Fastify({ logger: true });
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
  // WIS-247: Added logging for visibility into how many duplicates are archived.
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
  await sql`
    ALTER TABLE deals
    ADD CONSTRAINT deals_status_check
    CHECK (status IN ('proposed', 'countered', 'accepted', 'active', 'funded', 'delivered', 'completed', 'cancelled', 'disputed'))
  `;
}

await ensurePhysicalServiceSchema();
await ensureFulfillmentStatusSchema();
await ensureOfferCompoundingSchema();
await ensureConsultationSchema();
await ensureMppSchema();
// WIS-247: Replaced silent auto-archive with dry-run count on startup.
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

async function releaseMilestonePayment(milestoneId: string): Promise<void> {
  const [payment] = await sql`
    SELECT pi.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id
    FROM payment_intents pi
    JOIN milestones m ON m.id = pi.milestone_id
    JOIN deals d ON d.id = m.deal_id
    WHERE pi.milestone_id = ${milestoneId} AND pi.status = 'funded'
    ORDER BY pi.created_at DESC LIMIT 1
  `;

  if (!payment) return;

  const gross = toNumber(payment.amount);
  const sellerAmount = Number((gross * (100 - PLATFORM_FEE_PCT) / 100).toFixed(6));
  const feeAmount = Number((gross - sellerAmount).toFixed(6));

  await sql.begin(async (txn) => {
    await txn.unsafe(
      `
        UPDATE payment_intents
        SET status = 'released', released_at = NOW(), updated_at = NOW(), tx_hash = $1
        WHERE id = $2
      `,
      [`sim_release_${randomUUID().slice(0, 8)}`, payment.id]
    );
    await txn.unsafe(
      `
        UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = $1
      `,
      [milestoneId]
    );
    await txn.unsafe(
      `
        UPDATE deals SET status = 'completed', updated_at = NOW()
        WHERE id = (SELECT deal_id FROM milestones WHERE id = $1)
      `,
      [milestoneId]
    );
    // Auto-archive the associated offer
    await txn.unsafe(
      `
        UPDATE offers SET status = 'archived', updated_at = NOW()
        WHERE id = (SELECT offer_id FROM deals WHERE id = (SELECT deal_id FROM milestones WHERE id = $1))
          AND status = 'active'
      `,
      [milestoneId]
    );
    await txn.unsafe(
      `
        INSERT INTO audit_log (action, object_type, object_id, payload_json)
        VALUES ('payment.release', 'milestone', $1, $2::jsonb)
      `,
      [milestoneId, JSON.stringify({ gross, sellerAmount, feeAmount, platformWallet: PLATFORM_WALLET })]
    );
  });

  notifyAgents(sql, [payment.seller_agent_id], "payment.released", {
    dealId: payment.deal_id,
    milestoneId,
    gross,
    sellerAmount,
    feeAmount,
  });
}

async function completeDealMilestones(
  dealId: string,
  opts: { skipOnChainRelease?: boolean; skipPaymentRelease?: boolean } = {},
): Promise<{ mode: "simulation" | "on-chain"; action: "released" | "buyer_sign_required" | "completed_without_onchain_release"; txData?: Array<{ milestoneId: string; to: string; data: string; value: string; description: string }>; onChainReleaseResults?: Array<{ milestoneId: string; txHash?: string; error?: string }> }> {
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
      // Try platform-initiated release via resolveDispute (pays seller)
      const releaseResults: Array<{ milestoneId: string; txHash?: string; error?: string }> = [];
      for (const milestone of milestones) {
        try {
          const result = await resolveDisputeOnChain(String(milestone.id), false);
          releaseResults.push({ milestoneId: String(milestone.id), txHash: result.txHash });
        } catch (err: any) {
          console.error(`[completeDealMilestones] On-chain release failed for ${milestone.id}: ${err.message}`);
          releaseResults.push({ milestoneId: String(milestone.id), error: err.message });
        }
      }
      
      // Update DB to completed regardless (funds will be claimable after timeout if on-chain fails)
      await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
      await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
      await sql`UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ANY(${milestones.map(m => String(m.id))}) AND status = 'funded'`;
      
      const allReleased = releaseResults.every(r => r.txHash);
      return {
        mode,
        action: allReleased ? "released" : "buyer_sign_required",
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

  for (const milestone of milestones) {
    await releaseMilestonePayment(String(milestone.id));
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
app.get('/health/pool', async () => {
  // postgres.js exposes pool stats via the tagged-template function object
  const pool = sql as unknown as Record<string, unknown>;
  return {
    maxConnections: 20,
    note: 'postgres.js does not expose live pool stats via public API; check Supabase dashboard for active connections',
    timestamp: new Date().toISOString(),
    // Canary query to verify pool is not exhausted
    canary: await sql`SELECT 1 AS ok`.then(() => 'ok').catch((e: Error) => `error: ${e.message}`),
    ...(typeof pool.totalCount === 'number' ? {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    } : {}),
  };
});

await initAuth(app);
registerHealthChecks(app, sql);
registerWebhookRoutes(app, sql);
registerConciergeRoutes(app, sql as unknown as Sql<Record<string, unknown>>);

app.addHook("preHandler", async (request, reply) => {
  const routePath = (request.url.split("?")[0] ?? request.url);
  const publicRoutes = new Set(["/health", "/api/health", "/api/config", "/api/auth/register", "/api/auth/verify", "/api/auth/nonce"]);

  if (publicRoutes.has(routePath)) {
    return;
  }

  // Public read-only routes: anything under /api/public/ or GET requests to browsable endpoints
  if (routePath.startsWith("/api/public/")) {
    return;
  }

  const publicGetRoutes = ["/api/offers", "/api/categories", "/api/needs", "/api/matches/recommendations", "/api/deals", "/api/agents", "/api/agents/online", "/api/leaderboard", "/api/skills", "/api/fulfillment/types", "/api/reputation"];
  const isConsultationResponsesRoute = /^\/api\/deals\/[^/]+\/consultation-responses$/.test(routePath);
  if (
    request.method === "GET" &&
    !isConsultationResponsesRoute &&
    publicGetRoutes.some(r => routePath === r || routePath.startsWith(r + "/"))
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

  // Auto-complete timeout endpoint — cron-friendly, no agent auth required
  if (routePath.match(/^\/api\/deals\/[^/]+\/fulfillment\/auto-complete$/) && request.method === "POST") {
    return;
  }

  if (routePath === "/api/autopilot/run" && request.method === "POST") {
    return;
  }

  if (routePath.startsWith("/api/")) {
    await app.authenticate(request, reply);
  }
});

// ── Route module registrations (WIS-82) ─────────────────────────
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
  });

  await registerAgentRoutes(app, _sql, deps);
  await registerOffersRoutes(app, _sql, deps, _recomputeMatches.scheduleRecompute);
  await registerNeedsRoutes(app, _sql, deps, _recomputeMatches.scheduleRecompute);
  await registerMatchingRoutes(app, _sql, deps, _recomputeMatches.recomputeNow);
  await registerDealsRoutes(app, _sql, deps);
  await registerFulfillmentRoutes(app, _sql, deps);
  await registerDisputesRoutes(app, _sql, deps, _releaseMilestonePayment);
  await registerPaymentsRoutes(app, _sql, deps, _releaseMilestonePayment);
  await registerReputationRoutes(app, _sql, deps);
  await app.register(adminRoutes);
  await app.register(feedbackRoutes);
}

app.setErrorHandler((error: { validation?: unknown; statusCode?: number; message?: string; name?: string; code?: string; issues?: unknown }, _request, reply) => {
  const err = error as Record<string, unknown>;
  // ZodError detection: duck-typing (instanceof fails with ESM dual packages)
  const issues = err.issues;
  const isZod = Array.isArray(issues) && issues.length > 0 && typeof (issues[0] as any)?.path !== 'undefined'
    || err.name === 'ZodError' || err.validation;
  if (isZod) {
    app.log.warn({ err: { name: err.name, message: err.message } }, 'validation error');
    return reply.code(400).send({ error: 'Validation error', details: issues ?? err.validation });
  }
  if (typeof error.code === "string" && (error.code.startsWith("23") || error.code.startsWith("22"))) {
    return reply.code(400).send({ error: error.message ?? "Invalid request" });
  }
  if (error.code === "57014") {
    return reply.code(504).send({ error: "Query timed out, please retry" });
  }
  const statusCode = error.statusCode ?? 500;
  const message = statusCode < 500 ? (error.message ?? 'Unknown error') : 'Internal server error';
  reply.code(statusCode).send({ error: message });
});

export const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
};
