import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeaders, getAuthHeadersForAgent } from "./helpers/testApp.js";


async function waitForNotification(eventType: string): Promise<Record<string, unknown>> {
  const { sql } = await createTestApp();
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const rows = await sql`
      SELECT id, event_type
      FROM notification_log
      WHERE event_type = ${eventType}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length > 0) {
      return rows[0] as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${eventType}`);
}

describe("Webhook events", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    await getAuthHeaders();
  });

  it("delivers provided/verified/revoked webhook events", async () => {
    const { app } = await createTestApp();

    const buyerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: await getAuthHeaders(),
      payload: generateTestAgent(),
    });
    const buyerId = (JSON.parse(buyerRes.body) as { id: string }).id;

    const sellerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: await getAuthHeaders(),
      payload: generateTestAgent(),
    });
    const sellerId = (JSON.parse(sellerRes.body) as { id: string }).id;

    const buyerHeaders = await getAuthHeadersForAgent(buyerId);
    const sellerHeaders = await getAuthHeadersForAgent(sellerId);

    const buyerWebhookRes = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: buyerHeaders,
      payload: {
        url: "https://webhook.test/buyer",
        events: ["deal.fulfillment_provided", "deal.fulfillment_revoked"],
      },
    });
    expect(buyerWebhookRes.statusCode).toBe(201);

    const sellerWebhookRes = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: sellerHeaders,
      payload: {
        url: "https://webhook.test/seller",
        events: ["deal.fulfillment_verified"],
      },
    });
    expect(sellerWebhookRes.statusCode).toBe(201);

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), fulfillmentType: "api-access" },
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), fulfillmentType: "api-access" },
    });
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    const proposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 120,
        maxPriceDeltaPct: 20,
        milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }],
      },
    });
    const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });

    const provideRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: sellerId,
        fulfillmentData: {
          endpoint_url: "https://api.example.com/v1/ping",
          auth_type: "bearer",
          auth_value: "test-token",
        },
      },
    });
    expect(provideRes.statusCode).toBe(200);
    await waitForNotification("deal.fulfillment_provided");

    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/verify`,
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        accepted: true,
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    await waitForNotification("deal.fulfillment_verified");

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/revoke`,
      headers: sellerHeaders,
      payload: {
        agentId: sellerId,
      },
    });
    expect(revokeRes.statusCode).toBe(200);
    await waitForNotification("deal.fulfillment_revoked");
  });
});
