import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// ── DEFECT 1 — unauthenticated cross-tenant settlement trigger ────────────
// POST /api/disputes/resolve-timeouts had NO auth check at all: any caller
// (including zero-auth) could sweep every globally-expired dispute and
// trigger releaseMilestonePayment() for unrelated parties. Fixed by gating
// with the SAME ADMIN_API_KEY mechanism as routes/admin.ts's
// /api/admin/auto-complete-timeouts sweeper.
//
// ── DEFECT 2 — buyer-forced platform-signed refund with no adjudication ───
// POST /api/payments/refund (on-chain mode, milestone status "Disputed")
// called resolveDisputeOnChain(milestoneId, refundBuyer=true) — the platform
// key would sign a refund the instant the OWNING buyer requested it, with no
// seller consent, no evidence review, no time window. Since the buyer can
// call openDispute() themselves, an authenticated buyer acting ALONE could
// take delivery and then claw the money back immediately. Fixed by routing
// disputed-milestone refund requests into pending_refund (the same
// operator-adjudicated hold used for the non-disputed case) instead of
// auto-resolving on-chain in the buyer's favor.

//
// UPDATED for issue #103: these cases originally pinned the exact status code
// returned by the ROUTE's own gate (403 / 503). The #103 fix hardened the
// global preHandler exemption in index.ts so an UNSET ADMIN_API_KEY can no
// longer satisfy `undefined === undefined` — which means the outer layer now
// answers first for unauthenticated / wrong-key / unset-key callers, and it
// answers 401. Nothing became more permissive: every one of these is still a
// refusal and the dispute is still not swept. The assertions were widened to
// the SECURITY CONTRACT ("refused, and nothing settled") instead of pinning
// which of two correct layers happens to answer. The legitimate admin path is
// still asserted exactly.

vi.mock("../chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chain.js")>();
  return {
    ...actual,
    isOnChainMode: vi.fn(() => false),
    getMilestoneStatus: vi.fn(),
    resolveDisputeOnChain: vi.fn(async () => ({ txHash: "0xshouldnotbecalled" })),
  };
});

const chainMock = await import("../chain.js");

async function seedExpiredDispute(sql: Awaited<ReturnType<typeof createTestApp>>["sql"]) {
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  await getAuthHeadersForAgent(buyerId);
  await getAuthHeadersForAgent(sellerId);

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Dispute-authz offer"}, ${"body"}, ${"development"}, ${50}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Dispute-authz need"}, ${"body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"disputed"}, ${50}, ${20})
    RETURNING id
  `;
  const [milestone] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${50}, ${"disputed"})
    RETURNING id
  `;
  const [dispute] = await sql`
    INSERT INTO disputes (deal_id, milestone_id, opened_by, reason, expires_at)
    VALUES (${deal.id}, ${milestone.id}, ${buyerId}, ${"timeout test"}, NOW() - INTERVAL '1 hour')
    RETURNING id
  `;
  return { buyerId, sellerId, dealId: String(deal.id), milestoneId: String(milestone.id), disputeId: String(dispute.id) };
}

describe("Dispute/refund authorization (RED-proof suite)", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    process.env.ADMIN_API_KEY = "test-admin-key-authz";
    vi.mocked(chainMock.isOnChainMode).mockReturnValue(false);
    vi.mocked(chainMock.resolveDisputeOnChain).mockClear();
  });

  afterEach(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = originalAdminKey;
    }
    vi.clearAllMocks();
  });

  describe("DEFECT 1: POST /api/disputes/resolve-timeouts", () => {
    it("rejects a completely unauthenticated request (no headers at all)", async () => {
      const { app, sql } = await createTestApp();
      await seedExpiredDispute(sql);

      const response = await app.inject({
        method: "POST",
        url: "/api/disputes/resolve-timeouts",
      });

      // Refused by whichever layer answers first (preHandler 401 or route 403).
      expect([401, 403]).toContain(response.statusCode);

      // Nothing should have been swept — the dispute must remain 'open'.
      const [dispute] = await sql`SELECT status FROM disputes WHERE status = 'open'`;
      expect(dispute?.status).toBe("open");
    });

    it("rejects a request authenticated as a plain (non-admin) agent", async () => {
      const { app, sql } = await createTestApp();
      const { buyerId } = await seedExpiredDispute(sql);
      const agentHeaders = await getAuthHeadersForAgent(buyerId);

      const response = await app.inject({
        method: "POST",
        url: "/api/disputes/resolve-timeouts",
        headers: agentHeaders,
      });

      // Refused by whichever layer answers first (preHandler 401 or route 403).
      expect([401, 403]).toContain(response.statusCode);

      const [dispute] = await sql`SELECT status FROM disputes WHERE status = 'open'`;
      expect(dispute?.status).toBe("open");
    });

    it("rejects a request with a WRONG admin key", async () => {
      const { app, sql } = await createTestApp();
      await seedExpiredDispute(sql);

      const response = await app.inject({
        method: "POST",
        url: "/api/disputes/resolve-timeouts",
        headers: { "x-admin-key": "totally-not-the-key" },
      });

      expect([401, 403]).toContain(response.statusCode);
    });

    it("fails closed when ADMIN_API_KEY is unset, even for a would-be admin caller", async () => {
      const { app, sql } = await createTestApp();
      await seedExpiredDispute(sql);
      delete process.env.ADMIN_API_KEY;

      const response = await app.inject({
        method: "POST",
        url: "/api/disputes/resolve-timeouts",
        headers: { "x-admin-key": "test-admin-key-authz" },
      });

      // Fails CLOSED. Post-#103 the hardened preHandler refuses the exemption
      // outright (401) before the route's 503 is reached; both are refusals and
      // neither settles anything. What must never happen here is a 2xx.
      expect([401, 403, 503]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    });

    it("STILL works with the correct admin credential (legitimate cron path preserved)", async () => {
      const { app, sql } = await createTestApp();
      const { milestoneId } = await seedExpiredDispute(sql);

      const response = await app.inject({
        method: "POST",
        url: "/api/disputes/resolve-timeouts",
        headers: { "x-admin-key": "test-admin-key-authz" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { timedOutDisputes: number };
      expect(body.timedOutDisputes).toBe(1);

      const [dispute] = await sql`SELECT status FROM disputes WHERE milestone_id = ${milestoneId}`;
      expect(dispute.status).toBe("timed_out");

      const [milestone] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
      expect(milestone.status).toBe("accepted");
    });

    it("also accepts the admin key via Authorization: Bearer header", async () => {
      const { app, sql } = await createTestApp();
      await seedExpiredDispute(sql);

      const response = await app.inject({
        method: "POST",
        url: "/api/disputes/resolve-timeouts",
        headers: { authorization: "Bearer test-admin-key-authz" },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("DEFECT 2: POST /api/payments/refund (on-chain, disputed milestone)", () => {
    async function setupDisputedFundedIntent() {
      const { app, sql } = await createTestApp();
      const buyerId = randomUUID();
      const sellerId = randomUUID();
      const buyerHeaders = await getAuthHeadersForAgent(buyerId);
      await getAuthHeadersForAgent(sellerId);

      const [offer] = await sql`
        INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
        VALUES (${sellerId}, ${"Refund-authz offer"}, ${"body"}, ${"development"}, ${75}, ${20}, ${"active"})
        RETURNING id
      `;
      const [need] = await sql`
        INSERT INTO needs (agent_id, title, description_md, category, status)
        VALUES (${buyerId}, ${"Refund-authz need"}, ${"body"}, ${"development"}, ${"open"})
        RETURNING id
      `;
      const [deal] = await sql`
        INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct)
        VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"disputed"}, ${75}, ${20})
        RETURNING id
      `;
      const [milestone] = await sql`
        INSERT INTO milestones (deal_id, idx, title, amount, status)
        VALUES (${deal.id}, ${1}, ${"Delivery"}, ${75}, ${"disputed"})
        RETURNING id
      `;
      const [intent] = await sql`
        INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, tx_hash, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
        VALUES (${milestone.id}, ${buyerId}, ${sellerId}, ${75}, ${"funded"}, ${"0xrealtx_dispute"}, ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"})
        RETURNING id
      `;

      return { app, sql, buyerId, sellerId, buyerHeaders, milestoneId: String(milestone.id), paymentIntentId: String(intent.id) };
    }

    it("does NOT let the buyer obtain an immediate platform-signed refund when they opened the dispute", async () => {
      vi.mocked(chainMock.isOnChainMode).mockReturnValue(true);
      vi.mocked(chainMock.getMilestoneStatus).mockResolvedValue({ exists: true, status: "Disputed" } as any);

      const { app, sql, buyerHeaders, paymentIntentId } = await setupDisputedFundedIntent();

      const response = await app.inject({
        method: "POST",
        url: "/api/payments/refund",
        headers: buyerHeaders,
        payload: { paymentIntentId, reason: "buyer-initiated dispute refund attempt" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { action: string };

      // The platform must NOT have signed an on-chain refund transaction.
      expect(chainMock.resolveDisputeOnChain).not.toHaveBeenCalled();
      expect(body.action).not.toBe("refunded_on_chain");
      expect(body.action).toBe("pending_refund");

      // DB state: intent held pending admin/operator adjudication, NOT refunded.
      const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${paymentIntentId}`;
      expect(intent.status).toBe("pending_refund");
      expect(intent.status).not.toBe("refunded");
    });

    it("legitimate non-disputed pending_refund path is unaffected (regression guard)", async () => {
      vi.mocked(chainMock.isOnChainMode).mockReturnValue(true);
      vi.mocked(chainMock.getMilestoneStatus).mockResolvedValue({ exists: true, status: "Funded" } as any);

      const { app, sql, buyerHeaders, paymentIntentId } = await setupDisputedFundedIntent();

      const response = await app.inject({
        method: "POST",
        url: "/api/payments/refund",
        headers: buyerHeaders,
        payload: { paymentIntentId, reason: "not disputed yet" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { action: string };
      expect(body.action).toBe("pending_refund");
      expect(chainMock.resolveDisputeOnChain).not.toHaveBeenCalled();

      const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${paymentIntentId}`;
      expect(intent.status).toBe("pending_refund");
    });

    it("still requires the requester to own the buyer side (pre-existing ownership check preserved)", async () => {
      vi.mocked(chainMock.isOnChainMode).mockReturnValue(true);
      vi.mocked(chainMock.getMilestoneStatus).mockResolvedValue({ exists: true, status: "Disputed" } as any);

      const { app, paymentIntentId } = await setupDisputedFundedIntent();
      const attackerHeaders = await getAuthHeadersForAgent(randomUUID());

      const response = await app.inject({
        method: "POST",
        url: "/api/payments/refund",
        headers: attackerHeaders,
        payload: { paymentIntentId },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
