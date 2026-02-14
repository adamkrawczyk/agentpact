
import Fastify from "fastify";
import cors from "@fastify/cors";
import postgres, { type Sql } from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { initAuth } from "./auth.js";
import { registerHealthChecks } from "./health.js";
import { registerWebhookRoutes, notifyAgents } from "./webhooks.js";
import { autoVerify } from "./auto-verify.js";
import {
  ensureCredentialVaultSchema,
  getCredentialEncryptionKey,
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

const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";

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

export const sql = postgres(DATABASE_URL, { max: 10 });
export const app = Fastify({ logger: true });
const vaultSql = sql as unknown as Sql<Record<string, unknown>>;
const credentialEncryptionKey = getCredentialEncryptionKey();

const walletProviderSchema = z.enum(["metamask", "walletconnect", "coinbase"]);

const milestoneSchema = z.object({
  idx: z.number().int().positive(),
  title: z.string().min(2),
  amount: z.number().positive(),
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
  "generic",
]);

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
  proofs: z.array(z.record(z.any())).default([]),
  fulfillmentType: fulfillmentTypeSchema.optional().default("generic"),
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

const provideFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  fulfillmentData: z.record(z.any()),
});

const getFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  decrypt: z.preprocess((v) => parseBooleanish(v), z.boolean()).optional().default(false),
});

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
  notes: z.string().optional(),
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

const listChallengesQuerySchema = z.object({
  category: z.string().min(2).optional(),
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

async function recomputeMatches(): Promise<number> {
  const offers = await sql`
    SELECT o.*, COALESCE(a.skill_verification_count, 0)::int AS seller_skill_verification_count
    FROM offers o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.status = 'active'
  `;
  const needs = await sql`SELECT * FROM needs WHERE status = 'open'`;
  let writes = 0;

  for (const offer of offers) {
    for (const need of needs) {
      const overlap = offer.tags.filter((t: string) => need.tags.includes(t));
      if (overlap.length === 0) continue;
      const budgetFit =
        need.budget_max === null || need.budget_max === undefined
          ? 1
          : Math.max(0, 1 - Math.abs(toNumber(offer.base_price) - toNumber(need.budget_max)) / Math.max(toNumber(need.budget_max), 1));
      const tagScore = Math.min(1, overlap.length / Math.max(offer.tags.length, 1));
      const skillBoost = Number(offer.seller_skill_verification_count) > 0 ? 0.2 : 0;
      const score = Number((0.7 * tagScore + 0.3 * budgetFit + skillBoost).toFixed(3));
      await sql`
        INSERT INTO matches (offer_id, need_id, score, reason_json)
        VALUES (${offer.id}, ${need.id}, ${score}, ${JSON.stringify({ overlap, budgetFit, skillBoost })}::jsonb)
        ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score, reason_json = EXCLUDED.reason_json
      `;
      writes += 1;
    }
  }
  return writes;
}

async function enforceDealDelta(dealId: string, negotiatedTotal: number): Promise<void> {
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

await initAuth(app);
registerHealthChecks(app, sql);
registerWebhookRoutes(app, sql);

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

  const publicGetRoutes = ["/api/offers", "/api/needs", "/api/matches/recommendations", "/api/deals", "/api/agents", "/api/leaderboard", "/api/skills", "/api/fulfillment/types"];
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

  const [agent] = await sql`
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
  const { id } = request.params as { id: string };
  const [agent] = await sql`SELECT * FROM agents WHERE id = ${id}`;
  if (!agent) return reply.code(404).send({ error: "Agent not found" });

  const [reputation] = await sql`
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
  const { id } = request.params as { id: string };
  const [aggregate] = await sql`
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

app.get("/api/skills/challenges", async (request) => {
  const q = listChallengesQuerySchema.parse(request.query ?? {});
  const rows = await sql`
    SELECT
      id,
      category,
      title,
      description_md,
      difficulty,
      time_limit_minutes,
      active,
      created_at
    FROM skill_challenges
    WHERE active = TRUE
      AND (${q.category ?? null}::text IS NULL OR category = ${q.category ?? null}::text)
    ORDER BY created_at DESC
  `;
  return rows;
});

app.post("/api/skills/challenges/:id/start", async (request, reply) => {
  const { id } = challengeIdParamSchema.parse(request.params);
  const body = startChallengeSchema.parse(request.body);

  const [challenge] = await sql`
    SELECT * FROM skill_challenges
    WHERE id = ${id} AND active = TRUE
  `;
  if (!challenge) return reply.code(404).send({ error: "Challenge not found" });

  const [existing] = await sql`
    SELECT *
    FROM skill_verifications
    WHERE challenge_id = ${id}
      AND agent_id = ${body.agentId}
  `;

  if (existing) {
    if (existing.status === "in_progress" && new Date(existing.expires_at).getTime() > Date.now()) {
      return {
        verificationId: existing.id,
        challengeId: id,
        category: challenge.category,
        title: challenge.title,
        inputPayload: challenge.input_payload,
        deadline: existing.expires_at,
        status: existing.status,
      };
    }

    const retryAt = new Date(existing.started_at);
    retryAt.setHours(retryAt.getHours() + 24);
    if (retryAt.getTime() > Date.now()) {
      return reply.code(429).send({
        error: "Challenge retry cooldown active",
        retryAfter: retryAt.toISOString(),
      });
    }

    await sql`DELETE FROM skill_verifications WHERE id = ${existing.id}`;
  }

  const [verification] = await sql`
    INSERT INTO skill_verifications (agent_id, challenge_id, status, expires_at)
    VALUES (
      ${body.agentId},
      ${id},
      'in_progress',
      NOW() + (${challenge.time_limit_minutes}::text || ' minutes')::interval
    )
    RETURNING *
  `;

  return reply.code(201).send({
    verificationId: verification.id,
    challengeId: id,
    category: challenge.category,
    title: challenge.title,
    inputPayload: challenge.input_payload,
    deadline: verification.expires_at,
    status: verification.status,
  });
});

app.post("/api/skills/challenges/:id/submit", async (request, reply) => {
  const { id } = challengeIdParamSchema.parse(request.params);
  const body = submitChallengeSchema.parse(request.body);

  const [attempt] = await sql`
    SELECT sv.*, sc.category, sc.expected_criteria
    FROM skill_verifications sv
    JOIN skill_challenges sc ON sc.id = sv.challenge_id
    WHERE sv.challenge_id = ${id}
      AND sv.agent_id = ${body.agentId}
    LIMIT 1
  `;

  if (!attempt) return reply.code(404).send({ error: "No challenge attempt found" });

  if (attempt.status !== "in_progress") {
    return reply.code(400).send({ error: `Attempt status is ${attempt.status}, expected in_progress` });
  }

  if (new Date(attempt.expires_at).getTime() <= Date.now()) {
    await sql`
      UPDATE skill_verifications
      SET status = 'expired', submitted_at = NOW()
      WHERE id = ${attempt.id}
    `;
    return reply.code(400).send({ error: "Challenge attempt expired" });
  }

  const criteria = typeof attempt.expected_criteria === "object" && attempt.expected_criteria !== null
    ? (attempt.expected_criteria as Record<string, unknown>)
    : {};
  const grade = gradeSkillSubmission(criteria, body.submission);

  let updatedAttempt: Record<string, unknown> | undefined;

  if (grade.deterministic) {
    const status = grade.passed ? "passed" : "failed";
    [updatedAttempt] = await sql`
      UPDATE skill_verifications
      SET
        submission = ${JSON.stringify(body.submission)}::jsonb,
        status = ${status},
        score = ${grade.score},
        grading_notes = ${grade.gradingNotes},
        submitted_at = NOW(),
        graded_at = NOW()
      WHERE id = ${attempt.id}
      RETURNING *
    `;

    if (grade.passed) {
      await sql`
        UPDATE agents
        SET
          skills_verified = CASE
            WHEN ${attempt.category} = ANY(skills_verified) THEN skills_verified
            ELSE array_append(skills_verified, ${attempt.category})
          END,
          skill_verification_count = cardinality(
            CASE
              WHEN ${attempt.category} = ANY(skills_verified) THEN skills_verified
              ELSE array_append(skills_verified, ${attempt.category})
            END
          )
        WHERE id = ${body.agentId}
      `;
    }
  } else {
    [updatedAttempt] = await sql`
      UPDATE skill_verifications
      SET
        submission = ${JSON.stringify(body.submission)}::jsonb,
        status = 'submitted',
        grading_notes = ${grade.gradingNotes},
        submitted_at = NOW()
      WHERE id = ${attempt.id}
      RETURNING *
    `;
  }

  return {
    verificationId: updatedAttempt?.id,
    challengeId: id,
    status: updatedAttempt?.status,
    passed: updatedAttempt?.status === "passed",
    score: updatedAttempt?.score ?? null,
    gradingNotes: updatedAttempt?.grading_notes ?? null,
  };
});

app.get("/api/agents/:id/skills", async (request, reply) => {
  const { id } = challengeIdParamSchema.parse(request.params);
  const [agent] = await sql`
    SELECT id, COALESCE(skills_verified, '{}'::text[]) AS skills_verified, COALESCE(skill_verification_count, 0)::int AS skill_verification_count
    FROM agents
    WHERE id = ${id}
  `;

  if (!agent) return reply.code(404).send({ error: "Agent not found" });

  const history = await sql`
    SELECT
      sv.id,
      sv.challenge_id,
      sc.category,
      sc.title,
      sc.difficulty,
      sv.status,
      sv.score,
      sv.grading_notes,
      sv.started_at,
      sv.submitted_at,
      sv.graded_at,
      sv.expires_at
    FROM skill_verifications sv
    JOIN skill_challenges sc ON sc.id = sv.challenge_id
    WHERE sv.agent_id = ${id}
    ORDER BY sv.started_at DESC
  `;

  return {
    agentId: id,
    skillsVerified: agent.skills_verified,
    verificationCount: Number(agent.skill_verification_count),
    history,
  };
});

app.post("/api/offers", async (request, reply) => {
  const idem = idempotencyKey(request.headers as Record<string, unknown>);
  const body = createOfferSchema.parse(request.body);

  const [offer] = await sql`
    INSERT INTO offers (
      agent_id, title, description_md, category, tags, base_price, currency, max_price_delta_pct, sla_days, proofs_json, fulfillment_type
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags}, ${body.basePrice},
      ${body.currency}, ${body.maxPriceDeltaPct}, ${body.slaDays}, ${JSON.stringify(body.proofs)}::jsonb, ${body.fulfillmentType}
    )
    RETURNING *
  `;

  await audit(body.agentId, "offer.create", "offer", offer.id, idem, body);
  await recomputeMatches();
  return reply.code(201).send(offer);
});

app.patch("/api/offers/:id", async (request) => {
  const { id } = request.params as { id: string };
  const body = createOfferSchema.partial().parse(request.body);
  const title = body.title ?? null;
  const descriptionMd = body.descriptionMd ?? null;
  const category = body.category ?? null;
  const tags = body.tags ?? null;
  const basePrice = body.basePrice ?? null;
  const maxPriceDeltaPct = body.maxPriceDeltaPct ?? null;
  const slaDays = body.slaDays ?? null;
  const proofsJson = body.proofs ? JSON.stringify(body.proofs) : null;
  const fulfillmentType = body.fulfillmentType ?? null;
  const [offer] = await sql`
    UPDATE offers SET
      title = COALESCE(${title}, title),
      description_md = COALESCE(${descriptionMd}, description_md),
      category = COALESCE(${category}, category),
      tags = COALESCE(${tags}, tags),
      base_price = COALESCE(${basePrice}, base_price),
      max_price_delta_pct = COALESCE(${maxPriceDeltaPct}, max_price_delta_pct),
      sla_days = COALESCE(${slaDays}, sla_days),
      proofs_json = COALESCE(${proofsJson}::jsonb, proofs_json),
      fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  await recomputeMatches();
  return offer;
});

app.post("/api/offers/:id/archive", async (request) => {
  const { id } = request.params as { id: string };
  const [offer] = await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
  return offer;
});

app.get("/api/offers", async (request) => {
  const q = z.object({
    query: z.string().optional(),
    tags: z.string().optional(),
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),
    verifiedOnly: z.string().optional(),
  }).parse(request.query ?? {});
  const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
  const query = `%${q.query ?? ""}%`;
  const min = q.minPrice ? Number(q.minPrice) : 0;
  const max = q.maxPrice ? Number(q.maxPrice) : Number.MAX_SAFE_INTEGER;
  const verifiedOnly = parseBooleanish(q.verifiedOnly);

  const rows = await sql`
    SELECT o.* FROM offers o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.status = 'active'
      AND (o.title ILIKE ${query} OR o.description_md ILIKE ${query})
      AND o.base_price BETWEEN ${min} AND ${max}
      AND (${tags.length} = 0 OR o.tags && ${tags})
      AND (${verifiedOnly} = FALSE OR COALESCE(a.skill_verification_count, 0) > 0)
    ORDER BY o.created_at DESC
    LIMIT 200
  `;
  return rows;
});

app.get("/api/offers/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const [offer] = await sql`SELECT * FROM offers WHERE id = ${id}`;
  if (!offer) return reply.code(404).send({ error: "Offer not found" });
  return offer;
});

app.post("/api/needs", async (request, reply) => {
  const idem = idempotencyKey(request.headers as Record<string, unknown>);
  const body = createNeedSchema.parse(request.body);
  const budgetMin = body.budgetMin ?? null;
  const budgetMax = body.budgetMax ?? null;
  const deadlineAt = body.deadlineAt ?? null;

  const [need] = await sql`
    INSERT INTO needs (
      agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at, fulfillment_type
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
      ${budgetMin}, ${budgetMax}, ${body.currency}, ${JSON.stringify(body.acceptanceCriteria)}::jsonb, ${deadlineAt}, ${body.fulfillmentType}
    ) RETURNING *
  `;

  await audit(body.agentId, "need.create", "need", need.id, idem, body);
  await recomputeMatches();
  return reply.code(201).send(need);
});

app.patch("/api/needs/:id", async (request) => {
  const { id } = request.params as { id: string };
  const body = createNeedSchema.partial().parse(request.body);
  const title = body.title ?? null;
  const descriptionMd = body.descriptionMd ?? null;
  const category = body.category ?? null;
  const tags = body.tags ?? null;
  const budgetMin = body.budgetMin ?? null;
  const budgetMax = body.budgetMax ?? null;
  const acceptanceCriteria = body.acceptanceCriteria ? JSON.stringify(body.acceptanceCriteria) : null;
  const deadlineAt = body.deadlineAt ?? null;
  const fulfillmentType = body.fulfillmentType ?? null;
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
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  await recomputeMatches();
  return need;
});

app.post("/api/needs/:id/archive", async (request) => {
  const { id } = request.params as { id: string };
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

app.get("/api/matches/recommendations", async (request) => {
  const q = z.object({
    agentId: z.string().uuid().optional(),
    limit: z.string().optional(),
    verifiedOnly: z.string().optional(),
  }).parse(request.query ?? {});
  const limit = Number(q.limit ?? 20);
  const verifiedOnly = parseBooleanish(q.verifiedOnly);
  const rows = await sql`
    SELECT m.*, o.title AS offer_title, n.title AS need_title
    FROM matches m
    JOIN offers o ON o.id = m.offer_id
    JOIN needs n ON n.id = m.need_id
    JOIN agents a ON a.id = o.agent_id
    WHERE (${q.agentId ?? null}::uuid IS NULL OR o.agent_id = ${q.agentId ?? null}::uuid OR n.agent_id = ${q.agentId ?? null}::uuid)
      AND (${verifiedOnly} = FALSE OR COALESCE(a.skill_verification_count, 0) > 0)
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

  const [subscription] = await sql`
    INSERT INTO alert_subscriptions (agent_id, kind, filter_json, webhook_url)
    VALUES (${body.agentId}, ${body.kind}, ${JSON.stringify(body.filter)}::jsonb, ${webhookUrl})
    RETURNING *
  `;
  return reply.code(201).send(subscription);
});

app.post("/api/deals/propose", async (request, reply) => {
  const idem = idempotencyKey(request.headers as Record<string, unknown>);
  const body = proposeDealSchema.parse(request.body);

  const result = await sql.begin(async (txn) => {
    const [deal] = await txn.unsafe(
      `
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days
        ) VALUES ($1, $2, $3, $4, 'proposed', $5, 'USDC', $6, $7)
        RETURNING *
      `,
      [body.buyerAgentId, body.sellerAgentId, body.offerId, body.needId, body.negotiatedTotal, body.maxPriceDeltaPct, body.acceptanceTimeoutDays]
    );

    const milestones = [];
    for (const milestone of body.milestones) {
      const dueAt = milestone.dueAt ?? null;
      const [ms] = await txn.unsafe(
        `
          INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6)
          RETURNING *
        `,
        [deal.id, milestone.idx, milestone.title, milestone.amount, JSON.stringify(milestone.acceptanceCriteria), dueAt]
      );
      milestones.push(ms);
    }

    await txn.unsafe(
      `
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)
      `,
      [deal.id, body.buyerAgentId, JSON.stringify(body)]
    );

    await audit(body.buyerAgentId, "deal.propose", "deal", deal.id, idem, body);

    return { ...deal, milestones };
  });

  notifyAgents(sql, [body.sellerAgentId], "deal.proposed", {
    dealId: (result as Record<string, unknown>).id as string,
    buyerAgentId: body.buyerAgentId,
    sellerAgentId: body.sellerAgentId,
    negotiatedTotal: body.negotiatedTotal,
  });

  return reply.code(201).send(result);
});

app.post("/api/deals/:id/counter", async (request) => {
  const { id } = request.params as { id: string };
  const requestBody = request.body && typeof request.body === "object" ? request.body : {};
  const body = counterDealSchema.parse({ ...requestBody, dealId: id });

  await enforceDealDelta(id, body.negotiatedTotal);

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
        SET status = 'countered', negotiated_total = $1, updated_at = NOW()
        WHERE id = $2
      `,
      [body.negotiatedTotal, id]
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

app.post("/api/deals/:id/accept", async (request) => {
  const { id } = request.params as { id: string };
  const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);

  const [deal] = await sql`
    SELECT d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
    FROM deals d
    JOIN offers o ON o.id = d.offer_id
    WHERE d.id = ${id}
  `;

  await sql.begin(async (txn) => {
    await txn.unsafe("UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1", [id]);
    await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
    await txn.unsafe(
      `
        INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status)
        VALUES ($1, $2, 'pending')
        ON CONFLICT (deal_id) DO NOTHING
      `,
      [id, deal?.fulfillment_type ?? "generic"],
    );
    await txn.unsafe(
      `
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'accept', $3::jsonb)
      `,
      [id, body.actorAgentId, JSON.stringify(body)]
    );
  });

  if (deal) {
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.accepted", {
      dealId: id,
      acceptedBy: body.actorAgentId,
      fulfillmentType: deal.fulfillment_type,
      sellerActionRequired: "Provide fulfillment details via /api/deals/:id/fulfillment",
    });
  }

  return { ok: true };
});

app.post("/api/deals/:id/cancel", async (request) => {
  const { id } = request.params as { id: string };
  const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);

  const [deal] = await sql`SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;

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
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.cancelled", {
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

app.get("/api/fulfillment/types", async () => {
  return Object.entries(FULFILLMENT_TYPES).map(([type, config]) => ({
    type,
    label: config.label,
    description: config.description,
    fields: config.fields,
    autoVerify: config.autoVerify,
  }));
});

app.post("/api/deals/:id/fulfillment", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = provideFulfillmentSchema.parse(request.body);

  const [deal] = await sql`
    SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
    FROM deals d
    JOIN offers o ON o.id = d.offer_id
    WHERE d.id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (body.agentId !== deal.seller_agent_id) return reply.code(403).send({ error: "Only seller can provide fulfillment details" });
  if (!["active", "delivered", "completed"].includes(String(deal.status))) {
    return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept fulfillment details` });
  }

  const typeKey = String(deal.fulfillment_type) as keyof typeof FULFILLMENT_TYPES;
  const typeConfig = FULFILLMENT_TYPES[typeKey] ?? FULFILLMENT_TYPES.generic;
  const parsedData = typeConfig.schema.parse(body.fulfillmentData);
  const parsedRecord = asRecord(parsedData);

  const expiresAt =
    typeof parsedData === "object" && parsedData !== null && "expires_at" in parsedData
      ? (parsedData.expires_at as string | undefined) ?? null
      : null;

  const autoVerifyResult = typeConfig.autoVerify
    ? await autoVerify(typeConfig.autoVerify, parsedData as Record<string, unknown>)
    : { success: true, details: "No auto-verification available for this type" };

  const [fulfillment] = await sql`
    INSERT INTO deal_fulfillment (
      deal_id, fulfillment_type, fulfillment_data, status, expires_at, provided_at, auto_verify_result, updated_at
    ) VALUES (
      ${id}, ${typeKey}, ${JSON.stringify(parsedData)}::jsonb, 'provided', ${expiresAt}, NOW(), ${JSON.stringify(autoVerifyResult)}::jsonb, NOW()
    )
    ON CONFLICT (deal_id) DO UPDATE SET
      fulfillment_type = EXCLUDED.fulfillment_type,
      fulfillment_data = EXCLUDED.fulfillment_data,
      status = 'provided',
      expires_at = EXCLUDED.expires_at,
      provided_at = NOW(),
      auto_verify_result = EXCLUDED.auto_verify_result,
      updated_at = NOW()
    RETURNING *
  `;

  const redactedData = await vaultStore(
    vaultSql,
    String(fulfillment.id),
    typeKey,
    parsedRecord,
    credentialEncryptionKey,
  );
  const encryptedFields = Object.entries(redactedData)
    .filter(([, value]) => value === "[encrypted]")
    .map(([field]) => field);

  const [stored] = await sql`
    UPDATE deal_fulfillment
    SET fulfillment_data = ${redactedData}::jsonb, updated_at = NOW()
    WHERE id = ${fulfillment.id}
    RETURNING *
  `;

  notifyAgents(sql, [deal.buyer_agent_id], "deal.fulfillment_provided", {
    dealId: id,
    sellerAgentId: body.agentId,
    fulfillmentType: typeKey,
    status: stored.status,
    encryptedFields,
  });

  return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields });
});

app.get("/api/deals/:id/fulfillment", async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = getFulfillmentSchema.parse(request.query ?? {});

  const [deal] = await sql`
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (query.agentId !== deal.buyer_agent_id && query.agentId !== deal.seller_agent_id) {
    return reply.code(403).send({ error: "Not authorized for this deal" });
  }

  const [fulfillment] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
  if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });

  const checked = await applyFulfillmentExpiryChecks(
    { id: String(deal.id), buyer_agent_id: String(deal.buyer_agent_id), seller_agent_id: String(deal.seller_agent_id) },
    {
      ...(fulfillment as Record<string, unknown>),
      id: String(fulfillment.id),
      status: String(fulfillment.status),
      expires_at: (fulfillment.expires_at as string | Date | null) ?? null,
      last_expiry_warning_at: (fulfillment.last_expiry_warning_at as string | Date | null) ?? null,
    },
  );

  if (!query.decrypt) {
    return checked;
  }

  const decryptedData = await vaultRetrieve(
    vaultSql,
    String(checked.id),
    asRecord(checked.fulfillment_data),
    credentialEncryptionKey,
  );

  await logCredentialAccess(String(checked.id), query.agentId, "decrypt", request.ip);

  return { ...checked, fulfillment_data: decryptedData };
});

app.post("/api/deals/:id/fulfillment/rotate", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = rotateCredentialSchema.parse(request.body);

  const [deal] = await sql`
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (body.agentId !== deal.seller_agent_id) {
    return reply.code(403).send({ error: "Only seller can rotate credentials" });
  }

  const [fulfillment] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
  if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });

  await vaultRotate(vaultSql, String(fulfillment.id), body.fieldName, body.newValue, credentialEncryptionKey);
  await logCredentialAccess(String(fulfillment.id), body.agentId, "rotate", request.ip);

  const [updated] = await sql`
    UPDATE deal_fulfillment
    SET
      fulfillment_data = jsonb_set(
        CASE
          WHEN jsonb_typeof(COALESCE(fulfillment_data, '{}'::jsonb)) = 'object' THEN COALESCE(fulfillment_data, '{}'::jsonb)
          ELSE '{}'::jsonb
        END,
        ARRAY[${body.fieldName}],
        to_jsonb('[encrypted]'::text),
        true
      ),
      updated_at = NOW()
    WHERE id = ${fulfillment.id}
    RETURNING *
  `;

  notifyAgents(sql, [deal.buyer_agent_id], "deal.credential_rotated", {
    dealId: id,
    fulfillmentId: fulfillment.id,
    fieldName: body.fieldName,
    rotatedBy: body.agentId,
    rotatedAt: new Date().toISOString(),
  });

  return updated;
});

app.get("/api/deals/:id/fulfillment/audit", async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = z.object({ agentId: z.string().uuid() }).parse(request.query ?? {});
  await ensureCredentialVaultSchema(vaultSql);

  const [deal] = await sql`
    SELECT id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (query.agentId !== deal.seller_agent_id) {
    return reply.code(403).send({ error: "Only seller can view fulfillment audit logs" });
  }

  const [fulfillment] = await sql`SELECT id FROM deal_fulfillment WHERE deal_id = ${id}`;
  if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });

  const logs = await sql`
    SELECT id, fulfillment_id, agent_id, action, ip_address, created_at
    FROM credential_access_log
    WHERE fulfillment_id = ${fulfillment.id}
    ORDER BY created_at DESC
  `;

  return logs;
});

app.post("/api/deals/:id/fulfillment/request-rotation", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = requestRotationSchema.parse(request.body);
  await ensureCredentialVaultSchema(vaultSql);

  const [deal] = await sql`
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (body.agentId !== deal.buyer_agent_id) {
    return reply.code(403).send({ error: "Only buyer can request credential rotation" });
  }

  const [updated] = await sql`
    UPDATE deal_fulfillment
    SET rotation_requested_at = NOW(), updated_at = NOW()
    WHERE deal_id = ${id}
    RETURNING *
  `;
  if (!updated) return reply.code(404).send({ error: "Fulfillment not found" });

  await logCredentialAccess(String(updated.id), body.agentId, "request_rotation", request.ip);

  notifyAgents(sql, [deal.seller_agent_id], "deal.rotation_requested", {
    dealId: id,
    fulfillmentId: updated.id,
    requestedBy: body.agentId,
    reason: body.reason ?? null,
    requestedAt: updated.rotation_requested_at,
  });

  return updated;
});

app.post("/api/deals/:id/fulfillment/verify", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = verifyFulfillmentSchema.parse(request.body);

  const [deal] = await sql`
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (body.agentId !== deal.buyer_agent_id) return reply.code(403).send({ error: "Only buyer can verify fulfillment" });

  const [existing] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
  if (!existing) return reply.code(404).send({ error: "Fulfillment not found" });

  const verificationPayload = JSON.stringify({
    buyerVerification: {
      accepted: body.accepted,
      notes: body.notes ?? null,
      verifiedAt: new Date().toISOString(),
    },
  });

  const [updated] = await sql`
    UPDATE deal_fulfillment
    SET
      status = ${body.accepted ? "active" : "pending"},
      verified_at = ${body.accepted ? new Date().toISOString() : null},
      auto_verify_result = COALESCE(auto_verify_result, '{}'::jsonb) || ${verificationPayload}::jsonb,
      updated_at = NOW()
    WHERE deal_id = ${id}
    RETURNING *
  `;

  if (body.accepted) {
    notifyAgents(sql, [deal.seller_agent_id], "deal.fulfillment_verified", {
      dealId: id,
      buyerAgentId: body.agentId,
      accepted: true,
      notes: body.notes,
    });
  }

  return updated;
});

app.post("/api/deals/:id/fulfillment/revoke", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = revokeFulfillmentSchema.parse(request.body);

  const [deal] = await sql`
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (body.agentId !== deal.seller_agent_id) return reply.code(403).send({ error: "Only seller can revoke fulfillment" });

  const [updated] = await sql`
    UPDATE deal_fulfillment
    SET status = 'revoked', updated_at = NOW()
    WHERE deal_id = ${id}
    RETURNING *
  `;
  if (!updated) return reply.code(404).send({ error: "Fulfillment not found" });
  await logCredentialAccess(String(updated.id), body.agentId, "revoke", request.ip);

  notifyAgents(sql, [deal.buyer_agent_id], "deal.fulfillment_revoked", {
    dealId: id,
    sellerAgentId: body.agentId,
    status: "revoked",
  });

  return updated;
});

app.post("/api/payments/create-intent", async (request, reply) => {
  const idem = idempotencyKey(request.headers as Record<string, unknown>);
  const body = createPaymentIntentSchema.parse(request.body);
  const mode = isOnChainMode() ? "on-chain" : "simulation";

  const [milestone] = await sql`
    SELECT m.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id, d.status AS deal_status, a.owner_wallet_address AS seller_wallet_address
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    JOIN agents a ON a.id = d.seller_agent_id
    WHERE m.id = ${body.milestoneId}
  `;

  if (!milestone) return reply.code(404).send({ error: "Milestone not found" });
  if (!["in_progress", "pending"].includes(milestone.status)) {
    return reply.code(400).send({ error: `Milestone status ${milestone.status} cannot be funded` });
  }

  if (mode === "on-chain") {
    // Generate unsigned transaction data for the buyer to sign
    const txData = generateFundingTransaction(
      milestone.deal_id,
      body.milestoneId,
      Number(milestone.amount),
      milestone.seller_wallet_address as Address,
    );

    const [intent] = await sql`
      INSERT INTO payment_intents (
        milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
        buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address
      ) VALUES (
        ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id}, ${milestone.amount}, 'USDC', ${body.chain}, 'created',
        ${body.walletProvider}, ${body.buyerWalletAddress}, ${milestone.seller_wallet_address}, ${PLATFORM_WALLET}
      )
      RETURNING *
    `;

    await audit(body.buyerAgentId, "payment.create_intent", "payment_intent", intent.id, idem, body);

    return reply.code(201).send({
      paymentIntentId: intent.id,
      status: "created",
      mode,
      chain: intent.chain,
      amount: intent.amount,
      currency: "USDC",
      feePct: PLATFORM_FEE_PCT,
      platformWallet: PLATFORM_WALLET,
      provider: "usdc",
      escrowContract: ESCROW_ADDRESS,
      usdcContract: USDC_ADDRESS,
      txData: {
        step1_approve: {
          to: txData.approveTo,
          data: txData.approveCalldata,
          value: txData.value,
          description: "Approve USDC spending by escrow contract",
        },
        step2_fund: {
          to: txData.fundTo,
          data: txData.fundCalldata,
          value: txData.value,
          description: "Fund milestone via escrow contract (createMilestone)",
        },
        amountRaw: txData.amountRaw,
      },
    });
  }

  // Simulation mode — immediate funding (legacy behavior)
  const [intent] = await sql`
    INSERT INTO payment_intents (
      milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
      buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address, tx_hash
    ) VALUES (
      ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id}, ${milestone.amount}, 'USDC', ${body.chain}, 'funded',
      ${body.walletProvider}, ${body.buyerWalletAddress}, ${milestone.seller_wallet_address}, ${PLATFORM_WALLET}, ${`sim_fund_${randomUUID().slice(0, 8)}`}
    )
    RETURNING *
  `;

  await sql`UPDATE milestones SET status = 'funded' WHERE id = ${body.milestoneId}`;
  await audit(body.buyerAgentId, "payment.create_intent", "payment_intent", intent.id, idem, body);

  notifyAgents(sql, [milestone.seller_agent_id], "payment.funded", {
    dealId: milestone.deal_id,
    milestoneId: body.milestoneId,
    amount: milestone.amount,
    buyerAgentId: body.buyerAgentId,
  });

  return reply.code(201).send({
    paymentIntentId: intent.id,
    status: intent.status,
    mode,
    chain: intent.chain,
    amount: intent.amount,
    currency: "USDC",
    feePct: PLATFORM_FEE_PCT,
    platformWallet: PLATFORM_WALLET,
    provider: "usdc",
  });
});

app.get("/api/payments/status", async (request, reply) => {
  const q = request.query as { milestoneId?: string; paymentIntentId?: string };
  if (!q.milestoneId && !q.paymentIntentId) {
    return reply.code(400).send({ error: "Provide milestoneId or paymentIntentId" });
  }
  const rows = await sql`
    SELECT * FROM payment_intents
    WHERE (${q.milestoneId ?? null}::uuid IS NULL OR milestone_id = ${q.milestoneId ?? null}::uuid)
      AND (${q.paymentIntentId ?? null}::uuid IS NULL OR id = ${q.paymentIntentId ?? null}::uuid)
    ORDER BY created_at DESC
  `;
  return rows.map((r: Record<string, unknown>) => ({ ...r, mode: isOnChainMode() ? "on-chain" : "simulation" }));
});

// ── Confirm on-chain funding ─────────────────────────────────────────
const confirmFundingSchema = z.object({
  paymentIntentId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

app.post("/api/payments/confirm-funding", async (request, reply) => {
  const body = confirmFundingSchema.parse(request.body);
  const idem = idempotencyKey(request.headers as Record<string, unknown>);

  const [intent] = await sql`
    SELECT * FROM payment_intents WHERE id = ${body.paymentIntentId}
  `;

  if (!intent) return reply.code(404).send({ error: "Payment intent not found" });
  if (intent.status !== "created") {
    return reply.code(400).send({ error: `Intent status is ${intent.status}, expected created` });
  }

  // Verify on-chain
  const verification = await verifyFunding(body.txHash as Hex);

  if (!verification.verified) {
    return reply.code(400).send({ error: "Transaction not verified on-chain — failed or not confirmed" });
  }

  // Update intent + milestone status
  await sql.begin(async (txn) => {
    await txn.unsafe(
      `UPDATE payment_intents SET status = 'funded', tx_hash = $1, updated_at = NOW() WHERE id = $2`,
      [body.txHash, body.paymentIntentId]
    );
    await txn.unsafe(
      `UPDATE milestones SET status = 'funded' WHERE id = $1`,
      [intent.milestone_id]
    );
  });

  await audit(intent.buyer_agent_id, "payment.confirm_funding", "payment_intent", intent.id, idem, { txHash: body.txHash });

  notifyAgents(sql, [intent.seller_agent_id], "payment.funded", {
    milestoneId: intent.milestone_id,
    amount: intent.amount,
    buyerAgentId: intent.buyer_agent_id,
    txHash: body.txHash,
  });

  return reply.code(200).send({
    paymentIntentId: intent.id,
    status: "funded",
    txHash: body.txHash,
    mode: "on-chain",
    verified: true,
  });
});

// ── On-chain milestone status ────────────────────────────────────────
app.get("/api/payments/on-chain-status", async (request, reply) => {
  const q = request.query as { milestoneId?: string };
  if (!q.milestoneId) return reply.code(400).send({ error: "Provide milestoneId" });

  if (!isOnChainMode()) {
    return { mode: "simulation", message: "On-chain status not available in simulation mode" };
  }

  const status = await getMilestoneStatus(q.milestoneId);
  return { mode: "on-chain", ...status };
});

app.post("/api/payments/release", async (request, reply) => {
  const body = z.object({ milestoneId: z.string().uuid() }).parse(request.body);
  const mode = isOnChainMode() ? "on-chain" : "simulation";

  if (mode === "on-chain") {
    // In the on-chain model, release = buyer calls acceptMilestone on-chain.
    // The platform can't call acceptMilestone (only buyer can).
    // So we return the unsigned tx data for the buyer to sign.
    const txData = generateAcceptTransaction(body.milestoneId);

    return reply.code(200).send({
      ok: true,
      mode,
      action: "buyer_sign_required",
      message: "Buyer must call acceptMilestone on-chain to release funds to seller",
      txData: {
        to: txData.to,
        data: txData.calldata,
        value: "0",
        description: "Accept milestone — releases USDC to seller (minus platform fee)",
      },
    });
  }

  // Simulation mode — direct release
  await releaseMilestonePayment(body.milestoneId);
  return { ok: true, mode };
});

app.post("/api/payments/refund", async (request, reply) => {
  const body = z.object({ paymentIntentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
  const mode = isOnChainMode() ? "on-chain" : "simulation";

  const [intent] = await sql`SELECT * FROM payment_intents WHERE id = ${body.paymentIntentId}`;
  if (!intent) return reply.code(404).send({ error: "Payment intent not found" });

  if (mode === "on-chain") {
    // On-chain refund: the milestone must first be disputed (buyer calls openDispute),
    // then the platform resolves the dispute in the buyer's favor.
    // Check if we can do it:
    try {
      const onChainStatus = await getMilestoneStatus(intent.milestone_id);
      if (onChainStatus.exists && onChainStatus.status === "Disputed") {
        // Platform resolves dispute — refund buyer
        const { txHash } = await resolveDisputeOnChain(intent.milestone_id, true);
        await sql`
          UPDATE payment_intents
          SET status = 'refunded', updated_at = NOW(), tx_hash = ${txHash}
          WHERE id = ${body.paymentIntentId}
        `;
        await sql`UPDATE milestones SET status = 'cancelled' WHERE id = ${intent.milestone_id}`;
        return { ok: true, mode, txHash, action: "refunded_on_chain" };
      }

      // Milestone not disputed — can't refund on-chain yet; mark as pending
      await sql`
        UPDATE payment_intents
        SET status = 'pending_refund', updated_at = NOW()
        WHERE id = ${body.paymentIntentId}
      `;
      return {
        ok: true,
        mode,
        action: "pending_refund",
        message: "Milestone must be disputed on-chain before platform can refund. Buyer should call openDispute first.",
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.code(500).send({ error: `On-chain refund failed: ${message}` });
    }
  }

  // Simulation mode
  await sql`
    UPDATE payment_intents
    SET status = 'refunded', updated_at = NOW(), tx_hash = ${`sim_refund_${randomUUID().slice(0, 8)}`}
    WHERE id = ${body.paymentIntentId}
  `;
  return { ok: true, mode };
});

app.post("/api/deliveries/submit", async (request, reply) => {
  const body = submitDeliverySchema.parse(request.body);
  const checksum = createHash("sha256").update(JSON.stringify(body.artifacts)).digest("hex");
  const notes = body.notes ?? null;

  const [delivery] = await sql`
    INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, verification_notes)
    VALUES (${body.milestoneId}, ${body.submittedBy}, ${JSON.stringify(body.artifacts)}::jsonb, ${checksum}, ${notes})
    RETURNING *
  `;

  await sql`UPDATE milestones SET status = 'delivered' WHERE id = ${body.milestoneId}`;
  await sql`
    UPDATE deals SET status = 'delivered', updated_at = NOW()
    WHERE id = (SELECT deal_id FROM milestones WHERE id = ${body.milestoneId})
  `;

  return reply.code(201).send(delivery);
});

app.post("/api/deliveries/verify", async (request, reply) => {
  const body = verifyDeliverySchema.parse(request.body);
  const verificationNotes = body.verificationNotes ?? null;

  if (!body.accepted) {
    await sql`
      UPDATE deliveries
      SET status = 'rejected', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
      WHERE milestone_id = ${body.milestoneId}
    `;
    await sql`UPDATE milestones SET status = 'in_progress' WHERE id = ${body.milestoneId}`;
    return reply.code(200).send({ accepted: false });
  }

  await sql`
    UPDATE deliveries
    SET status = 'verified', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
    WHERE milestone_id = ${body.milestoneId}
  `;

  // Look up deal to notify buyer
  const [milestoneInfo] = await sql`
    SELECT d.buyer_agent_id, d.id AS deal_id
    FROM milestones m JOIN deals d ON d.id = m.deal_id
    WHERE m.id = ${body.milestoneId}
  `;

  await releaseMilestonePayment(body.milestoneId);

  if (milestoneInfo) {
    notifyAgents(sql, [milestoneInfo.buyer_agent_id], "milestone.completed", {
      dealId: milestoneInfo.deal_id,
      milestoneId: body.milestoneId,
      verifiedBy: body.buyerAgentId,
    });
  }

  return { accepted: true, payoutReleased: true };
});

app.post("/api/disputes/open", async (request, reply) => {
  const body = disputeSchema.parse(request.body);
  const [dispute] = await sql`
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

  await sql`UPDATE milestones SET status = 'disputed' WHERE id = ${body.milestoneId}`;
  await sql`UPDATE deals SET status = 'disputed', updated_at = NOW() WHERE id = ${body.dealId}`;
  return reply.code(201).send(dispute);
});

app.post("/api/disputes/resolve-timeouts", async () => {
  const expired = await sql`
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
  const [entry] = await sql`
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

  const [aggregate] = await sql`
    SELECT COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score
    FROM feedback WHERE to_agent_id = ${body.toAgentId}
  `;

  await sql`UPDATE agents SET reputation_score = ${Number(aggregate.score)} WHERE id = ${body.toAgentId}`;

  notifyAgents(sql, [body.toAgentId], "feedback.received", {
    dealId: body.dealId,
    fromAgentId: body.fromAgentId,
    ratingQuality: body.ratingQuality,
    ratingTimeliness: body.ratingTimeliness,
    ratingCommunication: body.ratingCommunication,
    ratingAccuracy: body.ratingAccuracy,
  });

  return reply.code(201).send(entry);
});

app.get("/api/public/overview", async () => {
  const [stats] = await sql`
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
  const q = request.query as { sortBy?: string; limit?: string; period?: string };
  const sortBy = q.sortBy ?? "reputation";
  const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
  const period = q.period ?? "all";

  let periodFilter = "";
  if (period === "30d") periodFilter = "AND d.created_at >= NOW() - INTERVAL '30 days'";
  else if (period === "7d") periodFilter = "AND d.created_at >= NOW() - INTERVAL '7 days'";

  let orderClause = "reputation_score DESC";
  if (sortBy === "deals") orderClause = "completed_deals DESC";
  else if (sortBy === "volume") orderClause = "total_volume DESC";
  else if (sortBy === "skills") orderClause = "skill_verification_count DESC";

  const rows = await sql.unsafe(`
    SELECT
      a.id AS agent_id,
      a.display_name AS name,
      a.created_at AS member_since,
      COALESCE(a.skills_verified, '{}'::text[]) AS skills_verified,
      COALESCE(a.skill_verification_count, 0)::int AS skill_verification_count,
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

  return rows.map((row: Record<string, unknown>, idx: number) => {
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
      skillsVerified: row.skills_verified,
      verificationCount: Number(row.skill_verification_count),
      totalVolume: Number(Number(row.total_volume).toFixed(2)),
      disputeRate: totalDeals > 0 ? Number((disputedDeals / totalDeals).toFixed(4)) : 0,
      memberSince: row.member_since,
    };
  });
});

app.setErrorHandler((error: { validation?: unknown; statusCode?: number; message?: string; name?: string; code?: string; issues?: unknown }, _request, reply) => {
  app.log.error(error);
  if (error.validation || error.name === "ZodError") {
    return reply.code(400).send({ error: 'Validation error', details: error.validation });
  }
  if (typeof error.code === "string" && (error.code.startsWith("23") || error.code.startsWith("22"))) {
    return reply.code(400).send({ error: error.message ?? "Invalid request" });
  }
  const statusCode = error.statusCode ?? 500;
  const message = statusCode < 500 ? (error.message ?? 'Unknown error') : 'Internal server error';
  reply.code(statusCode).send({ error: message });
});

export const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
};
