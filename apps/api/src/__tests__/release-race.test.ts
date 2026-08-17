import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// ── DEFECT — releaseMilestonePayment() has no idempotency/status guard on its
// UPDATE, so two concurrent callers racing on the SAME funded milestone both
// pass the initial `WHERE pi.status = 'funded'` SELECT (classic TOCTOU: the
// SELECT and the later UPDATE are not the same atomic statement, and the
// UPDATE inside sql.begin() carries no `AND status = 'funded'` predicate —
// shared/deal-helpers.ts:274 `UPDATE payment_intents SET status = 'released'
// ... WHERE id = $2` has no status guard at all).
//
// This is directly reachable over HTTP: a buyer who double-submits
// POST /api/deliveries/verify (network retry, double-click, or two tabs) for
// the same milestone races two concurrent request handlers into
// releaseMilestonePayment() with no synchronization between them. Both
// observe payment_intents.status = 'funded', both proceed, and — because the
// admin dispute-timeout sweep (POST /api/disputes/resolve-timeouts) calls the
// exact same unguarded function — the identical race is reachable between a
// buyer's manual verify and the timeout sweep firing on the same milestone
// concurrently (the scenario the audit's Q4 asks about).
//
// Net effect: TWO 'payment.release' audit_log rows are written for one
// milestone, seller reputation/notifications fire twice, and the platform
// fee is recorded twice in `auditedPlatformFeeRevenue` for a single real
// payment. Precedent for the correct guard already exists in this repo:
// routes/admin.ts's expire-stale-proposals sweep does
// `UPDATE deals SET status='cancelled' WHERE id=... AND status=${deal.status}
// RETURNING id` and explicitly treats zero returned rows as "lost the race,
// leave it alone" (routes/admin.ts:388-397). releaseMilestonePayment() never
// adopted that pattern.

let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: Awaited<ReturnType<typeof createTestApp>>["app"];

async function seedFundedDeliveredMilestone(): Promise<{ milestoneId: string; buyerHeaders: Record<string, string>; buyerAgentId: string }> {
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  const buyerHeaders = await getAuthHeadersForAgent(buyerId);
  await getAuthHeadersForAgent(sellerId);

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Release-race offer"}, ${"body"}, ${"development"}, ${100}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Release-race need"}, ${"body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"}, ${100}, ${20})
    RETURNING id
  `;
  const [milestone] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${100}, ${"delivered"})
    RETURNING id
  `;
  await sql`
    INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, revision)
    VALUES (${milestone.id}, ${sellerId}, ${JSON.stringify([{ url: "https://example.com/a" }])}::jsonb, ${"deadbeef"}, ${1})
  `;
  await sql`
    INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
    VALUES (${milestone.id}, ${buyerId}, ${sellerId}, ${100}, ${"funded"}, ${"metamask"}, ${"0x1111111111111111111111111111111111111111"}, ${"0x2222222222222222222222222222222222222222"}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"})
  `;
  return { milestoneId: String(milestone.id), buyerHeaders, buyerAgentId: buyerId };
}

describe("releaseMilestonePayment idempotency (RED-proof)", () => {
  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase();
  });

  it("does NOT double-release when POST /api/deliveries/verify is called twice concurrently for the same milestone", async () => {
    const { milestoneId, buyerHeaders, buyerAgentId } = await seedFundedDeliveredMilestone();

    const payload = { milestoneId, buyerAgentId, accepted: true };

    // Simulates a client double-submit (retry-after-timeout, double-click,
    // two tabs) — both requests reach the handler before either commits.
    const [res1, res2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/deliveries/verify", headers: buyerHeaders, payload }),
      app.inject({ method: "POST", url: "/api/deliveries/verify", headers: buyerHeaders, payload }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    // The security contract: exactly ONE release should have actually
    // happened for this milestone — the second racer should observe the
    // funds already released and refuse to release again.
    const releaseRows = await sql`
      SELECT * FROM audit_log WHERE action = 'payment.release' AND object_id = ${milestoneId}
    `;
    expect(releaseRows.length).toBe(1);

    const [intent] = await sql`SELECT status FROM payment_intents WHERE milestone_id = ${milestoneId}`;
    expect(intent.status).toBe("released");
  });
});
