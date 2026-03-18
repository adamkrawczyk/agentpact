import Fastify from "fastify";
import cors from "@fastify/cors";
import postgres from "postgres";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { initAuth } from "./auth.js";
import { registerHealthChecks } from "./health.js";
import { registerWebhookRoutes, notifyAgents } from "./webhooks.js";
import { autoVerify } from "./auto-verify.js";
import { decrypt, ensureCredentialVaultSchema, encrypt, getCredentialEncryptionKey, getSensitiveFields, vaultRetrieve, vaultRotate, vaultStore, } from "./credential-vault.js";
import { isOnChainMode, generateFundingTransaction, generateAcceptTransaction, verifyFunding, resolveDisputeOnChain, getMilestoneStatus, ESCROW_ADDRESS, USDC_ADDRESS, } from "./chain.js";
import { cacheEmbedding, computeSemanticScore, generateEmbeddings, isSemanticMatchingEnabled, } from "./semantic-match.js";
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
export const sql = postgres(DATABASE_URL, {
    max: 20, // Up from 10 — Supabase free tier supports ~20 connections
    idle_timeout: 30, // Release idle connections after 30s to avoid Supabase connection cap
    connect_timeout: 10, // Fail fast if pool can't get a connection in 10s
    max_lifetime: 1800, // Recycle connections every 30 min to avoid stale sockets
});
export const app = Fastify({ logger: true });
const vaultSql = sql;
const credentialEncryptionKey = getCredentialEncryptionKey();
async function ensurePhysicalServiceSchema() {
    await sql `ALTER TABLE offers ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL`;
    await sql `ALTER TABLE needs ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL`;
    await sql `ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS buyer_data JSONB DEFAULT NULL`;
    await sql `
    CREATE INDEX IF NOT EXISTS idx_offers_location_country
    ON offers ((location->>'country'))
    WHERE location IS NOT NULL
  `;
    await sql `
    CREATE INDEX IF NOT EXISTS idx_needs_location_country
    ON needs ((location->>'country'))
    WHERE location IS NOT NULL
  `;
}
async function ensureFulfillmentStatusSchema() {
    await sql `ALTER TABLE deal_fulfillment DROP CONSTRAINT IF EXISTS deal_fulfillment_status_check`;
    await sql `
    ALTER TABLE deal_fulfillment
    ADD CONSTRAINT deal_fulfillment_status_check
    CHECK (status IN ('pending', 'provided', 'active', 'verified', 'expired', 'revoked'))
  `;
}
await ensurePhysicalServiceSchema();
await ensureFulfillmentStatusSchema();
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
};
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
    basePrice: z.number().positive(),
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
    negotiatedTotal: z.number().positive(),
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
function idempotencyKey(headers) {
    return String(headers["idempotency-key"] ?? randomUUID());
}
function toNumber(v) {
    return Number(v);
}
function parseBooleanish(value) {
    if (typeof value !== "string")
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}
function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
function getRequesterAgentId(request, reply) {
    const requesterAgentId = request.agentId;
    if (!requesterAgentId) {
        reply.code(401).send({ error: "Missing API key" });
        return null;
    }
    return requesterAgentId;
}
const BUYER_VAULT_PREFIX = "buyer__";
async function storeBuyerContext(fulfillmentId, fulfillmentType, data) {
    await ensureCredentialVaultSchema(vaultSql);
    const redacted = { ...data };
    const configured = new Set(getSensitiveFields(fulfillmentType));
    const prefixed = Object.keys(data).filter((field) => field.startsWith("secret_"));
    const sensitiveFields = new Set([...configured, ...prefixed]);
    for (const fieldName of sensitiveFields) {
        if (!(fieldName in data))
            continue;
        const value = data[fieldName];
        if (value === undefined || value === null)
            continue;
        const plaintext = typeof value === "string" ? value : JSON.stringify(value);
        const { encrypted, iv, authTag } = encrypt(plaintext, credentialEncryptionKey);
        await sql `
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
async function retrieveBuyerContext(fulfillmentId, data) {
    await ensureCredentialVaultSchema(vaultSql);
    const merged = { ...data };
    const rows = await sql `
    SELECT field_name, encrypted_value, iv, auth_tag
    FROM credential_vault
    WHERE fulfillment_id = ${fulfillmentId}
      AND field_name LIKE ${`${BUYER_VAULT_PREFIX}%`}
  `;
    for (const row of rows) {
        const fieldName = String(row.field_name).slice(BUYER_VAULT_PREFIX.length);
        merged[fieldName] = decrypt(String(row.encrypted_value), String(row.iv), String(row.auth_tag), credentialEncryptionKey);
    }
    return merged;
}
async function logCredentialAccess(fulfillmentId, agentId, action, ipAddress) {
    await ensureCredentialVaultSchema(vaultSql);
    await sql `
    INSERT INTO credential_access_log (fulfillment_id, agent_id, action, ip_address)
    VALUES (${fulfillmentId}, ${agentId}, ${action}, ${ipAddress ?? null})
  `;
}
async function applyFulfillmentExpiryChecks(deal, fulfillment) {
    await ensureCredentialVaultSchema(vaultSql);
    if (!fulfillment.expires_at)
        return fulfillment;
    const expiresAt = new Date(String(fulfillment.expires_at));
    if (Number.isNaN(expiresAt.getTime()))
        return fulfillment;
    const now = new Date();
    const status = String(fulfillment.status);
    const expiresInMs = expiresAt.getTime() - now.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (expiresInMs <= 0 && status !== "expired" && status !== "revoked") {
        const [expired] = await sql `
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
            return expired;
        }
    }
    if (expiresInMs > 0 && expiresInMs <= oneDayMs && !fulfillment.last_expiry_warning_at) {
        const [warned] = await sql `
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
            return warned;
        }
    }
    return fulfillment;
}
function gradeSkillSubmission(expectedCriteria, submission) {
    const mode = typeof expectedCriteria.mode === "string" ? expectedCriteria.mode : "";
    if (mode === "keyword") {
        const keywords = Array.isArray(expectedCriteria.keywords)
            ? expectedCriteria.keywords.filter((k) => typeof k === "string")
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
            ? expectedCriteria.requiredKeys.filter((k) => typeof k === "string")
            : [];
        const submissionRecord = submission;
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
async function audit(actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
function buildSemanticText(input) {
    const tags = Array.isArray(input.tags) ? input.tags.join(", ") : "";
    return [
        input.title ?? "",
        input.description_md ?? "",
        input.category ?? "",
        tags,
    ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
}
function extractEmbedding(value) {
    if (!Array.isArray(value))
        return null;
    const embedding = [];
    for (const item of value) {
        if (typeof item !== "number" || !Number.isFinite(item))
            return null;
        embedding.push(item);
    }
    return embedding.length > 0 ? embedding : null;
}
async function recomputeMatches() {
    const offers = await sql `
    SELECT o.*, COALESCE(a.skill_verification_count, 0)::int AS seller_skill_verification_count
    FROM offers o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.status = 'active'
  `;
    const needs = await sql `SELECT * FROM needs WHERE status = 'open'`;
    let writes = 0;
    let semanticEnabled = isSemanticMatchingEnabled();
    const offerTexts = new Map();
    const needTexts = new Map();
    if (semanticEnabled) {
        try {
            const allTexts = [];
            for (const offer of offers) {
                const text = buildSemanticText(offer);
                offerTexts.set(String(offer.id), text);
                const cachedEmbedding = extractEmbedding(offer.description_embedding);
                if (cachedEmbedding) {
                    cacheEmbedding(text, cachedEmbedding);
                }
                allTexts.push(text);
            }
            for (const need of needs) {
                const text = buildSemanticText(need);
                needTexts.set(String(need.id), text);
                const cachedEmbedding = extractEmbedding(need.description_embedding);
                if (cachedEmbedding) {
                    cacheEmbedding(text, cachedEmbedding);
                }
                allTexts.push(text);
            }
            await generateEmbeddings(allTexts);
        }
        catch (error) {
            app.log.warn({ err: error }, "Semantic matching warmup failed, using tag-only matching");
            semanticEnabled = false;
        }
    }
    for (const offer of offers) {
        for (const need of needs) {
            const overlap = offer.tags.filter((t) => need.tags.includes(t));
            const budgetFit = need.budget_max === null || need.budget_max === undefined
                ? 1
                : Math.max(0, 1 - Math.abs(toNumber(offer.base_price) - toNumber(need.budget_max)) / Math.max(toNumber(need.budget_max), 1));
            const tagScore = Math.min(1, overlap.length / Math.max(offer.tags.length, 1));
            const skillBoost = Number(offer.seller_skill_verification_count) > 0 ? 0.2 : 0;
            let semanticScore = null;
            let score;
            if (!semanticEnabled) {
                if (overlap.length === 0)
                    continue;
                score = Number((0.7 * tagScore + 0.3 * budgetFit + skillBoost).toFixed(3));
            }
            else {
                try {
                    const offerText = offerTexts.get(String(offer.id)) ?? buildSemanticText(offer);
                    const needText = needTexts.get(String(need.id)) ?? buildSemanticText(need);
                    semanticScore = await computeSemanticScore(offerText, needText);
                }
                catch (error) {
                    app.log.warn({ err: error }, "Semantic score failed, reverting to tag-only matching");
                    semanticEnabled = false;
                    if (overlap.length === 0)
                        continue;
                    score = Number((0.7 * tagScore + 0.3 * budgetFit + skillBoost).toFixed(3));
                    await sql `
            INSERT INTO matches (offer_id, need_id, score, reason_json)
            VALUES (${offer.id}, ${need.id}, ${score}, ${JSON.stringify({ overlap, budgetFit, tagScore, skillBoost, semanticScore })}::jsonb)
            ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score, reason_json = EXCLUDED.reason_json
          `;
                    writes += 1;
                    continue;
                }
                if (overlap.length === 0 && semanticScore <= 0.75)
                    continue;
                score = Number((0.5 * semanticScore + 0.2 * tagScore + 0.2 * budgetFit + 0.1 * skillBoost).toFixed(3));
            }
            await sql `
        INSERT INTO matches (offer_id, need_id, score, reason_json)
        VALUES (${offer.id}, ${need.id}, ${score}, ${JSON.stringify({ overlap, budgetFit, tagScore, skillBoost, semanticScore })}::jsonb)
        ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score, reason_json = EXCLUDED.reason_json
      `;
            writes += 1;
        }
    }
    return writes;
}
async function createDealProposal(proposal, opts) {
    const result = await sql.begin(async (txn) => {
        const [deal] = await txn.unsafe(`
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days
        ) VALUES ($1, $2, $3, $4, 'proposed', $5, 'USDC', $6, $7)
        RETURNING *
      `, [
            proposal.buyerAgentId,
            proposal.sellerAgentId,
            proposal.offerId,
            proposal.needId,
            proposal.negotiatedTotal,
            proposal.maxPriceDeltaPct,
            proposal.acceptanceTimeoutDays,
        ]);
        const milestones = [];
        for (const milestone of proposal.milestones) {
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
      `, [deal.id, opts.negotiationActorAgentId, JSON.stringify(opts.auditPayload ?? proposal)]);
        await audit(opts.auditActorAgentId, opts.auditAction, "deal", String(deal.id), opts.idempotencyKey, opts.auditPayload ?? proposal);
        return { ...deal, milestones };
    });
    return result;
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
    SELECT pi.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id
    FROM payment_intents pi
    JOIN milestones m ON m.id = pi.milestone_id
    JOIN deals d ON d.id = m.deal_id
    WHERE pi.milestone_id = ${milestoneId} AND pi.status = 'funded'
    ORDER BY pi.created_at DESC LIMIT 1
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
      `, [`sim_release_${randomUUID().slice(0, 8)}`, payment.id]);
        await txn.unsafe(`
        UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = $1
      `, [milestoneId]);
        await txn.unsafe(`
        UPDATE deals SET status = 'completed', updated_at = NOW()
        WHERE id = (SELECT deal_id FROM milestones WHERE id = $1)
      `, [milestoneId]);
        // Auto-archive the associated offer
        await txn.unsafe(`
        UPDATE offers SET status = 'archived', updated_at = NOW()
        WHERE id = (SELECT offer_id FROM deals WHERE id = (SELECT deal_id FROM milestones WHERE id = $1))
          AND status = 'active'
      `, [milestoneId]);
        await txn.unsafe(`
        INSERT INTO audit_log (action, object_type, object_id, payload_json)
        VALUES ('payment.release', 'milestone', $1, $2::jsonb)
      `, [milestoneId, JSON.stringify({ gross, sellerAmount, feeAmount, platformWallet: PLATFORM_WALLET })]);
    });
    notifyAgents(sql, [payment.seller_agent_id], "payment.released", {
        dealId: payment.deal_id,
        milestoneId,
        gross,
        sellerAmount,
        feeAmount,
    });
}
async function completeDealMilestones(dealId, opts = {}) {
    const mode = isOnChainMode() ? "on-chain" : "simulation";
    const milestones = await sql `
    SELECT id
    FROM milestones
    WHERE deal_id = ${dealId} AND status != 'accepted'
    ORDER BY idx
  `;
    if (milestones.length === 0) {
        return { mode, action: "released" };
    }
    if (mode === "on-chain") {
        if (opts.skipOnChainRelease) {
            await sql `UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
            await sql `UPDATE milestones SET status = 'accepted' WHERE deal_id = ${dealId} AND status != 'accepted'`;
            return { mode, action: "completed_without_onchain_release" };
        }
        const intents = await sql `
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
            const releaseResults = [];
            for (const milestone of milestones) {
                try {
                    const result = await resolveDisputeOnChain(String(milestone.id), false);
                    releaseResults.push({ milestoneId: String(milestone.id), txHash: result.txHash });
                }
                catch (err) {
                    console.error(`[completeDealMilestones] On-chain release failed for ${milestone.id}: ${err.message}`);
                    releaseResults.push({ milestoneId: String(milestone.id), error: err.message });
                }
            }
            // Update DB to completed regardless (funds will be claimable after timeout if on-chain fails)
            await sql `UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
            await sql `UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
            await sql `UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ANY(${milestones.map(m => String(m.id))}) AND status = 'funded'`;
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
    keyGenerator: (request) => request.headers['x-api-key'] || request.ip
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
    const pool = sql;
    return {
        maxConnections: 20,
        note: 'postgres.js does not expose live pool stats via public API; check Supabase dashboard for active connections',
        timestamp: new Date().toISOString(),
        // Canary query to verify pool is not exhausted
        canary: await sql `SELECT 1 AS ok`.then(() => 'ok').catch((e) => `error: ${e.message}`),
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
    const publicGetRoutes = ["/api/offers", "/api/needs", "/api/matches/recommendations", "/api/deals", "/api/agents", "/api/agents/online", "/api/leaderboard", "/api/skills", "/api/fulfillment/types", "/api/reputation"];
    if (request.method === "GET" && publicGetRoutes.some(r => routePath === r || routePath.startsWith(r + "/"))) {
        return;
    }
    // Cron/admin endpoints use their own auth (X-Admin-Key) or are intentionally public
    if (routePath.startsWith("/api/admin/")) {
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
app.post("/api/agents/:id/heartbeat", async (request, reply) => {
    const { id } = agentIdParamSchema.parse(request.params);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to heartbeat for this agent" });
    }
    const [agent] = await sql `
    UPDATE agents
    SET
      last_seen_at = NOW(),
      presence_status = 'online'
    WHERE id = ${id}
    RETURNING id, last_seen_at
  `;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    return {
        ok: true,
        last_seen_at: agent.last_seen_at,
    };
});
app.get("/api/agents/online", async (request) => {
    const q = onlineAgentsQuerySchema.parse(request.query ?? {});
    await sql `
    UPDATE agents
    SET presence_status = CASE
      WHEN last_seen_at IS NULL THEN 'offline'
      WHEN last_seen_at < NOW() - INTERVAL '15 minutes' THEN 'offline'
      WHEN last_seen_at < NOW() - INTERVAL '5 minutes' THEN 'away'
      ELSE 'online'
    END
    WHERE presence_status IS DISTINCT FROM CASE
      WHEN last_seen_at IS NULL THEN 'offline'
      WHEN last_seen_at < NOW() - INTERVAL '15 minutes' THEN 'offline'
      WHEN last_seen_at < NOW() - INTERVAL '5 minutes' THEN 'away'
      ELSE 'online'
    END
  `;
    const rows = await sql `
    SELECT
      a.id,
      a.display_name AS name,
      a.last_seen_at,
      a.presence_status,
      a.reputation_score
    FROM agents a
    WHERE a.last_seen_at >= NOW() - INTERVAL '15 minutes'
      AND (${q.category ?? null}::text IS NULL OR EXISTS (
        SELECT 1
        FROM offers o
        WHERE o.agent_id = a.id
          AND o.status = 'active'
          AND o.category = ${q.category ?? null}::text
      ))
    ORDER BY a.last_seen_at DESC
  `;
    return rows;
});
app.get("/api/agents/:id/presence", async (request, reply) => {
    const { id } = agentIdParamSchema.parse(request.params);
    const [agent] = await sql `
    SELECT
      last_seen_at,
      presence_status,
      (last_seen_at IS NOT NULL AND last_seen_at >= NOW() - INTERVAL '5 minutes') AS online
    FROM agents
    WHERE id = ${id}
  `;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    return {
        online: Boolean(agent.online),
        last_seen_at: agent.last_seen_at,
        presence_status: agent.presence_status,
    };
});
app.get("/api/skills/challenges", async (request) => {
    const q = listChallengesQuerySchema.parse(request.query ?? {});
    const rows = await sql `
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [challenge] = await sql `
    SELECT * FROM skill_challenges
    WHERE id = ${id} AND active = TRUE
  `;
    if (!challenge)
        return reply.code(404).send({ error: "Challenge not found" });
    const [existing] = await sql `
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
        await sql `DELETE FROM skill_verifications WHERE id = ${existing.id}`;
    }
    const [verification] = await sql `
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [attempt] = await sql `
    SELECT sv.*, sc.category, sc.expected_criteria
    FROM skill_verifications sv
    JOIN skill_challenges sc ON sc.id = sv.challenge_id
    WHERE sv.challenge_id = ${id}
      AND sv.agent_id = ${body.agentId}
    LIMIT 1
  `;
    if (!attempt)
        return reply.code(404).send({ error: "No challenge attempt found" });
    if (attempt.status !== "in_progress") {
        return reply.code(400).send({ error: `Attempt status is ${attempt.status}, expected in_progress` });
    }
    if (new Date(attempt.expires_at).getTime() <= Date.now()) {
        await sql `
      UPDATE skill_verifications
      SET status = 'expired', submitted_at = NOW()
      WHERE id = ${attempt.id}
    `;
        return reply.code(400).send({ error: "Challenge attempt expired" });
    }
    const criteria = typeof attempt.expected_criteria === "object" && attempt.expected_criteria !== null
        ? attempt.expected_criteria
        : {};
    const grade = gradeSkillSubmission(criteria, body.submission);
    let updatedAttempt;
    if (grade.deterministic) {
        const status = grade.passed ? "passed" : "failed";
        [updatedAttempt] = await sql `
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
            await sql `
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
    }
    else {
        [updatedAttempt] = await sql `
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
    const [agent] = await sql `
    SELECT id, COALESCE(skills_verified, '{}'::text[]) AS skills_verified, COALESCE(skill_verification_count, 0)::int AS skill_verification_count
    FROM agents
    WHERE id = ${id}
  `;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    const history = await sql `
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
app.post("/api/autopilot/settings", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = autopilotSettingsSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [agent] = await sql `
    UPDATE agents
    SET
      auto_buy_enabled = COALESCE(${body.autoBuyEnabled ?? null}, auto_buy_enabled),
      max_auto_deal_price = CASE
        WHEN ${body.maxAutoDealPrice !== undefined} THEN ${body.maxAutoDealPrice ?? null}
        ELSE max_auto_deal_price
      END,
      auto_buy_categories = CASE
        WHEN ${body.autoBuyCategories !== undefined} THEN ${body.autoBuyCategories ?? null}::text[]
        ELSE auto_buy_categories
      END
    WHERE id = ${body.agentId}
    RETURNING id, auto_buy_enabled, max_auto_deal_price, auto_buy_categories
  `;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    await audit(body.agentId, "autopilot.settings.update", "agent", body.agentId, idem, body);
    return agent;
});
app.post("/api/offers", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = createOfferSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const location = body.location ?? null;
    const [offer] = await sql `
    INSERT INTO offers (
      agent_id, title, description_md, category, tags, base_price, currency, max_price_delta_pct, sla_days, proofs_json, fulfillment_type, location
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags}, ${body.basePrice},
      ${body.currency}, ${body.maxPriceDeltaPct}, ${body.slaDays}, ${JSON.stringify(body.proofs)}::jsonb, ${body.fulfillmentType}, ${location}::jsonb
    )
    RETURNING *
  `;
    await audit(body.agentId, "offer.create", "offer", offer.id, idem, body);
    // Fire-and-forget: don't block the response on N×M match recomputation
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after offer.create"));
    return reply.code(201).send(offer);
});
app.patch("/api/offers/:id", async (request, reply) => {
    const { id } = request.params;
    const body = createOfferSchema.partial().parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const [existingOffer] = await sql `SELECT agent_id FROM offers WHERE id = ${id}`;
    if (!existingOffer || existingOffer.agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    const title = body.title ?? null;
    const descriptionMd = body.descriptionMd ?? null;
    const category = body.category ?? null;
    const tags = body.tags ?? null;
    const basePrice = body.basePrice ?? null;
    const maxPriceDeltaPct = body.maxPriceDeltaPct ?? null;
    const slaDays = body.slaDays ?? null;
    const proofsJson = body.proofs ? JSON.stringify(body.proofs) : null;
    const fulfillmentType = body.fulfillmentType ?? null;
    const location = body.location ?? null;
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
      fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
      location = COALESCE(${location}::jsonb, location),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
    // Fire-and-forget: don't block the response on N×M match recomputation
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after offer.update"));
    return offer;
});
app.post("/api/offers/:id/archive", async (request, reply) => {
    const { id } = request.params;
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const [existingOffer] = await sql `SELECT agent_id FROM offers WHERE id = ${id}`;
    if (!existingOffer || existingOffer.agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    const [offer] = await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
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
    const rows = await sql `
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
    const { id } = request.params;
    const [offer] = await sql `SELECT * FROM offers WHERE id = ${id}`;
    if (!offer)
        return reply.code(404).send({ error: "Offer not found" });
    return offer;
});
app.post("/api/needs", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = createNeedSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const deadlineAt = body.deadlineAt ?? null;
    const location = body.location ?? null;
    const [need] = await sql `
    INSERT INTO needs (
      agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at, fulfillment_type, location
    ) VALUES (
      ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
      ${budgetMin}, ${budgetMax}, ${body.currency}, ${JSON.stringify(body.acceptanceCriteria)}::jsonb, ${deadlineAt}, ${body.fulfillmentType}, ${location}::jsonb
    ) RETURNING *
  `;
    await audit(body.agentId, "need.create", "need", need.id, idem, body);
    // Fire-and-forget: don't block the response on N×M match recomputation
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after need.create"));
    return reply.code(201).send(need);
});
app.patch("/api/needs/:id", async (request, reply) => {
    const { id } = request.params;
    const body = createNeedSchema.partial().parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const [existingNeed] = await sql `SELECT agent_id FROM needs WHERE id = ${id}`;
    if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    const title = body.title ?? null;
    const descriptionMd = body.descriptionMd ?? null;
    const category = body.category ?? null;
    const tags = body.tags ?? null;
    const budgetMin = body.budgetMin ?? null;
    const budgetMax = body.budgetMax ?? null;
    const acceptanceCriteria = body.acceptanceCriteria ? JSON.stringify(body.acceptanceCriteria) : null;
    const deadlineAt = body.deadlineAt ?? null;
    const fulfillmentType = body.fulfillmentType ?? null;
    const location = body.location ?? null;
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
      fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
      location = COALESCE(${location}::jsonb, location),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
    // Fire-and-forget: don't block the response on N×M match recomputation
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after need.update"));
    return need;
});
app.post("/api/needs/:id/archive", async (request, reply) => {
    const { id } = request.params;
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const [existingNeed] = await sql `SELECT agent_id FROM needs WHERE id = ${id}`;
    if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
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
    const q = z.object({
        agentId: z.string().uuid().optional(),
        limit: z.string().optional(),
        verifiedOnly: z.string().optional(),
    }).parse(request.query ?? {});
    const limit = Number(q.limit ?? 20);
    const verifiedOnly = parseBooleanish(q.verifiedOnly);
    const rows = await sql `
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
app.post("/api/autopilot/run", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = request.headers["x-admin-key"] || String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey)
        return reply.code(403).send({ error: "Invalid admin key" });
    const matchesComputed = await recomputeMatches();
    const candidateMatches = await sql `
    SELECT
      m.offer_id,
      m.need_id,
      m.score,
      o.agent_id AS seller_agent_id,
      o.base_price,
      o.max_price_delta_pct,
      o.category,
      o.title AS offer_title,
      n.agent_id AS buyer_agent_id,
      n.title AS need_title,
      n.acceptance_criteria,
      a.auto_buy_enabled,
      a.max_auto_deal_price,
      a.auto_buy_categories
    FROM matches m
    JOIN offers o ON o.id = m.offer_id
    JOIN needs n ON n.id = m.need_id
    JOIN agents a ON a.id = n.agent_id
    WHERE m.score >= 0.8
      AND o.status = 'active'
      AND n.status = 'open'
    ORDER BY m.score DESC
  `;
    const buyerIds = Array.from(new Set(candidateMatches.map((match) => String(match.buyer_agent_id))));
    const recentAutopilotEvents = buyerIds.length > 0
        ? await sql `
        SELECT actor_agent_id, COUNT(*)::int AS deal_count
        FROM audit_log
        WHERE action = 'autopilot.deal.proposed'
          AND created_at > NOW() - INTERVAL '1 hour'
          AND actor_agent_id = ANY(${buyerIds})
        GROUP BY actor_agent_id
      `
        : [];
    const recentDealsByBuyer = new Map(recentAutopilotEvents.map((row) => [String(row.actor_agent_id), Number(row.deal_count)]));
    let dealsProposed = 0;
    let skipped = 0;
    const runId = randomUUID();
    for (const match of candidateMatches) {
        const buyerAgentId = String(match.buyer_agent_id);
        const sellerAgentId = String(match.seller_agent_id);
        const offerId = String(match.offer_id);
        const needId = String(match.need_id);
        const negotiatedTotal = toNumber(match.base_price);
        if (!match.auto_buy_enabled) {
            skipped += 1;
            continue;
        }
        if (match.max_auto_deal_price !== null && match.max_auto_deal_price !== undefined && negotiatedTotal > toNumber(match.max_auto_deal_price)) {
            skipped += 1;
            continue;
        }
        const autoBuyCategories = Array.isArray(match.auto_buy_categories)
            ? match.auto_buy_categories.filter((value) => typeof value === "string")
            : null;
        if (autoBuyCategories && !autoBuyCategories.includes(String(match.category))) {
            skipped += 1;
            continue;
        }
        const dealsInWindow = recentDealsByBuyer.get(buyerAgentId) ?? 0;
        if (dealsInWindow >= 5) {
            skipped += 1;
            continue;
        }
        const [existingDeal] = await sql `
      SELECT id
      FROM deals
      WHERE offer_id = ${offerId}
        AND need_id = ${needId}
        AND status IN ('proposed', 'countered', 'accepted', 'active', 'delivered', 'disputed')
      LIMIT 1
    `;
        if (existingDeal) {
            skipped += 1;
            continue;
        }
        const acceptanceCriteria = Array.isArray(match.acceptance_criteria)
            ? match.acceptance_criteria.filter((value) => typeof value === "string")
            : [];
        const milestoneAcceptanceCriteria = acceptanceCriteria.length > 0
            ? acceptanceCriteria
            : [`Deliver work matching need ${needId}`];
        const proposal = proposeDealSchema.parse({
            buyerAgentId,
            sellerAgentId,
            offerId,
            needId,
            negotiatedTotal,
            maxPriceDeltaPct: toNumber(match.max_price_delta_pct),
            acceptanceTimeoutDays: 0,
            milestones: [
                {
                    idx: 1,
                    title: `Autopilot: ${String(match.offer_title ?? "Deliver service")}`,
                    amount: negotiatedTotal,
                    acceptanceCriteria: milestoneAcceptanceCriteria,
                },
            ],
        });
        try {
            const createdDeal = await createDealProposal(proposal, {
                idempotencyKey: `autopilot-run:${runId}:${offerId}:${needId}`,
                auditAction: "autopilot.deal.proposed",
                auditActorAgentId: buyerAgentId,
                negotiationActorAgentId: buyerAgentId,
                auditPayload: {
                    runId,
                    score: toNumber(match.score),
                    offerId,
                    needId,
                    buyerAgentId,
                    sellerAgentId,
                    negotiatedTotal,
                    source: "autopilot",
                },
            });
            recentDealsByBuyer.set(buyerAgentId, dealsInWindow + 1);
            dealsProposed += 1;
            notifyAgents(sql, [sellerAgentId], "deal.proposed", {
                dealId: String(createdDeal.id),
                buyerAgentId,
                sellerAgentId,
                negotiatedTotal,
                source: "autopilot",
            });
        }
        catch (error) {
            skipped += 1;
            request.log.error({
                err: error,
                offerId,
                needId,
            }, "autopilot.run failed to propose deal");
        }
    }
    return {
        matchesComputed,
        dealsProposed,
        skipped,
        runId,
    };
});
app.post("/api/embeddings/recompute", async (request, reply) => {
    if (!isSemanticMatchingEnabled()) {
        return reply.code(400).send({ error: "OPENAI_API_KEY is not configured" });
    }
    const offers = await sql `SELECT id, title, description_md, category, tags FROM offers`;
    const needs = await sql `SELECT id, title, description_md, category, tags FROM needs`;
    const offerTexts = offers.map((offer) => buildSemanticText(offer));
    const needTexts = needs.map((need) => buildSemanticText(need));
    const [offerEmbeddings, needEmbeddings] = await Promise.all([
        generateEmbeddings(offerTexts),
        generateEmbeddings(needTexts),
    ]);
    await sql.begin(async (txn) => {
        for (let i = 0; i < offers.length; i += 1) {
            await txn.unsafe(`
          UPDATE offers
          SET description_embedding = $1::jsonb
          WHERE id = $2
        `, [JSON.stringify(offerEmbeddings[i]), offers[i].id]);
        }
        for (let i = 0; i < needs.length; i += 1) {
            await txn.unsafe(`
          UPDATE needs
          SET description_embedding = $1::jsonb
          WHERE id = $2
        `, [JSON.stringify(needEmbeddings[i]), needs[i].id]);
        }
    });
    return {
        offersUpdated: offers.length,
        needsUpdated: needs.length,
        totalUpdated: offers.length + needs.length,
    };
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.buyerAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [offerOwner] = await sql `SELECT agent_id FROM offers WHERE id = ${body.offerId}`;
    if (!offerOwner || offerOwner.agent_id !== body.sellerAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    const [needOwner] = await sql `SELECT agent_id FROM needs WHERE id = ${body.needId}`;
    if (!needOwner || needOwner.agent_id !== body.buyerAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    const result = await createDealProposal(body, {
        idempotencyKey: idem,
        auditAction: "deal.propose",
        auditActorAgentId: body.buyerAgentId,
        negotiationActorAgentId: body.buyerAgentId,
        auditPayload: body,
    });
    notifyAgents(sql, [body.sellerAgentId], "deal.proposed", {
        dealId: result.id,
        buyerAgentId: body.buyerAgentId,
        sellerAgentId: body.sellerAgentId,
        negotiatedTotal: body.negotiatedTotal,
    });
    return reply.code(201).send(result);
});
app.post("/api/deals/:id/counter", async (request, reply) => {
    const { id } = request.params;
    const requestBody = request.body && typeof request.body === "object" ? request.body : {};
    const body = counterDealSchema.parse({ ...requestBody, dealId: id });
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.actorAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.actorAgentId !== deal.buyer_agent_id && body.actorAgentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Not authorized" });
    }
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
app.post("/api/deals/:id/accept", async (request, reply) => {
    const { id } = request.params;
    const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.actorAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    // LEFT JOIN so deals without an offer (e.g. counter-proposed) still resolve
    const [deal] = await sql `
    SELECT d.buyer_agent_id, d.seller_agent_id, d.status,
           COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type
    FROM deals d
    LEFT JOIN offers o ON o.id = d.offer_id
    WHERE d.id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    // Idempotency: if already active, return ok without re-running the transaction
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
            // CAS-style update: only succeeds if still in an acceptable status
            const [updated] = await txn.unsafe("UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1 AND status IN ('proposed', 'countered') RETURNING id", [id]);
            if (!updated) {
                throw new Error(`Deal ${id} status changed concurrently — accept aborted`);
            }
            await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
            await txn.unsafe(`
          INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status)
          VALUES ($1, $2, 'pending')
          ON CONFLICT (deal_id) DO NOTHING
        `, [id, deal.fulfillment_type]);
            await txn.unsafe(`
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'accept', $3::jsonb)
        `, [id, body.actorAgentId, JSON.stringify(body)]);
        });
    }
    catch (err) {
        app.log.error({ err, dealId: id }, "deal.accept transaction failed — deal status NOT changed");
        return reply.code(500).send({ error: "Failed to accept deal — please retry" });
    }
    // Fire-and-forget notification (don't let webhook errors fail the accept)
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.accepted", {
        dealId: id,
        acceptedBy: body.actorAgentId,
        fulfillmentType: deal.fulfillment_type,
        sellerActionRequired: "Provide fulfillment details via /api/deals/:id/fulfillment",
    });
    return { ok: true };
});
app.post("/api/deals/:id/cancel", async (request, reply) => {
    const { id } = request.params;
    const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.actorAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    await sql.begin(async (txn) => {
        await txn.unsafe("UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
        await txn.unsafe("UPDATE milestones SET status = 'cancelled' WHERE deal_id = $1", [id]);
        await txn.unsafe(`
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'cancel', $3::jsonb)
      `, [id, body.actorAgentId, JSON.stringify(body)]);
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
    const { id } = request.params;
    const body = provideFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `
    SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
    FROM deals d
    JOIN offers o ON o.id = d.offer_id
    WHERE d.id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.seller_agent_id)
        return reply.code(403).send({ error: "Only seller can provide fulfillment details" });
    if (!["active", "delivered", "completed"].includes(String(deal.status))) {
        return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept fulfillment details` });
    }
    const typeKey = String(deal.fulfillment_type);
    const typeConfig = FULFILLMENT_TYPES[typeKey] ?? FULFILLMENT_TYPES.generic;
    const parsedData = typeConfig.schema.parse(body.fulfillmentData);
    const parsedRecord = asRecord(parsedData);
    const expiresAt = typeof parsedData === "object" && parsedData !== null && "expires_at" in parsedData
        ? parsedData.expires_at ?? null
        : null;
    const autoVerifyResult = typeConfig.autoVerify
        ? await autoVerify(typeConfig.autoVerify, parsedData)
        : { success: true, details: "No auto-verification available for this type" };
    const [fulfillment] = await sql `
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
    const redactedData = await vaultStore(vaultSql, String(fulfillment.id), typeKey, parsedRecord, credentialEncryptionKey);
    const encryptedFields = Object.entries(redactedData)
        .filter(([, value]) => value === "[encrypted]")
        .map(([field]) => field);
    const [stored] = await sql `
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
    // ── Instant auto-complete: if acceptance_timeout_days = 0, close the deal immediately ──
    const [dealFull] = await sql `SELECT acceptance_timeout_days FROM deals WHERE id = ${id}`;
    if (Number(dealFull?.acceptance_timeout_days ?? 7) === 0) {
        try {
            await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')`;
            await completeDealMilestones(id, { skipOnChainRelease: false });
            await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
            notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
                dealId: id, reason: "acceptance_timeout_days=0 — instant auto-complete on fulfillment",
            });
            notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
                dealId: id,
                message: "Deal complete! Leave feedback via POST /api/feedback to build your reputation.",
                feedbackUrl: "https://api.agentpact.xyz/api/feedback",
                buyerAgentId: deal.buyer_agent_id,
                sellerAgentId: deal.seller_agent_id,
            });
            const [completedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
            return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields, auto_completed: true, deal: completedDeal });
        }
        catch (autoErr) {
            console.error("[fulfillment] Auto-complete failed:", autoErr.message);
            // Fall through — return fulfillment as normal, deal not auto-completed
        }
    }
    return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields });
});
app.post("/api/deals/:id/fulfillment/buyer", async (request, reply) => {
    const { id } = request.params;
    const body = provideBuyerFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `
    SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
    FROM deals d
    JOIN offers o ON o.id = d.offer_id
    WHERE d.id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id)
        return reply.code(403).send({ error: "Only buyer can provide buyer fulfillment context" });
    if (!["active", "delivered", "completed"].includes(String(deal.status))) {
        return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept buyer fulfillment context` });
    }
    const typeKey = String(deal.fulfillment_type);
    const parsedRecord = asRecord(body.buyerData);
    const [fulfillment] = await sql `
    INSERT INTO deal_fulfillment (
      deal_id, fulfillment_type, buyer_data, status, updated_at
    ) VALUES (
      ${id}, ${typeKey}, '{}'::jsonb, 'pending', NOW()
    )
    ON CONFLICT (deal_id) DO UPDATE SET
      fulfillment_type = EXCLUDED.fulfillment_type,
      updated_at = NOW()
    RETURNING *
  `;
    const redactedData = await storeBuyerContext(String(fulfillment.id), typeKey, parsedRecord);
    const encryptedFields = Object.entries(redactedData)
        .filter(([, value]) => value === "[encrypted]")
        .map(([field]) => field);
    const [stored] = await sql `
    UPDATE deal_fulfillment
    SET buyer_data = ${redactedData}::jsonb, updated_at = NOW()
    WHERE id = ${fulfillment.id}
    RETURNING *
  `;
    notifyAgents(sql, [deal.seller_agent_id], "deal.buyer_context_provided", {
        dealId: id,
        buyerAgentId: body.agentId,
        fulfillmentType: typeKey,
        encryptedFields,
    });
    return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields });
});
app.get("/api/deals/:id/fulfillment", async (request, reply) => {
    const { id } = request.params;
    const query = getFulfillmentSchema.parse(request.query ?? {});
    const [deal] = await sql `
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (query.agentId !== deal.buyer_agent_id && query.agentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Not authorized for this deal" });
    }
    const [fulfillment] = await sql `SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!fulfillment)
        return reply.code(404).send({ error: "Fulfillment not found" });
    const checked = await applyFulfillmentExpiryChecks({ id: String(deal.id), buyer_agent_id: String(deal.buyer_agent_id), seller_agent_id: String(deal.seller_agent_id) }, {
        ...fulfillment,
        id: String(fulfillment.id),
        status: String(fulfillment.status),
        expires_at: fulfillment.expires_at ?? null,
        last_expiry_warning_at: fulfillment.last_expiry_warning_at ?? null,
    });
    const isBuyer = query.agentId === deal.buyer_agent_id;
    const canDecryptBuyerData = isBuyer || query.decrypt;
    const rawBuyerData = checked.buyer_data;
    const buyerDataRecord = asRecord(rawBuyerData);
    const fulfillmentDataRecord = asRecord(checked.fulfillment_data);
    let fulfillmentData = fulfillmentDataRecord;
    if (query.decrypt) {
        fulfillmentData = await vaultRetrieve(vaultSql, String(checked.id), fulfillmentDataRecord, credentialEncryptionKey);
    }
    let buyerData = rawBuyerData === null ? null : buyerDataRecord;
    if (canDecryptBuyerData && (Object.keys(buyerDataRecord).length > 0 || rawBuyerData !== null)) {
        buyerData = await retrieveBuyerContext(String(checked.id), buyerDataRecord);
    }
    if (query.decrypt) {
        await logCredentialAccess(String(checked.id), query.agentId, "decrypt", request.ip);
    }
    return { ...checked, fulfillment_data: fulfillmentData, buyer_data: buyerData };
});
app.post("/api/deals/:id/fulfillment/rotate", async (request, reply) => {
    const { id } = request.params;
    const body = rotateCredentialSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Only seller can rotate credentials" });
    }
    const [fulfillment] = await sql `SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!fulfillment)
        return reply.code(404).send({ error: "Fulfillment not found" });
    await vaultRotate(vaultSql, String(fulfillment.id), body.fieldName, body.newValue, credentialEncryptionKey);
    await logCredentialAccess(String(fulfillment.id), body.agentId, "rotate", request.ip);
    const [updated] = await sql `
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
    const { id } = request.params;
    const query = z.object({ agentId: z.string().uuid() }).parse(request.query ?? {});
    await ensureCredentialVaultSchema(vaultSql);
    const [deal] = await sql `
    SELECT id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (query.agentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Only seller can view fulfillment audit logs" });
    }
    const [fulfillment] = await sql `SELECT id FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!fulfillment)
        return reply.code(404).send({ error: "Fulfillment not found" });
    const logs = await sql `
    SELECT id, fulfillment_id, agent_id, action, ip_address, created_at
    FROM credential_access_log
    WHERE fulfillment_id = ${fulfillment.id}
    ORDER BY created_at DESC
  `;
    return logs;
});
app.post("/api/deals/:id/fulfillment/request-rotation", async (request, reply) => {
    const { id } = request.params;
    const body = requestRotationSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    await ensureCredentialVaultSchema(vaultSql);
    const [deal] = await sql `
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id) {
        return reply.code(403).send({ error: "Only buyer can request credential rotation" });
    }
    const [updated] = await sql `
    UPDATE deal_fulfillment
    SET rotation_requested_at = NOW(), updated_at = NOW()
    WHERE deal_id = ${id}
    RETURNING *
  `;
    if (!updated)
        return reply.code(404).send({ error: "Fulfillment not found" });
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
    const { id } = request.params;
    const body = verifyFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id)
        return reply.code(403).send({ error: "Only buyer can verify fulfillment" });
    const [existing] = await sql `SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!existing)
        return reply.code(404).send({ error: "Fulfillment not found" });
    const verificationPayload = JSON.stringify({
        buyerVerification: {
            accepted: body.accepted,
            notes: body.notes ?? null,
            verifiedAt: new Date().toISOString(),
        },
    });
    const [updated] = await sql `
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
        if (body.completeOnVerify) {
            await completeDealMilestones(id, { skipOnChainRelease: false });
        }
        notifyAgents(sql, [deal.seller_agent_id], "deal.fulfillment_verified", {
            dealId: id,
            buyerAgentId: body.agentId,
            accepted: true,
            notes: body.notes,
        });
    }
    return updated;
});
app.post("/api/deals/:id/confirm-delivery", async (request, reply) => {
    try {
        const { id } = request.params;
        const idem = idempotencyKey(request.headers);
        const body = confirmDeliverySchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const rating = body.rating ?? 5;
        const [deal] = await sql `
    SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
    FROM deals
    WHERE id = ${id}
  `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.buyer_agent_id) {
            return reply.code(403).send({ error: "Only buyer can confirm delivery" });
        }
        if (!["active", "delivered"].includes(String(deal.status))) {
            return reply.code(400).send({ error: `Deal status ${deal.status} cannot be confirmed` });
        }
        const [fulfillment] = await sql `
    SELECT id, status
    FROM deal_fulfillment
    WHERE deal_id = ${id}
  `;
        if (!fulfillment)
            return reply.code(404).send({ error: "Fulfillment not found" });
        if (!["provided", "active", "verified"].includes(String(fulfillment.status))) {
            return reply.code(400).send({ error: `Fulfillment status ${fulfillment.status} cannot be confirmed` });
        }
        await sql `
    UPDATE deal_fulfillment
    SET status = 'verified', updated_at = NOW()
    WHERE deal_id = ${id}
  `;
        const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: body.skipOnChainRelease });
        // Auto-archive the associated offer when deal completes
        if (deal.offer_id) {
            await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
        }
        await audit(body.agentId, "deal.buyer_review", "deal", id, idem, {
            dealId: id,
            rating,
            notes: body.notes ?? null,
        });
        await sql `
    UPDATE agents
    SET reputation_score = LEAST(COALESCE(reputation_score, 0) + (${rating} / 10.0), 9.999)
    WHERE id = ${deal.seller_agent_id}
  `;
        notifyAgents(sql, [deal.seller_agent_id], "deal.delivery_confirmed", {
            dealId: id,
            buyerAgentId: body.agentId,
            rating,
            notes: body.notes ?? null,
            releaseAction: releaseResult.action,
        });
        // Prompt both parties for detailed feedback
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
            dealId: id,
            message: "Deal completed! Please leave feedback for your counterpart via POST /api/feedback",
            feedbackUrl: `https://api.agentpact.xyz/api/feedback`,
            buyerAgentId: deal.buyer_agent_id,
            sellerAgentId: deal.seller_agent_id,
        });
        const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
        const milestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
        const events = await sql `SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
        return {
            ...updatedDeal,
            milestones,
            events,
            release: releaseResult,
        };
    }
    catch (err) {
        console.error("[confirm-delivery] Error:", err.message, err.stack);
        return reply.code(500).send({ error: "Internal server error", detail: err.message });
    }
});
// ── Simplified deal close (one-call completion for buyers) ──────────
app.post("/api/deals/:id/close", async (request, reply) => {
    try {
        const { id } = request.params;
        const idem = idempotencyKey(request.headers);
        const body = z.object({
            agentId: z.string().uuid(),
            rating: z.number().min(1).max(5).optional(),
            notes: z.string().optional(),
            skipOnChainRelease: z.boolean().optional().default(false),
        }).parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const rating = body.rating ?? 5;
        const [deal] = await sql `
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
      FROM deals WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.buyer_agent_id) {
            return reply.code(403).send({ error: "Only buyer can close a deal" });
        }
        if (!["active", "delivered", "proposed", "countered"].includes(String(deal.status))) {
            return reply.code(400).send({ error: `Deal status '${deal.status}' cannot be closed` });
        }
        // Mark any pending fulfillment as verified
        await sql `
      UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW()
      WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')
    `;
        const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: body.skipOnChainRelease });
        if (deal.offer_id) {
            await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
        }
        await audit(body.agentId, "deal.close", "deal", id, idem, { dealId: id, rating, notes: body.notes ?? null });
        await sql `
      UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + (${rating} / 10.0), 9.999)
      WHERE id = ${deal.seller_agent_id}
    `;
        notifyAgents(sql, [deal.seller_agent_id], "deal.closed", {
            dealId: id, buyerAgentId: body.agentId, rating, notes: body.notes ?? null, releaseAction: releaseResult.action,
        });
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
            dealId: id,
            message: "Deal closed! Leave feedback via POST /api/feedback",
            feedbackUrl: "https://api.agentpact.xyz/api/feedback",
            buyerAgentId: deal.buyer_agent_id,
            sellerAgentId: deal.seller_agent_id,
        });
        const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
        const milestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
        return { ...updatedDeal, milestones, release: releaseResult };
    }
    catch (err) {
        console.error("[deal/close] Error:", err.message, err.stack);
        return reply.code(500).send({ error: "Internal server error", detail: err.message });
    }
});
// ── Auto-complete timed-out delivered deals (cron-friendly) ─────────
app.post("/api/deals/:id/fulfillment/auto-complete", async (request, reply) => {
    const { id } = request.params;
    const [deal] = await sql `
    SELECT id, status, buyer_agent_id, seller_agent_id, offer_id, acceptance_timeout_days, updated_at
    FROM deals WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (!["delivered", "active"].includes(String(deal.status))) {
        return { ok: false, reason: `Deal status '${deal.status}' is not eligible for auto-complete` };
    }
    const timeoutDays = Number(deal.acceptance_timeout_days ?? 7);
    const updatedAt = new Date(deal.updated_at);
    const expiredAt = new Date(updatedAt.getTime() + timeoutDays * 24 * 60 * 60 * 1000);
    const force = request.query.force === "true";
    if (!force && new Date() < expiredAt) {
        return { ok: false, reason: `Acceptance timeout not reached. Expires at ${expiredAt.toISOString()}`, expiresAt: expiredAt.toISOString() };
    }
    await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')`;
    await completeDealMilestones(id, { skipOnChainRelease: false });
    if (deal.offer_id) {
        await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }
    await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
        dealId: id, reason: "Acceptance timeout reached — deal auto-completed", expiredAt: expiredAt.toISOString(),
    });
    const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
    return { ok: true, completed: true, deal: updatedDeal };
});
// ── Batch auto-complete all timed-out delivered deals (admin/cron) ──
app.post("/api/admin/auto-complete-timeouts", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = request.headers["x-admin-key"] || String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey)
        return reply.code(403).send({ error: "Invalid admin key" });
    const expiredDeals = await sql `
    SELECT id, acceptance_timeout_days, updated_at, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE status IN ('delivered', 'active')
      AND updated_at < NOW() - (COALESCE(acceptance_timeout_days, 7) || ' days')::interval
  `;
    const results = [];
    for (const deal of expiredDeals) {
        try {
            await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${deal.id} AND status NOT IN ('verified', 'revoked')`;
            await completeDealMilestones(String(deal.id), { skipOnChainRelease: false });
            await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
            notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
                dealId: String(deal.id),
                message: "Deal auto-completed! Leave feedback via POST /api/feedback to build your reputation.",
                feedbackUrl: "https://api.agentpact.xyz/api/feedback",
            });
            results.push({ dealId: deal.id, completed: true });
        }
        catch (err) {
            results.push({ dealId: deal.id, completed: false, error: err.message });
        }
    }
    return { processed: results.length, results };
});
// ── Admin: Force-close specific deal (no timeout check) ─────────────
app.post("/api/admin/force-close", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = request.headers["x-admin-key"] || String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey)
        return reply.code(403).send({ error: "Invalid admin key" });
    const body = z.object({
        dealId: z.string().uuid(),
        reason: z.string().optional().default("Admin force-close"),
    }).parse(request.body);
    const [deal] = await sql `
    SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
    FROM deals WHERE id = ${body.dealId}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (deal.status === "completed")
        return { ok: true, alreadyCompleted: true };
    await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${body.dealId} AND status NOT IN ('verified', 'revoked')`;
    const releaseResult = await completeDealMilestones(body.dealId, { skipOnChainRelease: false });
    if (deal.offer_id) {
        await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }
    await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
        dealId: body.dealId, reason: body.reason,
    });
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
        dealId: body.dealId,
        message: "Deal closed! Leave feedback via POST /api/feedback to build your reputation.",
        feedbackUrl: "https://api.agentpact.xyz/api/feedback",
        buyerAgentId: deal.buyer_agent_id,
        sellerAgentId: deal.seller_agent_id,
    });
    const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${body.dealId}`;
    return { ok: true, deal: updatedDeal, release: releaseResult };
});
app.post("/api/deals/:id/fulfillment/revoke", async (request, reply) => {
    const { id } = request.params;
    const body = revokeFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `
    SELECT id, buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${id}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.seller_agent_id)
        return reply.code(403).send({ error: "Only seller can revoke fulfillment" });
    const [updated] = await sql `
    UPDATE deal_fulfillment
    SET status = 'revoked', updated_at = NOW()
    WHERE deal_id = ${id}
    RETURNING *
  `;
    if (!updated)
        return reply.code(404).send({ error: "Fulfillment not found" });
    await logCredentialAccess(String(updated.id), body.agentId, "revoke", request.ip);
    notifyAgents(sql, [deal.buyer_agent_id], "deal.fulfillment_revoked", {
        dealId: id,
        sellerAgentId: body.agentId,
        status: "revoked",
    });
    return updated;
});
app.post("/api/payments/create-intent", async (request, reply) => {
    const idem = idempotencyKey(request.headers);
    const body = createPaymentIntentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.buyerAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const mode = isOnChainMode() ? "on-chain" : "simulation";
    const [milestone] = await sql `
    SELECT m.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id, d.status AS deal_status, a.owner_wallet_address AS seller_wallet_address
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    JOIN agents a ON a.id = d.seller_agent_id
    WHERE m.id = ${body.milestoneId}
  `;
    if (!milestone)
        return reply.code(404).send({ error: "Milestone not found" });
    if (milestone.buyer_agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    if (!["in_progress", "pending"].includes(milestone.status)) {
        return reply.code(400).send({ error: `Milestone status ${milestone.status} cannot be funded` });
    }
    if (mode === "on-chain") {
        // Generate unsigned transaction data for the buyer to sign
        const txData = generateFundingTransaction(milestone.deal_id, body.milestoneId, Number(milestone.amount), milestone.seller_wallet_address);
        const [intent] = await sql `
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
    const [intent] = await sql `
    INSERT INTO payment_intents (
      milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
      buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address, tx_hash
    ) VALUES (
      ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id}, ${milestone.amount}, 'USDC', ${body.chain}, 'funded',
      ${body.walletProvider}, ${body.buyerWalletAddress}, ${milestone.seller_wallet_address}, ${PLATFORM_WALLET}, ${`sim_fund_${randomUUID().slice(0, 8)}`}
    )
    RETURNING *
  `;
    await sql `UPDATE milestones SET status = 'funded' WHERE id = ${body.milestoneId}`;
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
    return rows.map((r) => ({ ...r, mode: isOnChainMode() ? "on-chain" : "simulation" }));
});
// ── Confirm on-chain funding ─────────────────────────────────────────
const confirmFundingSchema = z.object({
    paymentIntentId: z.string().uuid(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
app.post("/api/payments/confirm-funding", async (request, reply) => {
    const body = confirmFundingSchema.parse(request.body);
    const idem = idempotencyKey(request.headers);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const [intent] = await sql `
    SELECT * FROM payment_intents WHERE id = ${body.paymentIntentId}
  `;
    if (!intent)
        return reply.code(404).send({ error: "Payment intent not found" });
    if (intent.buyer_agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    if (intent.status !== "created") {
        return reply.code(400).send({ error: `Intent status is ${intent.status}, expected created` });
    }
    // Verify on-chain
    const verification = await verifyFunding(body.txHash);
    if (!verification.verified) {
        return reply.code(400).send({ error: "Transaction not verified on-chain — failed or not confirmed" });
    }
    // Update intent + milestone status
    await sql.begin(async (txn) => {
        await txn.unsafe(`UPDATE payment_intents SET status = 'funded', tx_hash = $1, updated_at = NOW() WHERE id = $2`, [body.txHash, body.paymentIntentId]);
        await txn.unsafe(`UPDATE milestones SET status = 'funded' WHERE id = $1`, [intent.milestone_id]);
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
    const q = request.query;
    if (!q.milestoneId)
        return reply.code(400).send({ error: "Provide milestoneId" });
    if (!isOnChainMode()) {
        return { mode: "simulation", message: "On-chain status not available in simulation mode" };
    }
    const status = await getMilestoneStatus(q.milestoneId);
    return { mode: "on-chain", ...status };
});
app.post("/api/payments/release", async (request, reply) => {
    const body = z.object({ milestoneId: z.string().uuid() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const [milestone] = await sql `
    SELECT d.buyer_agent_id
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    WHERE m.id = ${body.milestoneId}
  `;
    if (!milestone)
        return reply.code(404).send({ error: "Milestone not found" });
    if (milestone.buyer_agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    const mode = isOnChainMode() ? "on-chain" : "simulation";
    const [intent] = await sql `SELECT * FROM payment_intents WHERE id = ${body.paymentIntentId}`;
    if (!intent)
        return reply.code(404).send({ error: "Payment intent not found" });
    if (intent.buyer_agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    if (mode === "on-chain") {
        // On-chain refund: the milestone must first be disputed (buyer calls openDispute),
        // then the platform resolves the dispute in the buyer's favor.
        // Check if we can do it:
        try {
            const onChainStatus = await getMilestoneStatus(intent.milestone_id);
            if (onChainStatus.exists && onChainStatus.status === "Disputed") {
                // Platform resolves dispute — refund buyer
                const { txHash } = await resolveDisputeOnChain(intent.milestone_id, true);
                await sql `
          UPDATE payment_intents
          SET status = 'refunded', updated_at = NOW(), tx_hash = ${txHash}
          WHERE id = ${body.paymentIntentId}
        `;
                await sql `UPDATE milestones SET status = 'cancelled' WHERE id = ${intent.milestone_id}`;
                return { ok: true, mode, txHash, action: "refunded_on_chain" };
            }
            // Milestone not disputed — can't refund on-chain yet; mark as pending
            await sql `
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
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return reply.code(500).send({ error: `On-chain refund failed: ${message}` });
        }
    }
    // Simulation mode
    await sql `
    UPDATE payment_intents
    SET status = 'refunded', updated_at = NOW(), tx_hash = ${`sim_refund_${randomUUID().slice(0, 8)}`}
    WHERE id = ${body.paymentIntentId}
  `;
    return { ok: true, mode };
});
app.post("/api/deliveries/submit", async (request, reply) => {
    const body = submitDeliverySchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.submittedBy !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [submissionAuth] = await sql `
    SELECT d.seller_agent_id
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    WHERE m.id = ${body.milestoneId}
  `;
    if (!submissionAuth)
        return reply.code(404).send({ error: "Milestone not found" });
    if (submissionAuth.seller_agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.buyerAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [verificationAuth] = await sql `
    SELECT d.buyer_agent_id
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    WHERE m.id = ${body.milestoneId}
  `;
    if (!verificationAuth)
        return reply.code(404).send({ error: "Milestone not found" });
    if (verificationAuth.buyer_agent_id !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized" });
    }
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
    // Look up deal to notify buyer
    const [milestoneInfo] = await sql `
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.openedBy !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${body.dealId}`;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Not authorized" });
    }
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
// ── Admin: Force-release stuck on-chain milestones ──────────────────
// Uses resolveDispute(milestoneId, false) to pay seller when funds are stuck in escrow.
// Protected by ADMIN_API_KEY env var.
app.post("/api/admin/force-release", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey)
        return reply.code(503).send({ error: "Admin API not configured" });
    const authHeader = request.headers["x-admin-key"] || request.headers["authorization"]?.replace("Bearer ", "");
    if (authHeader !== adminKey)
        return reply.code(403).send({ error: "Invalid admin key" });
    const body = z.object({
        milestoneId: z.string().uuid(),
        reason: z.string().optional(),
    }).parse(request.body);
    const [milestone] = await sql `
    SELECT m.*, d.id AS deal_id, d.status AS deal_status, d.seller_agent_id
    FROM milestones m
    JOIN deals d ON d.id = m.deal_id
    WHERE m.id = ${body.milestoneId}
  `;
    if (!milestone)
        return reply.code(404).send({ error: "Milestone not found" });
    const mode = isOnChainMode() ? "on-chain" : "simulation";
    let txHash = null;
    if (mode === "on-chain") {
        try {
            const result = await resolveDisputeOnChain(body.milestoneId, false);
            txHash = result.txHash;
        }
        catch (err) {
            // If dispute resolution fails (e.g. milestone not in disputed state on-chain),
            // log and continue with DB update
            console.error(`[admin/force-release] On-chain resolveDispute failed: ${err.message}`);
        }
    }
    // Update DB regardless
    await sql `UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = ${body.milestoneId}`;
    await sql `UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${milestone.deal_id}`;
    await sql `UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ${body.milestoneId} AND status = 'funded'`;
    console.log(`[admin/force-release] Milestone ${body.milestoneId} released. Reason: ${body.reason || "admin action"}. TxHash: ${txHash || "N/A"}`);
    return {
        ok: true,
        milestoneId: body.milestoneId,
        dealId: milestone.deal_id,
        mode,
        txHash,
        reason: body.reason || "admin force-release",
    };
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
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId)
        return;
    if (body.fromAgentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql `
    SELECT buyer_agent_id, seller_agent_id
    FROM deals
    WHERE id = ${body.dealId}
  `;
    if (!deal)
        return reply.code(404).send({ error: "Deal not found" });
    if (body.fromAgentId !== deal.buyer_agent_id && body.fromAgentId !== deal.seller_agent_id) {
        return reply.code(403).send({ error: "Not authorized" });
    }
    if (body.toAgentId !== deal.buyer_agent_id && body.toAgentId !== deal.seller_agent_id) {
        return reply.code(400).send({ error: "Feedback target must be a participant in the deal" });
    }
    if (body.fromAgentId === body.toAgentId) {
        return reply.code(400).send({ error: "Feedback target must differ from author" });
    }
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
    else if (sortBy === "skills")
        orderClause = "skill_verification_count DESC";
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
            skillsVerified: row.skills_verified,
            verificationCount: Number(row.skill_verification_count),
            totalVolume: Number(Number(row.total_volume).toFixed(2)),
            disputeRate: totalDeals > 0 ? Number((disputedDeals / totalDeals).toFixed(4)) : 0,
            memberSince: row.member_since,
        };
    });
});
// ── Agent Reputation as a Service (RaaS) ─────────────────────────────────────
// All GET endpoints are intentionally public — that's the point of RaaS.
/**
 * Compute composite RaaS score (0–100) with weighted breakdown.
 * dealHistory 40% | reviewAvg 30% | disputeRate 20% | accountAge 10%
 */
function computeRaaSScore(completedDeals, avgRating, // 0–5
totalDeals, disputedDeals, memberSinceMs) {
    // Deal history: saturates at 50 completed deals → 100 pts
    const dealHistory = Math.min(completedDeals / 50, 1) * 100;
    // Review average: 0–5 → 0–100
    const reviewAvg = (avgRating / 5) * 100;
    // Dispute rate: 0 disputes → 100, 50%+ dispute rate → 0
    const disputeRate = totalDeals > 0
        ? Math.max(0, (1 - (disputedDeals / totalDeals) * 2)) * 100
        : 100; // no deals → no disputes → full score
    // Account age: saturates at 1 year → 100 pts
    const ageMs = Date.now() - memberSinceMs;
    const accountAge = Math.min(ageMs / (365 * 24 * 60 * 60 * 1000), 1) * 100;
    const score = dealHistory * 0.4 +
        reviewAvg * 0.3 +
        disputeRate * 0.2 +
        accountAge * 0.1;
    return {
        score: Number(score.toFixed(2)),
        breakdown: {
            dealHistory: Number(dealHistory.toFixed(2)),
            reviewAvg: Number(reviewAvg.toFixed(2)),
            disputeRate: Number(disputeRate.toFixed(2)),
            accountAge: Number(accountAge.toFixed(2)),
        },
    };
}
/**
 * Compute badges for an agent based on their stats.
 */
function computeBadges(opts) {
    const badges = [];
    const ageMs = Date.now() - opts.memberSinceMs;
    const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);
    if (ageMonths <= 3)
        badges.push("early-adopter");
    if (opts.completedDeals >= 50)
        badges.push("high-volume");
    if (opts.totalVolume >= 10000)
        badges.push("big-earner");
    if (opts.disputedDeals === 0 && opts.totalDeals >= 5)
        badges.push("zero-disputes");
    if (opts.reviewCount >= 20)
        badges.push("well-reviewed");
    if (opts.endorsementCount >= 5)
        badges.push("trusted-peer");
    if (opts.completedDeals >= 100)
        badges.push("century-club");
    return badges;
}
// GET /api/reputation/leaderboard — public RaaS leaderboard with tier distribution
app.get("/api/reputation/leaderboard", async (request) => {
    const q = request.query;
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const tierFilter = q.tier ?? null;
    const rows = await sql `
    SELECT
      a.id AS agent_id,
      a.display_name AS name,
      a.created_at AS member_since,
      COALESCE(f.avg_score, 0) AS avg_rating,
      COALESCE(f.review_count, 0)::int AS review_count,
      COALESCE(ds.completed_deals, 0)::int AS completed_deals,
      COALESCE(ds.total_volume, 0) AS total_volume,
      COALESCE(ds.disputed_deals, 0)::int AS disputed_deals,
      COALESCE(ds.total_deals, 0)::int AS total_deals,
      COALESCE(e.endorsement_count, 0)::int AS endorsement_count
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
      WHERE d.buyer_agent_id = a.id OR d.seller_agent_id = a.id
    ) ds ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS endorsement_count
      FROM endorsements WHERE endorsed_id = a.id
    ) e ON true
    ORDER BY a.reputation_score DESC, a.created_at ASC
    LIMIT ${limit}
  `;
    const entries = rows.map((row, idx) => {
        const completedDeals = Number(row.completed_deals);
        const avgRating = Number(row.avg_rating);
        const { score, breakdown } = computeRaaSScore(completedDeals, avgRating, Number(row.total_deals), Number(row.disputed_deals), new Date(row.member_since).getTime());
        const trustTier = computeTrustTier(completedDeals, avgRating);
        return {
            rank: idx + 1,
            agentId: row.agent_id,
            name: row.name,
            trustTier: trustTier.tier,
            score,
            breakdown,
            avgRating: Number(Number(avgRating).toFixed(2)),
            reviewCount: Number(row.review_count),
            completedDeals,
            totalVolume: Number(Number(row.total_volume).toFixed(2)),
            endorsementCount: Number(row.endorsement_count),
            memberSince: row.member_since,
        };
    });
    // Tier distribution summary
    const tierDist = { gold: 0, silver: 0, bronze: 0, new: 0 };
    for (const e of entries) {
        tierDist[e.trustTier] = (tierDist[e.trustTier] ?? 0) + 1;
    }
    const filtered = tierFilter
        ? entries.filter(e => e.trustTier === tierFilter)
        : entries;
    return {
        leaderboard: filtered,
        meta: {
            total: filtered.length,
            tierDistribution: tierDist,
        },
    };
});
// GET /api/reputation/:agentId — Full public reputation profile
app.get("/api/reputation/:agentId", async (request, reply) => {
    const { agentId } = request.params;
    const [agent] = await sql `SELECT id, display_name, created_at FROM agents WHERE id = ${agentId}`;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    const [feedback] = await sql `
    SELECT
      COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS avg_rating,
      COUNT(*)::int AS review_count
    FROM feedback
    WHERE to_agent_id = ${agentId}
  `;
    const [dealStats] = await sql `
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_deals,
      COALESCE(SUM(negotiated_total) FILTER (WHERE status = 'completed'), 0) AS total_volume,
      COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed_deals,
      COUNT(*)::int AS total_deals
    FROM deals
    WHERE buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}
  `;
    const [endorseStats] = await sql `
    SELECT COUNT(*)::int AS endorsement_count
    FROM endorsements
    WHERE endorsed_id = ${agentId}
  `;
    const completedDeals = Number(dealStats.completed_deals);
    const avgRating = Number(feedback.avg_rating);
    const totalVolume = Number(Number(dealStats.total_volume).toFixed(2));
    const reviewCount = Number(feedback.review_count);
    const disputedDeals = Number(dealStats.disputed_deals);
    const totalDeals = Number(dealStats.total_deals);
    const endorsementCount = Number(endorseStats.endorsement_count);
    const memberSinceMs = new Date(agent.created_at).getTime();
    const { score, breakdown } = computeRaaSScore(completedDeals, avgRating, totalDeals, disputedDeals, memberSinceMs);
    const trustTier = computeTrustTier(completedDeals, avgRating);
    const badges = computeBadges({
        completedDeals, totalVolume, disputedDeals, totalDeals, reviewCount, memberSinceMs, endorsementCount,
    });
    return {
        agentId,
        displayName: agent.display_name,
        memberSince: agent.created_at,
        completedDeals,
        totalVolume,
        avgRating: Number(avgRating.toFixed(2)),
        reviewCount,
        disputedDeals,
        totalDeals,
        disputeRate: totalDeals > 0 ? Number((disputedDeals / totalDeals).toFixed(4)) : 0,
        endorsementCount,
        score,
        trustTier: {
            tier: trustTier.tier,
            label: trustTier.label,
            color: trustTier.color,
            thresholds: TRUST_TIERS.map(t => ({
                tier: t.tier,
                minDeals: t.minDeals,
                minReputation: t.minReputation,
            })),
        },
        scoreBreakdown: breakdown,
        badges,
    };
});
// GET /api/reputation/:agentId/attestation — HMAC-signed attestation for external verification
app.get("/api/reputation/:agentId/attestation", async (request, reply) => {
    const { agentId } = request.params;
    const [agent] = await sql `SELECT id, display_name, created_at FROM agents WHERE id = ${agentId}`;
    if (!agent)
        return reply.code(404).send({ error: "Agent not found" });
    const [feedback] = await sql `
    SELECT
      COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS avg_rating
    FROM feedback
    WHERE to_agent_id = ${agentId}
  `;
    const [dealStats] = await sql `
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_deals,
      COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed_deals,
      COUNT(*)::int AS total_deals
    FROM deals
    WHERE buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}
  `;
    const completedDeals = Number(dealStats.completed_deals);
    const avgRating = Number(feedback.avg_rating);
    const { score } = computeRaaSScore(completedDeals, avgRating, Number(dealStats.total_deals), Number(dealStats.disputed_deals), new Date(agent.created_at).getTime());
    const trustTier = computeTrustTier(completedDeals, avgRating);
    const timestamp = new Date().toISOString();
    const signingKey = process.env.PLATFORM_SIGNING_KEY ?? "agentpact-dev-signing-key";
    const payload = {
        agentId,
        score,
        tier: trustTier.tier,
        completedDeals,
        avgRating: Number(avgRating.toFixed(2)),
        timestamp,
        issuer: "agentpact.xyz",
    };
    const signature = createHmac("sha256", signingKey)
        .update(JSON.stringify(payload))
        .digest("hex");
    return {
        ...payload,
        signature,
        verificationInstructions: "HMAC-SHA256 over JSON.stringify(payload without .signature) using PLATFORM_SIGNING_KEY",
    };
});
// POST /api/reputation/:agentId/endorse — Agent-to-agent endorsement (requires auth)
app.post("/api/reputation/:agentId/endorse", async (request, reply) => {
    const { agentId } = request.params;
    const body = z.object({
        skillTag: z.string().min(2).max(64),
        message: z.string().max(500).optional(),
    }).parse(request.body);
    const endorserId = request.agentId;
    if (!endorserId)
        return reply.code(401).send({ error: "Authentication required" });
    if (endorserId === agentId)
        return reply.code(400).send({ error: "Cannot endorse yourself" });
    const [target] = await sql `SELECT id FROM agents WHERE id = ${agentId}`;
    if (!target)
        return reply.code(404).send({ error: "Agent not found" });
    // Check if endorser has completed at least one deal with the endorsed agent
    const [sharedDeal] = await sql `
    SELECT id FROM deals
    WHERE status = 'completed'
      AND (
        (buyer_agent_id = ${endorserId} AND seller_agent_id = ${agentId}) OR
        (buyer_agent_id = ${agentId} AND seller_agent_id = ${endorserId})
      )
    LIMIT 1
  `;
    if (!sharedDeal) {
        return reply.code(403).send({ error: "You must have completed at least one deal with this agent to endorse them" });
    }
    // Upsert endorsement (one endorsement per skill tag per pair)
    const [endorsement] = await sql `
    INSERT INTO endorsements (endorser_id, endorsed_id, skill_tag, message)
    VALUES (${endorserId}, ${agentId}, ${body.skillTag}, ${body.message ?? null})
    ON CONFLICT (endorser_id, endorsed_id, skill_tag) DO UPDATE SET
      message = EXCLUDED.message,
      created_at = NOW()
    RETURNING *
  `;
    return reply.code(201).send({
        endorsement,
        message: "Endorsement recorded successfully",
    });
});
app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (error.validation || error.name === "ZodError") {
        const details = error.issues ?? error.validation;
        return reply.code(400).send({ error: 'Validation error', details });
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
