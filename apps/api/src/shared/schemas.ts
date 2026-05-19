import { z } from "zod";

export const walletProviderSchema = z.enum(["metamask", "walletconnect", "coinbase", "phantom", "other"]);

export const milestoneSchema = z.object({
  idx: z.number().int().positive(),
  title: z.string().min(2),
  amount: z.number().min(0),
  acceptanceCriteria: z.array(z.string()).min(1),
  dueAt: z.string().datetime().optional(),
});

export const fulfillmentTypeSchema = z.enum([
  "api-access",
  "code-task",
  "data-delivery",
  "compute-access",
  "consulting",
  "physical-service",
  "generic",
]);

export const locationSchema = z
  .object({
    city: z.string().min(1).optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    remote: z.boolean().optional(),
  })
  .optional();

export const createOfferSchema = z.object({
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
  acceptanceTimeoutDays: z.number().int().min(0).max(30).default(0),
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
  milestones: z.array(milestoneSchema).min(1),
});

export const createPaymentIntentSchema = z.object({
  milestoneId: z.string().uuid(),
  buyerAgentId: z.string().uuid(),
  walletProvider: walletProviderSchema,
  buyerWalletAddress: z.string().min(4),
  chain: z.string().default("base"),
});

export const submitDeliverySchema = z.object({
  milestoneId: z.string().uuid(),
  submittedBy: z.string().uuid(),
  artifacts: z
    .array(
      z.object({
        type: z.string(),
        url: z.string().url(),
        hash: z.string().optional(),
      })
    )
    .min(1),
  notes: z.string().optional(),
});

export const verifyDeliverySchema = z.object({
  milestoneId: z.string().uuid(),
  buyerAgentId: z.string().uuid(),
  accepted: z.boolean(),
  verificationNotes: z.string().optional(),
});

export function parseBooleanish(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export const provideFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  fulfillmentData: z.record(z.any()),
});

export const provideBuyerFulfillmentSchema = z.object({
  agentId: z.string().uuid(),
  buyerData: z.record(z.any()),
});

export const getFulfillmentSchema = z
  .object({
    agentId: z.string().uuid(),
    decrypt: z
      .preprocess((v) => parseBooleanish(v), z.boolean())
      .optional()
      .default(false),
    reveal: z
      .preprocess((v) => parseBooleanish(v), z.boolean())
      .optional(),
  })
  .transform((data) => ({
    agentId: data.agentId,
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
  comment: z.string().optional(),
});

export const disputeSchema = z.object({
  dealId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  openedBy: z.string().uuid(),
  reason: z.string().min(5),
  evidence: z.array(z.record(z.any())).default([]),
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

export const TRUST_TIERS = [
  { tier: "gold", label: "Gold", minDeals: 25, minReputation: 4.0, color: "#FFD700" },
  { tier: "silver", label: "Silver", minDeals: 10, minReputation: 3.5, color: "#C0C0C0" },
  { tier: "bronze", label: "Bronze", minDeals: 3, minReputation: 3.0, color: "#CD7F32" },
  { tier: "new", label: "New", minDeals: 0, minReputation: 0, color: "#888888" },
] as const;

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
  "physical-service": {
    label: "Physical Service",
    description:
      "On-site service requiring physical presence (repair, installation, delivery, inspection)",
    fields: {
      service_type: {
        type: "enum",
        values: ["repair", "installation", "delivery", "inspection", "cleaning", "other"],
        required: true,
      },
      service_date: { type: "string", format: "datetime", required: true },
      secret_address: { type: "string", required: true },
      secret_access_notes: { type: "string", required: false },
      contact_method: { type: "enum", values: ["phone", "email", "in-app"], required: false },
      secret_contact_value: { type: "string", required: false },
      proof_type: {
        type: "enum",
        values: ["photo", "video", "signed-confirmation", "none"],
        required: false,
      },
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
    schema: z
      .object({
        description: z.string().min(10),
        artifact_urls: z.array(z.string().url()).optional(),
        instructions: z.string().optional(),
        expires_at: z.string().datetime().optional(),
      })
      .passthrough(),
    autoVerify: null,
  },
} as const;
