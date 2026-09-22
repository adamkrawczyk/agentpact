/**
 * deal.delivered buyer notification (moneypath M1 remainder).
 *
 * Ground truth: POST /api/deliveries/submit flipped the deal to 'delivered'
 * and told NOBODY. The buyer's acceptance window (acceptance_timeout_days —
 * after which the settlement sweeper may auto-complete and release escrow)
 * started running with no signal to the buyer that it had. Meanwhile
 * docs/agent-integration-guide.md already advertised `deal.delivered` as a
 * subscribable event. This test makes that claim true.
 *
 * CONTRACT under test:
 *  1. Submitting a delivery emits `deal.delivered` to the BUYER's webhook.
 *  2. The payload carries dealId, fulfillmentType, an artifact summary with
 *     the manifest sha256, and acceptanceDeadline = updated_at +
 *     acceptance_timeout_days.
 *  3. The SELLER does not receive it (buyer-only).
 *  4. `deal.delivered` is a valid subscription value on POST /api/webhooks.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

async function waitForNotification(eventType: string, agentId: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  const { sql } = await createTestApp();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await sql`
      SELECT id, event_type, agent_id, payload_json
      FROM notification_log
      WHERE event_type = ${eventType} AND agent_id = ${agentId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0] as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

describe("deal.delivered — buyer notification on delivery submission", () => {
  const originalFetch = globalThis.fetch;
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;

  beforeAll(() => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  afterAll(() => { globalThis.fetch = originalFetch; });

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
    sellerHeaders = await getAuthHeadersForAgent(sellerId);
  });

  async function setupDeliverableDeal(acceptanceTimeoutDays: number) {
    const { app, sql } = await createTestApp();

    for (const [headers, url] of [[buyerHeaders, "https://webhook.test/buyer"], [sellerHeaders, "https://webhook.test/seller"]] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks",
        headers,
        payload: { url, events: ["deal.delivered"] },
      });
      expect(res.statusCode).toBe(201);
    }

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: { ...generateTestOffer(sellerId), basePrice: 0, fulfillmentType: "generic" },
    });
    expect(offerRes.statusCode).toBe(201);
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

    const needRes = await app.inject({ method: "POST", url: "/api/needs", headers: buyerHeaders, payload: generateTestNeed(buyerId) });
    expect(needRes.statusCode).toBe(201);
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    // Zero-price so delivery needs no funding (issue #134 guard exempts it).
    const proposeRes = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 0,
        maxPriceDeltaPct: 20,
        acceptanceTimeoutDays,
        milestones: [{ idx: 1, title: "Delivery", amount: 0, acceptanceCriteria: ["Done"] }],
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

    const [milestone] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId} ORDER BY idx LIMIT 1`;
    return { app, sql, dealId, milestoneId: milestone.id as string };
  }

  it("emits deal.delivered to the buyer with artifact sha256 and acceptanceDeadline = updated_at + acceptance_timeout_days", async () => {
    const { app, sql, dealId, milestoneId } = await setupDeliverableDeal(3);
    const artifacts = [{ type: "url", url: "https://example.com/report.pdf" }];

    const res = await app.inject({
      method: "POST",
      url: "/api/deliveries/submit",
      headers: sellerHeaders,
      payload: { milestoneId, submittedBy: sellerId, artifacts, notes: "done" },
    });
    expect(res.statusCode).toBe(201);

    const note = await waitForNotification("deal.delivered", buyerId);
    expect(note, "buyer must receive deal.delivered").not.toBeNull();

    const raw = note!.payload_json;
    const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as { event: string; payload: Record<string, unknown> };
    expect(body.event).toBe("deal.delivered");
    const p = body.payload;
    expect(p.dealId).toBe(dealId);
    expect(p.milestoneId).toBe(milestoneId);
    expect(p.revision).toBe(1);
    expect(p.sellerAgentId).toBe(sellerId);
    expect(p.fulfillmentType).toBe("generic");
    expect(p.acceptanceTimeoutDays).toBe(3);
    expect(p.artifacts).toEqual({
      count: 1,
      sha256: createHash("sha256").update(JSON.stringify(artifacts)).digest("hex"),
    });

    const [deal] = await sql<Array<{ status: string; updated_at: Date }>>`SELECT status, updated_at FROM deals WHERE id = ${dealId}`;
    expect(deal.status).toBe("delivered");
    const expectedDeadline = new Date(new Date(deal.updated_at).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(p.acceptanceDeadline).toBe(expectedDeadline);
  });

  it("does NOT emit deal.delivered to the seller (buyer-only signal)", async () => {
    const { app, milestoneId } = await setupDeliverableDeal(1);
    const res = await app.inject({
      method: "POST",
      url: "/api/deliveries/submit",
      headers: sellerHeaders,
      payload: { milestoneId, submittedBy: sellerId, artifacts: [{ type: "url", url: "https://example.com/a" }] },
    });
    expect(res.statusCode).toBe(201);

    expect(await waitForNotification("deal.delivered", buyerId)).not.toBeNull();
    expect(await waitForNotification("deal.delivered", sellerId, 500)).toBeNull();
  });

  it("rejects a subscription to an unknown event but accepts deal.delivered", async () => {
    const { app } = await createTestApp();
    const bad = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: buyerHeaders,
      payload: { url: "https://webhook.test/x", events: ["deal.not_a_thing"] },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: buyerHeaders,
      payload: { url: "https://webhook.test/x", events: ["deal.delivered"] },
    });
    expect(good.statusCode).toBe(201);
  });
});
