import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanDatabase,
  createTestApp,
  generateTestNeed,
  generateTestOffer,
  getAuthHeadersForAgent,
} from "./helpers/testApp.js";

type DealFixture = {
  dealId: string;
  buyerId: string;
  sellerId: string;
  buyerHeaders: Record<string, string>;
  sellerHeaders: Record<string, string>;
};

async function setupPhysicalServiceDeal(): Promise<DealFixture> {
  const { app } = await createTestApp();
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  const buyerHeaders = await getAuthHeadersForAgent(buyerId);
  const sellerHeaders = await getAuthHeadersForAgent(sellerId);

  const offerRes = await app.inject({
    method: "POST",
    url: "/api/offers",
    headers: sellerHeaders,
    payload: { ...generateTestOffer(sellerId), fulfillmentType: "physical-service" },
  });
  const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

  const needRes = await app.inject({
    method: "POST",
    url: "/api/needs",
    headers: buyerHeaders,
    payload: { ...generateTestNeed(buyerId), fulfillmentType: "physical-service" },
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
      milestones: [{ idx: 1, title: "On-site service", amount: 120, acceptanceCriteria: ["Done"] }],
    },
  });
  const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

  await app.inject({
    method: "POST",
    url: `/api/deals/${dealId}/accept`,
    headers: sellerHeaders,
    payload: { actorAgentId: sellerId },
  });

  return { dealId, buyerId, sellerId, buyerHeaders, sellerHeaders };
}

describe("Physical Service Fulfillment", () => {
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    authHeaders = await getAuthHeadersForAgent(randomUUID());
  });

  it("includes physical-service in fulfillment types", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/fulfillment/types",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const types = JSON.parse(response.body) as Array<{ type: string; autoVerify: boolean | string | null }>;
    const physical = types.find((t) => t.type === "physical-service");
    expect(physical).toBeTruthy();
    expect(physical?.autoVerify).toBe(false);
  });

  it("stores encrypted buyer context and returns redacted buyer_data by default", async () => {
    const { app, sql } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupPhysicalServiceDeal();

    const provideRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/buyer`,
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        buyerData: {
          service_type: "repair",
          service_date: "2026-02-18T10:00:00Z",
          secret_address: "123 Main Street, Unit 4",
          secret_access_notes: "Gate code 4521#",
          contact_method: "phone",
          secret_contact_value: "+1-555-123-4567",
        },
      },
    });

    expect(provideRes.statusCode).toBe(200);

    const [row] = await sql`SELECT buyer_data FROM deal_fulfillment WHERE deal_id = ${dealId}`;
    const buyerData = row?.buyer_data as Record<string, unknown>;
    expect(buyerData.secret_address).toBe("[encrypted]");
    expect(buyerData.secret_access_notes).toBe("[encrypted]");
    expect(buyerData.secret_contact_value).toBe("[encrypted]");

    const vaultRows = await sql`
      SELECT field_name
      FROM credential_vault cv
      JOIN deal_fulfillment df ON df.id = cv.fulfillment_id
      WHERE df.deal_id = ${dealId}
      ORDER BY field_name
    `;
    const fieldNames = vaultRows.map((r) => String(r.field_name));
    expect(fieldNames).toContain("buyer__secret_address");
    expect(fieldNames).toContain("buyer__secret_access_notes");
    expect(fieldNames).toContain("buyer__secret_contact_value");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}`,
      headers: buyerHeaders,
    });
    expect(getRes.statusCode).toBe(200);

    const fetched = JSON.parse(getRes.body) as { buyer_data: Record<string, unknown> };
    expect(fetched.buyer_data.secret_address).toBe("123 Main Street, Unit 4");
  });

  it("returns redacted buyer_data for seller by default and decrypted with decrypt=true", async () => {
    const { app } = await createTestApp();
    const { dealId, buyerId, sellerId, buyerHeaders, sellerHeaders } = await setupPhysicalServiceDeal();

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/buyer`,
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        buyerData: {
          service_type: "repair",
          service_date: "2026-02-18T10:00:00Z",
          secret_address: "987 Service Road",
          secret_contact_value: "+1-555-000-9999",
        },
      },
    });

    const redactedRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${sellerId}`,
      headers: sellerHeaders,
    });
    expect(redactedRes.statusCode).toBe(200);
    const redacted = JSON.parse(redactedRes.body) as { buyer_data: Record<string, unknown> };
    expect(redacted.buyer_data.secret_address).toBe("[encrypted]");

    const decryptedRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${sellerId}&decrypt=true`,
      headers: sellerHeaders,
    });
    expect(decryptedRes.statusCode).toBe(200);
    const decrypted = JSON.parse(decryptedRes.body) as { buyer_data: Record<string, unknown> };
    expect(decrypted.buyer_data.secret_address).toBe("987 Service Road");
    expect(decrypted.buyer_data.secret_contact_value).toBe("+1-555-000-9999");
  });

  it("persists optional location on offers and needs", async () => {
    const { app } = await createTestApp();

    const agentId = randomUUID();
    const ownerHeaders = await getAuthHeadersForAgent(agentId);

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: ownerHeaders,
      payload: {
        ...generateTestOffer(agentId),
        location: {
          city: "Austin",
          region: "TX",
          country: "US",
          remote: false,
        },
      },
    });
    expect(offerRes.statusCode).toBe(201);
    const offer = JSON.parse(offerRes.body) as { id: string };

    const offerGetRes = await app.inject({
      method: "GET",
      url: `/api/offers/${offer.id}`,
      headers: ownerHeaders,
    });
    const fetchedOffer = JSON.parse(offerGetRes.body) as { location: Record<string, unknown> };
    expect(fetchedOffer.location.city).toBe("Austin");
    expect(fetchedOffer.location.country).toBe("US");

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: ownerHeaders,
      payload: {
        ...generateTestNeed(agentId),
        location: {
          city: "Seattle",
          region: "WA",
          country: "US",
          remote: true,
        },
      },
    });
    expect(needRes.statusCode).toBe(201);
    const need = JSON.parse(needRes.body) as { id: string };

    const needGetRes = await app.inject({
      method: "GET",
      url: `/api/needs/${need.id}`,
      headers: ownerHeaders,
    });
    const fetchedNeed = JSON.parse(needGetRes.body) as { location: Record<string, unknown> };
    expect(fetchedNeed.location.region).toBe("WA");
    expect(fetchedNeed.location.remote).toBe(true);
  });
});
