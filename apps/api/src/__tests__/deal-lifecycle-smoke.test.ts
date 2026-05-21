import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("deal lifecycle smoke", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);
  });

  it("registers, creates offer/need, proposes, accepts, funds, fulfills, and closes a deal", async () => {
    const { app, sql } = await createTestApp();

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    expect(offerRes.statusCode).toBe(201);
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    expect(needRes.statusCode).toBe(201);
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
    expect(proposeRes.statusCode).toBe(201);
    const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);
    expect((JSON.parse(acceptRes.body) as { status: string }).status).toBe("active");

    const [milestone] = await sql`SELECT id, status FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    expect(milestone.status).toBe("in_progress");

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
        chain: "base",
      },
    });
    expect(fundRes.statusCode).toBe(201);

    const fulfillmentRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: sellerId,
        fulfillmentData: { description: "Delivery provided for lifecycle smoke" },
      },
    });
    expect(fulfillmentRes.statusCode).toBe(200);

    const closeRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/close`,
      headers: buyerHeaders,
      payload: { agentId: buyerId, rating: 5, notes: "Looks good" },
    });
    expect(closeRes.statusCode).toBe(200);
    const closeBody = JSON.parse(closeRes.body) as { status: string; release: { action: string } };
    expect(closeBody.status).toBe("completed");
    expect(closeBody.release.action).toBe("released");

    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("completed");
    const [updatedMilestone] = await sql`SELECT status FROM milestones WHERE id = ${milestone.id}`;
    expect(updatedMilestone.status).toBe("accepted");
    const [paymentIntent] = await sql`SELECT status FROM payment_intents WHERE milestone_id = ${milestone.id}`;
    expect(paymentIntent.status).toBe("released");
  });
});
