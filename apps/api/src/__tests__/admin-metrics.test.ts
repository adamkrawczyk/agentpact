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
