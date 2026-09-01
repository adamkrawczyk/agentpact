/**
 * apps/api/src/__tests__/verified-seller-ranking.test.ts
 * Verified Seller SKU: offer search/discovery ranking boost.
 *
 * GET /api/offers must rank verified sellers' offers first (stable tiebreak
 * on agents.verified_at IS NOT NULL), falling back to recency — and every
 * offer response (list, search, detail) must carry a `verified` boolean.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, cleanDatabase, generateTestAgent, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Verified Seller ranking + badge on offers", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createVerifiedAgent(app: Awaited<ReturnType<typeof createTestApp>>["app"], verified: boolean) {
    const testAgent = generateTestAgent();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId, { walletAddress: testAgent.ownerWalletAddress });
    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: {
        handle: testAgent.handle,
        displayName: testAgent.displayName,
        ownerWalletAddress: testAgent.ownerWalletAddress,
        walletProvider: testAgent.walletProvider,
      },
    });
    if (verified) {
      const { sql } = await createTestApp();
      await sql`UPDATE agents SET verified_at = NOW() WHERE id = ${agentId}`;
    }
    return { agentId, headers };
  }

  it("ranks a verified seller's offer ahead of an older non-verified offer", async () => {
    const { app } = await createTestApp();

    const nonVerified = await createVerifiedAgent(app, false);
    const nonVerifiedOfferRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: nonVerified.headers,
      payload: generateTestOffer(nonVerified.agentId),
    });
    expect(nonVerifiedOfferRes.statusCode).toBe(201);

    // Small delay so created_at strictly orders older-first if verification
    // boost were absent (proving the boost, not just default recency, wins).
    await new Promise((r) => setTimeout(r, 20));

    const verified = await createVerifiedAgent(app, true);
    const verifiedOfferRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: verified.headers,
      payload: generateTestOffer(verified.agentId),
    });
    expect(verifiedOfferRes.statusCode).toBe(201);
    const verifiedOffer = JSON.parse(verifiedOfferRes.body) as { id: string };

    // Verified agent's offer is NEWER here, so recency alone would already
    // rank it first — add a second, newer non-verified offer to prove the
    // boost, not recency, decides order.
    const nonVerified2 = await createVerifiedAgent(app, false);
    await new Promise((r) => setTimeout(r, 20));
    const newerNonVerifiedRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: nonVerified2.headers,
      payload: generateTestOffer(nonVerified2.agentId),
    });
    expect(newerNonVerifiedRes.statusCode).toBe(201);

    const listRes = await app.inject({ method: "GET", url: "/api/offers" });
    expect(listRes.statusCode).toBe(200);
    const offers = JSON.parse(listRes.body) as Array<{ id: string; verified: boolean }>;

    // The verified offer must be first even though a non-verified offer was
    // posted after it.
    expect(offers[0].id).toBe(verifiedOffer.id);
    expect(offers[0].verified).toBe(true);
  });

  it("includes verified:false on offers from non-verified sellers, in list and detail", async () => {
    const { app } = await createTestApp();
    const agent = await createVerifiedAgent(app, false);
    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: agent.headers,
      payload: generateTestOffer(agent.agentId),
    });
    const offer = JSON.parse(offerRes.body) as { id: string; verified: boolean };
    expect(offer.verified).toBe(false);

    const detailRes = await app.inject({ method: "GET", url: `/api/offers/${offer.id}` });
    const detail = JSON.parse(detailRes.body) as { verified: boolean };
    expect(detail.verified).toBe(false);

    const listRes = await app.inject({ method: "GET", url: "/api/offers" });
    const list = JSON.parse(listRes.body) as Array<{ id: string; verified: boolean }>;
    const found = list.find((o) => o.id === offer.id);
    expect(found?.verified).toBe(false);
  });

  it("includes verified:true on a verified seller's offer detail", async () => {
    const { app } = await createTestApp();
    const agent = await createVerifiedAgent(app, true);
    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: agent.headers,
      payload: generateTestOffer(agent.agentId),
    });
    const offer = JSON.parse(offerRes.body) as { id: string };

    const detailRes = await app.inject({ method: "GET", url: `/api/offers/${offer.id}` });
    const detail = JSON.parse(detailRes.body) as { verified: boolean };
    expect(detail.verified).toBe(true);
  });
});
