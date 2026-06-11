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
});
