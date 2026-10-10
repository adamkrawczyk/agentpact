import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import * as chain from "../chain.js";
import { cancelledDealsHoldingFunds } from "../shared/deal-guards.js";
import { completeDealMilestones, releaseMilestonePayment } from "../shared/deal-helpers.js";
import { runAutoCloseSweep } from "../../../relayer-daemon/src/autoclose-sweeper.js";

// cancel-refund-guard: POST /api/deals/:id/cancel must never leave money
// escrowed on a cancelled deal. Refund settles first; cancel never triggers
// one. Spec §5 test plan, items 1-9. Synthetic ids and amounts only.

const stripeCancel = vi.hoisted(() => ({ fn: null as null | ((id: string) => Promise<unknown>) }));
const mpp = vi.hoisted(() => ({ charge: null as null | (() => Promise<unknown>) }));
vi.mock("../mpp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mpp.js")>();
  return {
    ...actual,
    getMppConfigurationError: () => (mpp.charge ? null : actual.getMppConfigurationError()),
    chargeDeal: async () => {
      if (!mpp.charge) throw new Error("test did not program chargeDeal");
      return mpp.charge();
    },
  };
});
vi.mock("../stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stripe.js")>();
  return {
    ...actual,
    isStripeEnabled: () => true,
    cancelPaymentIntent: vi.fn(async (id: string) => {
      if (!stripeCancel.fn) throw new Error("test did not program cancelPaymentIntent");
      return stripeCancel.fn(id);
    }),
  };
});

const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const ADMIN_KEY = "cancel-guard-admin-key";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: App;
let sql: Sql;
// Deals a test seeds DIRECTLY in an already-broken legacy state (cancelled +
// money held) to prove the downstream paths refuse to act on them. They are
// the input, not an output, so the global invariant skips exactly these ids.
let legacyFixtureDeals: Set<string>;

beforeEach(async () => {
  ({ app, sql } = await createTestApp());
  await cleanDatabase();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  legacyFixtureDeals = new Set();
  stripeCancel.fn = null;
  mpp.charge = null;
  vi.spyOn(chain, "isOnChainMode").mockReturnValue(true);
});

// Spec §5.8 — the card's regression: no code path leaves funds escrowed on a
// deal that ends cancelled. Runs the exact HELD predicate the guard uses.
afterEach(async () => {
  const offenders = (await cancelledDealsHoldingFunds(sql)).filter((id) => !legacyFixtureDeals.has(id));
  vi.restoreAllMocks();
  expect(offenders, "cancelled deals that still hold funds").toEqual([]);
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function agent(wallet: string) {
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id, { walletAddress: wallet });
  return { id, headers };
}

async function parties() {
  return { b: await agent(W(1)), s: await agent(W(2)) };
}

async function seedDeal(b: string, s: string, o: { status?: string; price?: number; milestoneStatus?: string } = {}) {
  const price = o.price ?? 2;
  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, accepted_payment_methods)
    VALUES (${s}, ${"cg offer " + randomUUID()}, 'body', 'Data', ${price}, 'usdc') RETURNING id`;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, accepted_payment_methods)
    VALUES (${b}, 'cg need', 'body', 'Data', 'usdc') RETURNING id`;
  const [d] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${b}, ${s}, ${offer.id}, ${need.id}, ${o.status ?? "active"}, ${price}, 100, ${price === 0}) RETURNING id`;
  const [m] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${d.id}, 1, 'M1', ${price}, ${o.milestoneStatus ?? "in_progress"}) RETURNING id`;
  return { id: String(d.id), milestoneId: String(m.id) };
}

async function seedPI(
  milestoneId: string, b: string, s: string, status: string,
  o: { provider?: "usdc" | "stripe"; stripeId?: string; amount?: number } = {},
) {
  const provider = o.provider ?? "usdc";
  const [p] = await sql`
    INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status,
      buyer_wallet_address, seller_wallet_address, platform_wallet_address, payment_provider, stripe_payment_intent_id, chain)
    VALUES (${milestoneId}, ${b}, ${s}, ${o.amount ?? 2}, ${status}, ${W(1)}, ${W(2)}, ${W(9)},
      ${provider}, ${o.stripeId ?? null}, ${provider === "stripe" ? "fiat" : "base"})
    RETURNING id`;
  return String(p.id);
}

/** A V3 Class-A intent linked both ways to the deal (as accept's auto-mint does). */
async function seedIntent(dealId: string, b: string, s: string, status: string, onChain: boolean) {
  const [i] = await sql`
    INSERT INTO intents (on_chain_id, buyer_agent_id, seller_agent_id, seller_target_agent_id, settlement_class,
      predicate_type, predicate_params, max_price_usdc, status, expires_at, deal_id)
    VALUES (${onChain ? Buffer.from(randomUUID().replace(/-/g, "").repeat(2), "hex") : null}, ${b}, ${s}, ${s}, 'A',
      'hash-preimage-v1', ${JSON.stringify({ verifier: W(7), params: "0x" + "11".repeat(32), seller_target: W(2) })}::jsonb,
      2, ${status}, NOW() + INTERVAL '7 days', ${dealId})
    RETURNING id`;
  await sql`UPDATE deals SET intent_id = ${i.id} WHERE id = ${dealId}`;
  return String(i.id);
}

async function seedAuthorization(intentId: string) {
  await sql`
    INSERT INTO intent_funding_authorizations (intent_id, value_usdc, valid_after, valid_before, nonce, sig_v, sig_r, sig_s, status)
    VALUES (${intentId}, 2, 0, ${Math.floor(Date.now() / 1000) + 3600}, ${Buffer.alloc(32, 1)}, 27, ${Buffer.alloc(32, 2)}, ${Buffer.alloc(32, 3)}, 'queued')`;
}

async function seedDelivery(milestoneId: string, s: string) {
  await sql`
    INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum)
    VALUES (${milestoneId}, ${s}, '[]'::jsonb, 'sha256:test')`;
}

async function seedDispute(dealId: string, milestoneId: string, by: string, expired = false) {
  await sql`
    INSERT INTO disputes (deal_id, milestone_id, opened_by, reason, expires_at)
    VALUES (${dealId}, ${milestoneId}, ${by}, 'test', ${expired ? sql`NOW() - INTERVAL '1 hour'` : sql`NOW() + INTERVAL '7 days'`})`;
}

function cancel(dealId: string, who: { id: string; headers: Record<string, string> }) {
  return app.inject({
    method: "POST", url: `/api/deals/${dealId}/cancel`, headers: who.headers,
    payload: { actorAgentId: who.id, reason: "test" },
  });
}

async function dealStatus(id: string) {
  const [r] = await sql`SELECT status FROM deals WHERE id = ${id}`;
  return String(r.status);
}
async function piStatus(id: string) {
  const [r] = await sql`SELECT status FROM payment_intents WHERE id = ${id}`;
  return String(r.status);
}

/** A fake relayer chain client that records FUND/CLAIM broadcasts. */
function fakeRelayerChain(onFund?: () => Promise<void>) {
  const calls = { fund: 0, claim: 0 };
  return {
    calls,
    client: {
      async acknowledgeTimeout() { return { txHash: "0xack" }; },
      async settleSchelling() { return { txHash: "0xsch" }; },
      async createIntentWithAuthorization() {
        calls.fund++;
        if (onFund) await onFund();
        return { txHash: "0xfund", onChainId: Buffer.alloc(32, 0xab) };
      },
      async claimIntent() { calls.claim++; return { txHash: "0xclaim" }; },
    },
  };
}
const relayerConfig = { autocloseMaxUsdc: 5 } as Parameters<typeof runAutoCloseSweep>[2];
const relayerSql = () => sql as unknown as Parameters<typeof runAutoCloseSweep>[0];

// ── §5.1 — one row per spec §2 line, as buyer AND as seller ─────────────────

type Seed = (d: { id: string; milestoneId: string }, b: string, s: string) => Promise<void>;
const none: Seed = async () => {};
const CASES: Array<{ name: string; status: string; price?: number; seed: Seed; code: number; err?: string }> = [
  { name: "proposed", status: "proposed", seed: none, code: 200 },
  { name: "countered", status: "countered", seed: none, code: 200 },
  { name: "active, nothing created", status: "active", seed: none, code: 200 },
  { name: "active, legacy PI funded", status: "active", seed: async (d, b, s) => { await seedPI(d.milestoneId, b, s, "funded"); }, code: 409, err: "deal_funded" },
  { name: "active, PI pending_funding", status: "active", seed: async (d, b, s) => { await seedPI(d.milestoneId, b, s, "pending_funding"); }, code: 409, err: "deal_funded" },
  { name: "active, PI pending_refund", status: "active", seed: async (d, b, s) => { await seedPI(d.milestoneId, b, s, "pending_refund"); }, code: 409, err: "deal_funded" },
  { name: "active, PI disputed", status: "active", seed: async (d, b, s) => { await seedPI(d.milestoneId, b, s, "disputed"); }, code: 409, err: "deal_funded" },
  { name: "active, Stripe PI funded", status: "active", seed: async (d, b, s) => { await seedPI(d.milestoneId, b, s, "funded", { provider: "stripe", stripeId: "pi_synthetic_1" }); }, code: 409, err: "deal_funded" },
  { name: "active, V3 intent open on-chain", status: "active", seed: async (d, b, s) => { await seedIntent(d.id, b, s, "open", true); }, code: 409, err: "deal_funded" },
  { name: "active, V3 intent expired but on-chain (unreconciled)", status: "active", seed: async (d, b, s) => { await seedIntent(d.id, b, s, "expired", true); }, code: 409, err: "deal_funded" },
  { name: "active, V3 intent funding_in_flight (§5.4)", status: "active", seed: async (d, b, s) => { await seedIntent(d.id, b, s, "funding_in_flight", false); }, code: 409, err: "deal_funded" },
  { name: "active, MPP receipt", status: "active", seed: async (d) => { await sql`UPDATE deals SET mpp_receipt = '{"ref":"synthetic"}'::jsonb WHERE id = ${d.id}`; }, code: 409, err: "deal_funded" },
  { name: "active free deal with a delivery row", status: "active", price: 0, seed: async (d, _b, s) => { await seedDelivery(d.milestoneId, s); }, code: 409, err: "deal_delivered" },
  { name: "active with an open dispute row", status: "active", seed: async (d, b) => { await seedDispute(d.id, d.milestoneId, b); }, code: 409, err: "deal_disputed" },
  { name: "delivered", status: "delivered", seed: none, code: 409, err: "deal_delivered" },
  { name: "release_pending_chain", status: "release_pending_chain", seed: none, code: 409, err: "deal_delivered" },
  { name: "disputed", status: "disputed", seed: none, code: 409, err: "deal_disputed" },
  { name: "completed", status: "completed", seed: none, code: 409, err: "deal_not_cancellable" },
  { name: "active, V3 intent already claimed (money left escrow)", status: "active", seed: async (d, b, s) => { await seedIntent(d.id, b, s, "claimed", true); }, code: 200 },
  { name: "active, PI refunded (refund settled first)", status: "active", seed: async (d, b, s) => { await seedPI(d.milestoneId, b, s, "refunded"); }, code: 200 },
];

describe("§5.1 cancel outcome per deal state", () => {
  for (const c of CASES) {
    for (const role of ["buyer", "seller"] as const) {
      it(`${c.name} — ${role} cancel → ${c.code}${c.err ? ` ${c.err}` : ""}`, async () => {
        const { b, s } = await parties();
        const d = await seedDeal(b.id, s.id, { status: c.status, price: c.price });
        await c.seed(d, b.id, s.id);
        const [mBefore] = await sql`SELECT status FROM milestones WHERE id = ${d.milestoneId}`;

        const res = await cancel(d.id, role === "buyer" ? b : s);
        expect(res.statusCode, res.body).toBe(c.code);
        const body = JSON.parse(res.body);
        if (c.code === 409) {
          expect(body.code).toBe(c.err);
          expect(body.hint).toEqual(expect.any(String));
          expect(await dealStatus(d.id)).toBe(c.status);
          const [mAfter] = await sql`SELECT status FROM milestones WHERE id = ${d.milestoneId}`;
          expect(mAfter.status).toBe(mBefore.status);
          const events = await sql`SELECT 1 FROM negotiation_events WHERE deal_id = ${d.id} AND event_type = 'cancel'`;
          expect(events.length).toBe(0);
        } else {
          expect(body).toMatchObject({ ok: true, dealId: d.id, priorStatus: c.status });
          expect(await dealStatus(d.id)).toBe("cancelled");
        }
      });
    }
  }

  it("cancelled → 200 alreadyCancelled; idempotent: one cancel event, no second write (§5.9)", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    expect((await cancel(d.id, b)).statusCode).toBe(200);
    const again = await cancel(d.id, s);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ ok: true, alreadyCancelled: true });
    const events = await sql`SELECT payload_json #>> '{}' AS payload FROM negotiation_events WHERE deal_id = ${d.id} AND event_type = 'cancel'`;
    expect(events.length).toBe(1);
    // Stored as a jsonb string scalar, like every pre-existing cancel event
    // (admin metrics decodes them with #>> '{}'); encoding left unchanged.
    expect(JSON.parse(String(events[0].payload))).toMatchObject({ priorStatus: "active", closed: { paymentIntentsFailed: [], intentsCancelled: [], authorizationsRevoked: 0 } });
  });

  it("non-party → 403, unknown deal → 404, deal unchanged", async () => {
    const { b, s } = await parties();
    const outsider = await agent(W(3));
    const d = await seedDeal(b.id, s.id);
    expect((await cancel(d.id, outsider)).statusCode).toBe(403);
    expect((await cancel(randomUUID(), b)).statusCode).toBe(404);
    expect(await dealStatus(d.id)).toBe("active");
  });

  it("simulation mode: create-intent funds immediately, so cancel is refused", async () => {
    vi.spyOn(chain, "isOnChainMode").mockReturnValue(false);
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    const ci = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: b.headers,
      payload: { provider: "usdc", milestoneId: d.milestoneId, buyerAgentId: b.id, walletProvider: "metamask", buyerWalletAddress: W(1), chain: "base" },
    });
    expect(ci.statusCode, ci.body).toBe(201);
    expect(JSON.parse(ci.body).status).toBe("funded");
    const res = await cancel(d.id, b);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("deal_funded");
    expect(await dealStatus(d.id)).toBe("active");
  });
});

// ── §5.2 — legacy inflow is closed in the cancel transaction ────────────────

describe("§5.2 legacy USDC: a created PI is closed by cancel and can never fund", () => {
  it("cancel flips created → failed; confirm-funding and create-intent then refuse", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    const pi = await seedPI(d.milestoneId, b.id, s.id, "created");

    const res = await cancel(d.id, b);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).closed.paymentIntentsFailed).toEqual([pi]);
    expect(await piStatus(pi)).toBe("failed");
    const [m] = await sql`SELECT status FROM milestones WHERE id = ${d.milestoneId}`;
    expect(m.status).toBe("cancelled");

    vi.spyOn(chain, "verifyFunding").mockResolvedValue({ verified: true } as Awaited<ReturnType<typeof chain.verifyFunding>>);
    const cf = await app.inject({
      method: "POST", url: "/api/payments/confirm-funding", headers: b.headers,
      payload: { paymentIntentId: pi, txHash: "0x" + "ab".repeat(32) },
    });
    expect(cf.statusCode, cf.body).toBe(409);
    expect(JSON.parse(cf.body).code).toBe("deal_not_fundable");
    expect(await piStatus(pi)).toBe("failed");
    // The buyer's on-chain tx may hold escrowed USDC: the refusal is traceable.
    const [refused] = await sql`SELECT payload_json FROM audit_log WHERE action = 'payment.confirm_funding.refused' AND object_id = ${pi}`;
    expect(refused).toBeTruthy();

    const ci = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: b.headers,
      payload: { provider: "usdc", milestoneId: d.milestoneId, buyerAgentId: b.id, walletProvider: "metamask", buyerWalletAddress: W(1), chain: "base" },
    });
    expect(ci.statusCode, ci.body).toBe(409);
    expect(JSON.parse(ci.body).code).toBe("deal_not_fundable");
  });

  it("create-intent refuses cancelled / proposed / disputed / settled deals", async () => {
    const { b, s } = await parties();
    for (const status of ["cancelled", "proposed", "countered", "disputed", "release_pending_chain", "completed"]) {
      const d = await seedDeal(b.id, s.id, { status });
      const ci = await app.inject({
        method: "POST", url: "/api/payments/create-intent", headers: b.headers,
        payload: { provider: "usdc", milestoneId: d.milestoneId, buyerAgentId: b.id, walletProvider: "metamask", buyerWalletAddress: W(1), chain: "base" },
      });
      expect(ci.statusCode, `${status}: ${ci.body}`).toBe(409);
      expect(JSON.parse(ci.body).code).toBe("deal_not_fundable");
    }
  });
});

// ── beyond spec §4 (flagged): MPP has no refund path, never charge a cancelled deal ──

describe("pay-mpp refuses a deal that is not active, before any charge", () => {
  it("cancelled deal → 409 deal_not_fundable (no MPP challenge, no charge)", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    expect((await cancel(d.id, b)).statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: `/api/deals/${d.id}/pay-mpp`, headers: b.headers, payload: { actorAgentId: b.id } });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("deal_not_fundable");
    const [row] = await sql`SELECT status, mpp_receipt FROM deals WHERE id = ${d.id}`;
    expect(row).toMatchObject({ status: "cancelled", mpp_receipt: null });
  });

  it("cancel commits DURING the MPP charge → write-back refused, deal stays cancelled, charge traced", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    mpp.charge = async () => {
      expect((await cancel(d.id, b)).statusCode).toBe(200); // lands mid-charge
      return { status: 200, receipt: { method: "stripe", reference: "synthetic_ref", status: "success", timestamp: new Date().toISOString() } };
    };
    const res = await app.inject({ method: "POST", url: `/api/deals/${d.id}/pay-mpp`, headers: b.headers, payload: { actorAgentId: b.id } });
    expect(res.statusCode, res.body).toBe(409);
    const [row] = await sql`SELECT status, mpp_receipt FROM deals WHERE id = ${d.id}`;
    expect(row).toMatchObject({ status: "cancelled", mpp_receipt: null });
    const traced = await sql`SELECT 1 FROM audit_log WHERE action = 'payment.mpp.refused_after_charge' AND object_id = ${d.id}`;
    expect(traced.length).toBe(1);
  });

  it("control: an active deal gets past the guard (to the MPP config check)", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    const res = await app.inject({ method: "POST", url: `/api/deals/${d.id}/pay-mpp`, headers: b.headers, payload: { actorAgentId: b.id } });
    expect(res.statusCode).not.toBe(409);
  });
});

describe("cancelled is terminal: a dispute cannot reopen it", () => {
  it("disputes/open on a cancelled deal → 409, deal and milestone stay cancelled", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    expect((await cancel(d.id, b)).statusCode).toBe(200);
    const res = await app.inject({
      method: "POST", url: "/api/disputes/open", headers: b.headers,
      payload: { dealId: d.id, milestoneId: d.milestoneId, openedBy: b.id, reason: "late dispute after cancel", evidence: [] },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(await dealStatus(d.id)).toBe("cancelled");
    const [m] = await sql`SELECT status FROM milestones WHERE id = ${d.milestoneId}`;
    expect(m.status).toBe("cancelled");
  });
});

describe("§4.2 deviation: a delivered deal held at settlement_pending stays fundable", () => {
  it("create-intent on a delivered deal → 201 (the documented re-close recovery path)", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id, { status: "delivered" });
    const ci = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: b.headers,
      payload: { provider: "usdc", milestoneId: d.milestoneId, buyerAgentId: b.id, walletProvider: "metamask", buyerWalletAddress: W(1), chain: "base" },
    });
    expect(ci.statusCode, ci.body).toBe(201);
    expect(JSON.parse(ci.body).status).toBe("created");
    // ...and the delivered deal still cannot be cancelled.
    const res = await cancel(d.id, b);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("deal_delivered");
  });
});

// ── §5.3 — V3 inflow closed; the relayer then never pulls USDC ──────────────

describe("§5.3 V3 Class A: awaiting_funding intent + queued authorization", () => {
  async function gaslessDeal() {
    const { b, s } = await parties();
    await sql`UPDATE agents SET autoclose_enabled = true WHERE id = ${b.id}`;
    const d = await seedDeal(b.id, s.id);
    const intentId = await seedIntent(d.id, b.id, s.id, "awaiting_funding", false);
    await seedAuthorization(intentId);
    return { b, s, d, intentId };
  }

  it("positive control: without cancel the real FUND query picks the intent up", async () => {
    await gaslessDeal();
    const fake = fakeRelayerChain();
    const res = await runAutoCloseSweep(relayerSql(), fake.client, relayerConfig);
    expect(res.fund.scanned).toBe(1);
    expect(fake.calls.fund).toBe(1);
  });

  it("cancel → intent cancelled, authorization revoked; relayer FUND scans 0 rows, no chain call", async () => {
    const { b, d, intentId } = await gaslessDeal();
    const res = await cancel(d.id, b);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).closed).toMatchObject({ intentsCancelled: [intentId], authorizationsRevoked: 1 });
    const [i] = await sql`SELECT status FROM intents WHERE id = ${intentId}`;
    expect(i.status).toBe("cancelled");
    const [a] = await sql`SELECT status FROM intent_funding_authorizations WHERE intent_id = ${intentId}`;
    expect(a.status).toBe("revoked");

    const fake = fakeRelayerChain();
    const sweep = await runAutoCloseSweep(relayerSql(), fake.client, relayerConfig);
    expect(sweep.fund.scanned).toBe(0);
    expect(fake.calls.fund).toBe(0);
  });

  it("funding-authorization after cancel → 409 deal_not_fundable, nothing re-queued", async () => {
    const { b, d, intentId } = await gaslessDeal();
    expect((await cancel(d.id, b)).statusCode).toBe(200);
    const fa = await app.inject({
      method: "POST", url: `/api/deals/${d.id}/funding-authorization`, headers: b.headers,
      payload: {
        actorAgentId: b.id, value: 2, validAfter: 0, validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce: "0x" + "01".repeat(32), v: 27, r: "0x" + "02".repeat(32), s: "0x" + "03".repeat(32),
      },
    });
    expect(fa.statusCode, fa.body).toBe(409);
    expect(JSON.parse(fa.body).code).toBe("deal_not_fundable");
    const [a] = await sql`SELECT status FROM intent_funding_authorizations WHERE intent_id = ${intentId}`;
    expect(a.status).toBe("revoked");
  });

  it("funding-authorization on an active deal still queues (no regression)", async () => {
    const { b, d, intentId } = await gaslessDeal();
    await sql`DELETE FROM intent_funding_authorizations WHERE intent_id = ${intentId}`;
    const fa = await app.inject({
      method: "POST", url: `/api/deals/${d.id}/funding-authorization`, headers: b.headers,
      payload: {
        actorAgentId: b.id, value: 2, validAfter: 0, validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce: "0x" + "01".repeat(32), v: 27, r: "0x" + "02".repeat(32), s: "0x" + "03".repeat(32),
      },
    });
    expect(fa.statusCode, fa.body).toBe(201);
    const [a] = await sql`SELECT status, value_usdc::text AS v FROM intent_funding_authorizations WHERE intent_id = ${intentId}`;
    expect(a).toMatchObject({ status: "queued", v: "2.000000" });
  });

  // §5.4 race, from the relayer side: the cancel lands WHILE the relayer is
  // broadcasting. The claim (funding_in_flight) is already committed, so the
  // cancel must see money in flight and refuse.
  it("§5.4 cancel during a relayer broadcast → 409 deal_funded; the intent opens, the deal stays active", async () => {
    const { b, d, intentId } = await gaslessDeal();
    let midBroadcast: { statusCode: number; body: string } | null = null;
    const fake = fakeRelayerChain(async () => {
      midBroadcast = await cancel(d.id, b);
    });
    const sweep = await runAutoCloseSweep(relayerSql(), fake.client, relayerConfig);
    expect(sweep.fund.acted).toBe(1);
    expect(midBroadcast!.statusCode).toBe(409);
    expect(JSON.parse(midBroadcast!.body).code).toBe("deal_funded");
    expect(await dealStatus(d.id)).toBe("active");
    const [i] = await sql`SELECT status FROM intents WHERE id = ${intentId}`;
    expect(i.status).toBe("open");
  });
});

// ── §5.5 — legacy race: cancel vs confirm-funding, exactly one wins ─────────

describe("§5.5 cancel vs confirm-funding: never cancelled + funded", () => {
  const tx = () => "0x" + randomUUID().replace(/-/g, "").repeat(2);
  function confirm(pi: string, b: { headers: Record<string, string> }) {
    return app.inject({ method: "POST", url: "/api/payments/confirm-funding", headers: b.headers, payload: { paymentIntentId: pi, txHash: tx() } });
  }

  it("cancel lands between on-chain verification and the funding CAS → confirm-funding loses (409)", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    const pi = await seedPI(d.milestoneId, b.id, s.id, "created");
    let cancelRes: { statusCode: number } | null = null;
    vi.spyOn(chain, "verifyFunding").mockImplementation(async () => {
      cancelRes = await cancel(d.id, b); // the race hook: cancel commits mid-confirm
      return { verified: true } as Awaited<ReturnType<typeof chain.verifyFunding>>;
    });
    const cf = await confirm(pi, b);
    expect(cancelRes!.statusCode).toBe(200);
    expect(cf.statusCode, cf.body).toBe(409);
    expect(await dealStatus(d.id)).toBe("cancelled");
    expect(await piStatus(pi)).toBe("failed");
    const audits = await sql`SELECT 1 FROM audit_log WHERE action = 'payment.confirm_funding.refused' AND object_id = ${pi}`;
    expect(audits.length, "verified-on-chain refusal leaves an operator trace").toBe(1);
  });

  it("confirm-funding holds the deal lock with the PI funded → cancel waits, then sees the money (409)", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    const pi = await seedPI(d.milestoneId, b.id, s.id, "created");
    let pending: Promise<{ statusCode: number; body: string }> | null = null;
    await sql.begin(async (txn) => {
      // Exactly what confirm-funding's transaction does, held open.
      await txn`SELECT id FROM deals WHERE id = ${d.id} FOR UPDATE`;
      await txn`UPDATE payment_intents SET status = 'funded', tx_hash = ${tx()} WHERE id = ${pi} AND status = 'created'`;
      pending = cancel(d.id, b);
      await new Promise((r) => setTimeout(r, 300)); // cancel is now blocked on the row lock
    });
    const res = await pending!;
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("deal_funded");
    expect(await dealStatus(d.id)).toBe("active");
    expect(await piStatus(pi)).toBe("funded");
  });

  it("concurrent fire, repeated: every outcome is (active, funded) or (cancelled, failed)", async () => {
    vi.spyOn(chain, "verifyFunding").mockResolvedValue({ verified: true } as Awaited<ReturnType<typeof chain.verifyFunding>>);
    const { b, s } = await parties();
    for (let n = 0; n < 8; n++) {
      const d = await seedDeal(b.id, s.id);
      const pi = await seedPI(d.milestoneId, b.id, s.id, "created");
      const [c, f] = await Promise.all([cancel(d.id, b), confirm(pi, b)]);
      const outcome = `${await dealStatus(d.id)}+${await piStatus(pi)}`;
      expect(["active+funded", "cancelled+failed"], `run ${n}: cancel=${c.statusCode} confirm=${f.statusCode}`).toContain(outcome);
      expect(c.statusCode === 200).toBe(outcome === "cancelled+failed");
    }
  });
});

// ── §5.6 — Stripe: cancelled at the provider before the DB is written ──────

describe("§5.6 Stripe created PI", () => {
  async function stripeDeal() {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id);
    const pi = await seedPI(d.milestoneId, b.id, s.id, "created", { provider: "stripe", stripeId: "pi_synthetic_" + randomUUID().slice(0, 8) });
    return { b, s, d, pi };
  }

  it("provider cancel succeeds → 200, PI failed", async () => {
    const { b, d, pi } = await stripeDeal();
    const seen: string[] = [];
    stripeCancel.fn = async (id) => { seen.push(id); return { outcome: "cancelled", status: "canceled" }; };
    const res = await cancel(d.id, b);
    expect(res.statusCode, res.body).toBe(200);
    expect(seen.length).toBe(1);
    expect(await piStatus(pi)).toBe("failed");
    expect(JSON.parse(res.body).closed.paymentIntentsFailed).toEqual([pi]);
  });

  it("provider says already captured → 409 deal_funded, nothing changed", async () => {
    const { b, d, pi } = await stripeDeal();
    stripeCancel.fn = async () => ({ outcome: "already_captured", status: "succeeded" });
    const res = await cancel(d.id, b);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("deal_funded");
    expect(await dealStatus(d.id)).toBe("active");
    expect(await piStatus(pi)).toBe("created");
  });

  it("provider network error → 502 refund_path_unavailable, nothing changed", async () => {
    const { b, d, pi } = await stripeDeal();
    stripeCancel.fn = async () => { throw new Error("ECONNRESET"); };
    const res = await cancel(d.id, b);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe("refund_path_unavailable");
    expect(await dealStatus(d.id)).toBe("active");
    expect(await piStatus(pi)).toBe("created");
  });

  it("webhook wins the race after the provider call → 409, deal stays active with its funded PI", async () => {
    const { b, d, pi } = await stripeDeal();
    stripeCancel.fn = async () => {
      await sql`UPDATE payment_intents SET status = 'funded' WHERE id = ${pi}`; // succeeded webhook landed
      return { outcome: "cancelled", status: "canceled" };
    };
    const res = await cancel(d.id, b);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("deal_funded");
    expect(await dealStatus(d.id)).toBe("active");
    expect(await piStatus(pi)).toBe("funded");
  });
});

// ── §5.7 — no resurrection, no payout against a cancelled deal ──────────────

describe("§5.7 legacy cancelled deals holding money are never settled by a sweep", () => {
  async function legacyCancelled() {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id, { status: "cancelled", milestoneStatus: "disputed" });
    legacyFixtureDeals.add(d.id);
    const pi = await seedPI(d.milestoneId, b.id, s.id, "funded");
    return { b, s, d, pi };
  }

  it("resolve-timeouts skips it: deal stays cancelled, PI not released", async () => {
    const { b, d, pi } = await legacyCancelled();
    await seedDispute(d.id, d.milestoneId, b.id, true);
    vi.spyOn(chain, "isOnChainMode").mockReturnValue(false); // the path that used to release + complete
    const res = await app.inject({ method: "POST", url: "/api/disputes/resolve-timeouts", headers: { "x-admin-key": ADMIN_KEY } });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ timedOutDisputes: 1, releasedCount: 0, releaseNotReleasedCount: 1 });
    expect(await dealStatus(d.id)).toBe("cancelled");
    expect(await piStatus(pi)).toBe("funded");
  });

  it("releaseMilestonePayment and completeDealMilestones refuse before any write", async () => {
    const { d, pi } = await legacyCancelled();
    vi.spyOn(chain, "isOnChainMode").mockReturnValue(false);
    const r = await releaseMilestonePayment(d.milestoneId);
    expect(r).toMatchObject({ action: "not_released", currentStatus: "deal_cancelled" });
    const c = await completeDealMilestones(d.id);
    expect(c.action).toBe("settlement_pending");
    expect(await dealStatus(d.id)).toBe("cancelled");
    expect(await piStatus(pi)).toBe("funded");
  });

  it("a zero-payment release on a cancelled deal does not resurrect it", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id, { status: "cancelled", price: 0, milestoneStatus: "delivered" });
    const r = await releaseMilestonePayment(d.milestoneId);
    expect(r.action).toBe("not_released");
    expect(await dealStatus(d.id)).toBe("cancelled");
  });

  it("relayer CLAIM never pays a seller against a cancelled deal; reveal-preimage refuses", async () => {
    const { b, s } = await parties();
    const d = await seedDeal(b.id, s.id, { status: "cancelled" });
    legacyFixtureDeals.add(d.id);
    const intentId = await seedIntent(d.id, b.id, s.id, "reveal_ready", true);
    await sql`INSERT INTO intent_reveals (intent_id, preimage) VALUES (${intentId}, ${Buffer.from("synthetic")})`;
    const fake = fakeRelayerChain();
    const sweep = await runAutoCloseSweep(relayerSql(), fake.client, relayerConfig);
    expect(sweep.claim.scanned).toBe(0);
    expect(fake.calls.claim).toBe(0);

    await sql`UPDATE intents SET status = 'open' WHERE id = ${intentId}`;
    const rv = await app.inject({
      method: "POST", url: `/api/intents/${intentId}/reveal-preimage`, headers: s.headers,
      payload: { agentId: s.id, preimage: "0x" + "aa".repeat(32) },
    });
    expect(rv.statusCode, rv.body).toBe(409);
    expect(JSON.parse(rv.body).code).toBe("DEAL_CANCELLED");
  });
});
