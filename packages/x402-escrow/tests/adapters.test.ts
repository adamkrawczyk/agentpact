import { test } from "node:test";
import assert from "node:assert/strict";
import { x402EscrowExpress, x402EscrowFastify, x402EscrowHono, DEAL_HEADER } from "../src/index.js";
import { API, FACILITATOR, OFFER, PAY_TO, SELLER, b64json, decodeB64json, mockNetwork } from "./helpers.js";

function cfg(net: ReturnType<typeof mockNetwork>, price = "$0.02") {
  return {
    sellerAgentId: SELLER, apiKey: "seller-key", offerId: OFFER, thresholdUsd: 1, price, payTo: PAY_TO,
    facilitatorUrl: FACILITATOR, apiBase: API, fetch: net.fetch,
  };
}

const EXACT = {
  scheme: "exact", network: "eip155:8453", amount: "20000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const PAYMENT = b64json({ x402Version: 2, accepted: EXACT, payload: { signature: "0x", authorization: {} } });

// ── Express (structural fake of req/res) ─────────────────────────────────────

const text = (c: unknown) => (c instanceof Uint8Array ? new TextDecoder().decode(c) : String(c));

function fakeExpress(headers: Record<string, string>) {
  const req = { method: "GET", originalUrl: "/data?x=1", protocol: "https", headers: { host: "seller.test", ...headers }, get(h: string) { return (this.headers as any)[h.toLowerCase()]; } };
  const out: { status: number; headers: Record<string, string>; body: string; ended: boolean } = { status: 200, headers: {}, body: "", ended: false };
  const res: any = {
    statusCode: 200,
    headersSent: false,
    setHeader(k: string, v: string) { out.headers[k] = String(v); },
    getHeader(k: string) { return out.headers[k]; },
    removeHeader(k: string) { delete out.headers[k]; },
    status(code: number) { this.statusCode = code; return this; },
    write(chunk: any) { out.body += text(chunk); return true; },
    end(chunk?: any) { if (chunk !== undefined) out.body += text(chunk); out.status = this.statusCode; out.ended = true; return this; },
  };
  return { req, res, out };
}

test("express: no payment → 402 JSON with PAYMENT-REQUIRED header, handler not called", async () => {
  const net = mockNetwork();
  const mw = x402EscrowExpress(cfg(net));
  const { req, res, out } = fakeExpress({});
  let called = false;
  await mw(req as any, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(out.status, 402);
  assert.equal(decodeB64json(out.headers["PAYMENT-REQUIRED"]).resource.url, "https://seller.test/data?x=1");
});

test("express: paid → handler runs, body buffered until settlement, PAYMENT-RESPONSE attached", async () => {
  const net = mockNetwork();
  const mw = x402EscrowExpress(cfg(net));
  const { req, res, out } = fakeExpress({ "payment-signature": PAYMENT });
  await mw(req as any, res, () => { res.status(200); res.write("hello "); res.end("world"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.ended, true);
  assert.equal(out.status, 200);
  assert.equal(out.body, "hello world");
  assert.equal(decodeB64json(out.headers["PAYMENT-RESPONSE"]).success, true);
});

test("express: settlement failure → buffered body is withheld, 402 sent instead", async () => {
  const net = mockNetwork({ settle: () => ({ json: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453" } }) });
  const mw = x402EscrowExpress(cfg(net));
  const { req, res, out } = fakeExpress({ "payment-signature": PAYMENT });
  await mw(req as any, res, () => { res.status(200); res.end("secret"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.status, 402);
  assert.doesNotMatch(out.body, /secret/);
});

// ── Fastify (preHandler + onSend hooks) ──────────────────────────────────────

function fakeFastify(headers: Record<string, string>) {
  const request = { method: "GET", url: "/data", protocol: "https", hostname: "seller.test", headers: { host: "seller.test", ...headers } };
  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const reply: any = {
    statusCode: 200,
    sent: false,
    code(c: number) { this.statusCode = c; sent.status = c; return this; },
    header(k: string, v: string) { sent.headers[k] = v; return this; },
    getHeader(k: string) { return sent.headers[k]; },
    send(b: unknown) { sent.body = b; this.sent = true; return this; },
  };
  return { request, reply, sent };
}

test("fastify: preHandler answers 402; onSend settles and swaps the payload on failure", async () => {
  const net = mockNetwork();
  const hooks = x402EscrowFastify(cfg(net));
  const a = fakeFastify({});
  await hooks.preHandler(a.request as any, a.reply);
  assert.equal(a.sent.status, 402);

  const b = fakeFastify({ "payment-signature": PAYMENT });
  await hooks.preHandler(b.request as any, b.reply);
  assert.equal(b.reply.sent, false, "paid request falls through to the handler");
  const payload = await hooks.onSend(b.request as any, b.reply, "the-data");
  assert.equal(payload, "the-data");
  assert.equal(decodeB64json(b.sent.headers["PAYMENT-RESPONSE"]).success, true);
});

test("fastify: escrow branch submits delivery from onSend", async () => {
  const net = mockNetwork({ deals: { d1: { sellerAgentId: SELLER, status: "active", escrowed: 30_000_000n, milestoneIds: ["m1"], token: "t1" } } });
  const hooks = x402EscrowFastify(cfg(net, "$25"));
  const r = fakeFastify({ [DEAL_HEADER.toLowerCase()]: "d1", "x-agentpact-deal-token": "t1" });
  await hooks.preHandler(r.request as any, r.reply);
  assert.equal(r.reply.sent, false);
  await hooks.onSend(r.request as any, r.reply, Buffer.from("rows"));
  assert.ok(net.calls.some((c) => c.url.endsWith("/api/deliveries/submit")));
});

// ── Hono (real Request/Response objects) ─────────────────────────────────────

function fakeHono(headers: Record<string, string>) {
  const raw = new Request("https://seller.test/data", { headers });
  const c: any = {
    req: { raw, url: raw.url, method: raw.method, header: (k: string) => raw.headers.get(k) ?? undefined },
    res: new Response(null),
    newResponse: undefined,
  };
  return c;
}

test("hono: 402 without payment, settles with payment", async () => {
  const net = mockNetwork();
  const mw = x402EscrowHono(cfg(net));
  const c1 = fakeHono({});
  const r1 = await mw(c1, async () => { throw new Error("must not run"); });
  assert.ok(r1 instanceof Response);
  assert.equal(r1.status, 402);
  assert.ok(r1.headers.get("PAYMENT-REQUIRED"));

  const c2 = fakeHono({ "payment-signature": PAYMENT });
  await mw(c2, async () => { c2.res = new Response("paid data", { status: 200 }); });
  assert.equal(c2.res.status, 200);
  assert.equal(await c2.res.text(), "paid data");
  assert.equal(decodeB64json(c2.res.headers.get("PAYMENT-RESPONSE")).success, true);
});
