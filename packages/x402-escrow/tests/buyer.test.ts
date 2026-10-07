import { test } from "node:test";
import assert from "node:assert/strict";
import { x402Escrow, fetchWithEscrow, createEvmExactSigner, DEAL_HEADER, type PaymentRequirements } from "../src/index.js";
import { API, FACILITATOR, OFFER, PAY_TO, SELLER, decodeB64json, mockNetwork, type DealState } from "./helpers.js";

const RESOURCE = "https://seller.test/batch";
const BUYER = "33333333-3333-4333-8333-333333333333";

/**
 * A whole little world: the seller's resource (served through the real
 * middleware core), the facilitator, and the AgentPact API (buyer + seller
 * sides) sharing one deals table.
 */
function world(price: string, opts: { simulationFunding?: boolean } = {}) {
  const deals: Record<string, DealState> = {};
  const sellerNet = mockNetwork({ deals });
  const mw = x402Escrow({
    sellerAgentId: SELLER, apiKey: "seller-key", offerId: OFFER, thresholdUsd: 1, price, payTo: PAY_TO,
    facilitatorUrl: FACILITATOR, apiBase: API, fetch: sellerNet.fetch,
  });
  const buyerCalls: Array<{ url: string; method: string; body: any }> = [];
  let dealSeq = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const buyerFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    buyerCalls.push({ url, method, body });

    if (url === RESOURCE) {
      const h: Record<string, string> = {};
      headers.forEach((v, k) => { h[k] = v; });
      const d = await mw.handle({ method, url, headers: h });
      if (d.action === "respond") return new Response(JSON.stringify(d.body), { status: d.status, headers: d.headers });
      const done = await d.complete("BATCH-RESULT", 200);
      if (!done.ok) return new Response(JSON.stringify(done.body), { status: done.status, headers: done.headers });
      return new Response("BATCH-RESULT", { status: 200, headers: done.headers });
    }
    if (url.startsWith(FACILITATOR)) return sellerNet.fetch(input, init);
    if (headers.get("x-api-key") !== "buyer-key") return json(401, { error: "bad key" });
    if (url === `${API}/api/needs` && method === "POST") return json(201, { id: "need-1" });
    if (url === `${API}/api/deals/propose` && method === "POST") {
      const id = `deal-${++dealSeq}`;
      deals[id] = { sellerAgentId: body.sellerAgentId, status: "proposed", escrowed: 0n, milestoneIds: [`${id}-m1`] };
      return json(201, { id, status: "proposed" });
    }
    const getDeal = url.match(/\/api\/deals\/([^/?]+)$/);
    if (getDeal && method === "GET") {
      const d = deals[getDeal[1]];
      return json(200, { id: getDeal[1], status: d.status, milestones: d.milestoneIds.map((id) => ({ id, amount: "25.000000" })) });
    }
    if (url === `${API}/api/payments/create-intent` && method === "POST") {
      const dealId = body.milestoneId.replace(/-m1$/, "");
      if (opts.simulationFunding !== false) {
        deals[dealId].escrowed = 25_000_000n;
        return json(201, { paymentIntentId: "pi-1", status: "funded", mode: "simulation" });
      }
      return json(201, {
        paymentIntentId: "pi-1", status: "created", mode: "on-chain",
        txData: { step1_approve: { to: "0xusdc", data: "0x01", value: "0" }, step2_fund: { to: "0xescrow", data: "0x02", value: "0" } },
      });
    }
    if (url === `${API}/api/payments/confirm-funding` && method === "POST") {
      const dealId = Object.keys(deals)[0];
      deals[dealId].escrowed = 25_000_000n;
      return json(200, { status: "funded" });
    }
    return json(404, { error: `unmocked ${method} ${url}` });
  }) as typeof fetch;

  return { buyerFetch, buyerCalls, deals, sellerNet };
}

const fakeSigner = async (req: PaymentRequirements) => ({
  x402Version: 2 as const,
  accepted: req,
  payload: { signature: "0xsig", authorization: { from: "0xbuyer", to: req.payTo, value: req.amount } },
});

test("buyer: small price → plain x402 (signs the exact option, no AgentPact calls)", async () => {
  const w = world("$0.02");
  const res = await fetchWithEscrow(RESOURCE, { method: "POST" }, {
    x402Signer: fakeSigner, maxPlainUsd: 1, fetch: w.buyerFetch,
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "BATCH-RESULT");
  assert.equal(w.buyerCalls.filter((c) => c.url.startsWith(API)).length, 0);
});

test("buyer: price above maxPlainUsd → escrow: need → propose → seller accepts → fund → retry → served", async () => {
  const w = world("$25");
  const res = await fetchWithEscrow(RESOURCE, { method: "POST" }, {
    x402Signer: fakeSigner, maxPlainUsd: 1, apiKey: "buyer-key", agentId: BUYER, apiBase: API, fetch: w.buyerFetch,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(DEAL_HEADER), "deal-1");
  const propose = w.buyerCalls.find((c) => c.url.endsWith("/api/deals/propose"));
  assert.ok(propose);
  assert.equal(propose.body.sellerAgentId, SELLER);
  assert.equal(propose.body.offerId, OFFER);
  assert.equal(propose.body.buyerAgentId, BUYER);
  assert.equal(propose.body.negotiatedTotal, 25);
  assert.equal(w.deals["deal-1"].consumedKey !== undefined, true);
  assert.ok(w.sellerNet.calls.some((c) => c.url.endsWith("/api/deliveries/submit")), "seller submitted delivery");
});

test("buyer: on-chain funding uses the caller's sendTransaction for both steps, then confirms", async () => {
  const w = world("$25", { simulationFunding: false });
  const sent: string[] = [];
  const res = await fetchWithEscrow(RESOURCE, {}, {
    maxPlainUsd: 1, apiKey: "buyer-key", agentId: BUYER, apiBase: API, fetch: w.buyerFetch,
    walletAddress: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    sendTransaction: async (tx) => { sent.push(tx.to); return `0x${String(sent.length).padStart(64, "0")}`; },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, ["0xusdc", "0xescrow"]);
  const confirm = w.buyerCalls.find((c) => c.url.endsWith("/api/payments/confirm-funding"));
  assert.equal(confirm?.body.txHash, `0x${"2".padStart(64, "0")}`);
});

test("buyer: escrow needed but no apiKey → returns the 402 untouched (never pays plain above the cap)", async () => {
  const w = world("$25");
  const res = await fetchWithEscrow(RESOURCE, {}, { x402Signer: fakeSigner, maxPlainUsd: 1, fetch: w.buyerFetch });
  assert.equal(res.status, 402);
  assert.equal(w.buyerCalls.length, 1);
});

test("buyer: non-402 responses pass straight through", async () => {
  const f = (async () => new Response("free", { status: 200 })) as typeof fetch;
  const res = await fetchWithEscrow("https://free.test/", {}, { fetch: f });
  assert.equal(await res.text(), "free");
});

test("createEvmExactSigner: EIP-712 TransferWithAuthorization over the USDC domain from `extra`", async () => {
  let typed: any;
  const signer = createEvmExactSigner({
    address: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    signTypedData: async (t) => { typed = t; return "0xsigned"; },
  }, { now: () => 1_740_672_089_000 });
  const req: PaymentRequirements = {
    scheme: "exact", network: "eip155:8453", amount: "20000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
  const p = await signer(req);
  assert.equal(p.x402Version, 2);
  assert.deepEqual(p.accepted, req);
  assert.equal(typed.primaryType, "TransferWithAuthorization");
  assert.deepEqual(typed.domain, { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: req.asset });
  assert.equal(typed.message.value, 20000n);
  assert.equal(typed.message.to, PAY_TO);
  const auth = (p.payload as any).authorization;
  assert.equal(auth.value, "20000");
  assert.equal(auth.validBefore, String(1_740_672_089 + 60));
  assert.match(auth.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal((p.payload as any).signature, "0xsigned");
  await assert.rejects(signer({ ...req, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), /EVM/);
});

test("buyer: decodes PAYMENT-REQUIRED from the header (v2 transport)", async () => {
  const w = world("$0.02");
  const res = await w.buyerFetch(RESOURCE, {});
  assert.equal(res.status, 402);
  assert.equal(decodeB64json(res.headers.get("PAYMENT-REQUIRED") ?? undefined).x402Version, 2);
});

test("buyer: API key only goes to the configured apiBase, never to a seller-advertised one", async () => {
  const w = world("$25");
  const seen: string[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    if (h.get("x-api-key")) seen.push(new URL(url).origin);
    const res = await w.buyerFetch(input, init);
    if (url === RESOURCE && res.status === 402) {
      // A hostile seller rewrites apiBase in its escrow option.
      const pr = decodeB64json(res.headers.get("PAYMENT-REQUIRED") ?? undefined);
      for (const a of pr.accepts) if (a.extra?.agentpact) a.extra.agentpact.apiBase = "https://evil.test";
      const hdr = Buffer.from(JSON.stringify(pr)).toString("base64");
      return new Response(JSON.stringify(pr), { status: 402, headers: { "PAYMENT-REQUIRED": hdr } });
    }
    return res;
  }) as typeof fetch;
  const res = await fetchWithEscrow(RESOURCE, {}, { maxPlainUsd: 1, apiKey: "buyer-key", agentId: BUYER, apiBase: API, fetch: spy });
  assert.equal(res.status, 200);
  assert.ok(seen.length > 0);
  assert.deepEqual([...new Set(seen)], [new URL(API).origin]);
});

test("buyer: escrow above maxEscrowUsd is refused (returns the 402, creates nothing)", async () => {
  const w = world("$25");
  const res = await fetchWithEscrow(RESOURCE, {}, { maxPlainUsd: 1, maxEscrowUsd: 10, apiKey: "buyer-key", agentId: BUYER, apiBase: API, fetch: w.buyerFetch });
  assert.equal(res.status, 402);
  assert.equal(w.buyerCalls.some((c) => c.url.startsWith(API)), false);
});
