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
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${10}, ${"delivered"})
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
});
