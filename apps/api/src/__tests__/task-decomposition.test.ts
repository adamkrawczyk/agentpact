import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

/**
 * Task decomposition: parent deal → N child deals.
 *
 * Covers:
 *  - POST /api/deals/decompose creates child deals linked to parent
 *  - child totals validated against parent budget
 *  - only parent buyer can decompose
 *  - child completion → parent resolution
 */
describe("task decomposition (parent → child deals)", () => {
  let buyerId: string;
  let seller1Id: string;
  let seller2Id: string;
  let buyerHeaders: Record<string, string>;
  let seller1Headers: Record<string, string>;
  let seller2Headers: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    seller1Id = randomUUID();
    seller2Id = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    seller1Headers = await getAuthHeadersForAgent(seller1Id);
    seller2Headers = await getAuthHeadersForAgent(seller2Id);
  });

  async function createOfferAndNeed(app: Awaited<ReturnType<typeof createTestApp>>["app"], sellerId: string, sellerHeaders: Record<string, string>) {
    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    return {
      offerId: (JSON.parse(offerRes.body) as { id: string }).id,
      needId: (JSON.parse(needRes.body) as { id: string }).id,
    };
  }

  it("decomposes a parent deal into child deals and tracks lineage", async () => {
    const { app, sql } = await createTestApp();

    // Create parent deal
    const { offerId: parentOfferId, needId: parentNeedId } = await createOfferAndNeed(app, seller1Id, seller1Headers);
    const parentRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: seller1Id,
        offerId: parentOfferId,
        needId: parentNeedId,
        negotiatedTotal: 200,
        maxPriceDeltaPct: 10,
        milestones: [{ idx: 1, title: "Full project", amount: 200, acceptanceCriteria: ["Done"] }],
      },
    });
    expect(parentRes.statusCode).toBe(201);
    const parentDealId = (JSON.parse(parentRes.body) as { id: string }).id;

    // Accept the parent deal
    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${parentDealId}/accept`,
      headers: seller1Headers,
      payload: { actorAgentId: seller1Id },
    });
    expect(acceptRes.statusCode).toBe(200);

    // Create offer/need for each child seller
    const { offerId: offer1Id, needId: need1Id } = await createOfferAndNeed(app, seller1Id, seller1Headers);
    const { offerId: offer2Id, needId: need2Id } = await createOfferAndNeed(app, seller2Id, seller2Headers);

    // Decompose
    const decomposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/decompose",
      headers: buyerHeaders,
      payload: {
        parentDealId,
        children: [
          { sellerAgentId: seller1Id, offerId: offer1Id, needId: need1Id, negotiatedTotal: 80, title: "Backend API" },
          { sellerAgentId: seller2Id, offerId: offer2Id, needId: need2Id, negotiatedTotal: 100, title: "Frontend UI" },
        ],
        maxPriceDeltaPct: 5,
        acceptanceTimeoutDays: 3,
      },
    });
    expect(decomposeRes.statusCode).toBe(201);
    const body = JSON.parse(decomposeRes.body) as { childDealIds: string[]; childCount: number; childTotal: number };
    expect(body.childCount).toBe(2);
    expect(body.childDealIds).toHaveLength(2);
    expect(body.childTotal).toBe(180);

    // Verify parent has child_deal_ids
    const [parent] = await sql`SELECT child_deal_ids FROM deals WHERE id = ${parentDealId}`;
    expect((parent.child_deal_ids as string[]).length).toBe(2);

    // Verify children have parent_deal_id
    for (const childId of body.childDealIds) {
      const [child] = await sql`SELECT parent_deal_id, buyer_agent_id FROM deals WHERE id = ${childId}`;
      expect(child.parent_deal_id).toBe(parentDealId);
      expect(child.buyer_agent_id).toBe(buyerId); // buyer of parent = buyer of children
    }
  });

  it("rejects decomposition exceeding parent budget", async () => {
    const { app } = await createTestApp();

    const { offerId, needId } = await createOfferAndNeed(app, seller1Id, seller1Headers);
    const parentRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: seller1Id,
        offerId,
        needId,
        negotiatedTotal: 100,
        maxPriceDeltaPct: 10,
        milestones: [{ idx: 1, title: "Full", amount: 100, acceptanceCriteria: ["Done"] }],
      },
    });
    const parentDealId = (JSON.parse(parentRes.body) as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/deals/${parentDealId}/accept`,
      headers: seller1Headers,
      payload: { actorAgentId: seller1Id },
    });

    const { offerId: o1, needId: n1 } = await createOfferAndNeed(app, seller1Id, seller1Headers);
    const { offerId: o2, needId: n2 } = await createOfferAndNeed(app, seller2Id, seller2Headers);

    const decomposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/decompose",
      headers: buyerHeaders,
      payload: {
        parentDealId,
        children: [
          { sellerAgentId: seller1Id, offerId: o1, needId: n1, negotiatedTotal: 80, title: "Part A" },
          { sellerAgentId: seller2Id, offerId: o2, needId: n2, negotiatedTotal: 80, title: "Part B" },
        ],
      },
    });
    expect(decomposeRes.statusCode).toBe(400);
    const errBody = JSON.parse(decomposeRes.body) as { error: string; childTotal: number; parentTotal: number };
    expect(errBody.childTotal).toBe(160);
    expect(errBody.parentTotal).toBe(100);
  });

  it("rejects decomposition by non-buyer", async () => {
    const { app } = await createTestApp();

    const { offerId, needId } = await createOfferAndNeed(app, seller1Id, seller1Headers);
    const parentRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: seller1Id,
        offerId,
        needId,
        negotiatedTotal: 200,
        maxPriceDeltaPct: 10,
        milestones: [{ idx: 1, title: "Full", amount: 200, acceptanceCriteria: ["Done"] }],
      },
    });
    const parentDealId = (JSON.parse(parentRes.body) as { id: string }).id;

    const { offerId: o1, needId: n1 } = await createOfferAndNeed(app, seller1Id, seller1Headers);

    // Seller tries to decompose (should fail)
    const decomposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/decompose",
      headers: seller1Headers,
      payload: {
        parentDealId,
        children: [
          { sellerAgentId: seller1Id, offerId: o1, needId: n1, negotiatedTotal: 100, title: "Part A" },
        ],
      },
    });
    expect(decomposeRes.statusCode).toBe(400); // min 2 children
  });
});
