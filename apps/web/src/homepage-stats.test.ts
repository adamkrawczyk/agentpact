/**
 * homepage-stats.test.ts
 *
 * Renders the homepage and the leaderboard page against a stubbed API and
 * asserts what a visitor actually sees: the exact honest counters from
 * /api/stats/public, the three use-case cards, the method line, the empty
 * leaderboard sentence — and that no stale "Live Deals" claim or the word
 * "trading" appears. Render the route, never grep the source.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, stopServer } from "./test-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(__dirname, process.env.WEB_SRC_OVERRIDE ?? "index.ts");
const TEST_PORT = 29861;
const STUB_PORT = 29862;
const BASE = `http://localhost:${TEST_PORT}`;
const NOTE = "No ranked agents yet — ranking needs 3 paid, external, settled deals.";
const METHOD = "Paid deals settled (external) = completed deals with real USDC in escrow, test method line.";

const stub: { stats: Record<string, unknown>; leaderboard: Record<string, unknown> } = {
  stats: {},
  leaderboard: {},
};

let api: Server | null = null;
let web: ChildProcess | null = null;

before(async () => {
  api = createServer((req, res) => {
    const routes: Record<string, Record<string, unknown>> = {
      "/api/stats/public": stub.stats,
      "/api/leaderboard": stub.leaderboard,
    };
    const body = routes[(req.url ?? "").split("?")[0]] ?? null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not stubbed" }));
  });
  await new Promise<void>((r) => api!.listen(STUB_PORT, "127.0.0.1", () => r()));
  web = await startServer({ src: WEB_SRC, port: TEST_PORT, env: { API_BASE_URL: `http://127.0.0.1:${STUB_PORT}` } });
});

after(async () => {
  stopServer(web);
  await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
});

function statValue(html: string, key: string): string {
  const m = html.match(new RegExp(`data-stat="${key}">([^<]*)<`));
  assert.ok(m, `stat ${key} not rendered`);
  return m[1];
}

async function home(): Promise<string> {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  return r.text();
}

describe("homepage", () => {
  test("renders the exact honest counters from /api/stats/public", async () => {
    stub.stats = {
      paidDealsSettledExternal: 2,
      paidVolumeSettledExternalUsd: "123456",
      practiceDeals: 17,
      agentsListed: "1,000+",
      openNeeds: 9,
      activeOffers: 31,
      generatedAt: "2026-10-07T00:00:00.000Z",
      method: METHOD,
    };
    const html = await home();
    assert.equal(statValue(html, "paid-settled"), "2");
    assert.equal(statValue(html, "paid-volume"), "$1,234.56");
    assert.equal(statValue(html, "practice"), "17");
    assert.equal(statValue(html, "open-needs"), "9");
    assert.equal(statValue(html, "agents"), "1,000+");
    assert.ok(html.includes("Paid deals settled (external)"));
    assert.ok(html.includes("Practice deals"));
    assert.ok(html.includes(METHOD), "method line missing");
  });

  test("shows zero as zero, with the method line", async () => {
    stub.stats = {
      paidDealsSettledExternal: 0,
      paidVolumeSettledExternalUsd: "0",
      practiceDeals: 0,
      agentsListed: "0",
      openNeeds: 0,
      activeOffers: 0,
      generatedAt: "2026-10-07T00:00:00.000Z",
      method: METHOD,
    };
    const html = await home();
    assert.equal(statValue(html, "paid-settled"), "0");
    assert.equal(statValue(html, "paid-volume"), "$0.00");
    assert.equal(statValue(html, "practice"), "0");
    assert.ok(html.includes(METHOD));
  });

  test("leads with the hook and the three use cases; copy-paste calls only for what ships", async () => {
    const html = await home();
    assert.ok(html.includes("AgentPact — escrow that turns agent work into evidence."));
    assert.match(html, /Pay on delivery, get a receipt, and check any agent before you pay\./);
    const hookAt = html.indexOf("escrow that turns agent work into evidence");
    for (const [key, title, call] of [
      ["pay-on-delivery", "Pay on delivery", "agentpact.submit_funding_authorization"],
      ["check-before-you-pay", "Check before you pay", "agentpact.get_reputation"],
    ] as const) {
      const at = html.indexOf(`data-usecase="${key}"`);
      assert.ok(at > hookAt, `card ${key} missing or above the hook`);
      const card = html.slice(at, html.indexOf("</pre>", at));
      assert.ok(card.includes(title), `card ${key} title`);
      assert.ok(card.includes(call), `card ${key} call`);
    }
    assert.ok(html.includes("/api/agents/&lt;agent-id&gt;/reputation"));
    assert.ok(html.includes("Fund with USDC on Base. Funding from Solana or Ethereum is coming soon."));
  });

  test("R1-09: lanes that are not shipped are labelled coming soon, with nothing to copy-paste", async () => {
    const html = await home();
    const at = html.indexOf('data-usecase="safety-net"');
    assert.ok(at > 0, "safety-net card missing");
    const card = html.slice(at, html.indexOf("</section>", at));
    assert.ok(card.includes('data-status="coming-soon"'));
    assert.ok(card.includes("Coming soon"));
    assert.ok(!card.includes("<pre"), "a coming-soon card must not carry copy-paste code");
    for (const unshipped of ["@agentpact/x402-escrow", "x402Escrow(", "agentpact.check_agent", "agentpact.quote_cross_chain",
      "agentpact.fund_deal_cross_chain", "/api/check/", "/api/cctp/", "USDC on Base, Solana or Ethereum"]) {
      assert.ok(!html.includes(unshipped), `homepage still advertises unshipped ${unshipped}`);
    }
  });

  test("drops stale claims and never says trading", async () => {
    const html = await home();
    assert.ok(!/Live Deals/i.test(html), "stale 'Live Deals' counter still rendered");
    assert.ok(!/trading/i.test(html), "the word 'trading' appears");
  });

  test("upstream failure shows n/a, never a fake zero", async () => {
    stub.stats = { error: "boom" } as Record<string, unknown>;
    const saved = api!;
    await new Promise<void>((r) => saved.close(() => r()));
    try {
      const html = await home();
      assert.equal(statValue(html, "paid-settled"), "n/a");
    } finally {
      api = createServer(saved.listeners("request")[0] as Parameters<typeof createServer>[0]);
      await new Promise<void>((r) => api!.listen(STUB_PORT, "127.0.0.1", () => r()));
    }
  });
});

describe("llms.txt", () => {
  test("carries the honest snapshot and never says trading", async () => {
    stub.stats = { ...stub.stats, paidDealsSettledExternal: 4, practiceDeals: 5, openNeeds: 1, activeOffers: 2, agentsListed: "80+", paidVolumeSettledExternalUsd: "1", method: METHOD };
    const r = await fetch(`${BASE}/llms.txt`);
    const text = await r.text();
    assert.match(text, /paid deals settled \(external\): 4/);
    assert.match(text, /practice deals \(\$0\):\s+5/);
    assert.ok(!/live deals/i.test(text));
    assert.ok(!/trading/i.test(text));
  });

  test("R1-09: advertises only calls that ship", async () => {
    const text = await (await fetch(`${BASE}/llms.txt`)).text();
    for (const unshipped of ["@agentpact/x402-escrow", "agentpact.check_agent", "agentpact.quote_cross_chain", "/api/check/", "/api/cctp/"]) {
      assert.ok(!text.includes(unshipped), `llms.txt still advertises unshipped ${unshipped}`);
    }
    assert.match(text, /agentpact\.get_reputation/);
  });
});

describe("leaderboard page", () => {
  test("renders the explicit sentence when nobody is ranked", async () => {
    stub.leaderboard = { ranked: [], unrankedCount: 12, rule: "Ranked agents have at least 3 paid deals.", note: NOTE };
    const r = await fetch(`${BASE}/leaderboard`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes(NOTE), "empty-board sentence missing");
    assert.ok(!html.includes("<tbody>"), "an empty ranking must not render a table");
  });

  test("renders ranked agents with their evidence", async () => {
    stub.leaderboard = {
      ranked: [{ rank: 1, agentId: "a-1", name: "Real Seller", trustTier: "bronze", reputationScore: 88.5, reviewCount: 2, completedDeals: 3, disputeRate: 0, paidSettledDeals: 3, distinctCounterpartyOwners: 2 }],
      unrankedCount: 11,
      rule: "Ranked agents have at least 3 paid deals.",
      note: null,
    };
    const html = await (await fetch(`${BASE}/leaderboard`)).text();
    const row = html.slice(html.indexOf('data-agent-id="a-1"'));
    assert.ok(row.includes("Real Seller"));
    assert.match(row, /<td>3<\/td>\s*<td>2<\/td>/);
    assert.ok(!html.includes(NOTE));
  });
});
