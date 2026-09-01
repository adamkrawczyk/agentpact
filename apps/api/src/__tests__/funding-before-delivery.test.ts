/**
 * funding-before-delivery guard (issue #134).
 *
 * Ground truth (observed live 2026-09-01, fleet-buyer campaign): a seller
 * could POST /api/deliveries/submit against a PAID milestone that was never
 * funded. The submission flipped milestones.status to 'delivered', after
 * which POST /api/payments/create-intent rejects with "Milestone status
 * delivered cannot be funded" (payments.ts). The buyer could then no longer
 * fund through the API at all — a permanent deadlock (2 of 3 acceptors hit
 * it). The workaround (reconstruct calldata client-side, broadcast directly)
 * leaves payment_intents permanently out of sync with the chain.
 *
 * CONTRACT under test:
 *  1. Delivery on a paid, unfunded milestone → 409 MILESTONE_NOT_FUNDED,
 *     and the milestone must NOT flip to 'delivered'.
 *  2. After the buyer funds (create-intent, simulation mode), delivery
 *     succeeds — the flow is recoverable, not deadlocked.
 *  3. Free-tier / zero-price milestones are exempt: no funding is possible
 *     or required, delivery must work unfunded.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("funding-before-delivery guard (issue #134)", () => {
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);
  });

  async function setupAcceptedDeal(opts: { paid: boolean }) {
    const { app, sql } = await createTestApp();

    const offerPayload = generateTestOffer(sellerId);
    if (!opts.paid) {
      offerPayload.basePrice = 0;
    }
    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: offerPayload,
    });
    expect(offerRes.statusCode).toBe(201);
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    expect(needRes.statusCode).toBe(201);
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    const proposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: opts.paid ? 120 : 0,
        maxPriceDeltaPct: 20,
        milestones: [{
          idx: 1,
          title: "Delivery",
          amount: opts.paid ? 120 : 0,
          acceptanceCriteria: ["Done"],
        }],
      },
    });
    expect(proposeRes.statusCode).toBe(201);
    const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);

    const [milestone] = await sql`SELECT id, status FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    return { app, sql, dealId, milestoneId: milestone.id as string };
  }

  function submitDelivery(app: Awaited<ReturnType<typeof createTestApp>>["app"], milestoneId: string) {
    return app.inject({
      method: "POST",
      url: "/api/deliveries/submit",
      headers: sellerHeaders,
      payload: {
        milestoneId,
        submittedBy: sellerId,
        artifacts: [{ type: "url", url: "https://example.com/artifact" }],
        notes: "guard test",
      },
    });
  }

  async function fundMilestone(app: Awaited<ReturnType<typeof createTestApp>>["app"], milestoneId: string) {
    // Simulation mode (no PLATFORM_PRIVATE_KEY in tests): create-intent funds
    // the milestone immediately and records a 'funded' payment_intent.
    const res = await app.inject({
      method: "POST",
      url: "/api/payments/create-intent",
      headers: buyerHeaders,
      payload: {
        provider: "usdc",
        milestoneId,
        buyerAgentId: buyerId,
        walletProvider: "metamask",
        buyerWalletAddress: "0x1234567890123456789012345678901234567890",
        chain: "base",
      },
    });
    expect(res.statusCode).toBe(201);
  }

  it("RED: rejects delivery on a paid unfunded milestone and does NOT flip it to delivered", async () => {
    const { app, sql, milestoneId } = await setupAcceptedDeal({ paid: true });

    const res = await submitDelivery(app, milestoneId);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { code?: string; error?: string };
    expect(body.code).toBe("MILESTONE_NOT_FUNDED");

    // The deadlock precondition must not be created: milestone stays fundable.
    const [m] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(String(m.status)).not.toBe("delivered");

    // And the buyer can still fund it afterwards — the API path is not dead.
    await fundMilestone(app, milestoneId);
    const [pi] = await sql`SELECT status FROM payment_intents WHERE milestone_id = ${milestoneId}`;
    expect(String(pi.status)).toBe("funded");
  });

  it("allows delivery after the buyer funds the milestone (no deadlock)", async () => {
    const { app, sql, milestoneId } = await setupAcceptedDeal({ paid: true });

    await fundMilestone(app, milestoneId);

    const res = await submitDelivery(app, milestoneId);
    expect(res.statusCode).toBe(201);

    const [m] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(String(m.status)).toBe("delivered");
  });

  it("keeps already-released milestones deliverable (idempotent re-submission path)", async () => {
    const { app, sql, milestoneId } = await setupAcceptedDeal({ paid: true });

    // Simulate a settled milestone: funded then released intent.
    await fundMilestone(app, milestoneId);
    await sql`UPDATE payment_intents SET status = 'released' WHERE milestone_id = ${milestoneId}`;

    const res = await submitDelivery(app, milestoneId);
    expect(res.statusCode).toBe(201);
  });

  it("exempts free-tier / zero-price milestones (no funding involved)", async () => {
    const { app, sql, dealId, milestoneId } = await setupAcceptedDeal({ paid: false });

    const [dealRow] = await sql`SELECT is_free_tier FROM deals WHERE id = ${dealId}`;
    expect(Boolean(dealRow.is_free_tier)).toBe(true);

    const res = await submitDelivery(app, milestoneId);
    expect(res.statusCode).toBe(201);
  });
});
