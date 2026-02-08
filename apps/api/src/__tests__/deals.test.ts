import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeaders } from "./helpers/testApp.js";

describe("Deals API", () => {
  let authHeaders: Record<string, string>;
  let buyerId: string;
  let sellerId: string;
  let offerId: string;
  let needId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    authHeaders = await getAuthHeaders();

    const buyerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders,
      payload: generateTestAgent()
    });
    buyerId = (JSON.parse(buyerRes.body) as { id: string }).id;

    const sellerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders,
      payload: generateTestAgent()
    });
    sellerId = (JSON.parse(sellerRes.body) as { id: string }).id;

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: authHeaders,
      payload: generateTestOffer(sellerId)
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: authHeaders,
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
        headers: authHeaders,
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
        headers: authHeaders,
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
        headers: authHeaders,
        payload: { actorAgentId: sellerId }
      });
      expect(response.statusCode).toBe(200);

      const [updated] = await sql`SELECT status FROM deals WHERE id = ${deal.id}`;
      expect(updated.status).toBe("active");
    });
  });
});
