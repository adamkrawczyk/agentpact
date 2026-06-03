import type { Sql } from "postgres";
import type { notifyAgents } from "../webhooks.js";
import type { autoVerify } from "../auto-verify.js";
import type { FULFILLMENT_TYPES, TRUST_TIERS } from "./utils.js";

export type CompleteDealMilestonesResult = {
  mode: "simulation" | "on-chain";
  action: "released" | "buyer_sign_required" | "completed_without_onchain_release" | "settlement_pending";
  txData?: Array<{ milestoneId: string; to: string; data: string; value: string; description: string }>;
  onChainReleaseResults?: Array<{ milestoneId: string; txHash?: string; error?: string }>;
};

export interface Deps {
  computeTrustTier: (completedDeals: number, reputationScore: number) => { tier: string; label: string; color: string };
  getAgentStats: (db: Sql<Record<string, unknown>>, agentId: string) => Promise<{ completedDeals: number; reputationScore: number }>;
  notifyAgents: typeof notifyAgents;
  autoVerify: typeof autoVerify;
  FULFILLMENT_TYPES: typeof FULFILLMENT_TYPES;
  PLATFORM_FEE_PCT: number;
  PLATFORM_WALLET: string;
  credentialEncryptionKey: Buffer;
  vaultSql: Sql<Record<string, unknown>>;
  TRUST_TIERS: typeof TRUST_TIERS;
  completeDealMilestones: (dealId: string, opts?: { skipOnChainRelease?: boolean; skipPaymentRelease?: boolean }) => Promise<CompleteDealMilestonesResult>;
  storeBuyerContext: (fulfillmentId: string, fulfillmentType: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
  retrieveBuyerContext: (fulfillmentId: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
