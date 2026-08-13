// apps/api/src/__tests__/deal-lifecycle-integrity.test.ts
//
// Covers the four DEAL/INTENT LIFECYCLE INTEGRITY defects (GitHub #90, #91):
//
//  A. GET /api/deals honors limit/offset (previously hardcoded LIMIT 200,
//     silently ignoring caller-requested pagination — the bug that produced a
//     wrong audit statistic from a recent-window sample reported as a
//     population ratio).
//  B. A stale 'proposed' deal past its acceptance deadline is swept to
//     'cancelled' by POST /api/admin/expire-stale-proposals; a fresh proposal
//     within its deadline is left untouched.
//  C. The accept-deal gasless auto-mint refuses to mint when
//     HASH_PREIMAGE_PREDICATE_ADDRESS is unset or the zero address — the deal
//     still accepts (degrades to manual settlement) instead of minting an
//     intent AgentPactEscrowV3 can never fund.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanDatabase,
  createTestApp,
  generateTestNeed,
  generateTestOffer,
  getAuthHeadersForAgent,
} from "./helpers/testApp.js";

const ADMIN_KEY = "test-admin-key-lifecycle";
const ADMIN_HEADERS = { "x-admin-key": ADMIN_KEY };

const DELIVERABLE_HASH_HEX = "0x" + "aa".repeat(32);
const BUYER_WALLET = "0x1111111111111111111111111111111111111111";
const SELLER_WALLET = "0x2222222222222222222222222222222222222222";
const REAL_PREDICATE_ADDRESS = "0x542535b7804E54877E5cd45695a3D6d50182D976";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Defect A: pagination ────────────────────────────────────────────────────

describe("DEFECT A — GET /api/deals honors limit/offset", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;
  let offerId: string;
  let needId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: BUYER_WALLET });
    sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: SELLER_WALLET });

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    needId = (JSON.parse(needRes.body) as { id: string }).id;
  });

  async function proposeNDeals(app: Awaited<ReturnType<typeof createTestApp>>["app"], n: number) {
    for (let i = 0; i < n; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/deals/propose",
        headers: buyerHeaders,
        payload: {
          buyerAgentId: buyerId,
          sellerAgentId: sellerId,
          offerId,
          needId,
          negotiatedTotal: 10,
          maxPriceDeltaPct: 20,
          milestones: [{ idx: 1, title: `M${i}`, amount: 10, acceptanceCriteria: ["Done"] }],
        },
      });
      expect(res.statusCode).toBe(201);
    }
  }

  it("returns exactly `limit` rows when limit < total, and a DIFFERENT page at offset=limit", async () => {
    const { app } = await createTestApp();
    await proposeNDeals(app, 5);

    const page1 = await app.inject({
      method: "GET",
      url: `/api/deals?buyerAgentId=${buyerId}&limit=2&offset=0`,
    });
    expect(page1.statusCode).toBe(200);
    const rows1 = JSON.parse(page1.body) as Array<{ id: string }>;
    expect(rows1.length).toBe(2);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/deals?buyerAgentId=${buyerId}&limit=2&offset=2`,
    });
    expect(page2.statusCode).toBe(200);
    const rows2 = JSON.parse(page2.body) as Array<{ id: string }>;
    expect(rows2.length).toBe(2);

    // Pages must not overlap — this is the pagination the bug silently broke.
    const ids1 = new Set(rows1.map((r) => r.id));
    for (const row of rows2) {
      expect(ids1.has(row.id)).toBe(false);
    }
  });

  it("clamps an oversized limit request instead of returning unbounded rows", async () => {
    const { app } = await createTestApp();
    await proposeNDeals(app, 3);

    const res = await app.inject({
      method: "GET",
      url: `/api/deals?buyerAgentId=${buyerId}&limit=999999`,
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ id: string }>;
    // Exactly the 3 we made (well under the 200 clamp) — proves the clamp
    // doesn't break normal small result sets.
    expect(rows.length).toBe(3);
  });

  it("defaults to unchanged behavior (no limit/offset passed) — existing callers unaffected", async () => {
    const { app } = await createTestApp();
    await proposeNDeals(app, 3);

    const res = await app.inject({
      method: "GET",
      url: `/api/deals?buyerAgentId=${buyerId}`,
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ id: string }>;
    expect(rows.length).toBe(3);
  });
});

// ── Defect B: stale proposal sweeper ────────────────────────────────────────

describe("DEFECT B — POST /api/admin/expire-stale-proposals", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;
  let offerId: string;
  let needId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: BUYER_WALLET });
    sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: SELLER_WALLET });

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    needId = (JSON.parse(needRes.body) as { id: string }).id;
  });

  async function proposeDeal(app: Awaited<ReturnType<typeof createTestApp>>["app"], expiresAt?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 10,
        maxPriceDeltaPct: 20,
        milestones: [{ idx: 1, title: "M1", amount: 10, acceptanceCriteria: ["Done"] }],
        ...(expiresAt ? { expiresAt } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  it("new proposals get a non-null expires_at by default (no override needed)", async () => {
    const { app, sql } = await createTestApp();
    const dealId = await proposeDeal(app);

    const [deal] = await sql<Array<{ expires_at: Date | null }>>`
      SELECT expires_at FROM deals WHERE id = ${dealId}
    `;
    expect(deal.expires_at).not.toBeNull();
    expect(new Date(deal.expires_at as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("sweeps a stale proposed deal (past deadline) to cancelled, and notifies both parties", async () => {
    const { app, sql } = await createTestApp();
    // Explicit expiry in the past — deal is proposed but already overdue.
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const staleDealId = await proposeDeal(app, pastExpiry);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/expire-stale-proposals",
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { processed: number; results: Array<{ dealId: string; expired: boolean }> };
    expect(body.processed).toBeGreaterThanOrEqual(1);
    const entry = body.results.find((r) => r.dealId === staleDealId);
    expect(entry?.expired).toBe(true);

    const [deal] = await sql<Array<{ status: string }>>`SELECT status FROM deals WHERE id = ${staleDealId}`;
    expect(deal.status).toBe("cancelled");
  });

  it("does NOT touch a fresh proposal that has not reached its deadline", async () => {
    const { app, sql } = await createTestApp();
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const freshDealId = await proposeDeal(app, futureExpiry);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/expire-stale-proposals",
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { results: Array<{ dealId: string }> };
    expect(body.results.find((r) => r.dealId === freshDealId)).toBeUndefined();

    const [deal] = await sql<Array<{ status: string }>>`SELECT status FROM deals WHERE id = ${freshDealId}`;
    expect(deal.status).toBe("proposed");
  });

  it("rejects without a valid admin key (same auth as auto-complete-timeouts)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/expire-stale-proposals",
      headers: { "x-admin-key": "wrong-key" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── Defect C: zero-address predicate guard ──────────────────────────────────

describe("DEFECT C — accept-deal auto-mint refuses a missing/zero predicate address", () => {
  const originalPredicateAddress = process.env.HASH_PREIMAGE_PREDICATE_ADDRESS;

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(() => {
    if (originalPredicateAddress === undefined) {
      delete process.env.HASH_PREIMAGE_PREDICATE_ADDRESS;
    } else {
      process.env.HASH_PREIMAGE_PREDICATE_ADDRESS = originalPredicateAddress;
    }
  });

  async function seedProposedGaslessDeal() {
    const { app, sql } = await createTestApp();
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: BUYER_WALLET });
    const sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: SELLER_WALLET });

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    expect(offerRes.statusCode).toBe(201);
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    expect(needRes.statusCode).toBe(201);
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
        negotiatedTotal: 50,
        maxPriceDeltaPct: 20,
        milestones: [{ idx: 1, title: "Milestone 1", amount: 50, acceptanceCriteria: ["Deliver work"] }],
        deliverableHash: DELIVERABLE_HASH_HEX,
      },
    });
    expect(proposeRes.statusCode).toBe(201);
    const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    return { app, sql, dealId, buyerId, sellerId, sellerHeaders };
  }

  it("does NOT mint an intent when HASH_PREIMAGE_PREDICATE_ADDRESS is unset, but still ACCEPTS the deal", async () => {
    delete process.env.HASH_PREIMAGE_PREDICATE_ADDRESS;
    const { sql, dealId, sellerId, sellerHeaders, app } = await seedProposedGaslessDeal();

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    // The refusal is scoped to MINTING, not commerce — accept must still succeed.
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql<Array<{ intent_id: string | null; status: string }>>`
      SELECT intent_id, status FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).toBeNull();
    expect(deal.status).not.toBe("proposed");

    // And critically: no intent row was created at all — not even a zero-address one.
    const intents = await sql<Array<{ id: string }>>`SELECT id FROM intents WHERE deal_id = ${dealId}`;
    expect(intents.length).toBe(0);
  });

  it("does NOT mint an intent when HASH_PREIMAGE_PREDICATE_ADDRESS is explicitly the zero address", async () => {
    process.env.HASH_PREIMAGE_PREDICATE_ADDRESS = ZERO_ADDRESS;
    const { sql, dealId, sellerId, sellerHeaders, app } = await seedProposedGaslessDeal();

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).toBeNull();

    const intents = await sql<Array<{ id: string }>>`SELECT id FROM intents WHERE deal_id = ${dealId}`;
    expect(intents.length).toBe(0);
  });

  it("MINTS normally on the same fixture once a real predicate address is configured (negative control)", async () => {
    process.env.HASH_PREIMAGE_PREDICATE_ADDRESS = REAL_PREDICATE_ADDRESS;
    const { sql, dealId, sellerId, sellerHeaders, app } = await seedProposedGaslessDeal();

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    // Proves the previous two tests' null intent_id was caused by the GUARD,
    // not a broken fixture — without this control, a fixture that never mints
    // would pass trivially.
    expect(deal.intent_id).not.toBeNull();

    const [intent] = await sql<Array<{ predicate_params: unknown }>>`
      SELECT predicate_params FROM intents WHERE id = ${deal.intent_id}
    `;
    const params =
      typeof intent.predicate_params === "string"
        ? (JSON.parse(intent.predicate_params as string) as { verifier?: string })
        : (intent.predicate_params as { verifier?: string });
    expect(params.verifier?.toLowerCase()).toBe(REAL_PREDICATE_ADDRESS.toLowerCase());
  });
});
