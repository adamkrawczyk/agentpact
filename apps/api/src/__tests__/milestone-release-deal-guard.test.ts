/**
 * multi-milestone completion guard — issue #108.
 *
 * Before this fix, releaseMilestonePayment() completed the ENTIRE deal and
 * archived the backing offer on the release of ANY single milestone — even
 * when sibling milestones on the same deal were still outstanding (pending,
 * in_progress, delivered-but-unreleased, disputed). This misrepresented
 * partially-settled deals as fully completed and took the seller's offer
 * off the market while most of the value was still in flight.
 *
 * CONTRACT under test: `deals.status='completed'` and `offers.status='archived'`
 * may only be written when EVERY milestone on the deal is settled
 * ('accepted' or 'cancelled') — the coverage-not-existence idiom already used
 * by completeDealMilestones()'s unbacked-milestone guard. The released
 * milestone itself is still accepted and its payment_intent released in all
 * cases; only the deal/offer lifecycle transition is gated.
 *
 * Single-milestone deals (today's common case) must keep completing on
 * release — byte-for-byte legacy behavior.
 *
 * We mock chain.js isOnChainMode -> true exactly as
 * onchain-release-integrity.test.ts does: prod boots fail-closed with
 * PLATFORM_PRIVATE_KEY, so on-chain mode is the production state.
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

type MilestoneSpec = {
  status: string;
  /** insert a funded USDC payment_intent for this milestone */
  fund?: boolean;
};

/**
 * Seeds a deal ('delivered') with N milestones; each may carry a funded
 * payment intent. Returns ids for asserting on deal/offer/milestone state.
 */
async function seedMultiMilestoneDeal(specs: MilestoneSpec[]): Promise<{
  dealId: string;
  offerId: string;
  milestoneIds: string[];
  buyerId: string;
  sellerId: string;
}> {
  const buyerId = await seedAgent();
  const sellerId = await seedAgent();

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Multi-milestone guard offer"}, ${"multi-milestone guard offer body"}, ${"development"}, ${300}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Multi-milestone guard need"}, ${"multi-milestone guard need body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${300}, ${20}, ${false})
    RETURNING id
  `;

  const milestoneIds: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const [milestone] = await sql`
      INSERT INTO milestones (deal_id, idx, title, amount, status)
      VALUES (${deal.id}, ${i + 1}, ${`Milestone ${i + 1}`}, ${100}, ${spec.status})
      RETURNING id
    `;
    milestoneIds.push(String(milestone.id));
    if (spec.fund) {
      await sql`
        INSERT INTO payment_intents (
          milestone_id, buyer_agent_id, seller_agent_id, amount, status,
          buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
          payment_provider, tx_hash
        )
        VALUES (
          ${milestone.id}, ${buyerId}, ${sellerId}, ${100}, ${"funded"},
          ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"},
          ${"usdc"}, ${null}
        )
      `;
    }
  }

  return { dealId: String(deal.id), offerId: String(offer.id), milestoneIds, buyerId, sellerId };
}

async function dealStatus(dealId: string): Promise<string> {
  const [deal] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
  return String(deal.status);
}

async function offerStatus(offerId: string): Promise<string> {
  const [offer] = await sql`SELECT status FROM offers WHERE id = ${offerId}`;
  return String(offer.status);
}

describe("multi-milestone completion guard (releaseMilestonePayment) — issue #108", () => {
  beforeEach(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("releases the milestone but does NOT complete the deal or archive the offer while sibling milestones are outstanding", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered", fund: true },
      { status: "in_progress" },
      { status: "pending" },
    ]);

    const result = await releaseMilestonePayment(milestoneIds[0], { releaseTxHash: "0xrealreleasetx_m1" });

    // The milestone itself settles normally.
    expect(result.action).toBe("released");
    const [m1] = await sql`SELECT status FROM milestones WHERE id = ${milestoneIds[0]}`;
    expect(m1.status).toBe("accepted");

    // THE BUG: deal completed + offer archived off ONE of three milestones.
    expect(await dealStatus(dealId)).not.toBe("completed");
    expect(await offerStatus(offerId)).toBe("active");
  });

  it("completes the deal and archives the offer only when the LAST outstanding milestone is released", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered", fund: true },
      { status: "delivered", fund: true },
      { status: "pending" },
    ]);

    // First release: two milestones still outstanding (one delivered, one pending).
    await releaseMilestonePayment(milestoneIds[0], { releaseTxHash: "0xrealreleasetx_m1" });
    expect(await dealStatus(dealId)).not.toBe("completed");
    expect(await offerStatus(offerId)).toBe("active");

    // Second release: the pending sibling still blocks.
    await releaseMilestonePayment(milestoneIds[1], { releaseTxHash: "0xrealreleasetx_m2" });
    expect(await dealStatus(dealId)).not.toBe("completed");
    expect(await offerStatus(offerId)).toBe("active");

    // Final milestone: fund it, deliver it, release it — NOW the deal completes.
    const [dealRow] = await sql`SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${dealId}`;
    await sql`UPDATE milestones SET status = 'delivered' WHERE id = ${milestoneIds[2]}`;
    await sql`
      INSERT INTO payment_intents (
        milestone_id, buyer_agent_id, seller_agent_id, amount, status,
        buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
        payment_provider, tx_hash
      )
      VALUES (
        ${milestoneIds[2]}, ${dealRow.buyer_agent_id}, ${dealRow.seller_agent_id}, ${100}, ${"funded"},
        ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"},
        ${"usdc"}, ${null}
      )
    `;
    const final = await releaseMilestonePayment(milestoneIds[2], { releaseTxHash: "0xrealreleasetx_m3" });
    expect(final.action).toBe("released");
    expect(await dealStatus(dealId)).toBe("completed");
    expect(await offerStatus(offerId)).toBe("archived");
  });

  it("keeps completing single-milestone deals on release (legacy behavior regression guard)", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered", fund: true },
    ]);

    const result = await releaseMilestonePayment(milestoneIds[0], { releaseTxHash: "0xrealreleasetx_solo" });

    expect(result.action).toBe("released");
    expect(await dealStatus(dealId)).toBe("completed");
    expect(await offerStatus(offerId)).toBe("archived");
  });

  it("treats cancelled siblings as settled (does not block completion)", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered", fund: true },
      { status: "cancelled" },
    ]);

    await releaseMilestonePayment(milestoneIds[0], { releaseTxHash: "0xrealreleasetx_cancelledsib" });

    expect(await dealStatus(dealId)).toBe("completed");
    expect(await offerStatus(offerId)).toBe("archived");
  });

  it("treats a DISPUTED sibling as unsettled (blocks completion until resolved)", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered", fund: true },
      { status: "disputed" },
    ]);

    await releaseMilestonePayment(milestoneIds[0], { releaseTxHash: "0xrealreleasetx_disputedsib" });

    expect(await dealStatus(dealId)).not.toBe("completed");
    expect(await offerStatus(offerId)).toBe("active");
  });

  it("zero-payment path: accepts the milestone but does not complete the deal while siblings are outstanding", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered" }, // no funded intent — early-return branch
      { status: "in_progress" },
    ]);

    const result = await releaseMilestonePayment(milestoneIds[0]);

    expect(result.action).toBe("released");
    const [m1] = await sql`SELECT status FROM milestones WHERE id = ${milestoneIds[0]}`;
    expect(m1.status).toBe("accepted");
    expect(await dealStatus(dealId)).not.toBe("completed");
    expect(await offerStatus(offerId)).toBe("active");
  });

  it("zero-payment path: completes the deal when it is the last outstanding milestone", async () => {
    const { dealId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "accepted" },
      { status: "delivered" }, // no funded intent — early-return branch
    ]);

    const result = await releaseMilestonePayment(milestoneIds[1]);

    expect(result.action).toBe("released");
    expect(await dealStatus(dealId)).toBe("completed");
  });

  it("CONCURRENCY: parallel releases of sibling milestones still complete the deal (no stuck-at-delivered)", async () => {
    const { dealId, offerId, milestoneIds } = await seedMultiMilestoneDeal([
      { status: "delivered", fund: true },
      { status: "delivered", fund: true },
    ]);

    // Without the deal-row lock, both transactions observe the sibling still
    // outstanding under READ COMMITTED, both skip completion → deal stuck at
    // 'delivered' with every milestone accepted.
    await Promise.all([
      releaseMilestonePayment(milestoneIds[0], { releaseTxHash: "0xconcurrentrx_m1" }),
      releaseMilestonePayment(milestoneIds[1], { releaseTxHash: "0xconcurrentrx_m2" }),
    ]);

    for (const id of milestoneIds) {
      const [m] = await sql`SELECT status FROM milestones WHERE id = ${id}`;
      expect(m.status).toBe("accepted");
    }
    expect(await dealStatus(dealId)).toBe("completed");
    expect(await offerStatus(offerId)).toBe("archived");
  });

  it("CONCURRENCY: parallel releases of milestones on DIFFERENT deals do not deadlock", async () => {
    const dealA = await seedMultiMilestoneDeal([{ status: "delivered", fund: true }]);
    const dealB = await seedMultiMilestoneDeal([{ status: "delivered", fund: true }]);

    // Different deals → different lock rows → both must settle promptly. A
    // cross-deal deadlock would surface as a test timeout / rejected promise.
    const results = await Promise.all([
      releaseMilestonePayment(dealA.milestoneIds[0], { releaseTxHash: "0xcrossdeal_a" }),
      releaseMilestonePayment(dealB.milestoneIds[0], { releaseTxHash: "0xcrossdeal_b" }),
    ]);

    expect(results.every((r) => r.action === "released")).toBe(true);
    expect(await dealStatus(dealA.dealId)).toBe("completed");
    expect(await dealStatus(dealB.dealId)).toBe("completed");
  });
});
