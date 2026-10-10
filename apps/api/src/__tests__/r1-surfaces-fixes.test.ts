import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { resetPublicStatsCache } from "../routes/public-stats.js";
import { getAgentStats } from "../shared/reputation.js";

// honest_0710 FIX-R1 (lane m0-surfaces): regressions for R1-04, R1-06, R1-07,
// R1-09 and R1-10. Each was seen RED on the stacked branch before its fix.

const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: App;
let sql: Sql;

beforeEach(async () => {
  ({ app, sql } = await createTestApp());
  await cleanDatabase();
  resetPublicStatsCache();
});

async function agent(wallet: string) {
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id, { walletAddress: wallet });
  return { id, headers };
}

async function listing(buyer: string, seller: string, price = 10) {
  const [o] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, accepted_payment_methods)
    VALUES (${seller}, ${"r1s offer " + randomUUID()}, 'body', 'Data', ${price}, 'usdc') RETURNING id`;
  const [n] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, accepted_payment_methods)
    VALUES (${buyer}, 'r1s need', 'body', 'Data', 'usdc') RETURNING id`;
  return { offerId: String(o.id), needId: String(n.id) };
}

/** A completed deal; `escrow` = USDC released through a payment intent (0 = unfunded). */
async function completedDeal(b: string, s: string, price: number, escrow: number) {
  const l = await listing(b, s, price);
  const [d] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${b}, ${s}, ${l.offerId}, ${l.needId}, 'active', ${price}, 100, ${price === 0}) RETURNING id`;
  const [m] = await sql`INSERT INTO milestones (deal_id, idx, title, amount, status) VALUES (${d.id}, 1, 'M1', ${escrow || price}, 'in_progress') RETURNING id`;
  if (escrow > 0) {
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m.id}, ${b}, ${s}, ${escrow}, 'released', ${W(1)}, ${W(2)}, ${W(9)})`;
  }
  await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
  return String(d.id);
}

async function feedback(dealId: string, from: { id: string; headers: Record<string, string> }, to: string, r = 5) {
  const res = await app.inject({
    method: "POST", url: "/api/feedback", headers: from.headers,
    payload: { dealId, fromAgentId: from.id, toAgentId: to, ratingQuality: r, ratingTimeliness: r, ratingCommunication: r, ratingAccuracy: r },
  });
  expect(res.statusCode).toBe(201);
}

async function boards() {
  const main = JSON.parse((await app.inject({ method: "GET", url: "/api/leaderboard" })).body);
  const rep = JSON.parse((await app.inject({ method: "GET", url: "/api/reputation/leaderboard" })).body);
  return { main, rep };
}
const pick = (board: { ranked: Array<Record<string, unknown>> }, id: string) => board.ranked.find((x) => x.agentId === id) as Record<string, any>;

describe("R1-04 / R1-10 — practice deals and their reviews never move public tiers, scores or counts", () => {
  it("25 practice deals with 5-star reviews leave both boards and every profile unchanged", async () => {
    const s = await agent(W(2));
    const b1 = await agent(W(1));
    const b2 = await agent(W(3));
    for (const b of [b1, b2, b1]) {
      const d = await completedDeal(b.id, s.id, 10, 10);
      await feedback(d, b, s.id, 3);
    }
    const before = await boards();
    const profileBefore = JSON.parse((await app.inject({ method: "GET", url: `/api/reputation/${s.id}` })).body);

    for (let i = 0; i < 25; i++) {
      const d = await completedDeal(b1.id, s.id, 0, 0);
      await feedback(d, b1, s.id, 5);
    }
    const after = await boards();
    const evidence = await getAgentStats(sql, s.id);
    expect(evidence).toEqual({ completedDeals: 3, reputationScore: 3 });

    for (const [name, b, a] of [["main", before.main, after.main], ["rep", before.rep, after.rep]] as const) {
      const x = pick(b, s.id);
      const y = pick(a, s.id);
      expect({ name, y }).toEqual({ name, y: x });
    }
    const mainEntry = pick(after.main, s.id);
    const repEntry = pick(after.rep, s.id);
    expect(mainEntry.completedDeals).toBe(3);
    expect(repEntry.completedDeals).toBe(3);
    expect(repEntry.reviewCount).toBe(3);
    expect(repEntry.totalVolume).toBe(30);

    const agentRep = JSON.parse((await app.inject({ method: "GET", url: `/api/agents/${s.id}/reputation` })).body);
    expect(agentRep.trust_tier.tier).toBe(mainEntry.trustTier);
    expect(agentRep.total_completed_deals).toBe(3);
    expect(agentRep.total_reviews).toBe(3);

    const profile = JSON.parse((await app.inject({ method: "GET", url: `/api/reputation/${s.id}` })).body);
    expect(profile).toMatchObject({ completedDeals: 3, reviewCount: 3, totalVolume: 30, avgRating: 3 });
    expect(profile.score).toBe(profileBefore.score);
    expect(profile.trustTier.tier).toBe(repEntry.trustTier);
    expect(typeof profile.basis).toBe("string");

    const attestation = JSON.parse((await app.inject({ method: "GET", url: `/api/reputation/${s.id}/attestation` })).body);
    expect(attestation.score).toBe(profile.score);
  });
});

describe("R1-06 — paid volume is money escrowed, not the quote", () => {
  it("a $1000 quote with $0.000001 escrowed adds $0.00 to paid volume", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    await completedDeal(b.id, s.id, 1000, 0.000001);
    const stats = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
    expect(stats.paidDealsSettledExternal).toBe(1);
    expect(stats.paidVolumeSettledExternalUsd).toBe("0");
  });

  it("volume is capped at the negotiated total and sums real escrow", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    await completedDeal(b.id, s.id, 20, 12.345);
    await completedDeal(b.id, s.id, 5, 5);
    const stats = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
    expect(stats.paidVolumeSettledExternalUsd).toBe("1734");
    expect(stats.method).toMatch(/escrow/i);
  });
});

describe("R1-07 — a dust ring is not a ranked track record", () => {
  it("three $0.000001 deals across distinct owners rank nobody; the rule names the $0.01 floor", async () => {
    const s = await agent(W(2));
    for (const w of [W(1), W(3), W(4)]) {
      const b = await agent(w);
      await completedDeal(b.id, s.id, 0.000001, 0.000001);
    }
    const { main, rep } = await boards();
    expect(main.ranked).toEqual([]);
    expect(rep.ranked).toEqual([]);
    expect(main.rule).toMatch(/\$0\.01/);
  });
});

describe("R1-09 — every advertised call exists", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const web = read("../../../web/src/index.ts");
  const skill = read("../../../../docs/agentpact-skill/SKILL.md");
  const mcpReadme = read("../../../mcp/README.md");
  const mcpSource = read("../../../mcp/src/index.ts");
  const tools = new Set([...mcpSource.matchAll(/name: "(agentpact\.[a-z_]+)"/g)].map((m) => m[1]));

  it("every agentpact.* MCP tool named on the homepage, llms.txt, SKILL.md and the MCP README is registered", () => {
    const missing: string[] = [];
    for (const [where, text] of [["web", web], ["SKILL.md", skill], ["mcp README", mcpReadme]] as const) {
      for (const m of text.matchAll(/\bagentpact\.([a-z]+(?:_[a-z]+)+|[a-z]+)\b/g)) {
        if (["xyz"].includes(m[1])) continue;
        if (!tools.has(`agentpact.${m[1]}`)) missing.push(`${where}: agentpact.${m[1]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("every api.agentpact.xyz/api/... path on the homepage, llms.txt and SKILL.md is a real route", async () => {
    const missing: string[] = [];
    const ZERO_ID = "00000000-0000-0000-0000-000000000000";
    // Authenticated, so the global auth hook cannot answer 401 for a path that
    // has no route at all: only Fastify's own "Route … not found" means missing.
    const { headers } = await agent(W(7));
    for (const [where, text] of [["web", web], ["SKILL.md", skill]] as const) {
      for (const m of text.matchAll(/api\.agentpact\.xyz(\/api\/[^\s"'`?\\)]+)/g)) {
        const path = m[1]
          .replace(/<\/.*$/, "") // a closing HTML tag ends the path
          .replace(/&lt;[^&]*&gt;|<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z]+/g, ZERO_ID)
          .replace(/[.,;]+$/, "");
        let exists = false;
        for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"] as const) {
          const res = await app.inject({ method, url: path, headers });
          const body = res.body;
          if (!(res.statusCode === 404 && /Route [A-Z]+:.* not found/.test(body))) { exists = true; break; }
        }
        if (!exists) missing.push(`${where}: ${m[1]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
