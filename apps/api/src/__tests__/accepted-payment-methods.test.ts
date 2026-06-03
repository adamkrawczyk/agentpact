import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestOffer, generateTestNeed, getAuthHeadersForAgent } from "./helpers/testApp.js";

// tillopen_0306/P1 — per-listing payment preference (accepted_payment_methods).
// Verifies the column round-trips through create + update on BOTH offers and
// needs, defaults to 'both' when omitted, and rejects out-of-set values.

describe("accepted_payment_methods (tillopen_0306/P1)", () => {
  let agentId: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    agentId = randomUUID();
    headers = await getAuthHeadersForAgent(agentId, { walletAddress: "0x1111111111111111111111111111111111111111" });
  });

  it("defaults offers to 'both' when omitted", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "POST", url: "/api/offers", headers, payload: generateTestOffer(agentId) });
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("both");
  });

  it("persists an explicit offer payment method (usdc)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers,
      payload: { ...generateTestOffer(agentId), acceptedPaymentMethods: "usdc" },
    });
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
  });

  it("defaults needs to 'both' and persists an explicit value (stripe)", async () => {
    const { app } = await createTestApp();
    const defRes = await app.inject({ method: "POST", url: "/api/needs", headers, payload: generateTestNeed(agentId) });
    expect(defRes.statusCode).toBe(201);
    expect((JSON.parse(defRes.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("both");

    const expRes = await app.inject({
      method: "POST", url: "/api/needs", headers,
      payload: { ...generateTestNeed(agentId), acceptedPaymentMethods: "stripe" },
    });
    expect(expRes.statusCode).toBe(201);
    expect((JSON.parse(expRes.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("stripe");
  });

  it("rejects an out-of-set payment method at the schema (400)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers,
      payload: { ...generateTestOffer(agentId), acceptedPaymentMethods: "paypal" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("updates an offer's payment method via PATCH", async () => {
    const { app } = await createTestApp();
    const createRes = await app.inject({
      method: "POST", url: "/api/offers", headers,
      payload: { ...generateTestOffer(agentId), acceptedPaymentMethods: "both" },
    });
    const offerId = (JSON.parse(createRes.body) as { id: string }).id;

    const patchRes = await app.inject({
      method: "PATCH", url: `/api/offers/${offerId}`, headers,
      payload: { acceptedPaymentMethods: "usdc" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((JSON.parse(patchRes.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
  });
});
