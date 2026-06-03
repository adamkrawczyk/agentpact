import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// tillopen_0306 / P1 — silent-$0 phantom-complete guard.
//
// Ground truth (verified 2026-06-03): prod @agentpact/api now has RPC_URL +
// PLATFORM_PRIVATE_KEY in env, so isOnChainMode() === true in production. The
// fall-through tail of completeDealMilestones() unconditionally flips a deal to
// status='completed' even when NO real money ever funded an intent — the
// "phantom complete" that produced 53 zero-fee "completed" deals and (via
// releaseMilestonePayment's audit_log 'payment.release' row) would inject FAKE
// feeAmounts into auditedPlatformFeeRevenue once volume grows.
//
// CONTRACT under test: in on-chain mode, a FEE-BEARING deal (is_free_tier=false)
// reaching settlement with NO real-money funded intent (no on-chain tx_hash AND
// no real Stripe intent) MUST NOT be marked 'completed'. It is held at
// 'delivered' and the helper returns action='settlement_pending'. Free-tier
// deals, and deals backed by a real funded intent, are unaffected.
//
// We mock chain.js isOnChainMode -> true to exercise prod's live state without
// needing a signing key in the test env. resolveDisputeOnChain is never reached
// on this path (no on-chain funded intent), so it needs no behavior.

vi.mock("../chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chain.js")>();
  return {
    ...actual,
    isOnChainMode: () => true,
  };
});

// Import AFTER the mock is registered so the helper closes over the mocked module.
const { completeDealMilestones } = await import("../shared/deal-helpers.js");

let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];

async function seedAgent(): Promise<string> {
  const id = randomUUID();
  // getAuthHeadersForAgent registers the agent row as a side effect.
  await getAuthHeadersForAgent(id, { walletAddress: "0x1111111111111111111111111111111111111111" });
  return id;
}

async function seedDeal(opts: { isFreeTier: boolean }): Promise<{ dealId: string; milestoneId: string; buyerId: string; sellerId: string }> {
  const buyerId = await seedAgent();
  const sellerId = await seedAgent();

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Guard test offer"}, ${"guard test offer body"}, ${"development"}, ${10}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Guard test need"}, ${"guard test need body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${10}, ${20}, ${opts.isFreeTier})
    RETURNING id
  `;
  const [milestone] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${10}, ${"in_progress"})
    RETURNING id
  `;
  return { dealId: String(deal.id), milestoneId: String(milestone.id), buyerId, sellerId };
}

describe("silent-$0 phantom-complete guard (tillopen_0306/P1)", () => {
  beforeEach(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT mark a fee-bearing deal completed when no real money funded it (on-chain mode)", async () => {
    const { dealId } = await seedDeal({ isFreeTier: false });

    const result = await completeDealMilestones(dealId, { skipOnChainRelease: false });

    // The deal must be HELD, not phantom-completed.
    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).not.toBe("completed");
    expect(deal.status).toBe("delivered");
    expect(result.action).toBe("settlement_pending");

    // And NO fake fee audit row was written (this is the auditedPlatformFeeRevenue poison).
    const feeRows = await sql`
      SELECT 1 FROM audit_log
      WHERE action = 'payment.release'
        AND object_id IN (SELECT id FROM milestones WHERE deal_id = ${dealId})
    `;
    expect(feeRows.length).toBe(0);
  });

  it("STILL completes a free-tier deal with no funded intent (zero-fee by design is fine)", async () => {
    const { dealId } = await seedDeal({ isFreeTier: true });

    const result = await completeDealMilestones(dealId, { skipOnChainRelease: false });

    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("completed");
    expect(result.action).toBe("released");
  });

  it("completes a fee-bearing deal that HAS a real on-chain funded intent (real money path unaffected)", async () => {
    const { dealId, milestoneId, buyerId, sellerId } = await seedDeal({ isFreeTier: false });
    // A real (non-sim) on-chain funded intent backs this milestone.
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, tx_hash, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${milestoneId}, ${buyerId}, ${sellerId}, ${10}, ${"funded"}, ${"0xrealtxhash_not_sim"}, ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"})
    `;

    const result = await completeDealMilestones(dealId, { skipOnChainRelease: false });

    // Real-money path: NOT held at delivered. (Exact terminal state depends on the
    // on-chain release result, but it must NOT be the settlement_pending hold and
    // must NOT be left at 'delivered'.)
    expect(result.action).not.toBe("settlement_pending");
    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).not.toBe("delivered");
  });

  it("does NOT reward the seller's reputation when the deal is held at settlement_pending", async () => {
    // Caller-gating contract: a held deal must not bump reputation. We simulate
    // the fulfillment auto-complete side-effect ordering by checking the seller's
    // reputation_score is unchanged after a settlement_pending completion.
    const { dealId, sellerId } = await seedDeal({ isFreeTier: false });
    const [before] = await sql`SELECT COALESCE(reputation_score, 0) AS rep FROM agents WHERE id = ${sellerId}`;

    const result = await completeDealMilestones(dealId, { skipOnChainRelease: false });
    expect(result.action).toBe("settlement_pending");

    // The guard returns before any reward side-effect; the caller (fulfillment.ts /
    // admin.ts) is responsible for skipping the +0.5 bump on this action. Assert the
    // helper itself never touched reputation.
    const [after] = await sql`SELECT COALESCE(reputation_score, 0) AS rep FROM agents WHERE id = ${sellerId}`;
    expect(Number(after.rep)).toBe(Number(before.rep));
  });

  it("HOLDS a multi-milestone deal when only SOME milestones are real-money funded (coverage, not existence)", async () => {
    // Codex MUST-FIX: a LIMIT-1 existence check would let one funded milestone
    // mask an unfunded sibling. Seed a 2-milestone deal, fund only milestone #1
    // with real money, leave #2 unfunded → the deal MUST be held, not completed.
    const buyerId = await seedAgent();
    const sellerId = await seedAgent();
    const [offer] = await sql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
      VALUES (${sellerId}, ${"Multi offer"}, ${"multi milestone body"}, ${"development"}, ${20}, ${20}, ${"active"})
      RETURNING id`;
    const [need] = await sql`
      INSERT INTO needs (agent_id, title, description_md, category, status)
      VALUES (${buyerId}, ${"Multi need"}, ${"multi milestone body"}, ${"development"}, ${"open"})
      RETURNING id`;
    const [deal] = await sql`
      INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
      VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${20}, ${20}, ${false})
      RETURNING id`;
    const [m1] = await sql`INSERT INTO milestones (deal_id, idx, title, amount, status) VALUES (${deal.id}, ${1}, ${"M1"}, ${10}, ${"in_progress"}) RETURNING id`;
    await sql`INSERT INTO milestones (deal_id, idx, title, amount, status) VALUES (${deal.id}, ${2}, ${"M2"}, ${10}, ${"in_progress"})`;
    // Only M1 has a real on-chain funded intent. M2 has nothing.
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, tx_hash, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m1.id}, ${buyerId}, ${sellerId}, ${10}, ${"funded"}, ${"0xrealtx_m1"}, ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"})`;

    const result = await completeDealMilestones(String(deal.id), { skipOnChainRelease: false });

    // Safety property: a deal with an unfunded milestone must NOT reach 'completed',
    // regardless of WHICH mechanism holds it. When some milestone has a real
    // on-chain intent, hasOnChainFundedIntent routes to the on-chain release
    // branch, where the unfunded sibling's release fails → deferred to
    // 'release_pending_chain' / buyer_sign_required (not my settlement_pending
    // guard, but equally non-completing). When NO milestone has real money, my
    // coverage guard returns settlement_pending. Either way: NOT completed.
    expect(result.action).not.toBe("released");
    const [d] = await sql`SELECT status FROM deals WHERE id = ${deal.id}`;
    expect(d.status).not.toBe("completed");
  });

  it("RECOVERS: a held deal completes once its milestone is funded with real money (no permanent trap)", async () => {
    // Codex MUST-FIX: prove the held state is recoverable. Guard touches only
    // deals.status; milestone stays 'in_progress' (fundable). Fund it, re-run.
    const { dealId, milestoneId, buyerId, sellerId } = await seedDeal({ isFreeTier: false });

    // First pass: unfunded → held.
    const held = await completeDealMilestones(dealId, { skipOnChainRelease: false });
    expect(held.action).toBe("settlement_pending");
    const [m] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(m.status).toBe("in_progress"); // still fundable (payments.ts allows in_progress)

    // Buyer funds with real money.
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, tx_hash, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${milestoneId}, ${buyerId}, ${sellerId}, ${10}, ${"funded"}, ${"0xrealtx_recover"}, ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"})`;

    // Second pass: now backed → no longer held.
    const recovered = await completeDealMilestones(dealId, { skipOnChainRelease: false });
    expect(recovered.action).not.toBe("settlement_pending");
    const [d] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(d.status).not.toBe("delivered");
  });
});
