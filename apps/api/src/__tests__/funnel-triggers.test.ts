import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";

// honest_0710 phase D — funnel_events are written by Postgres triggers on the
// state tables (no route edits). Each stage fires once per deal on its
// transition, never on a no-op update, and a trigger failure never fails the
// parent write.

type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];

const wallet = () => `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function mkAgent(sql: Sql, opts: { internal?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal)
    VALUES (${id}, ${"f-" + id.slice(0, 8)}, 'funnel', ${wallet()}, 'metamask', ${opts.internal ?? false})`;
  return id;
}

async function mkNeedOffer(sql: Sql, buyer: string, seller: string): Promise<{ needId: string; offerId: string }> {
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category)
    VALUES (${buyer}, 'need', 'need', 'Testing') RETURNING id`;
  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price)
    VALUES (${seller}, ${"offer " + randomUUID().slice(0, 8)}, 'offer', 'Testing', 10) RETURNING id`;
  return { needId: String(need.id), offerId: String(offer.id) };
}

async function mkDeal(sql: Sql, buyer: string, seller: string, status = "proposed"): Promise<{ dealId: string; needId: string }> {
  const { needId, offerId } = await mkNeedOffer(sql, buyer, seller);
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct)
    VALUES (${buyer}, ${seller}, ${offerId}, ${needId}, ${status}, 10, 'USDC', 10) RETURNING id`;
  return { dealId: String(deal.id), needId };
}

async function mkPaymentIntent(sql: Sql, dealId: string, buyer: string, seller: string): Promise<string> {
  const [m] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount) VALUES (${dealId}, 0, 'm0', 10) RETURNING id`;
  const [pi] = await sql`
    INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, platform_wallet_address)
    VALUES (${m.id}, ${buyer}, ${seller}, 10, ${wallet()}) RETURNING id`;
  return String(pi.id);
}

async function stages(sql: Sql, dealId: string): Promise<Record<string, number>> {
  const rows = await sql`SELECT stage, COUNT(*)::int AS n FROM funnel_events WHERE deal_id = ${dealId} GROUP BY stage`;
  return Object.fromEntries(rows.map((r) => [String(r.stage), Number(r.n)]));
}

describe("funnel_events triggers", () => {
  let sql: Sql;
  beforeEach(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
    await sql`TRUNCATE funnel_events`;
  });

  it("need_posted fires once on INSERT INTO needs, attributed to the poster", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { needId } = await mkNeedOffer(sql, buyer, seller);
    await sql`UPDATE needs SET status = 'open', title = 'x' WHERE id = ${needId}`;
    const rows = await sql`SELECT stage, agent_id, deal_id FROM funnel_events WHERE need_id = ${needId}`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ stage: "need_posted", agent_id: buyer, deal_id: null }]);
  });

  it("legacy deal lifecycle: each stage exactly once, never on no-op updates", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { dealId, needId } = await mkDeal(sql, buyer, seller);
    expect(await stages(sql, dealId)).toEqual({ proposed: 1 });
    const [proposed] = await sql`SELECT need_id, agent_id, counterparty_agent_id FROM funnel_events WHERE deal_id = ${dealId}`;
    expect({ ...proposed }).toEqual({ need_id: needId, agent_id: buyer, counterparty_agent_id: seller });

    // No-op updates: same status, other column.
    await sql`UPDATE deals SET status = 'proposed' WHERE id = ${dealId}`;
    await sql`UPDATE deals SET negotiated_total = 11 WHERE id = ${dealId}`;
    expect(await stages(sql, dealId)).toEqual({ proposed: 1 });

    await sql`UPDATE deals SET status = 'accepted' WHERE id = ${dealId}`;
    await sql`UPDATE deals SET status = 'accepted' WHERE id = ${dealId}`;
    expect(await stages(sql, dealId)).toEqual({ proposed: 1, accepted: 1 });

    const piId = await mkPaymentIntent(sql, dealId, buyer, seller);
    await sql`UPDATE payment_intents SET status = 'funded' WHERE id = ${piId}`;
    await sql`UPDATE payment_intents SET status = 'funded' WHERE id = ${piId}`;
    // The deal status following the money must not double count.
    await sql`UPDATE deals SET status = 'funded' WHERE id = ${dealId}`;
    expect(await stages(sql, dealId)).toEqual({ proposed: 1, accepted: 1, funded: 1 });

    await sql`UPDATE milestones SET status = 'delivered' WHERE deal_id = ${dealId}`;
    await sql`UPDATE deals SET status = 'delivered' WHERE id = ${dealId}`;
    expect((await stages(sql, dealId)).delivered).toBe(1);

    await sql`UPDATE milestones SET status = 'accepted' WHERE deal_id = ${dealId}`;
    await sql`UPDATE payment_intents SET status = 'released' WHERE id = ${piId}`;
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${dealId}`;
    expect(await stages(sql, dealId)).toEqual({
      proposed: 1, accepted: 1, funded: 1, delivered: 1, accepted_delivery: 1, settled: 1,
    });
  });

  it("R1-08: one released milestone does not settle a deal with an unfunded sibling", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { dealId } = await mkDeal(sql, buyer, seller, "active");
    const pi1 = await mkPaymentIntent(sql, dealId, buyer, seller);
    const [m2] = await sql`INSERT INTO milestones (deal_id, idx, title, amount) VALUES (${dealId}, 1, 'm1', 5) RETURNING id`;
    await sql`UPDATE payment_intents SET status = 'funded' WHERE id = ${pi1}`;
    await sql`UPDATE payment_intents SET status = 'released' WHERE id = ${pi1}`;
    expect((await stages(sql, dealId)).settled).toBeUndefined();

    // The last milestone's release settles the deal (once), even before the
    // deal row itself flips to completed.
    const [pi2] = await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, platform_wallet_address)
      VALUES (${m2.id}, ${buyer}, ${seller}, 5, 'funded', ${wallet()}) RETURNING id`;
    await sql`UPDATE payment_intents SET status = 'released' WHERE id = ${pi2.id}`;
    expect((await stages(sql, dealId)).settled).toBe(1);
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${dealId}`;
    expect((await stages(sql, dealId)).settled).toBe(1);
  });

  it("R1-08: a completed deal is settled even when its milestones carry no payment intents ($0 / legacy)", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { dealId } = await mkDeal(sql, buyer, seller, "active");
    await sql`INSERT INTO milestones (deal_id, idx, title, amount) VALUES (${dealId}, 0, 'm0', 0)`;
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${dealId}`;
    expect((await stages(sql, dealId)).settled).toBe(1);
  });

  it("disputed and refunded fire from payment_intents", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { dealId } = await mkDeal(sql, buyer, seller, "accepted");
    expect(await stages(sql, dealId)).toEqual({ proposed: 1, accepted: 1 });
    const piId = await mkPaymentIntent(sql, dealId, buyer, seller);
    await sql`UPDATE payment_intents SET status = 'funded' WHERE id = ${piId}`;
    await sql`UPDATE payment_intents SET status = 'disputed' WHERE id = ${piId}`;
    await sql`UPDATE deals SET status = 'disputed' WHERE id = ${dealId}`;
    await sql`UPDATE payment_intents SET status = 'refunded' WHERE id = ${piId}`;
    expect(await stages(sql, dealId)).toEqual({ proposed: 1, accepted: 1, funded: 1, disputed: 1, refunded: 1 });
  });

  it("on-chain intents: awaiting_funding → open is funded; claimed is settled", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { dealId } = await mkDeal(sql, buyer, seller, "accepted");
    const [intent] = await sql`
      INSERT INTO intents (buyer_agent_id, seller_agent_id, settlement_class, predicate_type, predicate_params,
                           max_price_usdc, status, expires_at, deal_id)
      VALUES (${buyer}, ${seller}, 'A', 'hash_preimage', '{}'::jsonb, 10, 'awaiting_funding', NOW() + INTERVAL '1 day', ${dealId})
      RETURNING id`;
    expect((await stages(sql, dealId)).funded).toBeUndefined();
    await sql`UPDATE intents SET status = 'open' WHERE id = ${intent.id}`;
    await sql`UPDATE intents SET status = 'delivered' WHERE id = ${intent.id}`;
    await sql`UPDATE intents SET status = 'reveal_ready' WHERE id = ${intent.id}`;
    await sql`UPDATE intents SET status = 'claimed' WHERE id = ${intent.id}`;
    expect(await stages(sql, dealId)).toEqual({ proposed: 1, accepted: 1, funded: 1, delivered: 1, settled: 1 });
  });

  it("reorder fires for a new deal when the buyer already completed a deal with the same seller", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const other = await mkAgent(sql);
    const first = await mkDeal(sql, buyer, seller);
    // An open (not completed) prior deal is not a reorder.
    const second = await mkDeal(sql, buyer, seller);
    expect((await stages(sql, second.dealId)).reorder).toBeUndefined();

    await sql`UPDATE deals SET status = 'completed' WHERE id = ${first.dealId}`;
    const third = await mkDeal(sql, buyer, seller);
    const unrelated = await mkDeal(sql, buyer, other);
    expect(await stages(sql, third.dealId)).toEqual({ proposed: 1, reorder: 1 });
    expect((await stages(sql, unrelated.dealId)).reorder).toBeUndefined();
    expect((await stages(sql, first.dealId)).reorder).toBeUndefined();
  });

  it("a trigger failure never fails the parent write", async () => {
    const buyer = await mkAgent(sql);
    const seller = await mkAgent(sql);
    const { dealId } = await mkDeal(sql, buyer, seller);
    await sql`ALTER TABLE funnel_events ADD CONSTRAINT funnel_events_test_block CHECK (false) NOT VALID`;
    try {
      await sql`UPDATE deals SET status = 'accepted' WHERE id = ${dealId}`;
      const after = await mkDeal(sql, buyer, seller);
      const [row] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
      expect(row.status).toBe("accepted");
      expect(await stages(sql, after.dealId)).toEqual({});
    } finally {
      await sql`ALTER TABLE funnel_events DROP CONSTRAINT IF EXISTS funnel_events_test_block`;
    }
    expect(await stages(sql, dealId)).toEqual({ proposed: 1 });
  });
});
