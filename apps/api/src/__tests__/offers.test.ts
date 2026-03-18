import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Offers API", () => {
  let authHeaders: Record<string, string>;
  let agentId: string;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    agentId = randomUUID();
    authHeaders = await getAuthHeadersForAgent(agentId);
  });

  describe("POST /api/offers", () => {
    it("should create a new offer", async () => {
      const { app } = await createTestApp();
      const offer = generateTestOffer(agentId);

      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: offer
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { id: string; title: string; status: string };
      expect(body.id).toBeTruthy();
      expect(body.title).toBe(offer.title);
      expect(body.status).toBe("active");
    });

    it("should reject creating offer for another agent", async () => {
      const { app } = await createTestApp();
      const offer = generateTestOffer("00000000-0000-0000-0000-000000000000");

      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: offer
      });

      expect(response.statusCode).toBe(403);
    });

    it("should validate positive price", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), basePrice: -100 }
      });
      expect(response.statusCode).toBe(400);
    });

    it("should allow reputation-only offers with zero price", async () => {
      const { app } = await createTestApp();
      const offer = { ...generateTestOffer(agentId), basePrice: 0 };

      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: offer
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { base_price: string | number };
      expect(Number(body.base_price)).toBe(0);
    });
  });

  describe("GET /api/offers", () => {
    it("should list active offers", async () => {
      const { app } = await createTestApp();
      await app.inject({ method: "POST", url: "/api/offers", headers: authHeaders, payload: generateTestOffer(agentId) });
      await app.inject({ method: "POST", url: "/api/offers", headers: authHeaders, payload: generateTestOffer(agentId) });

      const response = await app.inject({
        method: "GET",
        url: "/api/offers",
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as unknown[];
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by search query", async () => {
      const { app } = await createTestApp();
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Alpha AI Builder" }
      });
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Bravo Design Tool" }
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/offers?query=Alpha",
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Array<{ title: string }>;
      expect(body.some((offer) => offer.title.includes("Alpha"))).toBe(true);
    });

    it("should filter to free-tier offers and tag them as reputation-only", async () => {
      const { app } = await createTestApp();
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Paid Offer", basePrice: 100 }
      });
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Free Offer", basePrice: 0 }
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/offers?free_only=true",
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Array<{ title: string; base_price: string | number; tags: string[] }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.title).toBe("Free Offer");
      expect(Number(body[0]?.base_price)).toBe(0);
      expect(body[0]?.tags).toContain("reputation-only");
    });
  });

  describe("POST /api/offers/:id/archive", () => {
    it("should archive an offer", async () => {
      const { app } = await createTestApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: generateTestOffer(agentId)
      });
      const { id } = JSON.parse(createRes.body) as { id: string };

      const archiveRes = await app.inject({
        method: "POST",
        url: `/api/offers/${id}/archive`,
        headers: authHeaders
      });
      expect(archiveRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/offers/${id}`,
        headers: authHeaders
      });
      const body = JSON.parse(getRes.body) as { status: string };
      expect(body.status).toBe("archived");
    });
  });
});
