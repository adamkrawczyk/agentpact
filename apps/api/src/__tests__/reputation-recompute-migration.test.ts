import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";

// Migration 054: snapshot agents.reputation_score once, then recompute it from
// capital_at_risk deals + their feedback with the same SQL function the
// runtime helper (shared/reputation.ts creditReputation) uses.

const MIGRATION = readFileSync(resolve(__dirname, "../../../../migrations/054_reputation_recompute.sql"), "utf8");

type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let sql: Sql;

const W = (n: number) => `0x${String(n).repeat(40)}`;

async function mkAgent(wallet: string | null, score: number, internal = false): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal, reputation_score)
    VALUES (${id}, ${"m054-" + id.slice(0, 8)}, 'm054', ${wallet}, 'metamask', ${internal}, ${score})`;
  return id;
}

async function mkDeal(buyerId: string, sellerId: string, total: number, status: string, funded: boolean): Promise<string> {
  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"m054 offer " + randomUUID().slice(0, 8)}, 'm054 offer body', 'development', ${total || 1}, 20, 'active') RETURNING id`;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, 'm054 need', 'm054 need body', 'development', 'open') RETURNING id`;
  const [d] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, is_free_tier)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${status}, ${total}, 'USDC', 20, ${total === 0}) RETURNING id`;
  if (funded) {
    const [m] = await sql`INSERT INTO milestones (deal_id, idx, title, amount, currency, status) VALUES (${d.id}, 1, 'm', ${total}, 'USDC', 'accepted') RETURNING id`;
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m.id}, ${buyerId}, ${sellerId}, ${total}, 'released', ${W(1)}, ${W(2)}, ${W(2)})`;
  }
  return String(d.id);
}

async function feedback(dealId: string, from: string, to: string, r: number) {
  await sql`
    INSERT INTO feedback (deal_id, from_agent_id, to_agent_id, rating_quality, rating_timeliness, rating_communication, rating_accuracy)
    VALUES (${dealId}, ${from}, ${to}, ${r}, ${r}, ${r}, ${r})`;
}

async function score(id: string): Promise<number> {
  const [a] = await sql`SELECT reputation_score FROM agents WHERE id = ${id}`;
  return Number(a.reputation_score);
}

describe("migration 054_reputation_recompute", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();

    ids.farmer = await mkAgent(W(7), 9.5);         // self + same-owner + free farm
    ids.farmTwin = await mkAgent(W(7), 3);
    ids.honest = await mkAgent(W(2), 1.25);        // real seller
    ids.buyerA = await mkAgent(W(3), 4);
    ids.buyerB = await mkAgent(W(4), 0);
    ids.fleet = await mkAgent(W(5), 2, true);      // internal buyer
    ids.capped = await mkAgent(W(6), 0);           // many paid deals → cap

    // Farmer: self deals, same-owner deals, $0 deals — none count.
    for (let i = 0; i < 3; i++) {
      await mkDeal(ids.farmer, ids.farmer, 10, "completed", true);
      const so = await mkDeal(ids.farmTwin, ids.farmer, 10, "completed", true);
      await feedback(so, ids.farmTwin, ids.farmer, 5);
      await mkDeal(ids.buyerA, ids.farmer, 0, "completed", false);
    }

    // Honest seller:
    //  d1 completed, funded, no rating            → 5/10   = 0.5
    //  d2 completed, funded, buyer feedback 3     → 3/10   = 0.3
    //  d3 completed, funded, confirm rating 4      → 4/10   = 0.4 (audit_log, JSON-string row)
    //  d3b completed, funded, close rating 2       → 2/10   = 0.2 (audit_log, JSON-object row)
    //  d4 completed but UNFUNDED                   → 0
    //  d5 funded but still active                  → 0
    //  d6 completed, funded, internal buyer        → 0
    await mkDeal(ids.buyerA, ids.honest, 10, "completed", true);
    const d2 = await mkDeal(ids.buyerB, ids.honest, 20, "completed", true);
    await feedback(d2, ids.buyerB, ids.honest, 3);
    const d3 = await mkDeal(ids.buyerA, ids.honest, 15, "completed", true);
    await sql`
      INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, payload_json)
      VALUES (${ids.buyerA}, 'deal.buyer_review', 'deal', ${d3}, ${JSON.stringify({ dealId: d3, rating: 4 })}::jsonb)`;
    // The same review stored as a plain JSON object (not double-encoded) reads the same way.
    const d3b = await mkDeal(ids.buyerB, ids.honest, 15, "completed", true);
    await sql`
      INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, payload_json)
      VALUES (${ids.buyerB}, 'deal.close', 'deal', ${d3b}, ${sql.json({ dealId: d3b, rating: 2 })})`;
    await mkDeal(ids.buyerB, ids.honest, 10, "completed", false);
    await mkDeal(ids.buyerB, ids.honest, 10, "active", true);
    await mkDeal(ids.fleet, ids.honest, 10, "completed", true);
    // Seller → buyer feedback does not give the buyer reputation (they sold nothing).
    await feedback(d2, ids.honest, ids.buyerB, 5);

    for (let i = 0; i < 25; i++) {
      const b = await mkAgent(`0x${(100 + i).toString(16).padStart(40, "a")}`, 0);
      await mkDeal(b, ids.capped, 5, "completed", true);
    }

    // A pre-existing snapshot row must never be overwritten.
    await sql`DELETE FROM agents_reputation_backup_20261007 WHERE agent_id = ANY(${Object.values(ids)}::uuid[])`;
    await sql`INSERT INTO agents_reputation_backup_20261007 (agent_id, reputation_score, snapshot_at) VALUES (${ids.buyerA}, 7.777, '2026-01-01')`;

    await sql.unsafe(MIGRATION);
  });

  it("snapshots the pre-recompute scores (and keeps an existing snapshot row)", async () => {
    const rows = await sql`SELECT agent_id, reputation_score, snapshot_at FROM agents_reputation_backup_20261007 WHERE agent_id = ANY(${Object.values(ids)}::uuid[])`;
    const by = new Map(rows.map((r) => [String(r.agent_id), Number(r.reputation_score)]));
    expect(by.get(ids.farmer)).toBe(9.5);
    expect(by.get(ids.farmTwin)).toBe(3);
    expect(by.get(ids.honest)).toBe(1.25);
    expect(by.get(ids.fleet)).toBe(2);
    expect(by.get(ids.buyerA)).toBe(7.777);
  });

  it("recomputes from capital_at_risk deals + their feedback only", async () => {
    expect(await score(ids.farmer)).toBe(0);
    expect(await score(ids.farmTwin)).toBe(0);
    expect(await score(ids.honest)).toBeCloseTo(1.4, 3);
    expect(await score(ids.buyerA)).toBe(0);
    expect(await score(ids.buyerB)).toBe(0);
    expect(await score(ids.fleet)).toBe(0);
    expect(await score(ids.capped)).toBe(9.999);
  });

  it("the runtime formula and the migration agree (ap_reputation_score)", async () => {
    for (const id of Object.values(ids)) {
      const [r] = await sql`SELECT ap_reputation_score(${id}::uuid) AS s`;
      expect(Number(r.s)).toBe(await score(id));
    }
  });

  it("re-applying is idempotent and never overwrites the snapshot", async () => {
    await sql`UPDATE agents SET reputation_score = 4.2 WHERE id = ${ids.honest}`;
    await sql.unsafe(MIGRATION);
    expect(await score(ids.honest)).toBeCloseTo(1.4, 3);
    const [snap] = await sql`SELECT reputation_score FROM agents_reputation_backup_20261007 WHERE agent_id = ${ids.honest}`;
    expect(Number(snap.reputation_score)).toBe(1.25);
    const [n] = await sql`SELECT COUNT(*)::int AS n FROM agents_reputation_backup_20261007 WHERE agent_id = ${ids.honest}`;
    expect(n.n).toBe(1);
  });
});
