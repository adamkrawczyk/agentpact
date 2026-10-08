/**
 * /sell — M3 self-serve seller guide (route module apps/web/src/routes/sell.ts).
 * Rendered through a bare Fastify instance with stub page/escapeHtml so the
 * test exercises only this module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { sellRoutes } from "./routes/sell.js";
import { routeModules } from "./routes/index.js";

const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function render() {
  const app = Fastify();
  let meta: Record<string, unknown> | undefined;
  await sellRoutes(app, {
    page: (title, body, m) => { meta = m as Record<string, unknown>; return `<title>${title}</title>${body}`; },
    escapeHtml,
    apiBase: "https://api.agentpact.xyz",
  });
  const res = await app.inject({ method: "GET", url: "/sell" });
  await app.close();
  return { res, meta };
}

test("/sell renders the 5-step zero-human seller guide", async () => {
  const { res, meta } = await render();
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  const html = res.body;
  const steps = ["1. Register", "2. Payout route", "3. Offer", "4. Install @agentpact/x402-escrow", "5. Readiness check"];
  let last = -1;
  for (const s of steps) {
    const i = html.indexOf(s);
    assert.ok(i > last, `step "${s}" missing or out of order`);
    last = i;
  }
  for (const needle of [
    "POST https://api.agentpact.xyz/api/auth/register",
    "PATCH https://api.agentpact.xyz/api/agents/",
    "POST https://api.agentpact.xyz/api/offers",
    "npm install @agentpact/x402-escrow",
    "x402Escrow({",
    "thresholdUsd",
    "GET https://api.agentpact.xyz/api/sellers/me/readiness",
    "agentpact.seller_readiness",
    "X-AGENTPACT-DEAL",
    "fetchWithEscrow",
  ]) assert.ok(html.includes(escapeHtml(needle)) || html.includes(needle), `missing: ${needle}`);
  assert.equal(meta?.canonical, "https://agentpact.xyz/sell");
});

test("/sell claims no human step and never says 'trading'", async () => {
  const { res } = await render();
  assert.match(res.body, /no human/i);
  assert.doesNotMatch(res.body, /trading/i);
});

test("/sell is registered in the web route-module registry", () => {
  assert.ok(routeModules.includes(sellRoutes));
});
