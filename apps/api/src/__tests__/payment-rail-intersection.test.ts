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
    const { app, sql } = await createTestApp();
    // Create as 'usdc' (the only rail that passes the P1c create gate), then set
    // the target rail directly via SQL. These tests exercise the propose-time
    // rail logic specifically; the create gate is covered in payability.test.ts.
    const offerRes = await app.inject({
      method: "POST", url: "/api/offers", headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), acceptedPaymentMethods: "usdc" },
    });
    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), acceptedPaymentMethods: "usdc" },
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;
    const needId = (JSON.parse(needRes.body) as { id: string }).id;
    await sql`UPDATE offers SET accepted_payment_methods = ${offerRail} WHERE id = ${offerId}`;
    await sql`UPDATE needs SET accepted_payment_methods = ${needRail} WHERE id = ${needId}`;
    return { offerId, needId };
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

// tillopen_0306/P1b — autopilot bypass + stale-match gate.
// The HTTP /api/deals/propose handler enforces rail intersection, but
// /api/autopilot/run calls createDealProposal() directly, NOT through that
// route. The `matches` cache can also hold a row that was rail-compatible at
// compute time and went disjoint after a later PATCH of accepted_payment_methods.
// This block injects exactly that stale row and proves autopilot refuses to
// propose a deal across disjoint rails (regression guard for Codex R2 finding).
describe("autopilot rail-intersection gate (tillopen_0306/P1b)", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: "0x3333333333333333333333333333333333333333" });
    sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: "0x4444444444444444444444444444444444444444" });
  });

  async function seedDisjointMatch(offerRail: string, needRail: string, needBudgetMax = 150): Promise<{ offerId: string; needId: string }> {
    const { app, sql } = await createTestApp();
    // Create as 'usdc' (passes the P1c create gate) then set the target rail via
    // SQL — this block tests the autopilot rail guard, not the create gate.
    const offerRes = await app.inject({
      method: "POST", url: "/api/offers", headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), acceptedPaymentMethods: "usdc" },
    });
    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), budgetMax: needBudgetMax, acceptedPaymentMethods: "usdc" },
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;
    const needId = (JSON.parse(needRes.body) as { id: string }).id;
    await sql`UPDATE offers SET accepted_payment_methods = ${offerRail} WHERE id = ${offerId}`;
    await sql`UPDATE needs SET accepted_payment_methods = ${needRail} WHERE id = ${needId}`;

    // Buyer opts into autopilot with a price ceiling above the offer price.
    await sql`
      UPDATE agents
      SET auto_buy_enabled = true, max_auto_deal_price = 100000
      WHERE id = ${buyerId}
    `;

    // Inject a STALE high-score match row directly — bypasses recompute's own
    // rail filter to simulate "rails were compatible when matched, then PATCHed
    // apart". score >= 0.8 so the autopilot candidate query picks it up.
    await sql`
      INSERT INTO matches (offer_id, need_id, score, reason_json)
      VALUES (${offerId}, ${needId}, 0.950, '{"seeded":"stale-rail-test"}'::jsonb)
      ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score
    `;
    return { offerId, needId };
  }

  it("does NOT propose an autopilot deal across disjoint rails (offer=usdc, need=stripe)", async () => {
    const { app, sql } = await createTestApp();
    const { offerId, needId } = await seedDisjointMatch("usdc", "stripe");

    const res = await app.inject({ method: "POST", url: "/api/autopilot/run", headers: buyerHeaders, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { dealsProposed: number; skipped: number };
    expect(body.dealsProposed).toBe(0);

    const deals = await sql`SELECT id FROM deals WHERE offer_id = ${offerId} AND need_id = ${needId}`;
    expect(deals.length).toBe(0);
  });

  it("DOES propose an autopilot deal when rails intersect (offer=usdc, need=both)", async () => {
    const { app, sql } = await createTestApp();
    // budgetMax=100 == offer basePrice ⇒ budgetFit=1.0, tagScore=1.0 ⇒ matcher
    // score 0.800 (0.6*1 + 0.2*1), clearing the autopilot candidate threshold
    // (score >= 0.8). Proves the new rail gate does NOT block a compatible pair.
    const { offerId, needId } = await seedDisjointMatch("usdc", "both", 100);

    const res = await app.inject({ method: "POST", url: "/api/autopilot/run", headers: buyerHeaders, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { dealsProposed: number };
    expect(body.dealsProposed).toBe(1);

    const deals = await sql`SELECT id FROM deals WHERE offer_id = ${offerId} AND need_id = ${needId}`;
    expect(deals.length).toBe(1);
  });
});
