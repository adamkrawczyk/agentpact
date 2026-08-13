import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeaders } from "./helpers/testApp.js";

async function getAuthHeadersForAgent(agentId: string): Promise<Record<string, string>> {
  const { app } = await createTestApp();
  const registerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      agentId,
      walletAddress: `0x${agentId.replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
    },
  });
  const body = JSON.parse(registerRes.body) as { apiKey: string };
  return { "x-api-key": body.apiKey };
}

describe("Security ownership checks", () => {
  let bootstrapHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    bootstrapHeaders = await getAuthHeaders();
  });

  async function setupDealFixture() {
    const { app, sql } = await createTestApp();

    // Distinct canonical agents: register each under its own UUID, then set its
    // branded profile with ITS OWN headers. (Post issue-#75 fix, POST /api/agents
    // updates the caller's canonical row keyed on the authenticated agent id, so
    // three profiles require three distinct authenticated identities — not three
    // calls under one bootstrap header.)
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const attackerId = randomUUID();

    const buyerHeaders = await getAuthHeadersForAgent(buyerId);
    const sellerHeaders = await getAuthHeadersForAgent(sellerId);
    const attackerHeaders = await getAuthHeadersForAgent(attackerId);

    for (const [headers, id] of [
      [buyerHeaders, buyerId],
      [sellerHeaders, sellerId],
      [attackerHeaders, attackerId],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers,
        payload: generateTestAgent(),
      });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { id: string }).id).toBe(id);
    }

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), fulfillmentType: "generic" },
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), fulfillmentType: "generic" },
    });
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    const proposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 120,
        maxPriceDeltaPct: 20,
        milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }],
      },
    });
    const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: sellerId,
        fulfillmentData: { description: "ready" },
      },
    });

    const [milestone] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;

    await app.inject({
      method: "POST",
      url: "/api/payments/create-intent",
      headers: buyerHeaders,
      payload: {
        milestoneId: milestone.id,
        buyerAgentId: buyerId,
        walletProvider: "metamask",
        buyerWalletAddress: "0x1234567890123456789012345678901234567890",
        chain: "base",
      },
    });

    return {
      app,
      buyerId,
      sellerId,
      attackerId,
      offerId,
      needId,
      dealId,
      buyerHeaders,
      sellerHeaders,
      attackerHeaders,
    };
  }

  it("blocks confirming delivery as another agent", async () => {
    const { app, dealId, buyerId, attackerHeaders } = await setupDealFixture();

    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/confirm-delivery`,
      headers: attackerHeaders,
      payload: {
        agentId: buyerId,
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("blocks proposing a deal as another agent", async () => {
    const { app, buyerId, sellerId, offerId, needId, attackerHeaders } = await setupDealFixture();

    const response = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: attackerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 130,
        maxPriceDeltaPct: 20,
        milestones: [{ idx: 1, title: "Follow-up", amount: 130, acceptanceCriteria: ["Done"] }],
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("blocks leaving feedback as another agent", async () => {
    const { app, dealId, buyerId, sellerId, attackerHeaders } = await setupDealFixture();

    const response = await app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: attackerHeaders,
      payload: {
        dealId,
        fromAgentId: buyerId,
        toAgentId: sellerId,
        ratingQuality: 5,
        ratingTimeliness: 5,
        ratingCommunication: 5,
        ratingAccuracy: 5,
        comment: "impersonated",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("blocks archiving another agent's offer", async () => {
    const { app, offerId, attackerHeaders } = await setupDealFixture();

    const response = await app.inject({
      method: "POST",
      url: `/api/offers/${offerId}/archive`,
      headers: attackerHeaders,
    });

    expect(response.statusCode).toBe(403);
  });
});
