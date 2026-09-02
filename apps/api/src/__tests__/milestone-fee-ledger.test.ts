import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { releaseMilestonePayment } from "../shared/deal-helpers.js";

// ── issue #133 — the escrow milestone-release path never wrote
// platform_fee_ledger; the ONLY writer in the codebase was
// routes/audit-orders.ts's Stripe-audit-order completion path. Every dollar
// that moved through the agent-to-agent USDC escrow flow was invisible to
// the platform's own revenue ledger. This test proves the fix: a release
// through releaseMilestonePayment() must write exactly one
// platform_fee_ledger row (10% of gross, same convention as audit-orders.ts),
// and a retried release for the same deal must not double-write it.
describe("releaseMilestonePayment writes platform_fee_ledger (fixes #133)", () => {
  let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];

  beforeEach(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
  });

  async function seedFundedDeliveredMilestone(amount = 100): Promise<{
    milestoneId: string;
    dealId: string;
  }> {
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    await getAuthHeadersForAgent(buyerId);
    await getAuthHeadersForAgent(sellerId);

    const [offer] = await sql`
      INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
      VALUES (${sellerId}, ${"Fee-ledger offer"}, ${"body"}, ${"development"}, ${amount}, ${20}, ${"active"})
      RETURNING id
    `;
    const [need] = await sql`
      INSERT INTO needs (agent_id, title, description_md, category, status)
      VALUES (${buyerId}, ${"Fee-ledger need"}, ${"body"}, ${"development"}, ${"open"})
      RETURNING id
    `;
    const [deal] = await sql`
      INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct)
      VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${amount}, ${20})
      RETURNING id
    `;
    const [milestone] = await sql`
      INSERT INTO milestones (deal_id, idx, title, amount, status)
      VALUES (${deal.id}, ${1}, ${"Delivery"}, ${amount}, ${"delivered"})
      RETURNING id
    `;
    await sql`
      INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, revision)
      VALUES (${milestone.id}, ${sellerId}, ${JSON.stringify([{ url: "https://example.com/a" }])}::jsonb, ${"deadbeef"}, ${1})
    `;
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${milestone.id}, ${buyerId}, ${sellerId}, ${amount}, ${"funded"}, ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"})
    `;
    return { milestoneId: String(milestone.id), dealId: String(deal.id) };
  }

  it("writes a platform_fee_ledger row (10% of gross) when a milestone releases", async () => {
    const { milestoneId, dealId } = await seedFundedDeliveredMilestone(100);

    const result = await releaseMilestonePayment(milestoneId);
    expect(result.action).toBe("released");

    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM platform_fee_ledger WHERE deal_id = ${dealId}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0];
    // 10% of 100 gross, expressed in minor units (amount * 1e6, matching the
    // NUMERIC(18,6) precision payment_intents.amount already carries).
    expect(Number(row.amount_minor)).toBe(10_000_000);
    expect(Number(row.fee_pct_at_close)).toBe(10);
    expect(row.audit_order_id).toBeNull();
    expect(["stripe", "usdc"]).toContain(row.source as string);
  });

  it("does NOT double-write platform_fee_ledger when a release is retried for the same deal", async () => {
    const { milestoneId, dealId } = await seedFundedDeliveredMilestone(100);

    const first = await releaseMilestonePayment(milestoneId);
    expect(first.action).toBe("released");

    // Retry: payment_intents is already 'released', so this call takes the
    // early-return path (no funded intent found) rather than re-running the
    // CAS UPDATE — but the ledger uniqueness must hold regardless of WHICH
    // code path a retry takes.
    const second = await releaseMilestonePayment(milestoneId);
    expect(second.action).toBe("released");

    const rows = await sql`
      SELECT * FROM platform_fee_ledger WHERE deal_id = ${dealId}
    `;
    expect(rows.length).toBe(1);
  });

  it("a duplicate direct INSERT for the same deal_id is rejected by the DB constraint (defense in depth)", async () => {
    const { milestoneId, dealId } = await seedFundedDeliveredMilestone(100);
    await releaseMilestonePayment(milestoneId);

    await expect(
      sql`
        INSERT INTO platform_fee_ledger (deal_id, amount_minor, currency, fee_pct_at_close, source)
        VALUES (${dealId}, ${5_000_000}, ${"USDC"}, ${10}, ${"usdc"})
      `,
    ).rejects.toThrow();
  });
});
