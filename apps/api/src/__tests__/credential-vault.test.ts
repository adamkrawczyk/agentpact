import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../credential-vault.js";
import {
  cleanDatabase,
  createTestApp,
  generateTestNeed,
  generateTestOffer,
  getAuthHeadersForAgent,
} from "./helpers/testApp.js";

const SELLER_ID = "550e8400-e29b-41d4-a716-446655440000";

type DealFixture = {
  dealId: string;
  buyerId: string;
  attackerId: string;
  buyerHeaders: Record<string, string>;
  attackerHeaders: Record<string, string>;
};

async function setupDeal(fulfillmentType: string): Promise<DealFixture> {
  const { app } = await createTestApp();
  const buyerId = randomUUID();
  const attackerId = randomUUID();
  const buyerHeaders = await getAuthHeadersForAgent(buyerId);
  const attackerHeaders = await getAuthHeadersForAgent(attackerId);

  const offerRes = await app.inject({
    method: "POST",
    url: "/api/offers",
    headers: sellerHeaders,
    payload: { ...generateTestOffer(SELLER_ID), fulfillmentType },
  });
  const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

  const needRes = await app.inject({
    method: "POST",
    url: "/api/needs",
    headers: buyerHeaders,
    payload: { ...generateTestNeed(buyerId), fulfillmentType },
  });
  const needId = (JSON.parse(needRes.body) as { id: string }).id;

  const proposeRes = await app.inject({
    method: "POST",
    url: "/api/deals/propose",
    headers: buyerHeaders,
    payload: {
      buyerAgentId: buyerId,
      sellerAgentId: SELLER_ID,
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
    payload: { actorAgentId: SELLER_ID },
  });

  return { dealId, buyerId, attackerId, buyerHeaders, attackerHeaders };
}

async function waitForNotification(eventType: string): Promise<Record<string, unknown>> {
  const { sql } = await createTestApp();
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    const rows = await sql`
      SELECT id, event_type, payload_json
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
  throw new Error(`Timed out waiting for notification ${eventType}`);
}

let sellerHeaders: Record<string, string>;
const originalFetch = globalThis.fetch;

describe("Credential Vault", () => {
  beforeAll(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://webhook.test/")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    sellerHeaders = await getAuthHeadersForAgent(SELLER_ID);
  });

  it("encrypt/decrypt roundtrip", () => {
    const key = Buffer.alloc(32, 7);
    const payload = "super-secret-token";
    const encrypted = encrypt(payload, key);
    const decrypted = decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag, key);

    expect(decrypted).toBe(payload);
    expect(encrypted.encrypted).not.toBe(payload);
  });

  it("extracts sensitive fields and stores encrypted values on provide", async () => {
    const { app, sql } = await createTestApp();
    const { dealId } = await setupDeal("code-task");

    const provideRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fulfillmentData: {
          repo_url: "https://github.com/example/repo",
          access_method: "token",
          access_token: "initial-secret-token",
          delivery_method: "pull-request",
        },
      },
    });

    expect(provideRes.statusCode).toBe(200);
    const body = JSON.parse(provideRes.body) as {
      fulfillment_data: Record<string, unknown>;
      encrypted_fields: string[];
    };
    expect(body.fulfillment_data.access_token).toBe("[encrypted]");
    expect(body.encrypted_fields).toContain("access_token");

    const [vaultRow] = await sql`
      SELECT cv.field_name, cv.rotation_count
      FROM credential_vault cv
      JOIN deal_fulfillment df ON df.id = cv.fulfillment_id
      WHERE df.deal_id = ${dealId} AND cv.field_name = 'access_token'
    `;
    expect(vaultRow).toBeTruthy();
    expect(Number(vaultRow.rotation_count)).toBe(0);
  });

  it("returns redacted fulfillment by default", async () => {
    const { app } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupDeal("code-task");

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fulfillmentData: {
          repo_url: "https://github.com/example/repo",
          access_method: "token",
          access_token: "initial-secret-token",
          delivery_method: "pull-request",
        },
      },
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}`,
      headers: buyerHeaders,
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as { fulfillment_data: Record<string, unknown> };
    expect(body.fulfillment_data.access_token).toBe("[encrypted]");
  });

  it("returns decrypted fulfillment when authorized participant requests decrypt", async () => {
    const { app, sql } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupDeal("code-task");

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fulfillmentData: {
          repo_url: "https://github.com/example/repo",
          access_method: "token",
          access_token: "initial-secret-token",
          delivery_method: "pull-request",
        },
      },
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}&decrypt=true`,
      headers: buyerHeaders,
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as { fulfillment_data: Record<string, unknown>; id: string };
    expect(body.fulfillment_data.access_token).toBe("initial-secret-token");

    const [logRow] = await sql`
      SELECT action
      FROM credential_access_log
      WHERE fulfillment_id = ${body.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(logRow.action).toBe("decrypt");
  });

  it("rejects decrypt requests from unauthorized agents", async () => {
    const { app } = await createTestApp();
    const { dealId, attackerId, attackerHeaders } = await setupDeal("code-task");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${attackerId}&decrypt=true`,
      headers: attackerHeaders,
    });

    expect(getRes.statusCode).toBe(403);
  });

  it("rotates credentials and increments rotation_count", async () => {
    const { app, sql } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupDeal("code-task");

    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fulfillmentData: {
          repo_url: "https://github.com/example/repo",
          access_method: "token",
          access_token: "initial-secret-token",
          delivery_method: "pull-request",
        },
      },
    });

    const rotateRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/rotate`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fieldName: "access_token",
        newValue: "rotated-secret-token",
      },
    });
    expect(rotateRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}&decrypt=true`,
      headers: buyerHeaders,
    });
    const body = JSON.parse(getRes.body) as { fulfillment_data: Record<string, unknown> };
    expect(body.fulfillment_data.access_token).toBe("rotated-secret-token");

    const [vaultRow] = await sql`
      SELECT cv.rotation_count
      FROM credential_vault cv
      JOIN deal_fulfillment df ON df.id = cv.fulfillment_id
      WHERE df.deal_id = ${dealId} AND cv.field_name = 'access_token'
    `;
    expect(Number(vaultRow.rotation_count)).toBe(1);
  });

  it("fires rotation_requested webhook event", async () => {
    const { app } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupDeal("code-task");

    const webhookRes = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: sellerHeaders,
      payload: {
        url: "https://webhook.test/seller",
        events: ["deal.rotation_requested"],
      },
    });
    expect(webhookRes.statusCode).toBe(201);

    const requestRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/request-rotation`,
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        reason: "Possible token leak",
      },
    });

    expect(requestRes.statusCode).toBe(200);
    const event = await waitForNotification("deal.rotation_requested");
    expect(event.event_type).toBe("deal.rotation_requested");
  });

  it("fires expiry warning when fulfillment expires within 24h", async () => {
    const { app, sql } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupDeal("generic");

    await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: sellerHeaders,
      payload: {
        url: "https://webhook.test/seller-expiring",
        events: ["deal.fulfillment_expiring"],
      },
    });

    const expiresSoon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const provideRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fulfillmentData: {
          description: "Deliverables are attached in secure storage.",
          expires_at: expiresSoon,
          secret_token: "sensitive-generic-token",
        },
      },
    });

    expect(provideRes.statusCode).toBe(200);
    const provided = JSON.parse(provideRes.body) as { encrypted_fields: string[] };
    expect(provided.encrypted_fields).toContain("secret_token");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}`,
      headers: buyerHeaders,
    });
    expect(getRes.statusCode).toBe(200);

    await waitForNotification("deal.fulfillment_expiring");

    const [row] = await sql`
      SELECT last_expiry_warning_at
      FROM deal_fulfillment
      WHERE deal_id = ${dealId}
    `;
    expect(row.last_expiry_warning_at).toBeTruthy();
  });

  it("auto-expires fulfillment when expiry has passed", async () => {
    const { app } = await createTestApp();
    const { dealId, buyerId, buyerHeaders } = await setupDeal("generic");

    await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: sellerHeaders,
      payload: {
        url: "https://webhook.test/seller-expired",
        events: ["deal.fulfillment_expired"],
      },
    });

    const expiredAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment`,
      headers: sellerHeaders,
      payload: {
        agentId: SELLER_ID,
        fulfillmentData: {
          description: "Deliverables were available before expiry.",
          expires_at: expiredAt,
        },
      },
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/fulfillment?agentId=${buyerId}`,
      headers: buyerHeaders,
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as { status: string };
    expect(body.status).toBe("expired");

    const event = await waitForNotification("deal.fulfillment_expired");
    expect(event.event_type).toBe("deal.fulfillment_expired");
  });
});
