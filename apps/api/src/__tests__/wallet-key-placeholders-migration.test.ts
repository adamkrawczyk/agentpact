import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";
import { checkDealParties, resolveSellerPayoutAddress } from "../shared/deal-guards.js";

// Migration 056: precompile-style (0x…0001) and burn (0x…dEaD) owner wallets
// are UNKNOWN owners, and the reputation they inflated is recomputed for the
// affected sellers only.

const MIGRATION = readFileSync(resolve(__dirname, "../../../../migrations/056_wallet_key_placeholders.sql"), "utf8");

// The 052 rule (zero address only), to model a database that predates 056.
const PRE_056_WALLET_KEY = `
CREATE OR REPLACE FUNCTION ap_wallet_key(w TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN w IS NULL THEN NULL
    WHEN btrim(w) ~* '^0x[0-9a-f]{40}$' AND btrim(w) !~* '^0x0{40}$' THEN lower(btrim(w))
    WHEN btrim(w) ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND btrim(w) !~ '^1+$' THEN btrim(w)
    ELSE NULL
  END
$$;`;

const W = (n: number) => `0x${String(n).repeat(40)}`;
const PRECOMPILE = "0x0000000000000000000000000000000000000001";
const BURN = "0x000000000000000000000000000000000000dEaD";

type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let sql: Sql;

async function mkAgent(wallet: string | null, score = 0): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal, reputation_score)
    VALUES (${id}, ${"m056-" + id.slice(0, 8)}, 'm056', ${wallet}, 'metamask', false, ${score})`;
  return id;
}

/** A completed, funded $10 deal. The payment-intent INSERT fires 054's recompute trigger. */
async function mkPaidDeal(buyerId: string, sellerId: string): Promise<string> {
  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"m056 offer " + randomUUID().slice(0, 8)}, 'm056 offer body', 'development', 10, 20, 'active') RETURNING id`;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, 'm056 need', 'm056 need body', 'development', 'open') RETURNING id`;
  const [d] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, is_free_tier)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, 'completed', 10, 'USDC', 20, false) RETURNING id`;
  const [m] = await sql`INSERT INTO milestones (deal_id, idx, title, amount, currency, status) VALUES (${d.id}, 1, 'm', 10, 'USDC', 'accepted') RETURNING id`;
  await sql`
    INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
    VALUES (${m.id}, ${buyerId}, ${sellerId}, 10, 'released', ${W(1)}, ${W(2)}, ${W(2)})`;
  return String(d.id);
}

async function score(id: string): Promise<number> {
  const [a] = await sql`SELECT reputation_score FROM agents WHERE id = ${id}`;
  return Number(a.reputation_score);
}

async function backup(): Promise<Map<string, number>> {
  const rows = await sql`SELECT agent_id, reputation_score FROM agents_reputation_backup_056`;
  return new Map(rows.map((r) => [String(r.agent_id), Number(r.reputation_score)]));
}

describe("migration 056_wallet_key_placeholders", () => {
  const ids: Record<string, string> = {};
  const deals: Record<string, string> = {};

  beforeAll(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
    await sql.unsafe(`${PRE_056_WALLET_KEY} DROP TABLE IF EXISTS agents_reputation_backup_056;`);

    ids.mixed = await mkAgent(W(2));        // one real buyer + one placeholder buyer
    ids.clean = await mkAgent(W(3));        // real buyers only — must not be touched
    ids.burnSeller = await mkAgent(BURN);   // seller on the burn address
    ids.realBuyer = await mkAgent(W(4));
    ids.realBuyer2 = await mkAgent(W(5));
    ids.placeholderBuyer = await mkAgent(PRECOMPILE);

    deals.real = await mkPaidDeal(ids.realBuyer, ids.mixed);
    deals.placeholder = await mkPaidDeal(ids.placeholderBuyer, ids.mixed);
    deals.clean = await mkPaidDeal(ids.realBuyer2, ids.clean);
    deals.burn = await mkPaidDeal(ids.realBuyer, ids.burnSeller);

    // Pre-056 state: the placeholder deals counted as evidence (0.5 each).
    expect(await score(ids.mixed)).toBeCloseTo(1.0, 3);
    expect(await score(ids.burnSeller)).toBeCloseTo(0.5, 3);
    expect(await score(ids.clean)).toBeCloseTo(0.5, 3);

    await sql.unsafe(MIGRATION);
  });

  it("ap_wallet_key treats precompile-style and burn addresses as unknown", async () => {
    const [r] = await sql`
      SELECT ap_wallet_key(${PRECOMPILE}) AS p, ap_wallet_key(${BURN}) AS b,
             ap_wallet_key(${"0x" + "0".repeat(35) + "10000"}) AS near, ap_wallet_key(${W(2)}) AS real`;
    expect(r).toEqual({ p: null, b: null, near: "0x" + "0".repeat(35) + "10000", real: W(2) });
  });

  it("deals with a placeholder party leave qualifying_deals", async () => {
    const rows = await sql`SELECT deal_id FROM qualifying_deals WHERE deal_id = ANY(${Object.values(deals)}::uuid[])`;
    expect(new Set(rows.map((r) => String(r.deal_id)))).toEqual(new Set([deals.real, deals.clean]));
  });

  it("recomputes the affected sellers from the remaining evidence", async () => {
    expect(await score(ids.mixed)).toBeCloseTo(0.5, 3);
    expect(await score(ids.burnSeller)).toBe(0);
    expect(await score(ids.clean)).toBeCloseTo(0.5, 3);
    const [drift] = await sql`
      SELECT count(*)::int AS n FROM agents
      WHERE id = ANY(${Object.values(ids)}::uuid[]) AND reputation_score IS DISTINCT FROM ap_reputation_score(id)`;
    expect(drift.n).toBe(0);
  });

  it("snapshots only the affected sellers, with their pre-056 scores", async () => {
    const by = await backup();
    expect(by.get(ids.mixed)).toBeCloseTo(1.0, 3);
    expect(by.get(ids.burnSeller)).toBeCloseTo(0.5, 3);
    expect(by.has(ids.clean)).toBe(false);
    expect(by.has(ids.placeholderBuyer)).toBe(false);
  });

  it("is idempotent: a re-run keeps the original snapshot and the same scores", async () => {
    await sql.unsafe(MIGRATION);
    const by = await backup();
    expect(by.get(ids.mixed)).toBeCloseTo(1.0, 3);
    expect(by.get(ids.burnSeller)).toBeCloseTo(0.5, 3);
    expect(await score(ids.mixed)).toBeCloseTo(0.5, 3);
    expect(await score(ids.burnSeller)).toBe(0);
  });

  it("the documented rollback restores the pre-056 scores", async () => {
    await sql.unsafe(PRE_056_WALLET_KEY);
    await sql`UPDATE agents a SET reputation_score = b.reputation_score FROM agents_reputation_backup_056 b WHERE b.agent_id = a.id`;
    expect(await score(ids.mixed)).toBeCloseTo(1.0, 3);
    expect(await score(ids.burnSeller)).toBeCloseTo(0.5, 3);
    // Roll forward again (also leaves the database on the current rule for the rest of the suite).
    await sql.unsafe(MIGRATION);
    const [r] = await sql`SELECT ap_wallet_key(${PRECOMPILE}) AS k`;
    expect(r.k).toBeNull();
    expect(await score(ids.mixed)).toBeCloseTo(0.5, 3);
  });
});

describe("runtime guards treat a placeholder owner wallet as no wallet", () => {
  beforeAll(async () => {
    ({ sql } = await createTestApp());
    await cleanDatabase();
  });

  it("a paid deal to a seller on 0x…0001 without a payout route is refused (409)", async () => {
    const buyer = await mkAgent(W(4));
    const seller = await mkAgent(PRECOMPILE);
    const r = await checkDealParties(sql, { buyerAgentId: buyer, sellerAgentId: seller, negotiatedTotal: 5 });
    expect(r?.status).toBe(409);
    expect(r?.body.code).toBe("seller_payout_wallet_required");
  });

  it("escrow never pays a placeholder owner wallet", async () => {
    expect(await resolveSellerPayoutAddress(sql, await mkAgent(BURN))).toBeNull();
    expect(await resolveSellerPayoutAddress(sql, await mkAgent(PRECOMPILE))).toBeNull();
    expect(await resolveSellerPayoutAddress(sql, await mkAgent(W(6)))).toBe(W(6));
  });
});
