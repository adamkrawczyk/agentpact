/**
 * honest_0710 phase B — the public numbers equal the audited SQL.
 *
 * `/api/stats/public` must count only what `qualifying_deals` says counts
 * (capital_at_risk AND completed for "paid settled"). The seed below plants a
 * clean paid deal next to every way a deal can fake activity — self, same
 * owner, internal party, $0, quarantined, unfunded, not yet settled — and the
 * tests assert that none of them leaks into the "paid settled" numbers, and
 * that the endpoint agrees with an independent query over the views.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";
import { formatFlooredCount, resetPublicStatsCache } from "../routes/public-stats.js";

const W = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];

async function mkAgent(sql: Sql, wallet: string, opts: { internal?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal)
    VALUES (${id}, ${"ps-" + id.slice(0, 8)}, ${"ps " + id.slice(0, 4)}, ${wallet}, 'metamask', ${opts.internal ?? false})`;
  return id;
}

async function mkListing(sql: Sql, agentId: string): Promise<{ offerId: string; needId: string }> {
  const [o] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price)
    VALUES (${agentId}, 'ps offer', 'ps offer body', 'Data', 10) RETURNING id`;
  const [n] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, budget_max)
    VALUES (${agentId}, 'ps need', 'ps need body', 'Data', 10) RETURNING id`;
  return { offerId: String(o.id), needId: String(n.id) };
}

let fixture: { offerId: string; needId: string };

async function mkDeal(
  sql: Sql,
  d: { buyer: string; seller: string; total: string; status?: string; funded?: boolean; integrityClass?: string | null },
): Promise<string> {
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, integrity_class)
    VALUES (${d.buyer}, ${d.seller}, ${fixture.offerId}, ${fixture.needId}, ${d.status ?? "completed"}, ${d.total}, 'USDC', 20, ${d.integrityClass ?? null})
    RETURNING id`;
  if (d.funded) {
    const [m] = await sql`
      INSERT INTO milestones (deal_id, idx, title, amount, currency)
      VALUES (${deal.id}, 1, 'm', ${d.total}, 'USDC') RETURNING id`;
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m.id}, ${d.buyer}, ${d.seller}, ${d.total}, 'released', ${W(1)}, ${W(2)}, ${W(9)})`;
  }
  return String(deal.id);
}

describe("formatFlooredCount", () => {
  it("never rounds up and never leads with an exact large total", () => {
    expect(formatFlooredCount(0)).toBe("0");
    expect(formatFlooredCount(7)).toBe("7");
    expect(formatFlooredCount(10)).toBe("10+");
    expect(formatFlooredCount(87)).toBe("80+");
    expect(formatFlooredCount(230)).toBe("200+");
    expect(formatFlooredCount(1000)).toBe("1,000+");
    expect(formatFlooredCount(1999)).toBe("1,000+");
    expect(formatFlooredCount(12_345)).toBe("10,000+");
  });
});

describe("GET /api/stats/public", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let sql: Sql;

  beforeAll(async () => {
    const t = await createTestApp();
    app = t.app;
    sql = t.sql;
    await cleanDatabase();

    const a = await mkAgent(sql, W(1));
    const b = await mkAgent(sql, W(2));
    const c = await mkAgent(sql, W(3));
    const d = await mkAgent(sql, W(4));
    const aTwin = await mkAgent(sql, W(1).toUpperCase().replace("0X", "0x")); // same owner as a
    const fleet = await mkAgent(sql, W(5), { internal: true });
    const zero = await mkAgent(sql, ZERO);
    fixture = await mkListing(sql, a);
    await mkListing(sql, b); // second external listing pair
    await mkListing(sql, fleet); // internal listings never count as marketplace activity
    await sql`INSERT INTO offers (agent_id, title, description_md, category, base_price, status) VALUES (${b}, 'old', 'archived offer', 'Data', 5, 'archived')`;
    await sql`INSERT INTO needs (agent_id, title, description_md, category, budget_max, status) VALUES (${c}, 'old', 'closed need', 'Data', 5, 'closed')`;

    // Counts as paid settled (2 deals, 25 + 12.345678 = 37.345678 → 3734 cents).
    await mkDeal(sql, { buyer: a, seller: b, total: "25", funded: true });
    await mkDeal(sql, { buyer: c, seller: d, total: "12.345678", funded: true });
    // Every way to fake it — none may count as paid settled.
    await mkDeal(sql, { buyer: a, seller: d, total: "40", funded: true, status: "active" }); // not settled
    await mkDeal(sql, { buyer: a, seller: b, total: "7", funded: false }); // qualifying, no capital
    await mkDeal(sql, { buyer: a, seller: a, total: "10", funded: true }); // self
    await mkDeal(sql, { buyer: a, seller: aTwin, total: "10", funded: true }); // same owner
    await mkDeal(sql, { buyer: fleet, seller: b, total: "10", funded: true }); // internal party
    await mkDeal(sql, { buyer: zero, seller: b, total: "10", funded: true }); // unknown owner
    await mkDeal(sql, { buyer: c, seller: b, total: "50", funded: true, integrityClass: "quarantined_farm" });
    // Practice ($0): two real ones, plus farm-shaped $0 deals that must not count.
    await mkDeal(sql, { buyer: b, seller: c, total: "0" });
    await mkDeal(sql, { buyer: d, seller: a, total: "0" });
    await mkDeal(sql, { buyer: a, seller: a, total: "0" }); // self practice → no
    await mkDeal(sql, { buyer: a, seller: aTwin, total: "0" }); // same-owner practice → no
    await mkDeal(sql, { buyer: fleet, seller: c, total: "0" }); // fleet practice → no
    await mkDeal(sql, { buyer: b, seller: d, total: "0", integrityClass: "quarantined_farm" }); // → no
    await mkDeal(sql, { buyer: c, seller: d, total: "0", status: "proposed" }); // not completed → no
  });

  beforeEach(() => resetPublicStatsCache());

  it("is public: an anonymous request gets 200", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats/public" });
    expect(res.statusCode).toBe(200);
  });

  it("counts only capital-at-risk, completed, external deals as paid settled", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats/public" });
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      paidDealsSettledExternal: 2,
      paidVolumeSettledExternalUsd: "3734",
      practiceDeals: 2,
      agentsListed: "6",
      openNeeds: 2,
      activeOffers: 2,
    });
    expect(typeof body.method).toBe("string");
    expect(body.method).toMatch(/paid/i);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("equals an independent query over the qualifying_deals view", async () => {
    const [paid] = await sql`
      SELECT count(*)::int AS n, floor(coalesce(sum(negotiated_total), 0) * 100)::bigint::text AS cents
      FROM qualifying_deals WHERE capital_at_risk AND status = 'completed'`;
    const body = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
    expect(body.paidDealsSettledExternal).toBe(paid.n);
    expect(body.paidVolumeSettledExternalUsd).toBe(paid.cents);
  });

  it("serves a cached snapshot for ~60 s, then recomputes", async () => {
    const first = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
    const [x] = await sql`SELECT id FROM agents WHERE owner_wallet_address = ${W(3)}`;
    const [y] = await sql`SELECT id FROM agents WHERE owner_wallet_address = ${W(4)}`;
    const extra = await mkDeal(sql, { buyer: String(y.id), seller: String(x.id), total: "1", funded: true });
    const cached = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
    expect(cached).toEqual(first);
    resetPublicStatsCache();
    const fresh = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
    expect(fresh.paidDealsSettledExternal).toBe(first.paidDealsSettledExternal + 1);
    await sql`DELETE FROM payment_intents WHERE milestone_id IN (SELECT id FROM milestones WHERE deal_id = ${extra})`;
    await sql`DELETE FROM milestones WHERE deal_id = ${extra}`;
    await sql`DELETE FROM deals WHERE id = ${extra}`;
  });
});
