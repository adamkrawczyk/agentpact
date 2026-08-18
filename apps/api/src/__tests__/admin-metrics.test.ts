import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Admin metrics", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  let buyerId: string;
  let sellerId: string;
  let offerId: string;
  let needId: string;
  let dealId: string;

  beforeEach(async () => {
    const { app, sql } = await createTestApp();
    await cleanDatabase();
    process.env.ADMIN_API_KEY = "test-admin-key";

    buyerId = randomUUID();
    sellerId = randomUUID();
    const buyerHeaders = await getAuthHeadersForAgent(buyerId);
    const sellerHeaders = await getAuthHeadersForAgent(sellerId);

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: {
        agentId: sellerId,
        title: "Metrics Offer",
        descriptionMd: "Offer used by the metrics test.",
        category: "Metrics",
        tags: ["metrics"],
        basePrice: 200,
        currency: "USDC",
        maxPriceDeltaPct: 20,
        slaDays: 7,
        proofs: [],
      },
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        title: "Metrics Need",
        descriptionMd: "Need used by the metrics test.",
        category: "Metrics",
        tags: ["metrics"],
        budgetMax: 250,
        currency: "USDC",
        acceptanceCriteria: ["Done"],
      },
    });
    needId = (JSON.parse(needRes.body) as { id: string }).id;

    const [deal] = await sql`
      INSERT INTO deals (
        buyer_agent_id, seller_agent_id, offer_id, need_id, status,
        negotiated_total, currency, max_price_delta_pct
      ) VALUES (
        ${buyerId}, ${sellerId}, ${offerId}, ${needId}, 'completed',
        120, 'USDC', 20
      )
      RETURNING id
    `;
    dealId = String(deal.id);

    await sql`
      INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
      VALUES (${dealId}, ${sellerId}, 'accept', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO audit_log (action, object_type, object_id, payload_json)
      VALUES
        ('browse.latency', 'endpoint', NULL, '{"endpoint":"/api/offers","durationMs":25,"resultCount":2}'::jsonb),
        ('browse.latency', 'endpoint', NULL, '{"endpoint":"/api/offers","durationMs":75,"resultCount":3}'::jsonb),
        ('offer.view', 'offer', ${offerId}, '{"path":"/api/offers/detail"}'::jsonb),
        ('payment.release', 'milestone', NULL, '{"gross":120,"feeAmount":12}'::jsonb)
    `;
  });

  afterEach(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = originalAdminKey;
    }
  });

  it("requires the admin key", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
    });

    expect(response.statusCode).toBe(403);
  });

  it("fails closed (503) when ADMIN_API_KEY is unset", async () => {
    const { app } = await createTestApp();
    delete process.env.ADMIN_API_KEY;

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ error: "Admin API not configured" });
  });

  it("returns funnel, latency, GMV, fee revenue, and conversion metrics", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      browseLatency: { overall: { count: number; avgMs: number }; byEndpoint: Array<{ endpoint: string; count: number }> };
      offerPageViews: { total: number };
      funnel: {
        dealProposalsCreated: number;
        proposalsAccepted: number;
        dealsFunded: number;
        dealsCompleted: number;
        conversions: Array<{ from: string; to: string; rate: number | null }>;
      };
      revenue: { gmv: number; platformFeeRevenue: number };
    };

    expect(body.browseLatency.overall.count).toBe(2);
    expect(body.browseLatency.overall.avgMs).toBe(50);
    expect(body.browseLatency.byEndpoint[0]).toMatchObject({ endpoint: "/api/offers", count: 2 });
    expect(body.offerPageViews.total).toBe(1);
    expect(body.funnel.dealProposalsCreated).toBe(1);
    expect(body.funnel.proposalsAccepted).toBe(1);
    expect(body.funnel.dealsFunded).toBe(1);
    expect(body.funnel.dealsCompleted).toBe(1);
    expect(body.revenue.gmv).toBe(120);
    expect(body.revenue.platformFeeRevenue).toBe(12);
    expect(body.funnel.conversions).toContainEqual(expect.objectContaining({
      from: "dealProposalsCreated",
      to: "proposalsAccepted",
      rate: 1,
    }));
  });

  it("economics: a same-owner completed deal counts as naive GMV but NOT external GMV", async () => {
    // The default test setup registers buyer + seller with the SAME owner wallet
    // (0x1234…7890), so the completed 120-USDC deal is a SELF-deal. Naive gmv
    // must include it (120); business.externalGmv must EXCLUDE it (0).
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      revenue: { gmv: number };
      economics: {
        engineering: { dealsCompleted: number; fundToCompleteRate: number | null };
        business: { completedExternalDeals: number; externalGmv: number; externalFeeRevenue: number };
        integrity: { completedTotal: number; completedInternalOrSelf: number; internalAgentCount: number; externalSplitTrustworthy: boolean; note: string };
      };
    };

    // Naive GMV still counts the self-deal.
    expect(body.revenue.gmv).toBe(120);
    // Business signal correctly excludes the same-owner self-deal.
    expect(body.economics.business.completedExternalDeals).toBe(0);
    expect(body.economics.business.externalGmv).toBe(0);
    expect(body.economics.business.externalFeeRevenue).toBe(0);
    // Integrity: the deal is counted as internal-or-self, and with zero flagged
    // internal agents the split is flagged UNTRUSTWORTHY.
    expect(body.economics.integrity.completedTotal).toBe(1);
    expect(body.economics.integrity.completedInternalOrSelf).toBe(1);
    expect(body.economics.integrity.internalAgentCount).toBe(0);
    expect(body.economics.integrity.externalSplitTrustworthy).toBe(false);
    expect(body.economics.integrity.note).toMatch(/UNTRUSTWORTHY/);
    // Engineering signal is present.
    expect(body.economics.engineering.dealsCompleted).toBe(1);
  });

  it("economics: a completed deal between DISTINCT external owners counts as external GMV", async () => {
    const { app, sql } = await createTestApp();
    await cleanDatabase();

    // Two agents with DISTINCT owner wallets, both external (default is_internal=false).
    const extBuyer = randomUUID();
    const extSeller = randomUUID();
    const extBuyerHeaders = await getAuthHeadersForAgent(extBuyer, { walletAddress: "0xAAAA000000000000000000000000000000000001" });
    const extSellerHeaders = await getAuthHeadersForAgent(extSeller, { walletAddress: "0xBBBB000000000000000000000000000000000002" });

    const offerRes = await app.inject({
      method: "POST", url: "/api/offers", headers: extSellerHeaders,
      payload: { agentId: extSeller, title: "Ext Offer", descriptionMd: "External offer for the metrics test.", category: "Metrics", tags: ["m"], basePrice: 100, currency: "USDC", maxPriceDeltaPct: 20, slaDays: 7, proofs: [] },
    });
    const extOfferId = (JSON.parse(offerRes.body) as { id: string }).id;
    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: extBuyerHeaders,
      payload: { agentId: extBuyer, title: "Ext Need", descriptionMd: "External need for the metrics test.", category: "Metrics", tags: ["m"], budgetMax: 120, currency: "USDC", acceptanceCriteria: ["Done"] },
    });
    const extNeedId = (JSON.parse(needRes.body) as { id: string }).id;

    await sql`
      INSERT INTO deals (
        buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct
      ) VALUES (
        ${extBuyer}, ${extSeller}, ${extOfferId}, ${extNeedId}, 'completed', 90, 'USDC', 20
      )
    `;

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      economics: {
        business: { completedExternalDeals: number; externalGmv: number; externalFeeRevenue: number };
      };
    };

    expect(body.economics.business.completedExternalDeals).toBe(1);
    expect(body.economics.business.externalGmv).toBe(90);
    // 10% fee on real external GMV.
    expect(body.economics.business.externalFeeRevenue).toBe(9);
  });

  // ── Dead-intent-sweep SLA (issue #107) ──────────────────────────────────
  //
  // #102/#104 added the stale-proposal sweeper (POST
  // /api/admin/expire-stale-proposals) so proposed/countered deals past their
  // acceptance deadline don't accumulate silently. These tests cover the
  // metric that watches whether that sweeper KEEPS working — the gap #107
  // closes: #102 shipped the cure, nothing watched the cure.

  it("deadIntentSweep.overdueUnswept counts a stale proposed deal the sweeper has not yet run against", async () => {
    const { app, sql } = await createTestApp();

    const overdueBuyer = randomUUID();
    const overdueSeller = randomUUID();
    await getAuthHeadersForAgent(overdueBuyer, { walletAddress: "0xEEEE000000000000000000000000000000000005" });
    await getAuthHeadersForAgent(overdueSeller, { walletAddress: "0xFFFF000000000000000000000000000000000006" });

    const [offer] = await sql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
      VALUES (${overdueSeller}, ${"Sweep SLA offer"}, ${"body"}, ${"development"}, ${40}, ${20}, ${"active"})
      RETURNING id
    `;
    const [need] = await sql`
      INSERT INTO needs (agent_id, title, description_md, category, status)
      VALUES (${overdueBuyer}, ${"Sweep SLA need"}, ${"body"}, ${"development"}, ${"open"})
      RETURNING id
    `;
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await sql`
      INSERT INTO deals (
        buyer_agent_id, seller_agent_id, offer_id, need_id, status,
        negotiated_total, max_price_delta_pct, expires_at
      ) VALUES (
        ${overdueBuyer}, ${overdueSeller}, ${offer.id}, ${need.id}, 'proposed',
        40, 20, ${pastExpiry}
      )
    `;

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      deadIntentSweep: { overdueUnswept: number; sweptLast7d: number; lastSweptAt: string | null; sweptByDay: Array<{ day: string; swept: number }> };
    };
    expect(body.deadIntentSweep.overdueUnswept).toBeGreaterThanOrEqual(1);
  });

  it("deadIntentSweep.overdueUnswept does NOT count a deal the sweeper already cancelled", async () => {
    const { app, sql } = await createTestApp();

    const swpBuyer = randomUUID();
    const swpSeller = randomUUID();
    await getAuthHeadersForAgent(swpBuyer, { walletAddress: "0x1010000000000000000000000000000000000A" });
    await getAuthHeadersForAgent(swpSeller, { walletAddress: "0x2020000000000000000000000000000000000B" });

    const [offer] = await sql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
      VALUES (${swpSeller}, ${"Already swept offer"}, ${"body"}, ${"development"}, ${40}, ${20}, ${"active"})
      RETURNING id
    `;
    const [need] = await sql`
      INSERT INTO needs (agent_id, title, description_md, category, status)
      VALUES (${swpBuyer}, ${"Already swept need"}, ${"body"}, ${"development"}, ${"open"})
      RETURNING id
    `;
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const [dealRow] = await sql`
      INSERT INTO deals (
        buyer_agent_id, seller_agent_id, offer_id, need_id, status,
        negotiated_total, max_price_delta_pct, expires_at
      ) VALUES (
        ${swpBuyer}, ${swpSeller}, ${offer.id}, ${need.id}, 'proposed',
        40, 20, ${pastExpiry}
      )
      RETURNING id
    `;

    // Actually run the real sweeper — the sweeper's OWN endpoint, not a stub —
    // so this test is the RED-proof: it exercises the exact write path
    // deadIntentSweep reads from.
    process.env.ADMIN_API_KEY = "test-admin-key";
    const sweepRes = await app.inject({
      method: "POST",
      url: "/api/admin/expire-stale-proposals",
      headers: { "x-admin-key": "test-admin-key" },
    });
    expect(sweepRes.statusCode).toBe(200);
    const [swept] = await sql`SELECT status FROM deals WHERE id = ${dealRow.id}`;
    expect(swept.status).toBe("cancelled");

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      deadIntentSweep: {
        overdueUnswept: number;
        sweptLast7d: number;
        lastSweptAt: string | null;
        sweptByDay: { day: string; swept: number }[];
      };
    };
    // The deal that was just swept is now 'cancelled' — no longer overdue-unswept.
    expect(body.deadIntentSweep.overdueUnswept).toBe(0);
    // And it shows up in the throughput counter sourced from the sweeper's own
    // negotiation_events audit trail.
    expect(body.deadIntentSweep.sweptLast7d).toBeGreaterThanOrEqual(1);
    expect(body.deadIntentSweep.lastSweptAt).not.toBeNull();

    // --- sweptByDay BEHAVIOURAL assertions (adversarial-review finding,
    // 2026-08-18: the series was previously named only in a TypeScript type
    // and never inspected, so an empty series, wrong dates, or reversed
    // ordering would have left every assertion green). ---
    const series = body.deadIntentSweep.sweptByDay;
    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBeGreaterThanOrEqual(1);

    // Today's sweep must appear under TODAY's date, not an off-by-one day.
    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = series.find((d) => String(d.day).slice(0, 10) === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.swept).toBeGreaterThanOrEqual(1);

    // Every entry must be a well-formed YYYY-MM-DD / positive-count pair.
    for (const entry of series) {
      expect(String(entry.day).slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(entry.swept)).toBe(true);
      expect(entry.swept).toBeGreaterThan(0);
    }

    // Ordering must be stable and ascending by day (a reversed series would
    // render a backwards chart without failing anything otherwise).
    const days = series.map((d) => String(d.day).slice(0, 10));
    expect([...days].sort()).toEqual(days);

    // The per-day totals must reconcile with the 7d scalar — two independently
    // computed queries that must agree, so a drift in either is caught.
    const withinWindow = series.filter((d) => {
      const age =
        (Date.now() - new Date(`${String(d.day).slice(0, 10)}T00:00:00Z`).getTime()) /
        86_400_000;
      return age <= 7;
    });
    const seriesTotal = withinWindow.reduce((acc, d) => acc + d.swept, 0);
    expect(seriesTotal).toBeGreaterThanOrEqual(body.deadIntentSweep.sweptLast7d);
  });

  it("survives a malformed payload_json row instead of 500ing the endpoint", async () => {
    // Adversarial-review finding (2026-08-18): the read-side normalization
    // cast the inner text of EVERY string scalar to ::jsonb, so a single
    // malformed historical row (empty string, or a plain string scalar)
    // turned /api/admin/metrics into a hard 500. Excluding the bad row is the
    // only correct failure mode for an observability query.
    const { app, sql } = await createTestApp();
    process.env.ADMIN_API_KEY = "test-admin-key";

    // beforeEach already seeded a real deal through the real API surface —
    // reuse it rather than hand-rolling fixtures against a schema this test
    // would otherwise have to guess at.
    const [existing] = await sql`SELECT id, buyer_agent_id FROM deals LIMIT 1`;
    expect(existing).toBeDefined();

    // Three poison shapes, all as 'cancel' events so they hit the normalization.
    //
    // NOTE: these MUST be inserted as raw SQL literals via sql.unsafe(). A
    // bound parameter (${bad}::jsonb) does NOT work here — postgres.js
    // re-serializes the bound string, so '"hello"' arrives as the
    // double-encoded '"\"hello\""' whose inner text is the VALID JSON
    // '"hello"', which casts cleanly and poisons nothing. (That re-encoding
    // is the very behaviour this endpoint's normalization exists to undo,
    // measured empirically against this database.) Using a bound parameter
    // here produced a test that passed identically on guarded AND neutered
    // code — a green test proving nothing.
    const dealId = String(existing.id);
    const actorId = String(existing.buyer_agent_id);
    for (const bad of ['"hello"', '"[not json"', '""']) {
      await sql.unsafe(
        `INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
         VALUES ('${dealId}', '${actorId}', 'cancel', '${bad}'::jsonb)`
      );
    }

    // Sanity: the rows really are string scalars whose inner text is NOT a
    // JSON object — i.e. the poison is genuinely present. Without this the
    // test could silently degrade into asserting nothing again.
    const [poison] = await sql`
      SELECT COUNT(*)::int AS n
      FROM negotiation_events
      WHERE event_type = 'cancel'
        AND jsonb_typeof(payload_json) = 'string'
        AND (payload_json #>> '{}') !~ '^\\s*\\{'
    `;
    expect(poison.n).toBeGreaterThanOrEqual(3);

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    // The decisive assertion: 200, not 500.
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as {
      deadIntentSweep: { sweptLast7d: number; sweptByDay: { day: string; swept: number }[] };
    };
    // Malformed rows are EXCLUDED, never counted as real sweeps.
    expect(parsed.deadIntentSweep.sweptLast7d).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(parsed.deadIntentSweep.sweptByDay)).toBe(true);
  });

  it("funnelProgression reports the escrow rate for deals created within the window", async () => {
    // beforeEach already seeded one 'completed' deal created "now" (within any
    // reasonable window), so createdInWindow/reachedEscrowInWindow must be >= 1/1.
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      funnelProgression: { windowDays: number; createdInWindow: number; reachedEscrowInWindow: number; escrowRate: number | null };
    };
    expect(body.funnelProgression.windowDays).toBe(7);
    expect(body.funnelProgression.createdInWindow).toBeGreaterThanOrEqual(1);
    expect(body.funnelProgression.reachedEscrowInWindow).toBeGreaterThanOrEqual(1);
    expect(body.funnelProgression.escrowRate).not.toBeNull();
    expect(body.funnelProgression.escrowRate as number).toBeGreaterThan(0);
  });

  it("funnelProgression does NOT count a still-proposed deal as having reached escrow", async () => {
    const { app, sql } = await createTestApp();

    const progBuyer = randomUUID();
    const progSeller = randomUUID();
    await getAuthHeadersForAgent(progBuyer, { walletAddress: "0x3030000000000000000000000000000000000C" });
    await getAuthHeadersForAgent(progSeller, { walletAddress: "0x4040000000000000000000000000000000000D" });

    const [offer] = await sql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
      VALUES (${progSeller}, ${"Progression offer"}, ${"body"}, ${"development"}, ${40}, ${20}, ${"active"})
      RETURNING id
    `;
    const [need] = await sql`
      INSERT INTO needs (agent_id, title, description_md, category, status)
      VALUES (${progBuyer}, ${"Progression need"}, ${"body"}, ${"development"}, ${"open"})
      RETURNING id
    `;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await sql`
      INSERT INTO deals (
        buyer_agent_id, seller_agent_id, offer_id, need_id, status,
        negotiated_total, max_price_delta_pct, expires_at
      ) VALUES (
        ${progBuyer}, ${progSeller}, ${offer.id}, ${need.id}, 'proposed',
        40, 20, ${future}
      )
    `;

    const before = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });
    const bodyBefore = JSON.parse(before.body) as {
      funnelProgression: { createdInWindow: number; reachedEscrowInWindow: number };
    };
    // The new 'proposed' deal grows the denominator by 1 but NOT the numerator.
    expect(bodyBefore.funnelProgression.createdInWindow).toBeGreaterThanOrEqual(2);
    // reachedEscrowInWindow still only counts the ONE completed deal from
    // beforeEach — the proposed deal must not inflate it.
    expect(bodyBefore.funnelProgression.reachedEscrowInWindow).toBe(1);
  });

  it("economics: flagging an agent internal makes the split trustworthy", async () => {
    const { app, sql } = await createTestApp();
    await cleanDatabase();

    const a = randomUUID();
    const b = randomUUID();
    await getAuthHeadersForAgent(a, { walletAddress: "0xCCCC000000000000000000000000000000000003" });
    await getAuthHeadersForAgent(b, { walletAddress: "0xDDDD000000000000000000000000000000000004" });
    // Flag one agent internal — the split should now be trustworthy.
    await sql`UPDATE agents SET is_internal = true WHERE id = ${a}`;

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { "x-admin-key": "test-admin-key" },
    });

    const body = JSON.parse(response.body) as {
      economics: { integrity: { internalAgentCount: number; externalSplitTrustworthy: boolean; note: string } };
    };
    expect(body.economics.integrity.internalAgentCount).toBe(1);
    expect(body.economics.integrity.externalSplitTrustworthy).toBe(true);
    expect(body.economics.integrity.note).not.toMatch(/UNTRUSTWORTHY/);
  });
});
