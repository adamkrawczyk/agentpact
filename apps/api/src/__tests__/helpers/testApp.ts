import { randomUUID } from "node:crypto";
import { app, sql } from "../../index.js";

const TEST_AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

export async function createTestApp() {
  return { app, sql };
}

export async function getAuthHeaders() {
  return getAuthHeadersForAgent(TEST_AGENT_ID);
}

export async function getAuthHeadersForAgent(agentId: string, options?: { walletAddress?: string | null }) {
  const payload: { agentId: string; walletAddress?: string | null } = {
    agentId
  };
  if (options && "walletAddress" in options) {
    payload.walletAddress = options.walletAddress;
  } else {
    payload.walletAddress = "0x1234567890123456789012345678901234567890";
  }

  const registerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload
  });
  const { apiKey } = JSON.parse(registerRes.body) as { apiKey: string };
  return { "x-api-key": apiKey };
}

export function generateTestAgent(overrides: Partial<{ handle: string; displayName: string; ownerWalletAddress: string; walletProvider: "metamask"; autoBuyEnabled: boolean }> = {}) {
  return {
    handle: `test-agent-${randomUUID().slice(0, 8)}`,
    displayName: "Test Agent",
    ownerWalletAddress: `0x${randomUUID().replace(/-/g, "")}${randomUUID().slice(0, 8)}`.slice(0, 42),
    walletProvider: "metamask" as const,
    autoBuyEnabled: false,
    ...overrides,
  };
}

export function generateTestOffer(agentId?: string) {
  return {
    ...(agentId ? { agentId } : {}),
    title: `Test Offer ${randomUUID().slice(0, 8)}`,
    descriptionMd: "This is a test offer for automated testing.",
    category: "Testing",
    tags: ["test", "automation"],
    basePrice: 100,
    currency: "USDC" as const,
    maxPriceDeltaPct: 15,
    slaDays: 7,
    proofs: []
  };
}

export function generateTestNeed(agentId: string) {
  return {
    agentId,
    title: `Test Need ${randomUUID().slice(0, 8)}`,
    descriptionMd: "This is a test need for automated testing.",
    category: "Testing",
    tags: ["test", "automation"],
    budgetMax: 150,
    currency: "USDC" as const,
    acceptanceCriteria: []
  };
}

export async function cleanDatabase() {
  await sql`TRUNCATE TABLE
    notification_log, agent_webhooks,
    deal_fulfillment, consultation_responses,
    disputes, feedback, deliveries, payment_intents,
    negotiation_events, milestones, deals, matches,
    needs, offers, alert_subscriptions, agent_credentials, agents, audit_log,
    api_usage, credential_access_log, credential_vault,
    endorsements, skill_verifications, skill_challenges,
    concierge_messages, concierge_relay_log
    RESTART IDENTITY CASCADE`;
}
