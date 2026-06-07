import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encrypt, decrypt, ensureCredentialVaultSchema, getSensitiveFields, } from "../credential-vault.js";
// ── Constants ────────────────────────────────────────────────────────
export const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
export const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";
export const BUYER_VAULT_PREFIX = "buyer__";
export const BROWSE_STATEMENT_TIMEOUT_MS = 4_000;
export const TRUST_TIERS = [
    { tier: "gold", label: "Gold", minDeals: 25, minReputation: 4.0, color: "#FFD700" },
    { tier: "silver", label: "Silver", minDeals: 10, minReputation: 3.5, color: "#C0C0C0" },
    { tier: "bronze", label: "Bronze", minDeals: 3, minReputation: 3.0, color: "#CD7F32" },
    { tier: "new", label: "New", minDeals: 0, minReputation: 0, color: "#888888" },
];
export const FULFILLMENT_TYPES = {
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
// ── Helper functions ─────────────────────────────────────────────────
export async function withBrowseStatementTimeout(sql, runQuery) {
    return sql.begin(async (txn) => {
        await txn.unsafe("SELECT set_config('statement_timeout', $1, true)", [`${BROWSE_STATEMENT_TIMEOUT_MS}ms`]);
        return runQuery(txn);
    });
}
export function computeTrustTier(completedDeals, reputationScore) {
    for (const t of TRUST_TIERS) {
        if (completedDeals >= t.minDeals && reputationScore >= t.minReputation) {
            return { tier: t.tier, label: t.label, color: t.color };
        }
    }
    return { tier: "new", label: "New", color: "#888888" };
}
export async function getAgentStats(db, agentId) {
    const [stats] = await db `
    SELECT
      (SELECT COUNT(*)::int FROM deals WHERE (buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}) AND status = 'completed') AS completed_deals,
      COALESCE((SELECT AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) FROM feedback WHERE to_agent_id = ${agentId}), 0) AS reputation_score
  `;
    return { completedDeals: Number(stats.completed_deals), reputationScore: Number(stats.reputation_score) };
}
export function idempotencyKey(headers) {
    return String(headers["idempotency-key"] ?? randomUUID());
}
export function toNumber(v) {
    return Number(v);
}
export function isZeroPrice(value) {
    return toNumber(value) === 0;
}
export function withReputationOnlyTag(tags) {
    const normalized = Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string")
        : [];
    return normalized.includes("reputation-only")
        ? normalized
        : [...normalized, "reputation-only"];
}
export function normalizeTags(tags) {
    return Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string")
        : [];
}
export function enrichOfferRow(offer) {
    const isFreeTier = isZeroPrice(offer.base_price);
    // Parse JSONB location if it's a string (postgres.js test env)
    if (typeof offer.location === "string") {
        try {
            offer = { ...offer, location: JSON.parse(offer.location) };
        }
        catch { }
    }
    return {
        ...offer,
        tags: isFreeTier ? withReputationOnlyTag(offer.tags) : normalizeTags(offer.tags),
        is_free_tier: isFreeTier,
        pricing_model: isFreeTier ? "reputation-only" : "paid",
    };
}
export function parseBooleanish(value) {
    if (typeof value !== "string")
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}
export function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
export async function sendFetchResponse(reply, response) {
    const headers = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    const bodyText = await response.text();
    reply.code(response.status).headers(headers);
    const contentType = response.headers.get("content-type") ?? "";
    if (bodyText.length === 0) {
        return reply.code(response.status).headers(headers).send();
    }
    if (contentType.includes("application/json") || contentType.includes("application/problem+json")) {
        return reply.code(response.status).headers(headers).send(JSON.parse(bodyText));
    }
    return reply.code(response.status).headers(headers).send(bodyText);
}
export function getRequesterAgentId(request, reply) {
    const requesterAgentId = request.agentId;
    if (!requesterAgentId) {
        reply.code(401).send({ error: "Missing API key" });
        return null;
    }
    return requesterAgentId;
}
export async function storeBuyerContext(sql, vaultSql, credentialEncryptionKey, fulfillmentId, fulfillmentType, data) {
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
export async function retrieveBuyerContext(sql, vaultSql, credentialEncryptionKey, fulfillmentId, data) {
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
export function expandPaymentRails(pref) {
    if (pref === "usdc")
        return new Set(["usdc"]);
    if (pref === "stripe")
        return new Set(["stripe"]);
    // 'both', null, undefined, or any unrecognized value → both rails.
    return new Set(["usdc", "stripe"]);
}
export function paymentRailsIntersect(a, b) {
    const ra = expandPaymentRails(a);
    const rb = expandPaymentRails(b);
    for (const rail of ra) {
        if (rb.has(rail))
            return true;
    }
    return false;
}
// tillopen_0306/P1 — payability gate (defense-in-depth; all layers share this
// ONE function so there is a single source of truth for "may this listing
// advertise this rail", never two checks that can drift).
//
// Rail status today:
//   - usdc   → LIVE. Requires a valid on-chain payout address
//              (agents.owner_wallet_address). Closes the confirmed latent bug
//              where a wallet-less seller's deal hit a NULL address at fund time.
//   - stripe → COMING SOON. Gated behind STRIPE_RAIL_ENABLED (default false).
//              The seller-payout side (Stripe Connect onboarding + payouts_enabled)
//              is built in P1d; until the env flag flips on, a stripe/both listing
//              is rejected at create with a clear "coming soon" message.
export const STRIPE_RAIL_ENABLED = parseBooleanish(process.env.STRIPE_RAIL_ENABLED);
/**
 * Minimal, dependency-free wallet sanity check (0x + 40 hex). We deliberately
 * do NOT import viem here (keeps utils unit-testable); the fund path still casts
 * to viem's Address, but for the payability GATE a syntactic EVM-address check
 * is the right strength — it rejects null/empty/garbage without passing a
 * malformed string down to createMilestone.
 */
export function isPayableWalletAddress(addr) {
    return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}
/**
 * The single payability decision point, shared by the create gate (offers +
 * needs), the propose gate (re-check on both parties — catches capability drift
 * after listing creation), and the fund guard (last-resort NULL-wallet block).
 *
 * `requestedRail` is the listing's accepted_payment_methods ('usdc'|'stripe'|
 * 'both'; null/undefined/unknown → treated as 'both' via expandPaymentRails, so
 * the gate is maximally protective). Returns ok:false + an actionable message on
 * the first unservable rail, else ok:true.
 */
export function checkListingPayable(requestedRail, opts) {
    const wanted = expandPaymentRails(requestedRail);
    // Stripe rail — coming soon until STRIPE_RAIL_ENABLED flips on in P1d, AND
    // (once enabled) the seller has a Stripe connected account with payouts.
    if (wanted.has("stripe")) {
        if (!STRIPE_RAIL_ENABLED) {
            return {
                ok: false,
                message: "The 'stripe' payment rail is coming soon — only 'usdc' is available right now. Create this listing with acceptedPaymentMethods:'usdc'.",
            };
        }
        if (!opts.stripePayoutsEnabled) {
            return {
                ok: false,
                message: "Complete Stripe payout onboarding before advertising the 'stripe' payment rail.",
            };
        }
    }
    // USDC rail — live; requires a valid payout wallet.
    if (wanted.has("usdc") && !isPayableWalletAddress(opts.walletAddress)) {
        return {
            ok: false,
            message: "Link a valid wallet address to your agent before advertising the 'usdc' payment rail.",
        };
    }
    return { ok: true };
}
