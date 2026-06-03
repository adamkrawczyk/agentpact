import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { paymentRailsIntersect, expandPaymentRails } from "../routes/utils.js";
import { cleanDatabase, createTestApp, generateTestOffer, generateTestNeed, getAuthHeadersForAgent } from "./helpers/testApp.js";

// tillopen_0306/P1b — rail-intersection enforcement (matching + propose gate).
// Pairs with P1a's accepted_payment_methods column. A deal is viable only where
// the offer's and need's accepted rails overlap.

describe("paymentRailsIntersect (unit)", () => {
  it("'both' intersects with everything", () => {
    expect(paymentRailsIntersect("both", "both")).toBe(true);
    expect(paymentRailsIntersect("both", "usdc")).toBe(true);
    expect(paymentRailsIntersect("both", "stripe")).toBe(true);
    expect(paymentRailsIntersect("usdc", "both")).toBe(true);
    expect(paymentRailsIntersect("stripe", "both")).toBe(true);
  });
  it("same single rail intersects", () => {
    expect(paymentRailsIntersect("usdc", "usdc")).toBe(true);
    expect(paymentRailsIntersect("stripe", "stripe")).toBe(true);
  });
  it("opposite single rails do NOT intersect", () => {
    expect(paymentRailsIntersect("usdc", "stripe")).toBe(false);
    expect(paymentRailsIntersect("stripe", "usdc")).toBe(false);
  });
  it("null/undefined/unknown fall back to 'both' (backward-compatible)", () => {
    expect(paymentRailsIntersect(null, "usdc")).toBe(true);
    expect(paymentRailsIntersect(undefined, "stripe")).toBe(true);
    expect(paymentRailsIntersect("garbage", "usdc")).toBe(true);
    expect(expandPaymentRails(null).size).toBe(2);
    expect(expandPaymentRails("usdc")).toEqual(new Set(["usdc"]));
  });
});

describe("propose rail-intersection gate (tillopen_0306/P1b)", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: "0x1111111111111111111111111111111111111111" });
    sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: "0x2222222222222222222222222222222222222222" });
  });

  async function makeOfferAndNeed(offerRail: string, needRail: string): Promise<{ offerId: string; needId: string }> {
    const { app } = await createTestApp();
    const offerRes = await app.inject({
      method: "POST", url: "/api/offers", headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), acceptedPaymentMethods: offerRail },
    });
    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), acceptedPaymentMethods: needRail },
    });
    return {
      offerId: (JSON.parse(offerRes.body) as { id: string }).id,
      needId: (JSON.parse(needRes.body) as { id: string }).id,
    };
  }

  function proposePayload(offerId: string, needId: string) {
    return {
      buyerAgentId: buyerId, sellerAgentId: sellerId, offerId, needId,
      negotiatedTotal: 100, maxPriceDeltaPct: 20,
      milestones: [{ idx: 1, title: "Delivery", amount: 100, acceptanceCriteria: ["Done"] }],
    };
  }

  it("REJECTS a propose where offer=usdc and need=stripe (disjoint rails) with 400", async () => {
    const { app } = await createTestApp();
    const { offerId, needId } = await makeOfferAndNeed("usdc", "stripe");
    const res = await app.inject({ method: "POST", url: "/api/deals/propose", headers: buyerHeaders, payload: proposePayload(offerId, needId) });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/rail mismatch/i);
  });

  it("ALLOWS a propose where offer=usdc and need=both (intersection = usdc)", async () => {
    const { app } = await createTestApp();
    const { offerId, needId } = await makeOfferAndNeed("usdc", "both");
    const res = await app.inject({ method: "POST", url: "/api/deals/propose", headers: buyerHeaders, payload: proposePayload(offerId, needId) });
    expect(res.statusCode).toBe(201);
  });

  it("ALLOWS a propose where both sides default to 'both'", async () => {
    const { app } = await createTestApp();
    const { offerId, needId } = await makeOfferAndNeed("both", "both");
    const res = await app.inject({ method: "POST", url: "/api/deals/propose", headers: buyerHeaders, payload: proposePayload(offerId, needId) });
    expect(res.statusCode).toBe(201);
  });
});
