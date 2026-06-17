import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("GET /api/public/sitemap-ids", () => {
  it("enumerates active offers + open needs from external agents (beyond the 200-row browse cap)", async () => {
    const { app, sql } = await createTestApp();
    await cleanDatabase();

    const sellerId = randomUUID();
    const buyerId = randomUUID();
    const sellerHeaders = await getAuthHeadersForAgent(sellerId, {
      walletAddress: "0xA110000000000000000000000000000000000001",
    });
    const buyerHeaders = await getAuthHeadersForAgent(buyerId, {
      walletAddress: "0xB220000000000000000000000000000000000002",
    });

    const offerRes = await app.inject({
      method: "POST", url: "/api/offers", headers: sellerHeaders,
      payload: { agentId: sellerId, title: "Sitemap Offer", descriptionMd: "An external offer for the sitemap test.", category: "Test", tags: ["sitemap"], basePrice: 10, currency: "USDC", maxPriceDeltaPct: 10, slaDays: 7, proofs: [] },
    });
    expect(offerRes.statusCode).toBe(201);
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { agentId: buyerId, title: "Sitemap Need", descriptionMd: "An external need for the sitemap test.", category: "Test", tags: ["sitemap"], budgetMax: 50, currency: "USDC", acceptanceCriteria: ["Done"] },
    });
    expect(needRes.statusCode).toBe(201);
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    const res = await app.inject({ method: "GET", url: "/api/public/sitemap-ids" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      offers: Array<{ id: string; updated_at?: string }>;
      needs: Array<{ id: string; updated_at?: string }>;
    };

    expect(body.offers.map((o) => o.id)).toContain(offerId);
    expect(body.needs.map((n) => n.id)).toContain(needId);
    // Shape contract: id is a string, updated_at present — no description/embedding leakage.
    const offerRow = body.offers.find((o) => o.id === offerId)!;
    expect(typeof offerRow.id).toBe("string");
    expect(offerRow).not.toHaveProperty("description_md");
    expect(Object.keys(offerRow).sort()).toEqual(["id", "updated_at"]);
  });

  it("excludes internal agents' offers + archived/closed listings from the index", async () => {
    const { app, sql } = await createTestApp();
    await cleanDatabase();

    const intSeller = randomUUID();
    const intHeaders = await getAuthHeadersForAgent(intSeller, {
      walletAddress: "0xC330000000000000000000000000000000000003",
    });
    const intOfferRes = await app.inject({
      method: "POST", url: "/api/offers", headers: intHeaders,
      payload: { agentId: intSeller, title: "Internal Offer", descriptionMd: "An internal offer that must not be indexed.", category: "Test", tags: ["internal"], basePrice: 10, currency: "USDC", maxPriceDeltaPct: 10, slaDays: 7, proofs: [] },
    });
    const intOfferId = (JSON.parse(intOfferRes.body) as { id: string }).id;
    // Flag the agent internal — its offer must drop out of the sitemap.
    await sql`UPDATE agents SET is_internal = true WHERE id = ${intSeller}`;

    const res = await app.inject({ method: "GET", url: "/api/public/sitemap-ids" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { offers: Array<{ id: string }>; needs: Array<{ id: string }> };
    expect(body.offers.map((o) => o.id)).not.toContain(intOfferId);
  });
});
