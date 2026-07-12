import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { checkListingPayable, isPayableWalletAddress, STRIPE_RAIL_ENABLED } from "../routes/utils.js";
import { cleanDatabase, createTestApp, generateTestOffer, generateTestNeed, getAuthHeadersForAgent } from "./helpers/testApp.js";

// payment-methods rollout — payability gate (defense-in-depth, 3 layers) + Stripe
// "coming soon" gray-out. USDC is the live rail and requires a valid payout
// wallet; the stripe rail is gated behind STRIPE_RAIL_ENABLED (default false,
// lit up once Stripe Connect onboarding ships).

const VALID_WALLET = "0x1111111111111111111111111111111111111111";

describe("checkListingPayable / isPayableWalletAddress (unit)", () => {
  it("isPayableWalletAddress accepts a 0x+40hex address, rejects null/empty/garbage", () => {
    expect(isPayableWalletAddress(VALID_WALLET)).toBe(true);
    expect(isPayableWalletAddress(null)).toBe(false);
    expect(isPayableWalletAddress(undefined)).toBe(false);
    expect(isPayableWalletAddress("")).toBe(false);
    expect(isPayableWalletAddress("0xnothex")).toBe(false);
    expect(isPayableWalletAddress("0x123")).toBe(false); // too short
    expect(isPayableWalletAddress(12345)).toBe(false);
  });

  it("usdc rail: requires a valid wallet", () => {
    expect(checkListingPayable("usdc", { walletAddress: VALID_WALLET }).ok).toBe(true);
    const bad = checkListingPayable("usdc", { walletAddress: null });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/wallet/i);
  });

  it("stripe rail: 'coming soon' while STRIPE_RAIL_ENABLED is off (the default)", () => {
    // This test pins the shipped default. STRIPE_RAIL_ENABLED is read from env
    // at module load; in the test env it is unset → false.
    expect(STRIPE_RAIL_ENABLED).toBe(false);
    const res = checkListingPayable("stripe", { walletAddress: VALID_WALLET });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/coming soon/i);
  });

  it("both rail: blocked by the stripe leg's 'coming soon' even with a valid wallet", () => {
    const res = checkListingPayable("both", { walletAddress: VALID_WALLET });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/coming soon/i);
  });

  it("null/undefined rail is treated as 'both' (maximally protective) → coming soon", () => {
    expect(checkListingPayable(null, { walletAddress: VALID_WALLET }).ok).toBe(false);
    expect(checkListingPayable(undefined, { walletAddress: VALID_WALLET }).ok).toBe(false);
  });
});

describe("payability create gate — offers (Layer 1)", () => {
  let walletAgentId: string;
  let walletlessAgentId: string;
  let walletHeaders: Record<string, string>;
  let walletlessHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    walletAgentId = randomUUID();
    walletlessAgentId = randomUUID();
    walletHeaders = await getAuthHeadersForAgent(walletAgentId, { walletAddress: VALID_WALLET });
    walletlessHeaders = await getAuthHeadersForAgent(walletlessAgentId, { walletAddress: null });
  });

  it("allows a usdc offer from an agent WITH a wallet", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers: walletHeaders,
      payload: { ...generateTestOffer(walletAgentId), acceptedPaymentMethods: "usdc" },
    });
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
  });

  it("REJECTS a usdc offer from a WALLET-LESS agent with 400 (closes the latent bug at creation)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers: walletlessHeaders,
      payload: { ...generateTestOffer(walletlessAgentId), acceptedPaymentMethods: "usdc" },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/wallet/i);
  });

  it("REJECTS a stripe offer with 'coming soon' 400 even from a wallet agent", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers: walletHeaders,
      payload: { ...generateTestOffer(walletAgentId), acceptedPaymentMethods: "stripe" },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/coming soon/i);
  });

  it("REJECTS a 'both' offer with 'coming soon' 400 (stripe leg unservable)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers: walletHeaders,
      payload: { ...generateTestOffer(walletAgentId), acceptedPaymentMethods: "both" },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/coming soon/i);
  });

  it("defaults a rail-omitted offer to 'usdc' and allows it for a wallet agent", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers: walletHeaders,
      payload: generateTestOffer(walletAgentId), // no acceptedPaymentMethods → default
    });
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
  });
});

describe("payability create gate — needs (Layer 1)", () => {
  let walletlessAgentId: string;
  let walletlessHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    walletlessAgentId = randomUUID();
    walletlessHeaders = await getAuthHeadersForAgent(walletlessAgentId, { walletAddress: null });
  });

  it("REJECTS a usdc need from a wallet-less agent with 400", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/needs", headers: walletlessHeaders,
      payload: { ...generateTestNeed(walletlessAgentId), acceptedPaymentMethods: "usdc" },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/wallet/i);
  });

  it("REJECTS a stripe need with 'coming soon' 400", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/needs", headers: walletlessHeaders,
      payload: { ...generateTestNeed(walletlessAgentId), acceptedPaymentMethods: "stripe" },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(/coming soon/i);
  });
});

describe("payability fund guard — payments (Layer 3)", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: VALID_WALLET });
    // seller registered WITH a wallet so the deal can be created, then we clear
    // it below to simulate capability drift before fund.
    await getAuthHeadersForAgent(sellerId, { walletAddress: "0x2222222222222222222222222222222222222222" });
  });

  it("REJECTS create-intent for a milestone whose seller has a NULL wallet (closes the as-Address bug)", async () => {
    const { app, sql } = await createTestApp();

    // Build a funded-path deal: usdc offer + need, propose, accept → milestone.
    const offerRes = await app.inject({
      method: "POST", url: "/api/offers", headers: await getAuthHeadersForAgent(sellerId),
      payload: { ...generateTestOffer(sellerId), basePrice: 100, acceptedPaymentMethods: "usdc" },
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;
    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), acceptedPaymentMethods: "usdc" },
    });
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    const proposeRes = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId, sellerAgentId: sellerId, offerId, needId,
        negotiatedTotal: 100, maxPriceDeltaPct: 20,
        milestones: [{ idx: 1, title: "Delivery", amount: 100, acceptanceCriteria: ["Done"] }],
      },
    });
    expect(proposeRes.statusCode).toBe(201);
    const deal = JSON.parse(proposeRes.body) as { id: string; milestones?: Array<{ id: string }> };
    const dealId = deal.id;

    // Resolve the milestone id from the DB (robust to response shape).
    const [ms] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    const milestoneId = String(ms.id);

    // Simulate capability drift: seller's wallet is cleared AFTER deal creation.
    await sql`UPDATE agents SET owner_wallet_address = NULL WHERE id = ${sellerId}`;

    const fundRes = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: buyerHeaders,
      payload: { milestoneId, buyerAgentId: buyerId, provider: "usdc", walletProvider: "metamask", buyerWalletAddress: VALID_WALLET },
    });
    expect(fundRes.statusCode).toBe(400);
    expect((JSON.parse(fundRes.body) as { error: string }).error).toMatch(/wallet/i);
  });
});
