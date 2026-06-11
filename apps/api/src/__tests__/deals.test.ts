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

    it("should allow free-tier deals with zero total regardless of the offer base price", async () => {
      const { app, sql } = await createTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/deals/propose",
        headers: buyerHeaders,
        payload: {
          buyerAgentId: buyerId,
          sellerAgentId: sellerId,
          offerId,
          needId,
          negotiatedTotal: 0,
          maxPriceDeltaPct: 20,
          milestones: [{ idx: 1, title: "Reputation exchange", amount: 0, acceptanceCriteria: ["Done"] }]
        }
      });

      expect(response.statusCode).toBe(201);

      const [deal] = await sql`
        SELECT id, status, is_free_tier FROM deals
        WHERE buyer_agent_id = ${buyerId} AND seller_agent_id = ${sellerId}
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(deal.status).toBe("proposed");
      expect(deal.is_free_tier).toBe(true);
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

    it("should accept countered deals", async () => {
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

      const counterRes = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/counter`,
        headers: sellerHeaders,
        payload: {
          actorAgentId: sellerId,
          negotiatedTotal: 110,
          milestones: [{ idx: 1, title: "Counter delivery", amount: 110, acceptanceCriteria: ["Done"] }]
        }
      });
      expect(counterRes.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/accept`,
        headers: sellerHeaders,
        payload: { actorAgentId: sellerId }
      });
      expect(response.statusCode).toBe(200);

      const [deal] = await sql`SELECT status, negotiated_total FROM deals WHERE id = ${dealId}`;
      expect(deal.status).toBe("active");
      expect(Number(deal.negotiated_total)).toBe(110);
    });

    it("should move accepted free-tier deals directly to active without funding", async () => {
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
          negotiatedTotal: 0,
          maxPriceDeltaPct: 20,
          milestones: [{ idx: 1, title: "Delivery", amount: 0, acceptanceCriteria: ["Done"] }]
        }
      });
      const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/accept`,
        headers: sellerHeaders,
        payload: { actorAgentId: sellerId }
      });
      expect(response.statusCode).toBe(200);

      const [deal] = await sql`SELECT status, is_free_tier FROM deals WHERE id = ${dealId}`;
      expect(deal.status).toBe("active");
      expect(deal.is_free_tier).toBe(true);

      const [milestone] = await sql`SELECT id, status, amount FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
      expect(milestone.status).toBe("in_progress");
      expect(Number(milestone.amount)).toBe(0);

      const paymentIntents = await sql`SELECT id FROM payment_intents WHERE milestone_id = ${milestone.id}`;
      expect(paymentIntents).toHaveLength(0);
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
          provider: "usdc",
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
      expect(afterScore).toBe(beforeScore + 0.4);
    });

    it("confirm-delivery completes free-tier deals without releasing payment", async () => {
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
          negotiatedTotal: 0,
          maxPriceDeltaPct: 20,
          milestones: [{ idx: 1, title: "Reputation exchange", amount: 0, acceptanceCriteria: ["Done"] }]
        }
      });
      const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

      const acceptRes = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/accept`,
        headers: sellerHeaders,
        payload: { actorAgentId: sellerId }
      });
      expect(acceptRes.statusCode).toBe(200);

      const provideRes = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/fulfillment`,
        headers: sellerHeaders,
        payload: {
          agentId: sellerId,
          fulfillmentData: {
            description: "Free-tier delivery proof"
          }
        }
      });
      expect(provideRes.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/confirm-delivery`,
        headers: buyerHeaders,
        payload: {
          agentId: buyerId,
          rating: 5
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { release: { action: string } };
      expect(body.release.action).toBe("released");

      const [deal] = await sql`SELECT status, is_free_tier FROM deals WHERE id = ${dealId}`;
      expect(deal.status).toBe("completed");
      expect(deal.is_free_tier).toBe(true);

      const [milestone] = await sql`SELECT status FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
      expect(milestone.status).toBe("accepted");

      const paymentIntents = await sql`SELECT id FROM payment_intents WHERE milestone_id IN (SELECT id FROM milestones WHERE deal_id = ${dealId})`;
      expect(paymentIntents).toHaveLength(0);
    });
  });

  describe("POST /api/deals/:id/close", () => {
    it("should require verified fulfillment for free-tier deals before close", async () => {
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
          negotiatedTotal: 0,
          maxPriceDeltaPct: 20,
          milestones: [{ idx: 1, title: "Reputation exchange", amount: 0, acceptanceCriteria: ["Done"] }]
        }
      });
      const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

      const acceptRes = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/accept`,
        headers: sellerHeaders,
        payload: {
          actorAgentId: sellerId,
        }
      });
      expect(acceptRes.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/close`,
        headers: buyerHeaders,
        payload: {
          agentId: buyerId,
          rating: 5
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
