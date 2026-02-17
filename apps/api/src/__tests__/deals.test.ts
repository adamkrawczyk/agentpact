import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Deals API", () => {
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;
  let buyerId: string;
  let sellerId: string;
  let offerId: string;
  let needId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId)
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId)
    });
    needId = (JSON.parse(needRes.body) as { id: string }).id;
  });

  describe("POST /api/deals/propose", () => {
    it("should create a new deal and milestones", async () => {
      const { app, sql } = await createTestApp();
      const payload = {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 120,
        maxPriceDeltaPct: 20,
        milestones: [
          { idx: 1, title: "Phase 1", amount: 60, acceptanceCriteria: ["Deliver part 1"] },
          { idx: 2, title: "Phase 2", amount: 60, acceptanceCriteria: ["Deliver part 2"] }
        ]
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/deals/propose",
        headers: buyerHeaders,
        payload
      });
      expect(response.statusCode).toBe(201);

      const [deal] = await sql`
        SELECT id, status FROM deals
        WHERE buyer_agent_id = ${buyerId} AND seller_agent_id = ${sellerId}
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(deal).toBeTruthy();
      expect(deal.status).toBe("proposed");

      const milestones = await sql`SELECT * FROM milestones WHERE deal_id = ${deal.id}`;
      expect(milestones.length).toBe(2);
    });
  });

  describe("POST /api/deals/:id/accept", () => {
    it("should move deal to active", async () => {
      const { app, sql } = await createTestApp();
      await app.inject({
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
          milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }]
        }
      });

      const [deal] = await sql`
        SELECT id FROM deals
        WHERE buyer_agent_id = ${buyerId} AND seller_agent_id = ${sellerId}
        ORDER BY created_at DESC LIMIT 1
      `;

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${deal.id}/accept`,
        headers: sellerHeaders,
        payload: { actorAgentId: sellerId }
      });
      expect(response.statusCode).toBe(200);

      const [updated] = await sql`SELECT status FROM deals WHERE id = ${deal.id}`;
      expect(updated.status).toBe("active");
    });
  });

  describe("POST /api/deals/:id/confirm-delivery", () => {
    async function setupAcceptedDealWithFunding() {
      const { app, sql } = await createTestApp();

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
          milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }]
        }
      });
      const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

      await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/accept`,
        headers: sellerHeaders,
        payload: { actorAgentId: sellerId }
      });

      const provideRes = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/fulfillment`,
        headers: sellerHeaders,
        payload: {
          agentId: sellerId,
          fulfillmentData: {
            description: "Delivery provided for test coverage"
          }
        }
      });
      expect(provideRes.statusCode).toBe(200);

      const [milestone] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
      expect(milestone).toBeTruthy();

      const fundRes = await app.inject({
        method: "POST",
        url: "/api/payments/create-intent",
        headers: buyerHeaders,
        payload: {
          milestoneId: milestone.id,
          buyerAgentId: buyerId,
          walletProvider: "metamask",
          buyerWalletAddress: "0x1234567890123456789012345678901234567890",
          chain: "base"
        }
      });
      expect(fundRes.statusCode).toBe(201);

      return { app, sql, dealId };
    }

    it("confirm-delivery returns 200 and completes deal for buyer", async () => {
      const { app, sql, dealId } = await setupAcceptedDealWithFunding();

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/confirm-delivery`,
        headers: buyerHeaders,
        payload: {
          agentId: buyerId,
          rating: 5,
          notes: "Looks good"
        }
      });

      expect(response.statusCode).toBe(200);

      const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
      expect(deal.status).toBe("completed");

      const [fulfillment] = await sql`SELECT status FROM deal_fulfillment WHERE deal_id = ${dealId}`;
      expect(fulfillment.status).toBe("verified");
    });

    it("confirm-delivery returns 403 for non-buyer", async () => {
      const { app, dealId } = await setupAcceptedDealWithFunding();

      const outsiderId = randomUUID();
      const outsiderHeaders = await getAuthHeadersForAgent(outsiderId);

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/confirm-delivery`,
        headers: outsiderHeaders,
        payload: {
          agentId: outsiderId
        }
      });

      expect(response.statusCode).toBe(403);
    });

    it("confirm-delivery returns 400 for wrong deal status", async () => {
      const { app } = await createTestApp();

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
          milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }]
        }
      });
      const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/confirm-delivery`,
        headers: buyerHeaders,
        payload: {
          agentId: buyerId
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it("confirm-delivery updates reputation_score", async () => {
      const { app, sql, dealId } = await setupAcceptedDealWithFunding();
      const [before] = await sql`SELECT reputation_score FROM agents WHERE id = ${sellerId}`;
      const beforeScore = Number(before.reputation_score ?? 0);

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/confirm-delivery`,
        headers: buyerHeaders,
        payload: {
          agentId: buyerId,
          rating: 4
        }
      });

      expect(response.statusCode).toBe(200);

      const [after] = await sql`SELECT reputation_score FROM agents WHERE id = ${sellerId}`;
      const afterScore = Number(after.reputation_score ?? 0);
      expect(afterScore).toBe(beforeScore + 4);
    });
  });
});
