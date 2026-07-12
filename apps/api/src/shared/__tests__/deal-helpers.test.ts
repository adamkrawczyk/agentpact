/**
 * escrow-safety rollout — Escrow release safety test.
 *
 * Asserts that completeDealMilestones() does NOT mark deals/payment_intents
 * as released when the on-chain release call fails. Pre-A0 behavior was to
 * unconditionally UPDATE deals.status='completed' + payment_intents.status='released'
 * regardless of whether the on-chain release succeeded — a latent money-loss event
 * (DB says paid, contract still holds funds).
 *
 * Post-A0 behavior:
 *   - on-chain release succeeds for ALL milestones → deals='completed',
 *     payment_intents='released' (happy path unchanged)
 *   - on-chain release throws for any milestone → deals='release_pending_chain',
 *     payment_intents stay 'funded', audit_log row 'chain.release_failed' written
 *   - ALLOW_ONCHAIN_RELEASE=false → on-chain call skipped, deals='release_pending_chain'
 *
 * Uses vitest module mocking on ../chain.js so we never hit a real RPC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Mock the chain module BEFORE importing deal-helpers — vi.mock is hoisted.
vi.mock("../../chain.js", () => ({
  isOnChainMode: () => true,
  resolveDisputeOnChain: vi.fn(),
  generateAcceptTransaction: (milestoneId: string) => ({
    to: "0x0000000000000000000000000000000000000001",
    calldata: `0xaccept${milestoneId.slice(0, 8)}`,
  }),
}));

import * as chain from "../../chain.js";
import { completeDealMilestones } from "../deal-helpers.js";
import { sql } from "../../db.js";

const resolveDisputeOnChain = chain.resolveDisputeOnChain as ReturnType<typeof vi.fn>;

async function makeAgent(): Promise<string> {
  const handle = `a0test-${randomUUID().slice(0, 8)}`;
  const [agent] = await sql<{ id: string }[]>`
    INSERT INTO agents (handle, display_name, owner_wallet_address, wallet_provider)
    VALUES (${handle}, ${"A0 Test Agent"}, ${"0x" + randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}, 'metamask')
    RETURNING id
  `;
  return String(agent.id);
}

async function makeFundedDeal(): Promise<{ dealId: string; milestoneId: string; intentId: string }> {
  const buyerId = await makeAgent();
  const sellerId = await makeAgent();

  const [offer] = await sql<{ id: string }[]>`
    INSERT INTO offers (agent_id, title, description_md, category, tags, base_price, currency, max_price_delta_pct, sla_days, status)
    VALUES (${sellerId}, ${"A0 offer"}, ${"desc"}, ${"Testing"}, ${["t"]}, 100, 'USDC', 15, 7, 'active')
    RETURNING id
  `;
  const [need] = await sql<{ id: string }[]>`
    INSERT INTO needs (agent_id, title, description_md, category, tags, budget_max, currency, status)
    VALUES (${buyerId}, ${"A0 need"}, ${"desc"}, ${"Testing"}, ${["t"]}, 150, 'USDC', 'open')
    RETURNING id
  `;
  const [deal] = await sql<{ id: string }[]>`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, 'delivered', 100, 'USDC', 15, 7)
    RETURNING id
  `;
  const [milestone] = await sql<{ id: string }[]>`
    INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, status)
    VALUES (${deal.id}, 0, ${"M1"}, 100, 'USDC', '{}'::jsonb, 'pending')
    RETURNING id
  `;
  // Funded payment_intent with a REAL (non-sim) tx_hash so hasOnChainFundedIntent=true.
  // Schema (migrations/001_init.sql:104): payment_intents links to milestones (not deals);
  // uses buyer_agent_id / seller_agent_id (not payer/payee).
  const [intent] = await sql<{ id: string }[]>`
    INSERT INTO payment_intents (
      milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
      buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
      tx_hash
    ) VALUES (
      ${milestone.id}, ${buyerId}, ${sellerId}, 100, 'USDC', 'base', 'funded',
      'metamask',
      ${"0x" + "11".repeat(20)},
      ${"0x" + "22".repeat(20)},
      ${"0x" + "33".repeat(20)},
      ${"0x" + "ab".repeat(30) + randomUUID().replace(/-/g, "").slice(0, 4)}
    )
    RETURNING id
  `;
  return { dealId: String(deal.id), milestoneId: String(milestone.id), intentId: String(intent.id) };
}

describe("completeDealMilestones — escrow-safety rollout release safety", () => {
  beforeEach(() => {
    resolveDisputeOnChain.mockReset();
    delete process.env.ALLOW_ONCHAIN_RELEASE;
  });

  afterEach(async () => {
    // Best-effort cleanup of A0 test rows; testcontainer is torn down between
    // top-level test runs anyway, so failures here are non-fatal.
    try {
      await sql`DELETE FROM audit_log WHERE action = 'chain.release_failed'`;
    } catch {
      // ignore
    }
  });

  it("HAPPY PATH: marks deal=completed + payment_intents=released when on-chain release succeeds", async () => {
    const { dealId, milestoneId, intentId } = await makeFundedDeal();
    resolveDisputeOnChain.mockResolvedValue({ txHash: "0x" + "cd".repeat(32) });

    const result = await completeDealMilestones(dealId);

    expect(result.mode).toBe("on-chain");
    expect(result.action).toBe("released");
    expect(resolveDisputeOnChain).toHaveBeenCalledWith(milestoneId, false);

    const [deal] = await sql<{ status: string }[]>`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("completed");

    const [intent] = await sql<{ status: string }[]>`SELECT status FROM payment_intents WHERE id = ${intentId}`;
    expect(intent.status).toBe("released");
  });

  it("FAILURE PATH (the A0 bug): keeps deal=release_pending_chain + intent=funded when on-chain release THROWS", async () => {
    const { dealId, milestoneId, intentId } = await makeFundedDeal();
    resolveDisputeOnChain.mockRejectedValue(new Error("chain RPC down — A0 simulation"));

    const result = await completeDealMilestones(dealId);

    expect(result.mode).toBe("on-chain");
    expect(result.action).toBe("buyer_sign_required");
    expect(resolveDisputeOnChain).toHaveBeenCalledWith(milestoneId, false);

    const [deal] = await sql<{ status: string }[]>`SELECT status FROM deals WHERE id = ${dealId}`;
    // THE CONTRACT THIS TEST GUARDS: deal MUST stay at release_pending_chain.
    // Before A0 patch this assertion fails because the old code wrote 'completed'
    // unconditionally regardless of the on-chain throw.
    expect(deal.status).toBe("release_pending_chain");

    const [intent] = await sql<{ status: string }[]>`SELECT status FROM payment_intents WHERE id = ${intentId}`;
    // And payment_intents MUST stay at funded. Pre-A0 this was 'released'.
    expect(intent.status).toBe("funded");

    const auditRows = await sql<{ action: string; object_id: string }[]>`
      SELECT action, object_id FROM audit_log WHERE object_id = ${dealId} AND action = 'chain.release_failed'
    `;
    expect(auditRows.length).toBe(1);
  });

  it("KILL SWITCH: ALLOW_ONCHAIN_RELEASE=false skips the chain call entirely, deal still stays at release_pending_chain", async () => {
    const { dealId, milestoneId, intentId } = await makeFundedDeal();
    process.env.ALLOW_ONCHAIN_RELEASE = "false";

    const result = await completeDealMilestones(dealId);

    expect(result.action).toBe("buyer_sign_required");
    // resolveDisputeOnChain MUST NOT be called when the kill switch is flipped.
    expect(resolveDisputeOnChain).not.toHaveBeenCalled();

    const [deal] = await sql<{ status: string }[]>`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("release_pending_chain");

    const [intent] = await sql<{ status: string }[]>`SELECT status FROM payment_intents WHERE id = ${intentId}`;
    expect(intent.status).toBe("funded");

    void milestoneId;
  });
});
