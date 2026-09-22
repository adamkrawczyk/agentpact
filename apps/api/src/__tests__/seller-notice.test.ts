import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";
import {
  buildNoticePayload,
  CAMPAIGN_ID,
  CHANNEL,
  EVENT_TYPE,
  selectTopSellers,
  sendNotices,
} from "../../../../scripts/seller-notice.js";

// moneypath_0920 §3 M1 "the ask": top-20 seller Verified-Seller notice.
// Pins (1) the selection query — completed, NON-SELF deals in the window,
// ranked desc; (2) dry-run purity — selecting writes nothing; (3) --send logs
// one seller_notices row per recipient and calls the webhook path exactly
// once per recipient; (4) idempotency — a second --send skips everyone.
// notifyAgents is injected as a spy: nothing leaves the process in tests.

async function makeAgent(handle: string): Promise<string> {
  const { app } = await createTestApp();
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id);
  const res = await app.inject({ method: "POST", url: "/api/agents", headers, payload: generateTestAgent({ handle }) });
  expect(res.statusCode).toBe(200);
  return id;
}

async function seedDeal(sellerId: string, buyerId: string, status: string, daysAgo = 1): Promise<void> {
  const { app, sql } = await createTestApp();
  const sellerHeaders = await getAuthHeadersForAgent(sellerId);
  const buyerHeaders = await getAuthHeadersForAgent(buyerId);
  const offerRes = await app.inject({ method: "POST", url: "/api/offers", headers: sellerHeaders, payload: generateTestOffer(sellerId) });
  expect(offerRes.statusCode).toBe(201);
  const offerId = (JSON.parse(offerRes.body) as { id: string }).id;
  const needRes = await app.inject({ method: "POST", url: "/api/needs", headers: buyerHeaders, payload: generateTestNeed(buyerId) });
  expect(needRes.statusCode).toBe(201);
  const needId = (JSON.parse(needRes.body) as { id: string }).id;
  await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days, is_free_tier, updated_at)
    VALUES (${buyerId}, ${sellerId}, ${offerId}, ${needId}, ${status}, 10, 'USDC', 10, 7, false, NOW() - (${daysAgo}::int * INTERVAL '1 day'))
  `;
}

describe("scripts/seller-notice.ts", () => {
  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
  });

  it("selects sellers by completed non-self deals in the window, ranked desc, capped by limit", async () => {
    const { sql } = await createTestApp();
    const buyer = await makeAgent("buyer-x");
    const top = await makeAgent("seller-top");
    const mid = await makeAgent("seller-mid");
    const selfDealer = await makeAgent("seller-self");
    const stale = await makeAgent("seller-stale");
    const unfinished = await makeAgent("seller-unfinished");

    await seedDeal(top, buyer, "completed");
    await seedDeal(top, buyer, "completed");
    await seedDeal(top, buyer, "completed");
    await seedDeal(mid, buyer, "completed");
    await seedDeal(selfDealer, selfDealer, "completed"); // self-deal: excluded
    await seedDeal(selfDealer, selfDealer, "completed");
    await seedDeal(stale, buyer, "completed", 120);      // outside 90d window
    await seedDeal(unfinished, buyer, "delivered");      // not completed

    const sellers = await selectTopSellers(sql, { limit: 20, windowDays: 90 });
    expect(sellers.map((s) => s.handle)).toEqual(["seller-top", "seller-mid"]);
    expect(sellers[0].completed_deals).toBe(3);
    expect(sellers[1].completed_deals).toBe(1);
    expect(sellers[0].has_webhook).toBe(false);

    const capped = await selectTopSellers(sql, { limit: 1, windowDays: 90 });
    expect(capped.map((s) => s.handle)).toEqual(["seller-top"]);

    // Selecting is read-only: no notice rows, no notification_log rows.
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM seller_notices`;
    expect(n).toBe(0);
  });

  it("has_webhook reflects an active subscription to seller.verified_offer", async () => {
    const { app, sql } = await createTestApp();
    const buyer = await makeAgent("buyer-y");
    const seller = await makeAgent("seller-hooked");
    await seedDeal(seller, buyer, "completed");
    const headers = await getAuthHeadersForAgent(seller);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers,
      payload: { url: "https://webhook.test/seller", events: [EVENT_TYPE] },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await selectTopSellers(sql, { limit: 20 });
    expect(row.has_webhook).toBe(true);
  });

  it("buildNoticePayload is claim-grounded and carries the campaign id + links", () => {
    const payload = buildNoticePayload({ agent_id: "00000000-0000-0000-0000-000000000001", handle: "acme", completed_deals: 4 });
    expect(payload.campaign_id).toBe(CAMPAIGN_ID);
    expect(payload.price_usd).toBe(19);
    expect(payload.verified_seller_url).toBe("https://agentpact.xyz/verified");
    expect(payload.skill_url).toBe("https://agentpact.xyz/skill");
    expect(payload.message).toContain("$19 one-time");
    expect(payload.message).toContain("https://agentpact.xyz/skill");
    expect(payload.message).toContain("4 deal(s)");
    expect(payload.message).toContain("agentpact.xyz/verified");
  });

  it("sendNotices logs one seller_notices row per recipient, notifies once each, and is idempotent", async () => {
    const { sql } = await createTestApp();
    const buyer = await makeAgent("buyer-z");
    const a = await makeAgent("seller-a");
    const b = await makeAgent("seller-b");
    await seedDeal(a, buyer, "completed");
    await seedDeal(b, buyer, "completed");

    const sellers = await selectTopSellers(sql, { limit: 20 });
    expect(sellers).toHaveLength(2);

    const notify = vi.fn();
    const first = await sendNotices(sql, sellers, notify);
    expect(first.sent.sort()).toEqual([a, b].sort());
    expect(first.skipped).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(2);
    for (const call of notify.mock.calls) {
      expect(call[1]).toHaveLength(1);
      expect(call[2]).toBe(EVENT_TYPE);
      expect((call[3] as { campaign_id: string }).campaign_id).toBe(CAMPAIGN_ID);
    }

    const rows = await sql`SELECT agent_id, campaign_id, channel, event_type, sent_at FROM seller_notices ORDER BY sent_at`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.campaign_id === CAMPAIGN_ID && r.channel === CHANNEL && r.event_type === EVENT_TYPE)).toBe(true);

    // Second run: nothing new sent, nobody double-notified.
    notify.mockClear();
    const second = await sendNotices(sql, sellers, notify);
    expect(second.sent).toEqual([]);
    expect(second.skipped.sort()).toEqual([a, b].sort());
    expect(notify).not.toHaveBeenCalled();
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM seller_notices`;
    expect(n).toBe(2);
  });
});
