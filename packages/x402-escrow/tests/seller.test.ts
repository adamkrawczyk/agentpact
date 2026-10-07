import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { x402Escrow, parseUsd, AGENTPACT_ESCROW_SCHEME, DEAL_HEADER } from "../src/index.js";
import { API, FACILITATOR, OFFER, PAY_TO, SELLER, b64json, decodeB64json, mockNetwork, type MockOptions } from "./helpers.js";

const RESOURCE = "https://seller.test/validate";

function seller(net: ReturnType<typeof mockNetwork>, over: Partial<Parameters<typeof x402Escrow>[0]> = {}) {
  return x402Escrow({
    sellerAgentId: SELLER,
    apiKey: "seller-key",
    offerId: OFFER,
    thresholdUsd: 1,
    price: "$0.02",
    payTo: PAY_TO,
    network: "base",
    facilitatorUrl: FACILITATOR,
    apiBase: API,
    fetch: net.fetch,
    ...over,
  });
}

function req(headers: Record<string, string> = {}) {
  return { method: "POST", url: RESOURCE, headers };
}

function paymentFor(accepted: any, over: Record<string, unknown> = {}) {
  return b64json({
    x402Version: 2,
    accepted,
    payload: { signature: "0xsig", authorization: { from: "0xpayer", to: accepted.payTo, value: accepted.amount } },
    ...over,
  });
}

async function firstRequirements(mw: ReturnType<typeof seller>, r = req()) {
  const d = await mw.handle(r);
  assert.equal(d.action, "respond");
  if (d.action !== "respond") throw new Error("unreachable");
  return decodeB64json(d.headers["PAYMENT-REQUIRED"]);
}

test("parseUsd: integer base units, no floats, rejects ambiguous input", () => {
  assert.equal(parseUsd("$0.02"), 20_000n);
  assert.equal(parseUsd("0.000001"), 1n);
  assert.equal(parseUsd(5), 5_000_000n);
  assert.equal(parseUsd("12"), 12_000_000n);
  assert.equal(parseUsd({ amountBaseUnits: "123" }), 123n);
  assert.throws(() => parseUsd("0.0000001"), /6 decimals/);
  assert.throws(() => parseUsd("-1"), /USD/);
  assert.throws(() => parseUsd(1e-7), /USD/);
  assert.throws(() => parseUsd("1e3"), /USD/);
});

test("under threshold: 402 lists ONLY the standard x402 exact option (USDC on Base, CAIP-2)", async () => {
  const net = mockNetwork();
  const pr = await firstRequirements(seller(net));
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.resource.url, RESOURCE);
  assert.equal(pr.accepts.length, 1);
  const [exact] = pr.accepts;
  assert.equal(exact.scheme, "exact");
  assert.equal(exact.network, "eip155:8453");
  assert.equal(exact.amount, "20000");
  assert.equal(exact.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(exact.payTo, PAY_TO);
  assert.deepEqual(exact.extra, { name: "USD Coin", version: "2" });
  assert.equal(net.calls.length, 0, "no network calls to emit a 402");
});

test("solana configured: an exact option on solana mainnet is listed too", async () => {
  const net = mockNetwork();
  const pr = await firstRequirements(seller(net, {
    solana: { payTo: "So1anaPayTo111111111111111111111111111111", feePayer: "FeePayer11111111111111111111111111111111" },
  }));
  const sol = pr.accepts.find((a: any) => a.network.startsWith("solana:"));
  assert.ok(sol, "solana option present");
  assert.equal(sol.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(sol.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(sol.extra.feePayer, "FeePayer11111111111111111111111111111111");
});

test("over threshold: 402 ALSO lists the agentpact-escrow option with offer, calls and retry header", async () => {
  const net = mockNetwork();
  const pr = await firstRequirements(seller(net, { price: "$25" }));
  assert.equal(pr.accepts.length, 2);
  const escrow = pr.accepts.find((a: any) => a.scheme === AGENTPACT_ESCROW_SCHEME);
  assert.ok(escrow, "escrow option present");
  assert.equal(escrow.amount, "25000000");
  const ap = escrow.extra.agentpact;
  assert.equal(ap.sellerAgentId, SELLER);
  assert.equal(ap.offerId, OFFER);
  assert.equal(ap.retryHeader, DEAL_HEADER);
  assert.equal(ap.apiBase, API);
  assert.match(JSON.stringify(ap.createDeal.rest), /\/api\/deals\/propose/);
  assert.match(JSON.stringify(ap.createDeal.mcp), /agentpact\.propose_deal/);
});

test("batch request under the price threshold is still offered escrow", async () => {
  const net = mockNetwork();
  const pr = await firstRequirements(seller(net, { isBatch: (r) => r.headers["x-batch"] === "1" }), req({ "x-batch": "1" }));
  assert.ok(pr.accepts.some((a: any) => a.scheme === AGENTPACT_ESCROW_SCHEME));
});

test("plain x402: verify through the facilitator, serve, then settle and return PAYMENT-RESPONSE", async () => {
  const net = mockNetwork();
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const d = await mw.handle(req({ "payment-signature": paymentFor(pr.accepts[0]) }));
  assert.equal(d.action, "serve");
  if (d.action !== "serve") return;
  assert.equal(d.mode, "x402");
  const verify = net.calls.find((c) => c.url === `${FACILITATOR}/verify`);
  assert.ok(verify);
  assert.equal(verify.body.x402Version, 2);
  assert.deepEqual(verify.body.paymentRequirements, pr.accepts[0]);
  assert.equal(net.calls.some((c) => c.url.endsWith("/settle")), false, "settle only after the handler succeeded");

  const done = await d.complete("result-body", 200);
  assert.equal(done.ok, true);
  const settled = decodeB64json(done.headers["PAYMENT-RESPONSE"]);
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, "0xabc");
});

test("plain x402: the legacy v1 X-PAYMENT header is not accepted as v2 payment", async () => {
  const net = mockNetwork();
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const d = await mw.handle(req({ "x-payment": paymentFor(pr.accepts[0]) }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") assert.equal(d.status, 402);
});

test("plain x402: payload that does not match our requirements is refused without calling the facilitator", async () => {
  const net = mockNetwork();
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const cheaper = { ...pr.accepts[0], amount: "1" };
  const d = await mw.handle(req({ "payment-signature": paymentFor(cheaper) }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") {
    assert.equal(d.status, 402);
    assert.match(decodeB64json(d.headers["PAYMENT-REQUIRED"]).error, /does not match/);
  }
  assert.equal(net.calls.length, 0);
});

test("plain x402: malformed PAYMENT-SIGNATURE → 400", async () => {
  const net = mockNetwork();
  const d = await seller(net).handle(req({ "payment-signature": "%%%not-base64-json" }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") assert.equal(d.status, 400);
});

test("facilitator failure: verify says invalid → 402 with the reason", async () => {
  const net = mockNetwork({ verify: () => ({ json: { isValid: false, invalidReason: "insufficient_funds" } }) });
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const d = await mw.handle(req({ "payment-signature": paymentFor(pr.accepts[0]) }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") {
    assert.equal(d.status, 402);
    assert.equal(decodeB64json(d.headers["PAYMENT-REQUIRED"]).error, "insufficient_funds");
  }
});

test("facilitator failure: verify endpoint down → 500 (x402 server error), resource NOT served", async () => {
  const net = mockNetwork({ verify: () => ({ status: 503, json: { error: "down" } }) });
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const d = await mw.handle(req({ "payment-signature": paymentFor(pr.accepts[0]) }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") assert.equal(d.status, 500);
});

test("facilitator failure: settle fails → complete() refuses to release the body (402 + failed PAYMENT-RESPONSE)", async () => {
  const net = mockNetwork({
    settle: (b) => ({ json: { success: false, errorReason: "insufficient_funds", transaction: "", network: b.paymentRequirements.network } }),
  });
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const d = await mw.handle(req({ "payment-signature": paymentFor(pr.accepts[0]) }));
  assert.equal(d.action, "serve");
  if (d.action !== "serve") return;
  const done = await d.complete("secret result", 200);
  assert.equal(done.ok, false);
  if (!done.ok) {
    assert.equal(done.status, 402);
    assert.equal(decodeB64json(done.headers["PAYMENT-RESPONSE"]).success, false);
  }
});

test("handler error (non-2xx) → no settlement, buyer is not charged", async () => {
  const net = mockNetwork();
  const mw = seller(net);
  const pr = await firstRequirements(mw);
  const d = await mw.handle(req({ "payment-signature": paymentFor(pr.accepts[0]) }));
  assert.equal(d.action, "serve");
  if (d.action !== "serve") return;
  const done = await d.complete("oops", 500);
  assert.equal(done.ok, true);
  assert.equal(net.calls.some((c) => c.url.endsWith("/settle")), false);
});

// ── escrow branch ────────────────────────────────────────────────────────────

function escrowNet(state: Partial<NonNullable<MockOptions["deals"]>[string]> = {}, extra: MockOptions = {}) {
  return mockNetwork({
    ...extra,
    deals: {
      "deal-1": { sellerAgentId: SELLER, status: "active", escrowed: 25_000_000n, milestoneIds: ["m-1"], ...state },
    },
  });
}

test("escrow: funded deal for this seller → serve once, then submit the delivery with the artifact sha256", async () => {
  const net = escrowNet();
  const mw = seller(net, { price: "$25" });
  const d = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "serve");
  if (d.action !== "serve") return;
  assert.equal(d.mode, "escrow");
  const consume = net.calls.find((c) => c.url === `${API}/api/deals/deal-1/consume`);
  assert.ok(consume);
  assert.equal(consume.headers["x-api-key"], "seller-key");
  assert.equal(consume.body.priceBaseUnits, "25000000");
  assert.equal(consume.body.offerId, OFFER);

  const body = JSON.stringify({ rows: 10000, ok: true });
  const done = await d.complete(body, 200);
  assert.equal(done.ok, true);
  const delivery = net.calls.find((c) => c.url === `${API}/api/deliveries/submit`);
  assert.ok(delivery, "delivery submitted");
  assert.equal(delivery.body.milestoneId, "m-1");
  assert.equal(delivery.body.submittedBy, SELLER);
  const sha = createHash("sha256").update(body).digest("hex");
  assert.equal(delivery.body.artifacts[0].hash, `sha256:${sha}`);
  assert.equal(delivery.body.artifacts[0].url, RESOURCE);
  assert.equal(done.headers["X-AGENTPACT-DEAL"], "deal-1");
});

test("escrow: replay of a consumed deal → 402 again", async () => {
  const net = escrowNet();
  const mw = seller(net, { price: "$25" });
  const first = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(first.action, "serve");
  const replay = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(replay.action, "respond");
  if (replay.action === "respond") {
    assert.equal(replay.status, 402);
    assert.match(decodeB64json(replay.headers["PAYMENT-REQUIRED"]).error, /already_consumed/);
  }
});

test("escrow: underfunded deal → 402, not served", async () => {
  const net = escrowNet({ escrowed: 1_000_000n });
  const d = await seller(net, { price: "$25" }).handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") {
    assert.equal(d.status, 402);
    assert.match(decodeB64json(d.headers["PAYMENT-REQUIRED"]).error, /underfunded/);
  }
});

test("escrow: unfunded deal → 402 telling the buyer to fund", async () => {
  const net = escrowNet({ escrowed: 0n });
  const d = await seller(net, { price: "$25" }).handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") assert.match(decodeB64json(d.headers["PAYMENT-REQUIRED"]).error, /not_funded/);
});

test("escrow: deal belonging to another seller → 402, not served", async () => {
  const net = escrowNet({ sellerAgentId: "99999999-9999-4999-8999-999999999999" });
  const d = await seller(net, { price: "$25" }).handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") {
    assert.equal(d.status, 402);
    assert.match(decodeB64json(d.headers["PAYMENT-REQUIRED"]).error, /wrong_seller/);
  }
});

test("escrow: proposed deal → middleware accepts it for the seller and asks the buyer to fund", async () => {
  const net = escrowNet({ status: "proposed", escrowed: 0n });
  const d = await seller(net, { price: "$25" }).handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "respond");
  const accept = net.calls.find((c) => c.url === `${API}/api/deals/deal-1/accept`);
  assert.ok(accept, "accept called");
  assert.equal(accept.body.actorAgentId, SELLER);
  if (d.action === "respond") {
    const pr = decodeB64json(d.headers["PAYMENT-REQUIRED"]);
    assert.match(pr.error, /accepted_awaiting_funding/);
  }
  assert.equal(net.deals["deal-1"].status, "active");
});

test("escrow: AgentPact API unreachable → 500, not served", async () => {
  const mw = x402Escrow({
    sellerAgentId: SELLER, apiKey: "seller-key", offerId: OFFER, thresholdUsd: 1, price: "$25", payTo: PAY_TO,
    facilitatorUrl: FACILITATOR, apiBase: API,
    fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });
  const d = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "respond");
  if (d.action === "respond") assert.equal(d.status, 500);
});

test("escrow: delivery submission failure is reported but the paid response is still served", async () => {
  const errors: unknown[] = [];
  const net = escrowNet({}, { failDelivery: true });
  const mw = seller(net, { price: "$25", onError: (e) => errors.push(e) });
  const d = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "serve");
  if (d.action !== "serve") return;
  const done = await d.complete("data", 200);
  assert.equal(done.ok, true);
  assert.equal(errors.length, 1);
});

test("escrow: handler failure releases the consumption so the paid-for deal can be retried", async () => {
  const net = escrowNet();
  const mw = seller(net, { price: "$25" });
  const d = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(d.action, "serve");
  if (d.action !== "serve") return;
  await d.complete("internal error", 500);
  assert.ok(net.calls.some((c) => c.url === `${API}/api/deals/deal-1/consume/release`));
  assert.equal(net.calls.some((c) => c.url.endsWith("/api/deliveries/submit")), false, "no delivery for a failed response");
  assert.equal(net.deals["deal-1"].consumedKey, undefined);
  const again = await mw.handle(req({ [DEAL_HEADER.toLowerCase()]: "deal-1" }));
  assert.equal(again.action, "serve", "buyer can retry the same deal");
});

test("escrow: deal header on a seller without offerId is a configuration error at construction", () => {
  assert.throws(() => x402Escrow({
    sellerAgentId: SELLER, apiKey: "k", thresholdUsd: 1, price: "$25", payTo: PAY_TO,
  } as any), /offerId/);
});

test("config: threshold and price validated at construction", () => {
  assert.throws(() => x402Escrow({
    sellerAgentId: SELLER, apiKey: "k", offerId: OFFER, thresholdUsd: -1, price: "$1", payTo: PAY_TO,
  }), /USD/);
});
