import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

vi.mock("../stripe.js", async () => {
  return {
    isStripeEnabled: () => true,
    createPaymentIntent: vi.fn(async (amountCents: number, currency: string) => ({
      id: `pi_test_${amountCents}_${currency}`,
      client_secret: `pi_test_${amountCents}_${currency}_secret_test`,
    })),
    constructWebhookEvent: vi.fn(),
  };
});

describe("Payments API", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeEach(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_agentpact_payments";
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);
  });

  async function setupAcceptedDeal() {
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

    const [milestone] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    expect(milestone).toBeTruthy();

    return { app, sql, milestoneId: String(milestone.id) };
  }

  it("creates Stripe payment intents without wallet fields against the migrated schema", async () => {
    const { app, sql, milestoneId } = await setupAcceptedDeal();

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/create-intent",
      headers: buyerHeaders,
      payload: {
        provider: "stripe",
        milestoneId,
        buyerAgentId: buyerId,
        fiatCurrency: "usd",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { mode: string; provider: string; clientSecret: string };
    expect(body.mode).toBe("stripe");
    expect(body.provider).toBe("stripe");
    expect(body.clientSecret).toContain("secret_test");

    const [intent] = await sql`
      SELECT status, payment_provider, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address
      FROM payment_intents
      WHERE milestone_id = ${milestoneId}
    `;
    expect(intent.status).toBe("created");
    expect(intent.payment_provider).toBe("stripe");
    expect(intent.buyer_wallet_provider).toBeNull();
    expect(intent.buyer_wallet_address).toBeNull();
    expect(intent.seller_wallet_address).toBeNull();
  });

  it("refunds a funded simulation payment intent without violating status constraints", async () => {
    const { app, sql, milestoneId } = await setupAcceptedDeal();

    const fundRes = await app.inject({
      method: "POST",
      url: "/api/payments/create-intent",
      headers: buyerHeaders,
      payload: {
        provider: "usdc",
        milestoneId,
        buyerAgentId: buyerId,
        walletProvider: "metamask",
        buyerWalletAddress: "0x1234567890123456789012345678901234567890",
        chain: "base",
      },
    });
    expect(fundRes.statusCode).toBe(201);
    const paymentIntentId = (JSON.parse(fundRes.body) as { paymentIntentId: string }).paymentIntentId;

    const refundRes = await app.inject({
      method: "POST",
      url: "/api/payments/refund",
      headers: buyerHeaders,
      payload: { paymentIntentId, reason: "test refund" },
    });

    expect(refundRes.statusCode).toBe(200);
    const refundBody = JSON.parse(refundRes.body) as { ok: boolean; mode: string };
    expect(refundBody.ok).toBe(true);
    expect(refundBody.mode).toBe("simulation");

    const [intent] = await sql`SELECT status, tx_hash FROM payment_intents WHERE id = ${paymentIntentId}`;
    expect(intent.status).toBe("refunded");
    expect(intent.tx_hash).toMatch(/^sim_refund_/);
  });
});
