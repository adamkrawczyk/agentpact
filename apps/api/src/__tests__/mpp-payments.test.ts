import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAvailableDealPaymentMethods, mockChargeDeal } = vi.hoisted(() => ({
  mockGetAvailableDealPaymentMethods: vi.fn(),
  mockChargeDeal: vi.fn(),
}));

vi.mock("../mpp.js", () => ({
  getAvailableDealPaymentMethods: mockGetAvailableDealPaymentMethods,
  chargeDeal: mockChargeDeal,
  getMppConfigurationError: vi.fn(() => null),
}));

import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("MPP deal payments", () => {
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;
  let buyerId: string;
  let sellerId: string;
  let dealId: string;

  beforeEach(async () => {
    mockGetAvailableDealPaymentMethods.mockReset();
    mockChargeDeal.mockReset();
    mockGetAvailableDealPaymentMethods.mockReturnValue([
      { type: "mpp-fiat" },
      { type: "mpp-crypto" },
    ]);

    const { app, sql } = await createTestApp();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanDatabase();

    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
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
    dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("active");
  });

  it("lists deal payment methods as typed entries", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/payment-methods`,
      headers: buyerHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      dealId,
      methods: [{ type: "mpp-fiat" }, { type: "mpp-crypto" }],
    });
  });

  it("returns a 402 challenge for unpaid MPP deal funding", async () => {
    const { app } = await createTestApp();

    mockChargeDeal.mockResolvedValue({
      status: 402,
      challenge: new Response(JSON.stringify({ title: "Payment Required" }), {
        status: 402,
        headers: {
          "content-type": "application/problem+json",
          "www-authenticate": 'Payment realm="AgentPact", method="stripe", intent="charge", request="amount=12000"',
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/pay-mpp`,
      headers: buyerHeaders,
      payload: { actorAgentId: buyerId },
    });

    expect(response.statusCode).toBe(402);
    expect(response.headers["www-authenticate"]).toContain('method="stripe"');
    expect(mockChargeDeal).toHaveBeenCalled();
  });

  it("funds the deal and stores the MPP receipt after successful payment", async () => {
    const { app, sql } = await createTestApp();

    mockChargeDeal.mockResolvedValue({
      status: 200,
      receipt: {
        method: "stripe",
        reference: "pi_123",
        status: "success",
        timestamp: new Date().toISOString(),
      },
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/pay-mpp`,
      headers: buyerHeaders,
      payload: { actorAgentId: buyerId },
    });

    expect(response.statusCode).toBe(200);

    const [deal] = await sql`SELECT status, payment_method, mpp_receipt FROM deals WHERE id = ${dealId}`;
    const receipt = typeof deal.mpp_receipt === "string" ? JSON.parse(deal.mpp_receipt) : deal.mpp_receipt;
    expect(deal.status).toBe("funded");
    expect(deal.payment_method).toBe("mpp-fiat");
    expect(receipt.reference).toBe("pi_123");

    const [milestone] = await sql`SELECT status FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    expect(milestone.status).toBe("funded");
  });
});
