/**
 * receipts-routes.test.ts — /agents/:handle and /.well-known/agentpact-receipts.json
 * (ap_v31 M2). In-process: a Fastify instance with only the receipts module and a
 * stubbed API, so the render logic is tested without spawning the whole web server.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createReceiptsRoutes } from "./routes/receipts.js";
import { routeModules } from "./routes/index.js";
import { receiptsRoutes } from "./routes/receipts.js";
import type { WebContext } from "./routes/types.js";

const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ctx: WebContext = { page: (title, body) => `<html><title>${escapeHtml(title)}</title><body>${body}</body></html>`, escapeHtml, apiBase: "http://api.internal" };

function row(over: Record<string, unknown> = {}) {
  return {
    id: "r-" + Math.random().toString(16).slice(2, 8),
    closed_at: "2026-10-02T10:00:00.000Z",
    outcome: "settled",
    role: "payee",
    counterparty: { agent_id: "b", handle: "buyer-bot" },
    notional_usdc: "5.00",
    acceptance_test: { source: "milestones", criteria_text: '[{"criteria":["412 rows"],"milestone":0}]', sha256: "ab".repeat(32) },
    artifact: { deliverable_hash: "0x" + "d".repeat(64), delivery_checksum: null },
    judge: { judge: "jev-1@classifier.dev", verdict: "complete", p: "0.91200" },
    counts_as_evidence: true,
    anchored: false,
    receipt_url: "/api/receipts/r1",
    ...over,
  };
}

function api(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (url: string | URL) => {
    const hit = routes[String(url)];
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function appWith(routes: Record<string, { status: number; body: unknown }>) {
  const app = Fastify();
  await createReceiptsRoutes({ fetchImpl: api(routes), publicApiBase: "https://api.example" })(app, ctx);
  return app;
}

const mixed = {
  agent: { id: "s", handle: "seller-bot" },
  counts: { evidence: { settled: 3, refunded: 1, disputed: 0, disputed_buyer_won: 0, disputed_seller_won: 0, timed_out: 0, cancelled_after_funding: 0, total: 4 }, not_counted: 1 },
  summary: "3 paid external deals settled, 1 refunded, 0 disputed",
  evidence_state: "sufficient",
  evidence_threshold: 3,
  evidence_note: null,
  receipts: [
    row(), row({ outcome: "refunded", judge: null }), row(), row(),
    row({ counts_as_evidence: false, counterparty: { agent_id: "h", handle: "house-bot" } }),
  ],
  next_offset: null,
};

describe("/agents/:handle", () => {
  it("is registered in the web route module registry", () => {
    assert.ok(routeModules.includes(receiptsRoutes));
  });

  it("renders the timeline with code-computed counts, no score, practice deals listed separately", async () => {
    const app = await appWith({ "http://api.internal/api/agents/seller-bot/receipts?limit=100": { status: 200, body: mixed } });
    const res = await app.inject({ method: "GET", url: "/agents/seller-bot" });
    assert.equal(res.statusCode, 200);
    const html = res.body;
    assert.match(html, /3 paid external deals settled, 1 refunded, 0 disputed/);
    assert.doesNotMatch(html, /Insufficient evidence/);
    assert.doesNotMatch(html, /score:|trust score|rating/i);
    // Every row carries outcome, notional, counterparty, acceptance test, artifact hash, judge verdict, verify link.
    const [evidencePart, practicePart] = html.split("Not counted as evidence");
    assert.ok(practicePart, "practice section missing");
    assert.equal((evidencePart.match(/<tr data-outcome=/g) ?? []).length, 4);
    assert.equal((practicePart.match(/<tr data-outcome=/g) ?? []).length, 1);
    assert.match(practicePart, /house-bot/);
    assert.doesNotMatch(evidencePart, /house-bot/);
    assert.match(evidencePart, /disputed|settled/);
    assert.match(evidencePart, /5\.00 USDC/);
    assert.match(evidencePart, /href="\/agents\/buyer-bot"/);
    assert.match(evidencePart, /412 rows/);
    assert.match(evidencePart, /<code>0xdddddddd…dddddd<\/code>/);
    assert.match(evidencePart, /complete <span class="dim">\(jev-1@classifier\.dev, p=0\.91200\)/);
    assert.match(evidencePart, /href="https:\/\/api\.example\/api\/receipts\/r1"[^>]*>verify</);
    assert.match(evidencePart, /no automated judge/);
  });

  it("shows the explicit insufficient-evidence state with what would change it", async () => {
    const thin = {
      ...mixed,
      agent: { id: "n", handle: "newbie" },
      counts: { evidence: { ...mixed.counts.evidence, settled: 1, refunded: 0, total: 1 }, not_counted: 0 },
      summary: "1 paid external deal settled, 0 refunded, 0 disputed",
      evidence_state: "insufficient",
      evidence_note: "Insufficient evidence: 1 paid deal with an independent counterparty has closed through escrow. At least 3 are needed before this record says anything.",
      receipts: [row()],
    };
    const app = await appWith({ "http://api.internal/api/agents/newbie/receipts?limit=100": { status: 200, body: thin } });
    const html = (await app.inject({ method: "GET", url: "/agents/newbie" })).body;
    assert.match(html, /<h2>Insufficient evidence<\/h2>/);
    assert.match(html, /At least 3 are needed/);
    assert.match(html, /1 paid external deal settled/);
    assert.doesNotMatch(html, /Not counted as evidence/);
  });

  it("escapes agent-controlled text (handles, criteria) — no stored XSS", async () => {
    const evil = { ...mixed, agent: { id: "x", handle: "x<script>" }, receipts: [row({ acceptance_test: { source: "need", criteria_text: "<img src=x onerror=alert(1)>", sha256: "00" } })] };
    const app = await appWith({ "http://api.internal/api/agents/x%3Cscript%3E/receipts?limit=100": { status: 200, body: evil } });
    const html = (await app.inject({ method: "GET", url: "/agents/x%3Cscript%3E" })).body;
    assert.doesNotMatch(html, /<script>|<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it("404s for an unknown agent and 502s (not a fake empty record) when the API is down", async () => {
    const app = await appWith({});
    assert.equal((await app.inject({ method: "GET", url: "/agents/ghost" })).statusCode, 404);
    const down = Fastify();
    await createReceiptsRoutes({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch })(down, ctx);
    const r = await down.inject({ method: "GET", url: "/agents/anyone" });
    assert.equal(r.statusCode, 502);
    assert.doesNotMatch(r.body, /Insufficient evidence/);
  });
});

describe("/.well-known/agentpact-receipts.json", () => {
  it("serves the API's key set as public JSON", async () => {
    const keys = { version: "apr-1", keys: [{ key_id: "k1", alg: "ed25519", public_key: "AAAA" }] };
    const app = await appWith({ "http://api.internal/api/receipts/keys": { status: 200, body: keys } });
    const res = await app.inject({ method: "GET", url: "/.well-known/agentpact-receipts.json" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.deepEqual(res.json(), keys);
  });

  it("502s instead of serving an empty key set when the API is unavailable", async () => {
    const app = await appWith({ "http://api.internal/api/receipts/keys": { status: 500, body: {} } });
    const res = await app.inject({ method: "GET", url: "/.well-known/agentpact-receipts.json" });
    assert.equal(res.statusCode, 502);
  });
});
