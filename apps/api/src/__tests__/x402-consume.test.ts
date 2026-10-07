/**
 * M3 x402 → escrow upgrade: POST /api/deals/:id/consume (+ /consume/release).
 *
 * The seller middleware (@agentpact/x402-escrow) calls consume when a buyer
 * retries a paid request with `X-AGENTPACT-DEAL: <dealId>`. CONTRACT:
 *  - only the deal's seller may consume;
 *  - the deal must be accepted and hold ≥ price in escrow (integer base units);
 *  - a funded deal buys exactly ONE served response: a second consume with a
 *    different key is refused (replay), the same key is an idempotent replay;
 *  - two concurrent consumes → exactly one wins (race-safe);
 *  - release hands an undelivered consumption back (handler failed).
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];

describe("POST /api/deals/:id/consume (x402 escrow upgrade)", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);
  });

  let buyerToken = "";

  async function setupDeal(opts: { total?: number; accept?: boolean; fund?: boolean; needCriteria?: unknown[] } = {}) {
    const { app, sql } = await createTestApp();
    const total = opts.total ?? 25;
    const offer = generateTestOffer(sellerId);
    const offerRes = await app.inject({ method: "POST", url: "/api/offers", headers: sellerHeaders, payload: offer });
    expect(offerRes.statusCode).toBe(201);
    const offerId = JSON.parse(offerRes.body).id as string;
    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), acceptanceCriteria: opts.needCriteria ?? [] },
    });
    const needId = JSON.parse(needRes.body).id as string;
    const proposeRes = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId, sellerAgentId: sellerId, offerId, needId,
        negotiatedTotal: total, maxPriceDeltaPct: 0,
        milestones: [{ idx: 1, title: "x402 response", amount: total, acceptanceCriteria: ["HTTP 2xx"] }],
      },
    });
    expect(proposeRes.statusCode).toBe(201);
    const dealId = JSON.parse(proposeRes.body).id as string;
    const tok = await app.inject({ method: "POST", url: `/api/deals/${dealId}/x402-token`, headers: buyerHeaders });
    expect(tok.statusCode).toBe(201);
    buyerToken = JSON.parse(tok.body).token as string;
    const [milestone] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId}`;
    const milestoneId = milestone.id as string;
    if (opts.accept !== false) {
      const acc = await app.inject({ method: "POST", url: `/api/deals/${dealId}/accept`, headers: sellerHeaders, payload: { actorAgentId: sellerId } });
      expect(acc.statusCode).toBe(200);
      if (opts.fund !== false) {
        const fund = await app.inject({
          method: "POST", url: "/api/payments/create-intent", headers: buyerHeaders,
          payload: { provider: "usdc", milestoneId, buyerAgentId: buyerId, walletProvider: "metamask", buyerWalletAddress: "0x1234567890123456789012345678901234567890", chain: "base" },
        });
        expect(fund.statusCode).toBe(201);
      }
    }
    return { app, sql, dealId, offerId, milestoneId };
  }

  function consume(app: App, dealId: string, body: Record<string, unknown>, headers = sellerHeaders) {
    return app.inject({ method: "POST", url: `/api/deals/${dealId}/consume`, headers, payload: { buyerToken, ...body } });
  }

  it("deal hijack: a deal id without the buyer's token (or with a stale/wrong one) is refused", async () => {
    const { app, dealId } = await setupDeal();
    const none = await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "hijack-key-1", buyerToken: undefined });
    expect(none.statusCode).toBe(403);
    expect(JSON.parse(none.body).code).toBe("BUYER_TOKEN_INVALID");
    const wrong = await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "hijack-key-2", buyerToken: "guess" });
    expect(wrong.statusCode).toBe(403);
    const stale = buyerToken;
    const rot = await app.inject({ method: "POST", url: `/api/deals/${dealId}/x402-token`, headers: buyerHeaders });
    expect(rot.statusCode).toBe(201);
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "hijack-key-3", buyerToken: stale })).statusCode).toBe(403);
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "hijack-key-4", buyerToken: JSON.parse(rot.body).token })).statusCode).toBe(200);
  });

  it("only the buyer can mint the x402 token", async () => {
    const { app, dealId } = await setupDeal();
    const bySeller = await app.inject({ method: "POST", url: `/api/deals/${dealId}/x402-token`, headers: sellerHeaders });
    expect(bySeller.statusCode).toBe(403);
    const anon = await app.inject({ method: "POST", url: `/api/deals/${dealId}/x402-token` });
    expect(anon.statusCode).toBe(401);
  });

  it("deals carrying {validator} criteria are refused (an x402 artifact is the paywalled response itself)", async () => {
    const { app, dealId } = await setupDeal({ needCriteria: [{ validator: { type: "sha256", sha256: "a".repeat(64) } }] });
    const res = await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "validator-1" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("DEAL_HAS_VALIDATORS");
  });

  it("funded deal: the seller consumes once and gets the milestone ids to deliver against", async () => {
    const { app, dealId, offerId, milestoneId } = await setupDeal();
    const res = await consume(app, dealId, { priceBaseUnits: "25000000", consumeKey: "key-aaaaaaaa", offerId, resource: "https://seller.test/x" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ consumed: true, replay: false, dealId, milestoneIds: [milestoneId] });
  });

  it("price is compared in integer base units: exactly the escrowed amount passes, one unit more is underfunded", async () => {
    const { app, dealId } = await setupDeal({ total: 0.02 });
    const over = await consume(app, dealId, { priceBaseUnits: "20001", consumeKey: "key-over-1" });
    expect(over.statusCode).toBe(409);
    expect(JSON.parse(over.body)).toMatchObject({ code: "DEAL_UNDERFUNDED", escrowedBaseUnits: "20000" });
    const exact = await consume(app, dealId, { priceBaseUnits: "20000", consumeKey: "key-exact-1" });
    expect(exact.statusCode).toBe(200);
  });

  it("replay: a second consume with a different key is refused; the same key is an idempotent replay", async () => {
    const { app, dealId } = await setupDeal();
    expect((await consume(app, dealId, { priceBaseUnits: "1000000", consumeKey: "first-key-1" })).statusCode).toBe(200);
    const replay = await consume(app, dealId, { priceBaseUnits: "1000000", consumeKey: "other-key-2" });
    expect(replay.statusCode).toBe(409);
    expect(JSON.parse(replay.body).code).toBe("ALREADY_CONSUMED");
    const same = await consume(app, dealId, { priceBaseUnits: "1000000", consumeKey: "first-key-1" });
    expect(same.statusCode).toBe(200);
    expect(JSON.parse(same.body).replay).toBe(true);
  });

  it("race: two concurrent consumes → exactly one wins", async () => {
    const { app, sql, dealId } = await setupDeal();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => consume(app, dealId, { priceBaseUnits: "1000000", consumeKey: `race-key-${i}` })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    const rows = await sql`SELECT count(*)::int AS n FROM x402_consumptions WHERE deal_id = ${dealId}`;
    expect(rows[0].n).toBe(1);
  });

  it("wrong seller: the buyer (or anyone else) cannot consume", async () => {
    const { app, dealId } = await setupDeal();
    const res = await consume(app, dealId, { priceBaseUnits: "1000000", consumeKey: "buyer-key-1" }, buyerHeaders);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("WRONG_SELLER");
  });

  it("unfunded accepted deal → DEAL_NOT_FUNDED; proposed deal → DEAL_NOT_ACCEPTED", async () => {
    const unfunded = await setupDeal({ fund: false });
    const r1 = await consume(unfunded.app, unfunded.dealId, { priceBaseUnits: "1", consumeKey: "unfunded-1" });
    expect(r1.statusCode).toBe(409);
    expect(JSON.parse(r1.body).code).toBe("DEAL_NOT_FUNDED");

    const proposed = await setupDeal({ accept: false });
    const r2 = await consume(proposed.app, proposed.dealId, { priceBaseUnits: "1", consumeKey: "proposed-1" });
    expect(r2.statusCode).toBe(409);
    expect(JSON.parse(r2.body).code).toBe("DEAL_NOT_ACCEPTED");
  });

  it("underpriced PROPOSED deal → DEAL_UNDERPRICED, so the seller middleware never auto-accepts it", async () => {
    const { app, sql, dealId } = await setupDeal({ total: 5, accept: false });
    const res = await consume(app, dealId, { priceBaseUnits: "5000001", consumeKey: "underpriced-1" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: "DEAL_UNDERPRICED", negotiatedBaseUnits: "5000000" });
    const ok = await consume(app, dealId, { priceBaseUnits: "5000000", consumeKey: "underpriced-2" });
    expect(JSON.parse(ok.body).code).toBe("DEAL_NOT_ACCEPTED");
    const [d] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(d.status).toBe("proposed");
  });

  it("offer mismatch → refused (a deal for another offer of the same seller does not pay for this endpoint)", async () => {
    const { app, dealId } = await setupDeal();
    const res = await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "offer-mm-1", offerId: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("OFFER_MISMATCH");
  });

  it("validation + auth: bad price / key → 400; no API key → 401; unknown deal → 404", async () => {
    const { app, dealId } = await setupDeal();
    expect((await consume(app, dealId, { priceBaseUnits: "0.5", consumeKey: "valid-key-1" })).statusCode).toBe(400);
    expect((await consume(app, dealId, { priceBaseUnits: "0", consumeKey: "valid-key-1" })).statusCode).toBe(400);
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "short" })).statusCode).toBe(400);
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "valid-key-1" }, {} as Record<string, string>)).statusCode).toBe(401);
    expect((await consume(app, randomUUID(), { priceBaseUnits: "1", consumeKey: "valid-key-1" })).statusCode).toBe(404);
  });

  it("release: the consuming key hands an undelivered consumption back; others cannot", async () => {
    const { app, dealId } = await setupDeal();
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "rel-key-001" })).statusCode).toBe(200);
    const wrong = await app.inject({ method: "POST", url: `/api/deals/${dealId}/consume/release`, headers: sellerHeaders, payload: { consumeKey: "not-the-key" } });
    expect(wrong.statusCode).toBe(409);
    const byBuyer = await app.inject({ method: "POST", url: `/api/deals/${dealId}/consume/release`, headers: buyerHeaders, payload: { consumeKey: "rel-key-001" } });
    expect(byBuyer.statusCode).toBe(409);
    const ok = await app.inject({ method: "POST", url: `/api/deals/${dealId}/consume/release`, headers: sellerHeaders, payload: { consumeKey: "rel-key-001" } });
    expect(ok.statusCode).toBe(200);
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "rel-key-002" })).statusCode).toBe(200);
  });

  it("release after the delivery was submitted is refused (the response was served and evidenced)", async () => {
    const { app, dealId, milestoneId } = await setupDeal();
    expect((await consume(app, dealId, { priceBaseUnits: "1", consumeKey: "deliv-key-1" })).statusCode).toBe(200);
    const sub = await app.inject({
      method: "POST", url: "/api/deliveries/submit", headers: sellerHeaders,
      payload: { milestoneId, submittedBy: sellerId, artifacts: [{ type: "x402-response", url: "https://seller.test/x", hash: "sha256:" + "a".repeat(64) }] },
    });
    expect(sub.statusCode).toBe(201);
    const rel = await app.inject({ method: "POST", url: `/api/deals/${dealId}/consume/release`, headers: sellerHeaders, payload: { consumeKey: "deliv-key-1" } });
    expect(rel.statusCode).toBe(409);
    expect(JSON.parse(rel.body).code).toBe("ALREADY_DELIVERED");
  });
});
