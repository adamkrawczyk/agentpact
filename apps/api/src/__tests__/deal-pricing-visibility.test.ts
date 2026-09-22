import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { describeDealPricing, estimatePlatformFee, PAID_DEFAULT_MIN_USD } from "../shared/pricing.js";
import { PLATFORM_FEE_PCT } from "../shared/deal-helpers.js";

// moneypath_0920 §3 M1 "the ask": the paid tier and the platform fee must be
// VISIBLE on propose_deal / get_deal responses. The only tier concept in the
// codebase is is_free_tier (negotiated_total == 0); this pins that the
// `pricing` block reports it honestly and mirrors the contract's fee math.

describe("deal pricing visibility", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let offerId: string;
  let needId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    const sellerHeaders = await getAuthHeadersForAgent(sellerId);
    const offerRes = await app.inject({ method: "POST", url: "/api/offers", headers: sellerHeaders, payload: generateTestOffer(sellerId) });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;
    const needRes = await app.inject({ method: "POST", url: "/api/needs", headers: buyerHeaders, payload: generateTestNeed(buyerId) });
    needId = (JSON.parse(needRes.body) as { id: string }).id;
  });

  it("estimatePlatformFee floors in integer base units like AgentPactEscrow.sol", () => {
    // 1.008 USDC (real prod amount from PR #138): 1_008_000 * 10 / 100 = 100_800 → 0.1008
    expect(estimatePlatformFee(1.008, 10)).toEqual({ feeAmount: 0.1008, sellerAmount: 0.9072 });
    // 0.000001 at 10% → floor(0.1) = 0 base units
    expect(estimatePlatformFee(0.000001, 10)).toEqual({ feeAmount: 0, sellerAmount: 0.000001 });
  });

  it("describeDealPricing reports free vs paid and the ≥$5 default", () => {
    const free = describeDealPricing(0, null);
    expect(free.tier).toBe("free");
    expect(free.platform_fee_estimate).toBe(0);
    expect(free.meets_paid_default).toBe(false);
    expect(free.paid_default_min_usd).toBe(PAID_DEFAULT_MIN_USD);

    const small = describeDealPricing(PAID_DEFAULT_MIN_USD - 1, null);
    expect(small.tier).toBe("paid");
    expect(small.meets_paid_default).toBe(false);

    const paid = describeDealPricing(120, new Date());
    expect(paid.tier).toBe("paid");
    expect(paid.meets_paid_default).toBe(true);
    expect(paid.platform_fee_pct).toBe(PLATFORM_FEE_PCT);
    expect(paid.platform_fee_estimate).toBe(120 * PLATFORM_FEE_PCT / 100);
    expect(paid.seller_verified).toBe(true);
    expect(paid.verified_seller_url).toBe("https://agentpact.xyz/verified");
  });

  it("POST /api/deals/propose and GET /api/deals/:id expose pricing for a paid deal", async () => {
    const { app, sql } = await createTestApp();
    const res = await app.inject({
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
        milestones: [{ idx: 1, title: "Phase 1", amount: 120, acceptanceCriteria: ["Deliver"] }],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body) as { id: string; is_free_tier: boolean; pricing: ReturnType<typeof describeDealPricing> };
    expect(created.is_free_tier).toBe(false);
    expect(created.pricing.tier).toBe("paid");
    expect(created.pricing.platform_fee_pct).toBe(PLATFORM_FEE_PCT);
    expect(created.pricing.platform_fee_estimate).toBe(12);
    expect(created.pricing.seller_net_estimate).toBe(108);
    expect(created.pricing.meets_paid_default).toBe(true);
    expect(created.pricing.seller_verified).toBe(false);

    // Verify the seller, then get_deal must reflect it.
    await sql`UPDATE agents SET verified_at = NOW() WHERE id = ${sellerId}`;
    const getRes = await app.inject({ method: "GET", url: `/api/deals/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body) as { pricing: ReturnType<typeof describeDealPricing> };
    expect(fetched.pricing.tier).toBe("paid");
    expect(fetched.pricing.platform_fee_estimate).toBe(12);
    expect(fetched.pricing.seller_verified).toBe(true);
  });

  it("free-tier proposal reports tier=free with zero fee and the paid-default hint", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
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
        milestones: [{ idx: 1, title: "Free", amount: 0, acceptanceCriteria: ["Deliver"] }],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body) as { is_free_tier: boolean; pricing: ReturnType<typeof describeDealPricing> };
    expect(created.is_free_tier).toBe(true);
    expect(created.pricing.tier).toBe("free");
    expect(created.pricing.platform_fee_estimate).toBe(0);
    expect(created.pricing.note).toContain(`$${PAID_DEFAULT_MIN_USD}`);
  });
});
