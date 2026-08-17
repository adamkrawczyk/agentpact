import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { releaseMilestonePayment } from "../shared/deal-helpers.js";

// ── DEFECT — releaseMilestonePayment() has no idempotency/status guard on its
// UPDATE, so two concurrent callers racing on the SAME funded milestone both
// pass the initial `WHERE pi.status = 'funded'` SELECT (classic TOCTOU: the
// SELECT and the later UPDATE are not the same atomic statement). This is
// directly reachable over HTTP: a buyer who double-submits
// POST /api/deliveries/verify (network retry, double-click, or two tabs) for
// the same milestone races two concurrent request handlers into
// releaseMilestonePayment() with no synchronization between them, and the
// admin dispute-timeout sweep (POST /api/disputes/resolve-timeouts) calls the
// exact same function, so the identical race is reachable between a buyer's
// manual verify and the timeout sweep firing on the same milestone
// concurrently.
//
// Net effect if unguarded: TWO 'payment.release' audit_log rows are written
// for one milestone, seller reputation/notifications fire twice, and the
// platform fee is recorded twice in `auditedPlatformFeeRevenue` for a single
// real payment.
//
// ── DETERMINISM NOTE (why this test does NOT use Promise.all(app.inject x2))
// An earlier version of this file drove the race via
// `Promise.all([app.inject(...), app.inject(...)])` over the real HTTP route.
// That construction has NO barrier forcing both requests past the funded
// SELECT before either reaches the UPDATE — it just hopes Node's event-loop
// scheduling interleaves them favorably. Measured empirically against
// deliberately-broken code (guard removed): PASS/FAIL was a coin flip run to
// run (roughly 1-in-3 runs went green on broken code), because whichever
// request's SELECT+UPDATE macrotask happened to run to completion before the
// other's SELECT started would "resolve" the race by accident, leaving no
// double-release for the assertion to catch.
//
// This version replaces timing luck with an explicit synchronization point:
// releaseMilestonePayment() accepts a test-only `__raceTestHook` invoked
// exactly once, after the funded-SELECT succeeds and before the CAS UPDATE
// transaction begins. We use it to provably interleave two calls so BOTH
// have completed their funded-SELECT before EITHER's UPDATE commits — the
// exact TOCTOU window the real bug exploits — on every single run.
describe("releaseMilestonePayment idempotency (RED-proof, deterministic)", () => {
  let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];

  beforeEach(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
  });

  async function seedFundedDeliveredMilestone(): Promise<{ milestoneId: string; dealId: string }> {
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    await getAuthHeadersForAgent(buyerId);
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
    return { milestoneId: String(milestone.id), dealId: String(deal.id) };
  }

  it("does NOT double-release when two concurrent callers both pass the funded-SELECT before either commits the CAS UPDATE", async () => {
    const { milestoneId } = await seedFundedDeliveredMilestone();

    // Deterministic interleave, no Promise.all/event-loop luck involved:
    //   1. Caller A runs its funded-SELECT (finds the row — status is still
    //      'funded' at this point, nobody has written yet).
    //   2. Caller A's hook fires and BLOCKS, handing control to caller B.
    //   3. Caller B runs its OWN funded-SELECT — this is the critical
    //      TOCTOU proof point: it still finds the row 'funded' because A has
    //      not reached its UPDATE yet. B then proceeds all the way through
    //      its CAS UPDATE and commits — a real, successful release.
    //   4. Only THEN does A's hook unblock and let A proceed to its own CAS
    //      UPDATE. On correct (guarded) code, A's `WHERE status = 'funded'`
        //      predicate now matches zero rows (B already flipped it), so A's
    //      idempotency branch fires and A must NOT write a second release.
    let resolveBDone: () => void;
    const bDone = new Promise<void>((resolve) => {
      resolveBDone = resolve;
    });

    const callA = releaseMilestonePayment(milestoneId, {
      __raceTestHook: async () => {
        // A pauses here — right after its funded-SELECT, right before its
        // CAS UPDATE — until B has fully completed its own SELECT+UPDATE.
        await bDone;
      },
    });

    // Give A's SELECT a tick to actually run and hit the hook before B starts,
    // so B's SELECT genuinely races A's SELECT rather than running first.
    await new Promise((r) => setTimeout(r, 10));

    const bResult = await releaseMilestonePayment(milestoneId);
    resolveBDone!();

    const aResult = await callA;

    // Exactly one of the two calls performed the real release.
    const results = [aResult, bResult];
    const releasedResults = results.filter((r) => r.action === "released" && r.txHash);
    expect(releasedResults.length).toBe(1);

    // The security contract: exactly ONE release should have actually
    // happened for this milestone — the loser must not write a duplicate
    // 'payment.release' audit row (double-counts platform fee revenue,
    // double-fires seller notifications for one real payment).
    const releaseRows = await sql`
      SELECT * FROM audit_log WHERE action = 'payment.release' AND object_id = ${milestoneId}
    `;
    expect(releaseRows.length).toBe(1);

    const [intent] = await sql`SELECT status FROM payment_intents WHERE milestone_id = ${milestoneId}`;
    expect(intent.status).toBe("released");
  });

  // ── CONFIRMED DEFECT 1 (BLOCKING, fixed by this PR) ────────────────────────
  // The zero-row branch used to assume "another caller already released
  // this" and unconditionally return { action: "released" }. That inference
  // is wrong: zero rows only proves the intent's status is no longer
  // 'funded' — it could be 'refunded' or 'pending_refund' because a buyer
  // refund raced the release (routes/payments.ts's refund route writes
  // status='pending_refund'/'refunded' with NO status guard on its own
  // UPDATE). Prove the fix: a refund landing in the TOCTOU window must
  // produce action:'not_released', never action:'released'.
  it("does NOT report action:'released' when a concurrent refund (not another release) wins the race", async () => {
    const { milestoneId } = await seedFundedDeliveredMilestone();

    const [intentRow] = await sql`SELECT id FROM payment_intents WHERE milestone_id = ${milestoneId}`;

    const result = await releaseMilestonePayment(milestoneId, {
      __raceTestHook: async () => {
        // Simulate routes/payments.ts:576-580's unguarded refund UPDATE
        // landing exactly in the TOCTOU window between this call's
        // funded-SELECT and its CAS UPDATE.
        await sql`
          UPDATE payment_intents SET status = 'refunded', updated_at = NOW()
          WHERE id = ${intentRow.id}
        `;
      },
    });

    // The call must NOT claim a release happened.
    expect(result.action).not.toBe("released");
    expect(result.action).toBe("not_released");
    expect(result.currentStatus).toBe("refunded");

    // No fabricated 'payment.release' audit row, no fee double-counted.
    const releaseRows = await sql`
      SELECT * FROM audit_log WHERE action = 'payment.release' AND object_id = ${milestoneId}
    `;
    expect(releaseRows.length).toBe(0);

    // The milestone/deal must NOT be advanced as though settlement succeeded.
    const [milestone] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(milestone.status).not.toBe("accepted");

    // The payment intent must stay exactly as the refund left it.
    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${intentRow.id}`;
    expect(intent.status).toBe("refunded");
  });
});
