import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, clearAuthHeadersCache, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// Issue #104 — three defects surfaced by an independent adversarial review of
// the #96–#102 security sprint. Each is a gap the sprint's own fixes left open:
//
//  A. The stale-proposal sweeper (#102) selected only status='proposed'.
//     Countering sets status='countered' WITHOUT touching expires_at, and
//     accept permits BOTH ('proposed','countered') — so a countered proposal
//     stays a live, acceptable offer that can never expire. One counter-offer
//     re-opened the exact lifecycle leak the sweeper exists to close.
//
//  B. GET /api/deals clamped `limit` but not `offset` (#102). An unbounded
//     OFFSET makes Postgres walk every skipped row, and a value past BIGINT
//     range errors outright.
//
//  C. #99 correctly stopped a BUYER from forcing a platform-signed refund on
//     their own request — but that left NO caller anywhere passing
//     refundBuyer=true. A genuine buyer-win adjudication had no execution path,
//     so escrowed funds could never be returned through the application.
//     POST /api/admin/force-refund is the admin-gated counterpart to the
//     existing force-release.

vi.mock("../chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chain.js")>();
  return {
    ...actual,
    isOnChainMode: vi.fn(() => false),
    resolveDisputeOnChain: vi.fn(async () => ({ txHash: "0xadminrefund" })),
  };
});

let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: Awaited<ReturnType<typeof createTestApp>>["app"];

const ADMIN_KEY = "test-admin-key-104";

async function seedDeal(opts: {
  status: string;
  expiresAt: string | null;
}): Promise<{ dealId: string; buyerId: string; sellerId: string }> {
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  await getAuthHeadersForAgent(buyerId);
  await getAuthHeadersForAgent(sellerId);

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"#104 offer"}, ${"body"}, ${"development"}, ${50}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"#104 need"}, ${"body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (
      buyer_agent_id, seller_agent_id, offer_id, need_id, status,
      negotiated_total, max_price_delta_pct, expires_at
    )
    VALUES (
      ${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${opts.status},
      ${50}, ${20}, ${opts.expiresAt}
    )
    RETURNING id
  `;
  return { dealId: String(deal.id), buyerId, sellerId };
}

async function dealStatus(dealId: string): Promise<string> {
  const [row] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
  return String(row?.status);
}

describe("issue #104 — gaps left open by the security sprint", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase();
    // cleanDatabase() deletes the agent rows but the helper caches issued API
    // keys by agent id — a stale cache hit returns a key for an agent that no
    // longer exists, and the next INSERT trips needs_agent_id_fkey. Clear it.
    clearAuthHeadersCache();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
    vi.clearAllMocks();
  });

  describe("A — stale-proposal sweeper covers 'countered', not just 'proposed'", () => {
    it("sweeps a STALE COUNTERED deal (the leak a counter-offer re-opened)", async () => {
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const { dealId } = await seedDeal({ status: "countered", expiresAt: past });

      const res = await app.inject({
        method: "POST",
        url: "/api/admin/expire-stale-proposals",
        headers: { "x-admin-key": ADMIN_KEY },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(await dealStatus(dealId)).toBe("cancelled");
    });

    it("still sweeps a stale PROPOSED deal (no regression on the original fix)", async () => {
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const { dealId } = await seedDeal({ status: "proposed", expiresAt: past });

      await app.inject({
        method: "POST",
        url: "/api/admin/expire-stale-proposals",
        headers: { "x-admin-key": ADMIN_KEY },
        payload: {},
      });

      expect(await dealStatus(dealId)).toBe("cancelled");
    });

    it("does NOT touch a countered deal whose deadline has not passed", async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const { dealId } = await seedDeal({ status: "countered", expiresAt: future });

      await app.inject({
        method: "POST",
        url: "/api/admin/expire-stale-proposals",
        headers: { "x-admin-key": ADMIN_KEY },
        payload: {},
      });

      expect(await dealStatus(dealId)).toBe("countered");
    });
  });

  describe("B — GET /api/deals clamps offset as well as limit", () => {
    it("clamps an offset beyond BIGINT range instead of passing it to Postgres", async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await seedDeal({ status: "proposed", expiresAt: future });

      // Boundary verified directly against Postgres 16:
      //   SELECT 1 OFFSET 1000000000000000000;   -> (0 rows)      [in range]
      //   SELECT 1 OFFSET 99999999999999999999;  -> ERROR: bigint out of range
      // So the value that actually exercises the clamp must exceed BIGINT.
      // Unclamped, this reaches Postgres and 500s; clamped, it is a normal page.
      const res = await app.inject({
        method: "GET",
        url: "/api/deals?limit=5&offset=99999999999999999999",
      });

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.body))).toBe(true);
    });

    it("a normal offset still paginates", async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await seedDeal({ status: "proposed", expiresAt: future });
      await seedDeal({ status: "proposed", expiresAt: future });
      await seedDeal({ status: "proposed", expiresAt: future });

      const page1 = await app.inject({ method: "GET", url: "/api/deals?limit=2&offset=0" });
      const page2 = await app.inject({ method: "GET", url: "/api/deals?limit=2&offset=2" });

      const ids1 = JSON.parse(page1.body).map((d: { id: string }) => d.id);
      const ids2 = JSON.parse(page2.body).map((d: { id: string }) => d.id);

      expect(ids1.length).toBe(2);
      expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
    });
  });

  describe("C — POST /api/admin/force-refund exists and is admin-gated", () => {
    it("rejects an unauthenticated caller", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/force-refund",
        payload: { milestoneId: randomUUID() },
      });
      expect([401, 403]).toContain(res.statusCode);
    });

    it("rejects a WRONG admin key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/force-refund",
        headers: { "x-admin-key": "nope" },
        payload: { milestoneId: randomUUID() },
      });
      expect([401, 403]).toContain(res.statusCode);
    });

    it("refunds the buyer and cancels the deal with the correct admin key", async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const { dealId } = await seedDeal({ status: "disputed", expiresAt: future });
      const [milestone] = await sql`
        INSERT INTO milestones (deal_id, idx, title, amount, status)
        VALUES (${dealId}, ${1}, ${"Delivery"}, ${50}, ${"disputed"})
        RETURNING id
      `;

      const res = await app.inject({
        method: "POST",
        url: "/api/admin/force-refund",
        headers: { "x-admin-key": ADMIN_KEY },
        payload: { milestoneId: String(milestone.id), reason: "buyer won adjudication" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
      expect(await dealStatus(dealId)).toBe("cancelled");
    });
  });
});
