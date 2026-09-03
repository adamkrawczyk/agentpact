import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

/**
 * Delivery-revision primitive: reject → fix → resubmit.
 *
 * Covers:
 *  - revision auto-increments per milestone (1, 2, ...)
 *  - buyer reject reopens the milestone (in_progress) and keeps history
 *  - seller resubmits, buyer accepts revision 2
 *  - max_revisions cap returns 409 MAX_REVISIONS_EXCEEDED
 */
describe("delivery revisions (reject → resubmit loop)", () => {
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

  async function setupAcceptedDeal(maxRevisions?: number) {
    const { app, sql } = await createTestApp();

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
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
        negotiatedTotal: 120,
        maxPriceDeltaPct: 10,
        milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }],
        ...(maxRevisions ? { maxRevisions } : {}),
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

    // issue #134 guard: delivery on a paid unfunded milestone is now a 409.
    // Fund the milestone first so the reject → resubmit loop stays valid.
    const [milestoneToFund] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    if (!milestoneToFund.is_free_tier) {
      const fundRes = await app.inject({
        method: "POST",
        url: "/api/payments/create-intent",
        headers: buyerHeaders,
        payload: {
          provider: "usdc",
          milestoneId: milestoneToFund.id as string,
          buyerAgentId: buyerId,
          walletProvider: "metamask",
          buyerWalletAddress: "0x1234567890123456789012345678901234567890",
          chain: "base",
        },
      });
      expect(fundRes.statusCode).toBe(201);
    }

    const [milestone] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    return { app, sql, dealId, milestoneId: milestone.id as string };
  }

  function submitDelivery(app: Awaited<ReturnType<typeof createTestApp>>["app"], milestoneId: string, note: string) {
    return app.inject({
      method: "POST",
      url: "/api/deliveries/submit",
      headers: sellerHeaders,
      payload: {
        milestoneId,
        submittedBy: sellerId,
        artifacts: [{ type: "url", url: `https://example.com/artifact-${note}` }],
        notes: note,
      },
    });
  }

  function verifyDelivery(app: Awaited<ReturnType<typeof createTestApp>>["app"], milestoneId: string, accepted: boolean, notes: string) {
    return app.inject({
      method: "POST",
      url: "/api/deliveries/verify",
      headers: buyerHeaders,
      payload: { milestoneId, buyerAgentId: buyerId, accepted, verificationNotes: notes },
    });
  }

  it("runs the full reject → resubmit → accept loop with revision tracking", async () => {
    const { app, sql, milestoneId } = await setupAcceptedDeal();

    // Revision 1: seller submits
    const sub1 = await submitDelivery(app, milestoneId, "first-attempt");
    expect(sub1.statusCode).toBe(201);
    expect((JSON.parse(sub1.body) as { revision: number }).revision).toBe(1);

    // Buyer rejects with feedback
    const rej = await verifyDelivery(app, milestoneId, false, "CSV missing header row — fix and resubmit");
    expect(rej.statusCode).toBe(200);
    expect((JSON.parse(rej.body) as { accepted: boolean }).accepted).toBe(false);

    // Milestone reopened for the seller
    const [m1] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(m1.status).toBe("in_progress");

    // Rejected delivery is kept as history
    const [d1] = await sql`SELECT status, revision FROM deliveries WHERE milestone_id = ${milestoneId} AND revision = 1`;
    expect(d1.status).toBe("rejected");

    // Revision 2: seller fixes and resubmits
    const sub2 = await submitDelivery(app, milestoneId, "second-attempt-fixed");
    expect(sub2.statusCode).toBe(201);
    expect((JSON.parse(sub2.body) as { revision: number }).revision).toBe(2);

    // Buyer accepts revision 2
    const acc = await verifyDelivery(app, milestoneId, true, "Fixed — accepted");
    expect(acc.statusCode).toBe(200);

    const [d2] = await sql`SELECT status FROM deliveries WHERE milestone_id = ${milestoneId} AND revision = 2`;
    expect(d2.status).toBe("verified");

    // Full history preserved: 2 rows
    const rows = await sql`SELECT revision FROM deliveries WHERE milestone_id = ${milestoneId} ORDER BY revision`;
    expect(rows.map((r: { revision: number }) => Number(r.revision))).toEqual([1, 2]);
  });

  it("enforces max_revisions with 409 MAX_REVISIONS_EXCEEDED", async () => {
    const { app, milestoneId } = await setupAcceptedDeal(2);

    const sub1 = await submitDelivery(app, milestoneId, "r1");
    expect(sub1.statusCode).toBe(201);
    await verifyDelivery(app, milestoneId, false, "reject r1");

    const sub2 = await submitDelivery(app, milestoneId, "r2");
    expect(sub2.statusCode).toBe(201);
    await verifyDelivery(app, milestoneId, false, "reject r2");

    const sub3 = await submitDelivery(app, milestoneId, "r3");
    expect(sub3.statusCode).toBe(409);
    const body = JSON.parse(sub3.body) as { code: string; maxRevisions: number };
    expect(body.code).toBe("MAX_REVISIONS_EXCEEDED");
    expect(body.maxRevisions).toBe(2);
  });
});
