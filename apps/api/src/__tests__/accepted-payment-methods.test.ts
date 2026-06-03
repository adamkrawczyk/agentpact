import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestOffer, generateTestNeed, getAuthHeadersForAgent } from "./helpers/testApp.js";

// tillopen_0306/P1 — per-listing payment preference (accepted_payment_methods).
// Verifies the column round-trips through create + update on BOTH offers and
// needs. Post-P1c the default is 'usdc' (the live rail) and stripe/both are
// gated at create ("coming soon"), so explicit-value coverage for stripe/both
// is exercised via SQL in payment-rail-intersection.test.ts; here we cover the
// usdc create/PATCH round-trip and the schema-level out-of-set rejection.

describe("accepted_payment_methods (tillopen_0306/P1)", () => {
  let agentId: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    agentId = randomUUID();
    headers = await getAuthHeadersForAgent(agentId, { walletAddress: "0x1111111111111111111111111111111111111111" });
  });

  it("defaults offers to 'usdc' when omitted (P1c: live rail is the default)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "POST", url: "/api/offers", headers, payload: generateTestOffer(agentId) });
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
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

  it("defaults needs to 'usdc' when omitted (P1c)", async () => {
    const { app } = await createTestApp();
    const defRes = await app.inject({ method: "POST", url: "/api/needs", headers, payload: generateTestNeed(agentId) });
    expect(defRes.statusCode).toBe(201);
    expect((JSON.parse(defRes.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
  });

  it("rejects an out-of-set payment method at the schema (400)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST", url: "/api/offers", headers,
      payload: { ...generateTestOffer(agentId), acceptedPaymentMethods: "paypal" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("round-trips a usdc offer create→PATCH (column persists through update)", async () => {
    const { app } = await createTestApp();
    const createRes = await app.inject({
      method: "POST", url: "/api/offers", headers,
      payload: { ...generateTestOffer(agentId), acceptedPaymentMethods: "usdc" },
    });
    expect(createRes.statusCode).toBe(201);
    const offerId = (JSON.parse(createRes.body) as { id: string }).id;

    // PATCH that does not change the rail (still usdc) must succeed and persist.
    const patchRes = await app.inject({
      method: "PATCH", url: `/api/offers/${offerId}`, headers,
      payload: { acceptedPaymentMethods: "usdc", basePrice: 123 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((JSON.parse(patchRes.body) as { accepted_payment_methods: string }).accepted_payment_methods).toBe("usdc");
  });

  it("PATCH to a coming-soon rail (stripe) is rejected by the payability gate (400)", async () => {
    const { app } = await createTestApp();
    const createRes = await app.inject({
      method: "POST", url: "/api/offers", headers,
      payload: { ...generateTestOffer(agentId), acceptedPaymentMethods: "usdc" },
    });
    const offerId = (JSON.parse(createRes.body) as { id: string }).id;

    const patchRes = await app.inject({
      method: "PATCH", url: `/api/offers/${offerId}`, headers,
      payload: { acceptedPaymentMethods: "stripe" },
    });
    expect(patchRes.statusCode).toBe(400);
    expect((JSON.parse(patchRes.body) as { error: string }).error).toMatch(/coming soon/i);
  });
});
