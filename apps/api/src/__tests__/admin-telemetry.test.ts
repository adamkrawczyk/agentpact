import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";

// honest_0710 phase D — admin read side of telemetry. Plan v3.1 gates are
// evaluated from these numbers, so the counts and the external split (which
// must come from deal_integrity, never an inline rule) are pinned here.

type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
const ADMIN = { "x-admin-key": "test-admin-key" };
const wallet = () => `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function mkAgent(sql: Sql, opts: { internal?: boolean; ownerWallet?: string } = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal)
    VALUES (${id}, ${"t-" + id.slice(0, 8)}, 'telemetry', ${opts.ownerWallet ?? wallet()}, 'metamask', ${opts.internal ?? false})`;
  return id;
}

async function mkDeal(sql: Sql, buyer: string, seller: string, total = 10): Promise<string> {
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category) VALUES (${buyer}, 'n', 'n', 'Testing') RETURNING id`;
  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price)
    VALUES (${seller}, ${"o " + randomUUID().slice(0, 8)}, 'o', 'Testing', ${total}) RETURNING id`;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct)
    VALUES (${buyer}, ${seller}, ${offer.id}, ${need.id}, 'proposed', ${total}, 'USDC', 10) RETURNING id`;
  return String(deal.id);
}

async function fund(sql: Sql, dealId: string, buyer: string, seller: string): Promise<void> {
  const [m] = await sql`INSERT INTO milestones (deal_id, idx, title, amount) VALUES (${dealId}, 0, 'm', 10) RETURNING id`;
  await sql`
    INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, platform_wallet_address, status)
    VALUES (${m.id}, ${buyer}, ${seller}, 10, ${wallet()}, 'funded')`;
}

describe("GET /api/admin/usage + /api/admin/funnel", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  let sql: Sql;
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];

  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase();
    await app.telemetry.flush();
    await sql`TRUNCATE api_usage, funnel_events`;
    process.env.ADMIN_API_KEY = "test-admin-key";
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  it("both endpoints reject a request without the admin key (shared requireAdminKey gate)", async () => {
    for (const url of ["/api/admin/usage", "/api/admin/funnel"]) {
      const anon = await app.inject({ method: "GET", url });
      expect(anon.statusCode).toBe(403);
      const wrong = await app.inject({ method: "GET", url, headers: { "x-admin-key": "nope" } });
      expect(wrong.statusCode).toBe(403);
    }
  });

  it("rejects a malformed since", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/usage?since=yesterday-ish", headers: ADMIN });
    expect(res.statusCode).toBe(400);
  });

  it("usage: requests/day, distinct agents/day, top endpoints, per-endpoint external callers, writer drops", async () => {
    const ext1 = await mkAgent(sql);
    const ext2 = await mkAgent(sql);
    const internal = await mkAgent(sql, { internal: true });
    await sql`
      INSERT INTO api_usage (endpoint, method, status_code, response_time_ms, agent_id, client_kind, created_at) VALUES
        ('/api/check/:agent', 'GET', 200, 10, ${ext1}, 'mcp', '2026-10-01T10:00:00Z'),
        ('/api/check/:agent', 'GET', 200, 20, ${ext1}, 'mcp', '2026-10-01T11:00:00Z'),
        ('/api/check/:agent', 'GET', 200, 30, ${ext2}, 'sdk', '2026-10-01T12:00:00Z'),
        ('/api/check/:agent', 'GET', 200, 40, ${internal}, 'other', '2026-10-01T12:00:00Z'),
        ('/api/check/:agent', 'GET', 200, 50, NULL, 'browser', '2026-10-02T12:00:00Z'),
        ('/api/deals/:id', 'GET', 500, 60, ${internal}, 'other', '2026-10-02T12:00:00Z'),
        ('/api/deals/:id', 'GET', 200, 60, ${ext1}, 'other', '2026-09-01T12:00:00Z')`;

    const res = await app.inject({ method: "GET", url: "/api/admin/usage?since=2026-10-01", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.since).toBe("2026-10-01T00:00:00.000Z");
    expect(body.totals).toMatchObject({ requests: 6, distinctAgents: 3, distinctExternalAgents: 2, anonymousRequests: 1 });
    expect(body.perDay).toEqual([
      { day: "2026-10-01", requests: 4, distinctAgents: 3, distinctExternalAgents: 2 },
      { day: "2026-10-02", requests: 2, distinctAgents: 1, distinctExternalAgents: 0 },
    ]);
    expect(body.endpoints[0]).toMatchObject({
      endpoint: "/api/check/:agent",
      method: "GET",
      requests: 5,
      errors: 0,
      distinctAgents: 3,
      distinctExternalAgents: 2,
      anonymousRequests: 1,
    });
    expect(body.endpoints[1]).toMatchObject({ endpoint: "/api/deals/:id", requests: 1, errors: 1, distinctExternalAgents: 0 });
    expect(body.clientKinds).toEqual({ mcp: 2, sdk: 1, other: 2, browser: 1 });
    expect(body.writer).toEqual(expect.objectContaining({ dropped: expect.any(Number), flushFailures: expect.any(Number) }));
  });

  it("funnel: stage counts split all / external (deal_integrity.qualifying) / capital_at_risk", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const fleet = await mkAgent(sql, { internal: true });
    const sharedOwner = wallet();
    const selfA = await mkAgent(sql, { ownerWallet: sharedOwner });
    const selfB = await mkAgent(sql, { ownerWallet: sharedOwner });

    const realFunded = await mkDeal(sql, buyer, seller);
    await fund(sql, realFunded, buyer, seller);
    await mkDeal(sql, buyer, seller); // qualifying, never funded
    const fleetDeal = await mkDeal(sql, fleet, seller);
    await fund(sql, fleetDeal, fleet, seller);
    await mkDeal(sql, selfA, selfB); // same owner wallet → not qualifying
    await mkDeal(sql, buyer, seller, 0); // practice $0 deal → not qualifying

    // An event outside the window is excluded.
    await sql`UPDATE funnel_events SET occurred_at = '2020-01-01' WHERE deal_id = ${fleetDeal} AND stage = 'funded'`;

    const res = await app.inject({ method: "GET", url: "/api/admin/funnel?since=2026-01-01", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const byStage = Object.fromEntries(body.stages.map((s: { stage: string }) => [s.stage, s]));

    expect(byStage.need_posted).toMatchObject({ all: 5, external: 4, capitalAtRisk: null });
    expect(byStage.proposed).toMatchObject({ all: 5, external: 2, capitalAtRisk: 1 });
    expect(byStage.funded).toMatchObject({ all: 1, external: 1, capitalAtRisk: 1 });
    expect(byStage.settled).toMatchObject({ all: 0, external: 0, capitalAtRisk: 0 });
    // Stages come back in funnel order, every stage present.
    expect(body.stages.map((s: { stage: string }) => s.stage)).toEqual([
      "need_posted", "proposed", "accepted", "funded", "delivered",
      "accepted_delivery", "disputed", "settled", "refunded", "reorder",
    ]);
    // The point-in-time deal-state funnel from /api/admin/metrics is reused, not re-derived.
    expect(body.stateSnapshot).toMatchObject({ dealProposalsCreated: 5, dealsFunded: 2 });
  });
});
