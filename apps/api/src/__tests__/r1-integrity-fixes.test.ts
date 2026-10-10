import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { MIN_EVIDENCE_USDC, walletKey } from "../shared/qualifying.js";
import { getAgentStats } from "../shared/reputation.js";
import * as chain from "../chain.js";

// honest_0710 FIX-R1 (lane m0-integrity): regressions for the R1 review findings
// R1-01, R1-02, R1-03, R1-05 and R1-11. Each test was written first and seen
// RED against the pre-fix branch head (72e1b41).

const ZERO = "0x" + "0".repeat(40);
const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const ADMIN_KEY = "r1-integrity-admin-key";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: App;
let sql: Sql;

beforeEach(async () => {
  ({ app, sql } = await createTestApp());
  await cleanDatabase();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});
afterEach(() => vi.restoreAllMocks());

async function agent(wallet: string | null) {
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id, { walletAddress: wallet });
  return { id, headers };
}

async function listing(buyer: string, seller: string, price = 10) {
  const [o] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, accepted_payment_methods)
    VALUES (${seller}, ${"r1 offer " + randomUUID()}, 'body', 'Data', ${price}, 'usdc') RETURNING id`;
  const [n] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, accepted_payment_methods)
    VALUES (${buyer}, 'r1 need', 'body', 'Data', 'usdc') RETURNING id`;
  return { offerId: String(o.id), needId: String(n.id) };
}

function proposal(b: string, s: string, l: { offerId: string; needId: string }, price = 10) {
  return {
    buyerAgentId: b, sellerAgentId: s, ...l, negotiatedTotal: price, maxPriceDeltaPct: 100,
    milestones: [{ idx: 1, title: "M1", amount: price, acceptanceCriteria: ["done"] }],
  };
}

/** Insert a deal + one milestone directly (states the routes reach only via external paths). */
async function seedDeal(b: string, s: string, o: { price?: number; status?: string } = {}) {
  const price = o.price ?? 10;
  const l = await listing(b, s, price);
  const [d] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${b}, ${s}, ${l.offerId}, ${l.needId}, ${o.status ?? "active"}, ${price}, 100, ${price === 0}) RETURNING id`;
  const [m] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${d.id}, 1, 'M1', ${price}, 'in_progress') RETURNING id`;
  return { id: String(d.id), milestoneId: String(m.id), ...l };
}

async function payment(milestoneId: string, b: string, s: string, status = "released", amount = 10) {
  const [p] = await sql`
    INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
    VALUES (${milestoneId}, ${b}, ${s}, ${amount}, ${status}, ${W(1)}, ${W(2)}, ${W(9)}) RETURNING id`;
  return String(p.id);
}

async function reputation(agentId: string) {
  const [r] = await sql`SELECT reputation_score::text AS stored, ap_reputation_score(id)::text AS derived FROM agents WHERE id = ${agentId}`;
  return { stored: Number(r.stored), derived: Number(r.derived) };
}

describe("R1-01 — an unfunded auto-minted intent is not capital at risk", () => {
  it("accepted-not-funded deal: capital_at_risk=false and completion earns nothing; on-chain funding then counts", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const l = await listing(b.id, s.id);
    process.env.HASH_PREIMAGE_PREDICATE_ADDRESS = W(9);
    const proposed = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: b.headers,
      payload: { ...proposal(b.id, s.id, l), deliverableHash: "0x" + "11".repeat(32) },
    });
    expect(proposed.statusCode).toBe(201);
    const id = JSON.parse(proposed.body).id as string;
    const accepted = await app.inject({ method: "POST", url: `/api/deals/${id}/accept`, headers: s.headers, payload: { actorAgentId: s.id } });
    expect(accepted.statusCode).toBe(200);

    const [row] = await sql`
      SELECT q.capital_at_risk, i.status, i.on_chain_id, i.id AS intent_id
      FROM qualifying_deals q JOIN deals d ON d.id = q.deal_id JOIN intents i ON i.id = d.intent_id
      WHERE q.deal_id = ${id}`;
    expect(row.status).toBe("awaiting_funding");
    expect(row.on_chain_id).toBeNull();
    expect(row.capital_at_risk).toBe(false);

    await sql`UPDATE deals SET status = 'completed' WHERE id = ${id}`;
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });

    // The relayer broadcasts the funded intent (on_chain_id + status 'open'):
    // that IS money moved, so the deal counts — and the stored score follows.
    await sql`UPDATE intents SET on_chain_id = ${Buffer.from("22".repeat(32), "hex")}, status = 'open' WHERE id = ${row.intent_id}`;
    const [after] = await sql`SELECT capital_at_risk FROM qualifying_deals WHERE deal_id = ${id}`;
    expect(after.capital_at_risk).toBe(true);
    expect(await reputation(s.id)).toEqual({ stored: 0.5, derived: 0.5 });
  });
});

describe("R1-02 — the funding destination is a real payout address, never the zero address", () => {
  it("seller with zero owner wallet + verified route: funding calldata pays the route address", async () => {
    vi.spyOn(chain, "isOnChainMode").mockReturnValue(true); // calldata generation only; no network call
    const b = await agent(W(1));
    const s = await agent(ZERO);
    const d = await seedDeal(b.id, s.id, { status: "proposed" });
    await sql`
      INSERT INTO agent_payout_routes (agent_id, chain, cctp_domain, address, recipient_bytes32, proof_message, proof_signature, verified_at, is_default)
      VALUES (${s.id}, 'base', 6, ${W(2)}, ${"0x" + "0".repeat(24) + W(2).slice(2)}, 'test fixture', 'test signature', NOW(), true)`;
    const a = await app.inject({ method: "POST", url: `/api/deals/${d.id}/accept`, headers: s.headers, payload: { actorAgentId: s.id } });
    expect(a.statusCode).toBe(200);
    const r = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: b.headers,
      payload: { provider: "usdc", milestoneId: d.milestoneId, buyerAgentId: b.id, walletProvider: "metamask", buyerWalletAddress: W(1), chain: "base" },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    const decoded = decodeFunctionData({ abi: chain.ESCROW_ABI, data: body.txData.step2_fund.data });
    expect(String(decoded.args?.[2]).toLowerCase()).toBe(W(2));
    const [pi] = await sql`SELECT seller_wallet_address FROM payment_intents WHERE milestone_id = ${d.milestoneId}`;
    expect(String(pi.seller_wallet_address).toLowerCase()).toBe(W(2));
  });

  it("seller with zero owner wallet and no EVM payout route: funding is refused (400), nothing recorded", async () => {
    const b = await agent(W(1));
    const s = await agent(ZERO);
    const d = await seedDeal(b.id, s.id, { status: "active" });
    const r = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: b.headers,
      payload: { provider: "usdc", milestoneId: d.milestoneId, buyerAgentId: b.id, walletProvider: "metamask", buyerWalletAddress: W(1), chain: "base" },
    });
    expect(r.statusCode).toBe(400);
    const rows = await sql`SELECT id FROM payment_intents WHERE milestone_id = ${d.milestoneId}`;
    expect(rows).toHaveLength(0);
  });
});

describe("R1-03 — funded deals cannot be re-priced", () => {
  it("counter on a funded deal → 409 and the funding record survives", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id, { status: "active" });
    await payment(d.milestoneId, b.id, s.id, "funded");
    const r = await app.inject({
      method: "POST", url: `/api/deals/${d.id}/counter`, headers: s.headers,
      payload: { actorAgentId: s.id, negotiatedTotal: 12, milestones: [{ idx: 1, title: "replacement", amount: 12, acceptanceCriteria: ["done"] }] },
    });
    expect(r.statusCode).toBe(409);
    const after = await sql`SELECT pi.id FROM payment_intents pi JOIN milestones m ON m.id = pi.milestone_id WHERE m.deal_id = ${d.id}`;
    expect(after).toHaveLength(1);
    const [state] = await sql`SELECT status, negotiated_total FROM deals WHERE id = ${d.id}`;
    expect(state.status).toBe("active");
    expect(Number(state.negotiated_total)).toBe(10);
  });

  it("counter on a proposed deal that already carries a money-moved intent → 409", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id, { status: "proposed" });
    await sql`
      INSERT INTO intents (on_chain_id, buyer_agent_id, seller_agent_id, settlement_class, predicate_type, predicate_params, max_price_usdc, status, expires_at, deal_id)
      VALUES (${Buffer.from("33".repeat(32), "hex")}, ${b.id}, ${s.id}, 'A', 'hash-preimage-v1', '{}'::jsonb, 10, 'open', NOW() + INTERVAL '7 days', ${d.id})`;
    const r = await app.inject({
      method: "POST", url: `/api/deals/${d.id}/counter`, headers: s.headers,
      payload: { actorAgentId: s.id, negotiatedTotal: 12, milestones: [{ idx: 1, title: "x2", amount: 12, acceptanceCriteria: ["done"] }] },
    });
    expect(r.statusCode).toBe(409);
  });

  it("counter on an accepted (active) deal → 409 even before funding", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id, { status: "active" });
    const r = await app.inject({
      method: "POST", url: `/api/deals/${d.id}/counter`, headers: b.headers,
      payload: { actorAgentId: b.id, negotiatedTotal: 8, milestones: [{ idx: 1, title: "x2", amount: 8, acceptanceCriteria: ["done"] }] },
    });
    expect(r.statusCode).toBe(409);
    const ms = await sql`SELECT id FROM milestones WHERE deal_id = ${d.id}`;
    expect(ms.map((m) => String(m.id))).toEqual([d.milestoneId]);
  });

  it("decompose of a funded parent → 409, no children created", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const c1 = await agent(W(3));
    const c2 = await agent(W(4));
    const d = await seedDeal(b.id, s.id, { status: "active", price: 100 });
    await payment(d.milestoneId, b.id, s.id, "funded", 100);
    const before = await sql`SELECT count(*)::int AS n FROM deals`;
    const r = await app.inject({
      method: "POST", url: "/api/deals/decompose", headers: b.headers,
      payload: {
        parentDealId: d.id, maxPriceDeltaPct: 20,
        children: [
          { sellerAgentId: c1.id, offerId: d.offerId, needId: d.needId, title: "a", negotiatedTotal: 10 },
          { sellerAgentId: c2.id, offerId: d.offerId, needId: d.needId, title: "b", negotiatedTotal: 10 },
        ],
      },
    });
    expect(r.statusCode).toBe(409);
    const after = await sql`SELECT count(*)::int AS n FROM deals`;
    expect(after[0].n).toBe(before[0].n);
  });
});

describe("R1-05 — stored reputation follows every evidence change", () => {
  it("mark-internal on the buyer removes the seller's credited score immediately (and unmark restores it)", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id);
    await payment(d.milestoneId, b.id, s.id);
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
    expect(await reputation(s.id)).toEqual({ stored: 0.5, derived: 0.5 });

    const r = await app.inject({ method: "PATCH", url: `/api/admin/agents/${b.id}/mark-internal`, headers: { "x-admin-key": ADMIN_KEY }, payload: { isInternal: true } });
    expect(r.statusCode).toBe(200);
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });

    const u = await app.inject({ method: "PATCH", url: `/api/admin/agents/${b.id}/mark-internal`, headers: { "x-admin-key": ADMIN_KEY }, payload: { isInternal: false } });
    expect(u.statusCode).toBe(200);
    expect(await reputation(s.id)).toEqual({ stored: 0.5, derived: 0.5 });
  });

  it("bulk-mark-internal recomputes the counterparties too", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id);
    await payment(d.milestoneId, b.id, s.id);
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
    const r = await app.inject({ method: "POST", url: "/api/admin/agents/bulk-mark-internal", headers: { "x-admin-key": ADMIN_KEY }, payload: { walletAddresses: [W(1)], isInternal: true } });
    expect(r.statusCode).toBe(200);
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });
  });

  it("funding evidence that arrives after completion credits the seller", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id);
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });
    const pi = await payment(d.milestoneId, b.id, s.id, "created");
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });
    await sql`UPDATE payment_intents SET status = 'released' WHERE id = ${pi}`;
    expect(await reputation(s.id)).toEqual({ stored: 0.5, derived: 0.5 });
  });
});

describe("R1-11 — one wallet canonicalisation (TS == SQL)", () => {
  it("walletKey and ap_wallet_key agree on every form", async () => {
    const inputs = [
      W(2), W(2).replace("0x", "0X"), "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      "0XABCDEF0123456789ABCDEF0123456789ABCDEF01", ZERO, ZERO.replace("0x", "0X"),
      `  ${W(5)}  `, "0xAgentPactPlatformUSDC", "", "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
      "11111111111111111111111111111111", "0x123", "1".repeat(40),
    ];
    for (const w of inputs) {
      const [r] = await sql`SELECT ap_wallet_key(${w}) AS k`;
      expect({ w, ts: walletKey(w) }).toEqual({ w, ts: (r.k as string | null) ?? null });
    }
  });

  it("a 0X-prefixed copy of the seller's wallet cannot dodge the same-owner accept guard", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const l = await listing(b.id, s.id);
    const p = await app.inject({ method: "POST", url: "/api/deals/propose", headers: b.headers, payload: proposal(b.id, s.id, l) });
    expect(p.statusCode).toBe(201);
    const id = JSON.parse(p.body).id as string;
    const changed = await app.inject({ method: "PATCH", url: `/api/agents/${b.id}/wallet`, headers: b.headers, payload: { walletAddress: W(2).replace("0x", "0X") } });
    expect(changed.statusCode).toBe(200);
    const a = await app.inject({ method: "POST", url: `/api/deals/${id}/accept`, headers: s.headers, payload: { actorAgentId: s.id } });
    expect(a.statusCode).toBe(403);
    expect(JSON.parse(a.body).code).toBe("same_owner");
  });
});

describe("R1-07 — dust deals are never reputation evidence", () => {
  it("three funded $0.000001 deals across distinct owners earn no score and no tier evidence; $0.01 does", async () => {
    const s = await agent(W(2));
    const buyers = [await agent(W(1)), await agent(W(3)), await agent(W(4))];
    for (const b of buyers) {
      const d = await seedDeal(b.id, s.id, { price: 0.000001 });
      await payment(d.milestoneId, b.id, s.id, "released", 0.000001);
      await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
      await sql`INSERT INTO feedback (deal_id, from_agent_id, to_agent_id, rating_quality, rating_timeliness, rating_communication, rating_accuracy) VALUES (${d.id}, ${b.id}, ${s.id}, 5, 5, 5, 5)`;
    }
    const [car] = await sql`SELECT count(*)::int AS n FROM qualifying_deals WHERE capital_at_risk AND seller_agent_id = ${s.id}`;
    expect(car.n).toBe(3); // money did move — it is just not a track record
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });
    expect(await getAgentStats(sql, s.id)).toEqual({ completedDeals: 0, reputationScore: 0 });

    const d = await seedDeal(buyers[0].id, s.id, { price: MIN_EVIDENCE_USDC });
    await payment(d.milestoneId, buyers[0].id, s.id, "released", MIN_EVIDENCE_USDC);
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
    expect(await reputation(s.id)).toEqual({ stored: 0.5, derived: 0.5 });
    expect((await getAgentStats(sql, s.id)).completedDeals).toBe(1);
  });

  it("a big quote with dust escrow is capped at what was escrowed", async () => {
    const b = await agent(W(1));
    const s = await agent(W(2));
    const d = await seedDeal(b.id, s.id, { price: 1000 });
    await payment(d.milestoneId, b.id, s.id, "released", 0.000001);
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${d.id}`;
    const [r] = await sql`SELECT ap_deal_escrowed_usdc(${d.id}::uuid)::text AS escrowed, (SELECT count(*)::int FROM reputation_evidence_deals WHERE deal_id = ${d.id}) AS evidence`;
    expect(Number(r.escrowed)).toBe(0.000001);
    expect(r.evidence).toBe(0);
    expect(await reputation(s.id)).toEqual({ stored: 0, derived: 0 });
  });
});
