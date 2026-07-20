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

    it("should filter offers by category", async () => {
      const { app } = await createTestApp();
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Data Pipeline", category: "data" }
      });
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Onboarding Helper", category: "onboarding" }
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/offers?category=onboarding",
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Array<{ title: string; category: string }>;
      expect(body.length).toBeGreaterThan(0);
      // every returned offer must be in the requested category — pre-fix this returned all categories
      expect(body.every((offer) => offer.category === "onboarding")).toBe(true);
      expect(body.some((offer) => offer.category === "data")).toBe(false);
    });

    it("should combine category with a text query", async () => {
      const { app } = await createTestApp();
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Earn first dollar", category: "onboarding" }
      });
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: { ...generateTestOffer(agentId), title: "Earn with scraping", category: "data" }
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/offers?query=Earn&category=onboarding",
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Array<{ title: string; category: string }>;
      expect(body.every((offer) => offer.category === "onboarding")).toBe(true);
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

  // Regression: proofs_json is stored JSONB, same class of double-encode bug
  // as needs.acceptance_criteria (a manually JSON.stringify()'d value bound
  // with an explicit ::jsonb cast gets encoded twice by postgres.js). Every
  // read path must hand consumers a real JSON array, not the string "[]".
  describe("proofs_json is a real JSON array (not a stringified string)", () => {
    it("POST /api/offers returns proofs_json as a list, empty-array case", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: generateTestOffer(agentId) // proofs: []
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { proofs_json: unknown };
      expect(Array.isArray(body.proofs_json)).toBe(true);
      expect(body.proofs_json).toEqual([]);
    });

    it("GET /api/offers returns proofs_json as a list for every row", async () => {
      const { app } = await createTestApp();
      await app.inject({ method: "POST", url: "/api/offers", headers: authHeaders, payload: generateTestOffer(agentId) });

      const response = await app.inject({
        method: "GET",
        url: "/api/offers",
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Array<{ proofs_json: unknown }>;
      expect(body.length).toBeGreaterThanOrEqual(1);
      for (const offer of body) {
        expect(Array.isArray(offer.proofs_json)).toBe(true);
      }
    });

    it("GET /api/offers/:id returns proofs_json as a list", async () => {
      const { app } = await createTestApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: generateTestOffer(agentId)
      });
      const { id } = JSON.parse(createRes.body) as { id: string };

      const response = await app.inject({
        method: "GET",
        url: `/api/offers/${id}`,
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { proofs_json: unknown };
      expect(Array.isArray(body.proofs_json)).toBe(true);
    });
  });
});
