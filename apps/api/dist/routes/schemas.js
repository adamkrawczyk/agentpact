import { z } from "zod";
import { parseBooleanish } from "./utils.js";
export const walletProviderSchema = z.enum(["metamask", "walletconnect", "coinbase", "phantom", "other"]);
export const milestoneSchema = z.object({
    idx: z.number().int().positive(),
    title: z.string().min(2),
    amount: z.number().min(0),
    acceptanceCriteria: z.array(z.string()).min(1),
    dueAt: z.string().datetime().optional()
});
export const fulfillmentTypeSchema = z.enum([
    "api-access",
    "code-task",
    "data-delivery",
    "compute-access",
    "consulting",
    "consultation",
    "physical-service",
    "generic",
]);
export const locationSchema = z.object({
    city: z.string().min(1).optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    remote: z.boolean().optional(),
}).optional();
const baseOfferSchema = z.object({
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
    maxRespondents: z.number().int().positive().max(20).optional(),
    timeLimitMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
    location: locationSchema,
});
export const createOfferSchema = baseOfferSchema.superRefine((value, ctx) => {
    if (value.fulfillmentType !== "consultation") {
        return;
    }
    if (!value.maxRespondents) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "maxRespondents is required for consultation offers",
            path: ["maxRespondents"],
        });
    }
    if (!value.timeLimitMinutes) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "timeLimitMinutes is required for consultation offers",
            path: ["timeLimitMinutes"],
        });
    }
});
export const updateOfferSchema = baseOfferSchema.partial().superRefine((value, ctx) => {
    if (value.fulfillmentType !== "consultation") {
        return;
    }
    if (value.maxRespondents !== undefined && value.maxRespondents <= 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "maxRespondents must be positive",
            path: ["maxRespondents"],
        });
    }
    if (value.timeLimitMinutes !== undefined && value.timeLimitMinutes <= 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "timeLimitMinutes must be positive",
            path: ["timeLimitMinutes"],
        });
    }
});
export const createNeedSchema = z.object({
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
export const proposeDealSchema = z.object({
    buyerAgentId: z.string().uuid(),
    sellerAgentId: z.string().uuid(),
    offerId: z.string().uuid(),
    needId: z.string().uuid(),
    negotiatedTotal: z.number().min(0),
    maxPriceDeltaPct: z.number().min(0).max(100),
    milestones: z.array(milestoneSchema).min(1),
    acceptanceTimeoutDays: z.number().int().min(0).max(30).default(7)
});
export const autopilotSettingsSchema = z.object({
    agentId: z.string().uuid(),
    autoBuyEnabled: z.boolean().optional(),
    maxAutoDealPrice: z.number().positive().nullable().optional(),
    autoBuyCategories: z.array(z.string().min(1)).nullable().optional(),
});
export const counterDealSchema = z.object({
    dealId: z.string().uuid(),
    actorAgentId: z.string().uuid(),
    negotiatedTotal: z.number().min(0),
    milestones: z.array(milestoneSchema).min(1)
});
/** Payment provider: crypto (USDC on-chain / simulation) or Stripe fiat. */
export const paymentProviderSchema = z.enum(["usdc", "stripe"]).default("usdc");
/** Supported blockchain networks for USDC payments. */
export const chainSchema = z.enum(["base", "arbitrum", "polygon", "solana"]).default("base");
export const createPaymentIntentSchema = z.discriminatedUnion("provider", [
    // ── USDC / on-chain (original path) ─────────────────────────────────────
    z.object({
        provider: z.literal("usdc").default("usdc"),
        milestoneId: z.string().uuid(),
        buyerAgentId: z.string().uuid(),
        walletProvider: walletProviderSchema,
        buyerWalletAddress: z.string().min(4),
        chain: chainSchema,
    }),
    // ── Stripe / fiat (new path) ─────────────────────────────────────────────
    z.object({
        provider: z.literal("stripe"),
        milestoneId: z.string().uuid(),
        buyerAgentId: z.string().uuid(),
        /** ISO 4217 lowercase, e.g. "usd", "eur". Defaults to "usd". */
        fiatCurrency: z.string().length(3).toLowerCase().default("usd"),
    }),
]);
export const submitDeliverySchema = z.object({
    milestoneId: z.string().uuid(),
    submittedBy: z.string().uuid(),
    artifacts: z.array(z.object({ type: z.string(), url: z.string().url(), hash: z.string().optional() })).min(1),
    notes: z.string().optional()
});
export const verifyDeliverySchema = z.object({
    milestoneId: z.string().uuid(),
    buyerAgentId: z.string().uuid(),
    accepted: z.boolean(),
    verificationNotes: z.string().optional()
});
export const provideFulfillmentSchema = z.object({
    agentId: z.string().uuid(),
    fulfillmentData: z.record(z.any()),
});
export const provideBuyerFulfillmentSchema = z.object({
    agentId: z.string().uuid(),
    buyerData: z.record(z.any()),
});
export const getFulfillmentSchema = z.object({
    decrypt: z.preprocess((v) => parseBooleanish(v), z.boolean()).optional().default(false),
    reveal: z.preprocess((v) => parseBooleanish(v), z.boolean()).optional(),
}).transform((data) => ({
    decrypt: data.decrypt || data.reveal || false,
}));
export const rotateCredentialSchema = z.object({
    agentId: z.string().uuid(),
    fieldName: z.string().min(1),
    newValue: z.string().min(1),
});
export const requestRotationSchema = z.object({
    agentId: z.string().uuid(),
    reason: z.string().min(1).optional(),
});
export const verifyFulfillmentSchema = z.object({
    agentId: z.string().uuid(),
    accepted: z.boolean(),
    completeOnVerify: z.boolean().optional(),
    notes: z.string().optional(),
});
export const confirmDeliverySchema = z.object({
    agentId: z.string().uuid(),
    rating: z.number().min(1).max(5).optional(),
    notes: z.string().optional(),
}).strict();
export const revokeFulfillmentSchema = z.object({
    agentId: z.string().uuid(),
});
export const feedbackSchema = z.object({
    dealId: z.string().uuid(),
    fromAgentId: z.string().uuid(),
    toAgentId: z.string().uuid(),
    ratingQuality: z.number().int().min(1).max(5),
    ratingTimeliness: z.number().int().min(1).max(5),
    ratingCommunication: z.number().int().min(1).max(5),
    ratingAccuracy: z.number().int().min(1).max(5),
    comment: z.string().optional()
});
export const consultationResponseSchema = z.object({
    agentId: z.string().uuid(),
    responseMd: z.string().min(10),
});
export const disputeSchema = z.object({
    dealId: z.string().uuid(),
    milestoneId: z.string().uuid(),
    openedBy: z.string().uuid(),
    reason: z.string().min(5),
    evidence: z.array(z.record(z.any())).default([])
});
export const challengeIdParamSchema = z.object({
    id: z.string().uuid(),
});
export const agentIdParamSchema = z.object({
    id: z.string().uuid(),
});
export const listChallengesQuerySchema = z.object({
    category: z.string().min(2).optional(),
});
export const onlineAgentsQuerySchema = z.object({
    category: z.string().min(1).optional(),
});
export const startChallengeSchema = z.object({
    agentId: z.string().uuid(),
});
export const submitChallengeSchema = z.object({
    agentId: z.string().uuid(),
    submission: z.record(z.any()),
});
export const confirmFundingSchema = z.object({
    paymentIntentId: z.string().uuid(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
/**
 * Browse query limits (WIS-256): prevent pathological planner cost
 * from unbounded tags/query parameters.
 */
export const MAX_TAGS_COUNT = 20;
export const MAX_TAG_LENGTH = 64;
export const MAX_QUERY_LENGTH = 200;
/**
 * Validate and parse tags from a comma-separated string.
 * Returns { tags: string[], error: string | null }
 */
export function parseAndValidateTags(tagsStr) {
    if (!tagsStr)
        return { tags: [], error: null };
    const tagsRaw = tagsStr.split(",").filter(Boolean);
    if (tagsRaw.length > MAX_TAGS_COUNT) {
        return { tags: [], error: `tags must contain at most ${MAX_TAGS_COUNT} items (got ${tagsRaw.length})` };
    }
    for (const tag of tagsRaw) {
        if (tag.length > MAX_TAG_LENGTH) {
            return { tags: [], error: `each tag must be at most ${MAX_TAG_LENGTH} characters (got ${tag.length}: "${tag.slice(0, 20)}...")` };
        }
    }
    return { tags: tagsRaw, error: null };
}
/**
 * Validate query length. Returns truncated query or throws.
 */
export function validateAndTruncateQuery(query) {
    if (!query)
        return "";
    const trimmed = query.trim();
    if (trimmed.length > MAX_QUERY_LENGTH) {
        throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters (got ${trimmed.length})`);
    }
    return trimmed;
}
