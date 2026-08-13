/**
 * settlement-integrity — releaseMilestonePayment() on-chain fabrication guard.
 *
 * Ground truth (verified): prod @agentpact/api requires PLATFORM_PRIVATE_KEY
 * to boot (index.ts fail-closed check), so isOnChainMode() === true in
 * production. Before this fix, releaseMilestonePayment() (shared/deal-helpers.ts)
 * had NO isOnChainMode() check at all: it always wrote a `sim_release_<uuid>`
 * tx_hash into payment_intents, flipped the milestone to 'accepted' and the
 * deal to 'completed', and inserted a real-looking `payment.release` audit_log
 * row with a computed platform fee — regardless of whether any USDC actually
 * moved on-chain. A SECOND divergent copy of the same function lived in
 * index.ts with the identical defect.
 *
 * CONTRACT under test: in on-chain mode, a payment_intent funded via the USDC
 * escrow rail (payment_provider != 'stripe', status='funded') must NOT reach
 * status='released' with a `sim_release_*` hash, and the milestone/deal must
 * NOT be flipped to accepted/completed, unless a real (non-sim) release tx
 * hash was supplied by the caller. The function must return a discriminated
 * result (`action: 'buyer_sign_required'`) instead of silently lying.
 *
 * Simulation mode (isOnChainMode() === false) is unaffected — the sim_release_
 * behavior there is correct legacy/dev behavior and must not regress.
 *
 * We mock chain.js isOnChainMode -> true exactly as
 * silent-zero-complete-guard.test.ts does, to exercise prod's live state
 * without needing a signing key in the test env.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

vi.mock("../chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chain.js")>();
  return {
    ...actual,
    isOnChainMode: () => true,
  };
});

// Import AFTER the mock is registered so the helper closes over the mocked module.
const { releaseMilestonePayment } = await import("../shared/deal-helpers.js");

let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];

async function seedAgent(): Promise<string> {
  const id = randomUUID();
  await getAuthHeadersForAgent(id, { walletAddress: "0x1111111111111111111111111111111111111111" });
  return id;
}

async function seedFundedDeal(opts: {
  paymentProvider?: "usdc" | "stripe";
  txHash?: string | null;
}): Promise<{
  dealId: string;
  milestoneId: string;
  intentId: string;
  buyerId: string;
  sellerId: string;
}> {
  const buyerId = await seedAgent();
  const sellerId = await seedAgent();

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Release integrity offer"}, ${"release integrity offer body"}, ${"development"}, ${100}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Release integrity need"}, ${"release integrity need body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${100}, ${20}, ${false})
    RETURNING id
  `;
  const [milestone] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${100}, ${"delivered"})
    RETURNING id
  `;
  const [intent] = await sql`
    INSERT INTO payment_intents (
      milestone_id, buyer_agent_id, seller_agent_id, amount, status,
      buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
      payment_provider, tx_hash
    )
    VALUES (
      ${milestone.id}, ${buyerId}, ${sellerId}, ${100}, ${"funded"},
      ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"},
      ${opts.paymentProvider ?? "usdc"}, ${opts.txHash ?? null}
    )
    RETURNING id
  `;

  return { dealId: String(deal.id), milestoneId: String(milestone.id), intentId: String(intent.id), buyerId, sellerId };
}

describe("on-chain release-integrity guard (releaseMilestonePayment)", () => {
  beforeEach(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT fabricate a sim_release_* hash for a funded USDC escrow intent in on-chain mode", async () => {
    const { dealId, milestoneId, intentId } = await seedFundedDeal({ paymentProvider: "usdc" });

    const result = await releaseMilestonePayment(milestoneId);

    // The function must refuse, not lie.
    expect(result.action).toBe("buyer_sign_required");
    expect(result.mode).toBe("on-chain");

    // The payment intent must stay 'funded' — NOT 'released', and definitely
    // no sim_release_* tx_hash fabricated onto it.
    const [intent] = await sql`SELECT status, tx_hash FROM payment_intents WHERE id = ${intentId}`;
    expect(intent.status).toBe("funded");
    expect(String(intent.tx_hash ?? "")).not.toMatch(/^sim_release_/);

    // The milestone must NOT be force-accepted.
    const [milestone] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(milestone.status).not.toBe("accepted");

    // The deal must NOT be flipped to completed.
    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).not.toBe("completed");

    // No fake fee-bearing audit row was written (the auditedPlatformFeeRevenue poison).
    const feeRows = await sql`
      SELECT 1 FROM audit_log WHERE action = 'payment.release' AND object_id = ${milestoneId}
    `;
    expect(feeRows.length).toBe(0);
  });

  it("DOES release when the caller supplies a real (non-sim) on-chain release tx hash", async () => {
    const { dealId, milestoneId, intentId } = await seedFundedDeal({ paymentProvider: "usdc" });

    const result = await releaseMilestonePayment(milestoneId, { releaseTxHash: "0xrealreleasetxhash" });

    expect(result.action).toBe("released");
    expect(result.txHash).toBe("0xrealreleasetxhash");

    const [intent] = await sql`SELECT status, tx_hash FROM payment_intents WHERE id = ${intentId}`;
    expect(intent.status).toBe("released");
    expect(intent.tx_hash).toBe("0xrealreleasetxhash");

    const [milestone] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(milestone.status).toBe("accepted");

    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("completed");
  });

  it("still releases Stripe-funded intents in on-chain mode (no on-chain escrow to fake-release)", async () => {
    const { dealId, milestoneId, intentId } = await seedFundedDeal({ paymentProvider: "stripe" });

    const result = await releaseMilestonePayment(milestoneId);

    expect(result.action).toBe("released");
    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${intentId}`;
    expect(intent.status).toBe("released");
    const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("completed");
  });
});

describe("simulation-mode release behavior (unaffected by the on-chain guard)", () => {
  beforeEach(async () => {
    vi.doMock("../chain.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../chain.js")>();
      return { ...actual, isOnChainMode: () => false };
    });
  });

  it("keeps the legacy sim_release_ behavior when isOnChainMode() is false", async () => {
    vi.resetModules();
    vi.doMock("../chain.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../chain.js")>();
      return { ...actual, isOnChainMode: () => false };
    });
    const { releaseMilestonePayment: releaseInSimMode } = await import("../shared/deal-helpers.js");
    const { createTestApp: createTestAppSim, cleanDatabase: cleanDatabaseSim, getAuthHeadersForAgent: getAuthSim } =
      await import("./helpers/testApp.js");

    const { sql: simSql } = await createTestAppSim();
    await cleanDatabaseSim();

    const buyerId = randomUUID();
    const sellerId = randomUUID();
    await getAuthSim(buyerId, { walletAddress: "0x1111111111111111111111111111111111111111" });
    await getAuthSim(sellerId, { walletAddress: "0x2222222222222222222222222222222222222222" });

    const [offer] = await simSql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
      VALUES (${sellerId}, ${"Sim offer"}, ${"sim offer body"}, ${"development"}, ${50}, ${20}, ${"active"})
      RETURNING id
    `;
    const [need] = await simSql`
      INSERT INTO needs (agent_id, title, description_md, category, status)
      VALUES (${buyerId}, ${"Sim need"}, ${"sim need body"}, ${"development"}, ${"open"})
      RETURNING id
    `;
    const [deal] = await simSql`
      INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
      VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${50}, ${20}, ${false})
      RETURNING id
    `;
    const [milestone] = await simSql`
      INSERT INTO milestones (deal_id, idx, title, amount, status)
      VALUES (${deal.id}, ${1}, ${"Delivery"}, ${50}, ${"delivered"})
      RETURNING id
    `;
    const [intent] = await simSql`
      INSERT INTO payment_intents (
        milestone_id, buyer_agent_id, seller_agent_id, amount, status,
        buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
        payment_provider
      )
      VALUES (
        ${milestone.id}, ${buyerId}, ${sellerId}, ${50}, ${"funded"},
        ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"},
        ${"usdc"}
      )
      RETURNING id
    `;

    const result = await releaseInSimMode(String(milestone.id));

    expect(result.mode).toBe("simulation");
    expect(result.action).toBe("released");

    const [updatedIntent] = await simSql`SELECT status, tx_hash FROM payment_intents WHERE id = ${intent.id}`;
    expect(updatedIntent.status).toBe("released");
    expect(String(updatedIntent.tx_hash)).toMatch(/^sim_release_/);

    const [updatedDeal] = await simSql`SELECT status FROM deals WHERE id = ${deal.id}`;
    expect(updatedDeal.status).toBe("completed");

    vi.doUnmock("../chain.js");
    vi.resetModules();
  });
});
