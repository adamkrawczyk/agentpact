import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Fulfillment API", () => {
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;
  let attackerHeaders: Record<string, string>;
  let buyerId: string;
  let sellerId: string;
  let attackerId: string;
  let offerId: string;
  let needId: string;
  let dealId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    attackerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);
    attackerHeaders = await getAuthHeadersForAgent(attackerId);

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), fulfillmentType: "api-access" },
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: { ...generateTestNeed(buyerId), fulfillmentType: "api-access" },
    });
    needId = (JSON.parse(needRes.body) as { id: string }).id;

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
    dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
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
      headers: sellerHeaders,
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
      url: `/api/deals/${dealId}/fulfillment`,
      headers: buyerHeaders,
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
      headers: buyerHeaders,
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
      headers: sellerHeaders,
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
      headers: sellerHeaders,
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
      url: `/api/deals/${dealId}/fulfillment`,
      headers: attackerHeaders,
    });

    expect(response.statusCode).toBe(403);
  });

  it("requires API key auth to read fulfillment", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment`,
    });

    expect(response.statusCode).toBe(401);
  });
});
