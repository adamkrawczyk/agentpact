/**
 * honest_0710 — /api/admin/metrics uses the ONE definition of "external".
 *
 * economics.business must equal /api/stats/public paid-settled numbers on the
 * same fixtures; every other completed deal must land in exactly one
 * economics.excluded bucket (first failing reason); and the integrity guard
 * must trip when an owner wallet holds both internal and unflagged agents.
 * All fixtures are synthetic.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";
import { computePublicStats, resetPublicStatsCache } from "../routes/public-stats.js";
import {
  BULK_MARK_INTERNAL_ROUTE,
  EXCLUDED_BUCKETS,
  externalSplitIntegrity,
  MARK_INTERNAL_ROUTE,
} from "../shared/external-split.js";

const W = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN = { "x-admin-key": "test-admin-key" };

type T = Awaited<ReturnType<typeof createTestApp>>;
type Sql = T["sql"];

type Bucket = { deals: number; negotiatedUsdc: number };
type Economics = {
  business: { completedExternalDeals: number; externalGmv: number; externalFeeRevenue: number; definition: string };
  excluded: Record<string, Bucket>;
  integrity: {
    completedTotal: number;
    completedNotEvidence: number;
    completedInternalOrSelf: number;
    excludedReconciles: boolean;
    internalAgentCount: number;
    mixedOwnerWallets: number;
    unflaggedAgentsOnInternalWallets: number;
    externalDealsOnMixedWallets: number;
    externalSplitStatus: "no_flags" | "partial_flagging" | "ok";
    externalSplitTrustworthy: boolean;
    note: string;
  };
};

let listing: { offerId: string; needId: string } | null = null;

async function mkAgent(sql: Sql, wallet: string, opts: { internal?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal)
    VALUES (${id}, ${"amx-" + id.slice(0, 8)}, ${"amx " + id.slice(0, 4)}, ${wallet}, 'metamask', ${opts.internal ?? false})`;
  if (!listing) {
    const [o] = await sql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price)
      VALUES (${id}, 'amx offer', 'amx offer body', 'Data', 10) RETURNING id`;
    const [n] = await sql`
      INSERT INTO needs (agent_id, title, description_md, category, budget_max)
      VALUES (${id}, 'amx need', 'amx need body', 'Data', 10) RETURNING id`;
    listing = { offerId: String(o.id), needId: String(n.id) };
  }
  return id;
}

/** `escrowed` = USDC in a released payment intent (omit ⇒ unfunded). */
async function mkDeal(
  sql: Sql,
  d: { buyer: string; seller: string; total: string; escrowed?: string; status?: string; integrityClass?: string | null },
): Promise<string> {
  if (!listing) throw new Error("mkAgent first");
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, integrity_class)
    VALUES (${d.buyer}, ${d.seller}, ${listing.offerId}, ${listing.needId}, ${d.status ?? "completed"}, ${d.total}, 'USDC', 20, ${d.integrityClass ?? null})
    RETURNING id`;
  if (d.escrowed !== undefined) {
    const [m] = await sql`
      INSERT INTO milestones (deal_id, idx, title, amount, currency)
      VALUES (${deal.id}, 1, 'm', ${d.escrowed}, 'USDC') RETURNING id`;
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m.id}, ${d.buyer}, ${d.seller}, ${d.escrowed}, 'released', ${W(1)}, ${W(2)}, ${W(9)})`;
  }
  return String(deal.id);
}

async function reset(): Promise<void> {
  await cleanDatabase();
  listing = null;
  resetPublicStatsCache();
}

async function economics(app: T["app"]): Promise<{ economics: Economics; revenue: { gmv: number } }> {
  const res = await app.inject({ method: "GET", url: "/api/admin/metrics", headers: ADMIN });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

/** admin business === public paid settled, read both ways (helper + HTTP). */
async function expectAgreesWithPublic(app: T["app"], sql: Sql, e: Economics): Promise<void> {
  const direct = await computePublicStats(sql);
  resetPublicStatsCache();
  const http = JSON.parse((await app.inject({ method: "GET", url: "/api/stats/public" })).body);
  for (const pub of [direct, http]) {
    expect(e.business.completedExternalDeals).toBe(pub.paidDealsSettledExternal);
    expect(Math.round(e.business.externalGmv * 100)).toBe(Number(pub.paidVolumeSettledExternalUsd));
  }
}

function expectReconciles(e: Economics): void {
  const excluded = EXCLUDED_BUCKETS.reduce((n, b) => n + e.excluded[b].deals, 0);
  expect(excluded + e.business.completedExternalDeals).toBe(e.integrity.completedTotal);
  expect(e.integrity.excludedReconciles).toBe(true);
  expect(e.integrity.completedNotEvidence).toBe(e.integrity.completedTotal - e.business.completedExternalDeals);
  expect(e.integrity.completedInternalOrSelf).toBe(e.integrity.completedNotEvidence);
}

describe("admin metrics economics: one definition of external", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  let app: T["app"];
  let sql: Sql;

  beforeAll(async () => {
    ({ app, sql } = await createTestApp());
    process.env.ADMIN_API_KEY = "test-admin-key";
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  describe("excluded breakdown (one fixture per failure mode)", () => {
    let e: Economics;
    let gmv: number;

    beforeAll(async () => {
      await reset();
      const a = await mkAgent(sql, W(1));
      const b = await mkAgent(sql, W(2));
      const c = await mkAgent(sql, W(3));
      const aCase = await mkAgent(sql, W(1).toUpperCase().replace("0X", "0x")); // D4: same owner as a
      const unknown = await mkAgent(sql, ""); // D2: no owner wallet
      const zero = await mkAgent(sql, ZERO); // D2: placeholder wallet
      const fleet = await mkAgent(sql, W(5), { internal: true });

      // business: 25 fully escrowed + 10 quote with only 4 escrowed (D6) → 29.00
      await mkDeal(sql, { buyer: a, seller: b, total: "25", escrowed: "25" });
      await mkDeal(sql, { buyer: b, seller: c, total: "10", escrowed: "4" });
      // one per bucket
      await mkDeal(sql, { buyer: fleet, seller: a, total: "11", escrowed: "11" }); // internal_party
      await mkDeal(sql, { buyer: fleet, seller: b, total: "0" }); // internal_party wins over unpriced
      await mkDeal(sql, { buyer: c, seller: c, total: "12", escrowed: "12" }); // self_deal
      await mkDeal(sql, { buyer: a, seller: b, total: "0" }); // D1 unpriced
      await mkDeal(sql, { buyer: unknown, seller: a, total: "13", escrowed: "13" }); // D2 unknown_owner_wallet
      await mkDeal(sql, { buyer: zero, seller: b, total: "14", escrowed: "14" }); // D2 unknown_owner_wallet
      await mkDeal(sql, { buyer: a, seller: aCase, total: "15", escrowed: "15" }); // D4 same_owner
      await mkDeal(sql, { buyer: b, seller: c, total: "16", escrowed: "16", integrityClass: "test" }); // D5 quarantined
      await mkDeal(sql, { buyer: a, seller: c, total: "17" }); // D3 qualifying_unfunded
      // not completed → in no bucket and not in completedTotal
      await mkDeal(sql, { buyer: a, seller: c, total: "40", escrowed: "40", status: "active" });

      const body = await economics(app);
      e = body.economics;
      gmv = body.revenue.gmv;
    });

    it("business = capital_at_risk completed deals, volume = escrowed capped at quote", () => {
      expect(e.business.completedExternalDeals).toBe(2);
      expect(e.business.externalGmv).toBe(29);
      expect(e.business.externalFeeRevenue).toBe(2.9);
      expect(e.business.definition).toMatch(/capital_at_risk/);
    });

    it("every other completed deal lands in its first-failing-reason bucket", () => {
      expect(Object.keys(e.excluded)).toEqual([...EXCLUDED_BUCKETS]);
      expect(e.excluded).toEqual({
        internal_party: { deals: 2, negotiatedUsdc: 11 },
        self_deal: { deals: 1, negotiatedUsdc: 12 },
        unpriced: { deals: 1, negotiatedUsdc: 0 },
        unknown_owner_wallet: { deals: 2, negotiatedUsdc: 27 },
        same_owner: { deals: 1, negotiatedUsdc: 15 },
        quarantined: { deals: 1, negotiatedUsdc: 16 },
        qualifying_unfunded: { deals: 1, negotiatedUsdc: 17 },
      });
    });

    it("invariant: excluded + business = completedTotal", () => {
      expect(e.integrity.completedTotal).toBe(11);
      expectReconciles(e);
    });

    it("naive revenue.gmv still counts every completed quote (it is labelled unfiltered)", () => {
      expect(gmv).toBe(25 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17);
    });

    it("agrees with /api/stats/public on the same fixtures", async () => {
      await expectAgreesWithPublic(app, sql, e);
    });
  });

  describe("agent-set scenarios", () => {
    beforeEach(reset);

    it("internal-only: nothing is business, split is ok", async () => {
      const f1 = await mkAgent(sql, W(5), { internal: true });
      const f2 = await mkAgent(sql, W(6), { internal: true });
      await mkDeal(sql, { buyer: f1, seller: f2, total: "20", escrowed: "20" });
      const { economics: e } = await economics(app);
      expect(e.business.completedExternalDeals).toBe(0);
      expect(e.business.externalGmv).toBe(0);
      expect(e.excluded.internal_party.deals).toBe(1);
      expect(e.integrity).toMatchObject({ internalAgentCount: 2, mixedOwnerWallets: 0, externalSplitStatus: "ok", externalSplitTrustworthy: true });
      expectReconciles(e);
      await expectAgreesWithPublic(app, sql, e);
    });

    it("fully-external (nothing flagged): business counts, but split is no_flags", async () => {
      const a = await mkAgent(sql, W(1));
      const b = await mkAgent(sql, W(2));
      await mkDeal(sql, { buyer: a, seller: b, total: "30", escrowed: "30" });
      const { economics: e } = await economics(app);
      expect(e.business.completedExternalDeals).toBe(1);
      expect(e.business.externalGmv).toBe(30);
      expect(e.integrity.externalSplitStatus).toBe("no_flags");
      expect(e.integrity.externalSplitTrustworthy).toBe(false);
      expect(e.integrity.note).toMatch(/^UNTRUSTWORTHY/);
      expectReconciles(e);
      await expectAgreesWithPublic(app, sql, e);
    });

    it("mixed (fleet on its own wallet + outsiders): only outsider deals count, split ok", async () => {
      const fleet = await mkAgent(sql, W(5), { internal: true });
      const fleet2 = await mkAgent(sql, W(5), { internal: true });
      const a = await mkAgent(sql, W(1));
      const b = await mkAgent(sql, W(2));
      await mkDeal(sql, { buyer: a, seller: b, total: "8", escrowed: "8" });
      await mkDeal(sql, { buyer: fleet, seller: a, total: "9", escrowed: "9" });
      await mkDeal(sql, { buyer: fleet, seller: fleet2, total: "3", escrowed: "3" });
      const { economics: e } = await economics(app);
      expect(e.business.completedExternalDeals).toBe(1);
      expect(e.business.externalGmv).toBe(8);
      expect(e.excluded.internal_party.deals).toBe(2);
      expect(e.integrity).toMatchObject({
        internalAgentCount: 2,
        mixedOwnerWallets: 0,
        unflaggedAgentsOnInternalWallets: 0,
        externalDealsOnMixedWallets: 0,
        externalSplitStatus: "ok",
        externalSplitTrustworthy: true,
      });
      expect(e.integrity.note).not.toMatch(/UNTRUSTWORTHY/);
      expectReconciles(e);
      await expectAgreesWithPublic(app, sql, e);
    });

    it("partially flagged: 1 of 2 agents on a fleet wallet flagged → partial_flagging, guard trips", async () => {
      await mkAgent(sql, W(5), { internal: true });
      const unflaggedFleet = await mkAgent(sql, W(5));
      const outsider = await mkAgent(sql, W(1));
      const { economics: before } = await economics(app);
      expect(before.integrity).toMatchObject({
        externalSplitStatus: "partial_flagging",
        externalSplitTrustworthy: false,
        mixedOwnerWallets: 1,
        unflaggedAgentsOnInternalWallets: 1,
        externalDealsOnMixedWallets: 0,
      });

      // A funded completed qualifying deal between the unflagged fleet agent
      // and an outsider: it IS business by the shared definition (admin still
      // agrees with public), and the guard names it.
      await mkDeal(sql, { buyer: unflaggedFleet, seller: outsider, total: "5", escrowed: "5" });
      resetPublicStatsCache();
      const { economics: e } = await economics(app);
      expect(e.business.completedExternalDeals).toBe(1);
      expect(e.integrity).toMatchObject({
        externalSplitStatus: "partial_flagging",
        externalSplitTrustworthy: false,
        mixedOwnerWallets: 1,
        unflaggedAgentsOnInternalWallets: 1,
        externalDealsOnMixedWallets: 1,
      });
      expect(e.integrity.note).toMatch(/^UNTRUSTWORTHY: 1 owner wallet owns both internal and unflagged agents; 1 unflagged agent shares an owner with the fleet and 1 external deal touches those wallets\./);
      expect(e.integrity.note).toContain(MARK_INTERNAL_ROUTE);
      expectReconciles(e);
      await expectAgreesWithPublic(app, sql, e);

      // Resolving the wallet (flag the second agent) clears the guard.
      await sql`UPDATE agents SET is_internal = true WHERE id = ${unflaggedFleet}`;
      const { economics: after } = await economics(app);
      expect(after.integrity.externalSplitStatus).toBe("ok");
      expect(after.business.completedExternalDeals).toBe(0);
      expect(after.excluded.internal_party.deals).toBe(1);
    });

    it("partial flagging is detected through ap_wallet_key (case-variant wallets are one owner)", async () => {
      await mkAgent(sql, W(5).replace(/5/g, "a"), { internal: true });
      await mkAgent(sql, W(5).replace(/5/g, "A"));
      const { economics: e } = await economics(app);
      expect(e.integrity.externalSplitStatus).toBe("partial_flagging");
      expect(e.integrity.mixedOwnerWallets).toBe(1);
    });

    it("an unknown (empty or zero) wallet next to a flagged agent does NOT trip the guard", async () => {
      await mkAgent(sql, "", { internal: true });
      await mkAgent(sql, "");
      await mkAgent(sql, ZERO, { internal: true });
      await mkAgent(sql, ZERO);
      await mkAgent(sql, W(5), { internal: true });
      const { economics: e } = await economics(app);
      expect(e.integrity).toMatchObject({ internalAgentCount: 3, mixedOwnerWallets: 0, externalSplitStatus: "ok" });
    });
  });

  describe("integrity note names routes that exist", () => {
    const routes = [MARK_INTERNAL_ROUTE, BULK_MARK_INTERNAL_ROUTE];

    it("each referenced route is registered", () => {
      for (const r of routes) {
        const [method, url] = r.split(" ");
        expect(app.hasRoute({ method: method as "PATCH" | "POST", url }), r).toBe(true);
      }
    });

    it("every status note only references registered admin routes", () => {
      const base = { mixedOwnerWallets: 0, unflaggedAgentsOnInternalWallets: 0, externalDealsOnMixedWallets: 0 };
      const notes = [
        externalSplitIntegrity({ ...base, internalAgentCount: 0 }),
        externalSplitIntegrity({ ...base, internalAgentCount: 3, mixedOwnerWallets: 2, unflaggedAgentsOnInternalWallets: 4 }),
        externalSplitIntegrity({ ...base, internalAgentCount: 3 }),
      ].map((i) => i.note);
      for (const note of notes) {
        expect(note).not.toContain("/api/admin/agents/internal");
        for (const m of note.matchAll(/\b(GET|POST|PATCH|PUT|DELETE) (\/api\/[^\s,()]+)/g)) {
          expect(app.hasRoute({ method: m[1] as "POST", url: m[2] }), m[0]).toBe(true);
        }
      }
    });
  });
});

describe("externalSplitIntegrity (pure)", () => {
  const base = { mixedOwnerWallets: 0, unflaggedAgentsOnInternalWallets: 0, externalDealsOnMixedWallets: 0 };

  it("no flags → no_flags, untrustworthy", () => {
    const r = externalSplitIntegrity({ ...base, internalAgentCount: 0 });
    expect(r).toMatchObject({ externalSplitStatus: "no_flags", externalSplitTrustworthy: false });
    expect(r.note).toContain(MARK_INTERNAL_ROUTE);
    expect(r.note).toContain(BULK_MARK_INTERNAL_ROUTE);
  });

  it("any mixed wallet → partial_flagging even with many flagged agents", () => {
    const r = externalSplitIntegrity({ internalAgentCount: 50, mixedOwnerWallets: 2, unflaggedAgentsOnInternalWallets: 7, externalDealsOnMixedWallets: 3 });
    expect(r).toMatchObject({ externalSplitStatus: "partial_flagging", externalSplitTrustworthy: false });
    expect(r.note).toBe(
      "UNTRUSTWORTHY: 2 owner wallets own both internal and unflagged agents; 7 unflagged agents share an owner with the fleet " +
        `and 3 external deals touch those wallets. Resolve each wallet (flag the agents via ${MARK_INTERNAL_ROUTE}, or unflag) before trusting business.*.`,
    );
  });

  it("flags present and every wallet coherent → ok", () => {
    const r = externalSplitIntegrity({ ...base, internalAgentCount: 1 });
    expect(r).toMatchObject({ externalSplitStatus: "ok", externalSplitTrustworthy: true });
    expect(r.note).toBe("External split active: every owner wallet is internally consistent.");
  });
});
