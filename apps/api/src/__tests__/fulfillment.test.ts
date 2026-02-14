import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeaders } from "./helpers/testApp.js";

describe("Fulfillment API", () => {
  let authHeaders: Record<string, string>;
  let buyerId: string;
  let sellerId: string;
  let attackerId: string;
  let offerId: string;
  let needId: string;
  let dealId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    authHeaders = await getAuthHeaders();

    const buyerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders,
      payload: generateTestAgent(),
    });
    buyerId = (JSON.parse(buyerRes.body) as { id: string }).id;

    const sellerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders,
      payload: generateTestAgent(),
    });
    sellerId = (JSON.parse(sellerRes.body) as { id: string }).id;

    const attackerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders,
      payload: generateTestAgent(),
    });
    attackerId = (JSON.parse(attackerRes.body) as { id: string }).id;

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: authHeaders,
      payload: { ...generateTestOffer(sellerId), fulfillmentType: "api-access" },
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: authHeaders,
      payload: { ...generateTestNeed(buyerId), fulfillmentType: "api-access" },
    });
    needId = (JSON.parse(needRes.body) as { id: string }).id;

    const proposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: authHeaders,
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
    dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: authHeaders,
      payload: { actorAgentId: sellerId },
    });
  });

  it("creates fulfillment row on deal acceptance", async () => {
    const { sql } = await createTestApp();
    const [row] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${dealId}`;

    expect(row).toBeTruthy();
    expect(row.fulfillment_type).toBe("api-access");
    expect(row.status).toBe("pending");
  });

  it("provides, gets, verifies, and revokes fulfillment", async () => {
    const { app } = await createTestApp();

    const provideRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: authHeaders,
      payload: {
        agentId: sellerId,
        fulfillmentData: {
          endpoint_url: "https://api.example.com/v1/ping",
          auth_type: "bearer",
          auth_value: "test-token",
          usage_notes: "Use for integration tests only",
        },
      },
    });
    expect(provideRes.statusCode).toBe(200);
    const provided = JSON.parse(provideRes.body) as { status: string };
    expect(provided.status).toBe("provided");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}`,
      headers: authHeaders,
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body) as {
      status: string;
      fulfillment_data: Record<string, unknown>;
    };
    expect(fetched.status).toBe("provided");
    expect(fetched.fulfillment_data).toBeTruthy();
    expect(Object.keys(fetched.fulfillment_data).length).toBeGreaterThan(0);

    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/verify`,
      headers: authHeaders,
      payload: {
        agentId: buyerId,
        accepted: true,
        notes: "Looks good",
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verified = JSON.parse(verifyRes.body) as { status: string };
    expect(verified.status).toBe("active");

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/revoke`,
      headers: authHeaders,
      payload: {
        agentId: sellerId,
      },
    });
    expect(revokeRes.statusCode).toBe(200);
    const revoked = JSON.parse(revokeRes.body) as { status: string };
    expect(revoked.status).toBe("revoked");
  });

  it("rejects invalid fulfillment data", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: authHeaders,
      payload: {
        agentId: sellerId,
        fulfillmentData: {
          auth_type: "bearer",
          auth_value: "missing endpoint url",
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("blocks non-parties from accessing fulfillment", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${attackerId}`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(403);
  });
});
