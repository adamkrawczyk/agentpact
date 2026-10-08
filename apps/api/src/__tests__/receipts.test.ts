// Receipts (ap_v31 M2): issuance sweeper + public routes, against the REAL
// migrated schema.
//
// The sweeper lives in apps/relayer-daemon (it is the issuer and holds the
// signing key); the routes live here. Both share packages/receipts. This file
// drives the relayer's sweeper against the same database the API reads, so a
// column-name drift between issuer SQL and schema fails HERE, in CI, rather
// than on the first prod tick (see relayer-schema-contract.test.ts for why
// that matters in this repo).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSeed, merkleProof, merkleRoot, payloadHash, publicKeyFromSeed, signerFromSeed } from "@agentpact/receipts";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";
import { issueReceiptForDeal, runReceiptAnchor, runReceiptSweep, anchorCalldata } from "../../../relayer-daemon/src/receipt-sweeper.js";

type T = Awaited<ReturnType<typeof createTestApp>>;
let app: T["app"];
let sql: T["sql"];

const SEED = generateSeed();
const KEY_ID = "test-2026-10";
const W = (n: number) => "0x" + String(n).repeat(40).slice(0, 40);
const TX = (c: string) => "0x" + c.repeat(64);

const ids: Record<string, string> = {};
let buyer = "";
let seller = "";
let internalBuyer = "";
let offerId = "";
let needId = "";

async function mkAgent(handle: string, wallet: string, internal = false): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal)
    VALUES (${id}, ${handle}, ${handle}, ${wallet}, 'metamask', ${internal})`;
  return id;
}

interface DealSpec {
  status: string;
  total?: number;
  buyerId?: string;
  piStatus?: string | null;
  piTx?: string | null;
  fee?: number;
  dispute?: string;
  intent?: { status: string; expired: boolean };
  criteria?: unknown[];
  checksum?: string;
  judge?: { judge: string; outcome: string; p: number };
  updatedAt?: string;
}

async function mkDeal(name: string, s: DealSpec): Promise<string> {
  const total = s.total ?? 5;
  const b = s.buyerId ?? buyer;
  const [d] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency,
                       max_price_delta_pct, created_at, updated_at, deliverable_hash)
    VALUES (${b}, ${seller}, ${offerId}, ${needId}, ${s.status}, ${total}, 'USDC', 20,
            '2026-10-01T09:00:00Z', ${s.updatedAt ?? "2026-10-02T10:00:00Z"},
            ${Buffer.from("d".repeat(64), "hex")})
    RETURNING id`;
  const dealId = String(d.id);
  const [m] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria)
    VALUES (${dealId}, 0, 'm0', ${total}, 'USDC', ${sql.json((s.criteria ?? []) as never)}) RETURNING id`;
  if (s.piStatus) {
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, tx_hash,
                                   buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m.id}, ${b}, ${seller}, ${total}, ${s.piStatus}, ${s.piTx ?? null}, ${W(1)}, ${W(2)}, ${W(9)})`;
  }
  if (s.intent) {
    const [i] = await sql`
      INSERT INTO intents (buyer_agent_id, seller_agent_id, settlement_class, predicate_type, predicate_params,
                           max_price_usdc, status, expires_at, deal_id, on_chain_funding_tx, updated_at)
      VALUES (${b}, ${seller}, 'A', 'hash', ${sql.json({})}, ${total}, ${s.intent.status},
              ${s.intent.expired ? "2026-10-01T12:00:00Z" : "2026-12-01T00:00:00Z"}, ${dealId}, ${TX("f")},
              '2026-10-02T09:00:00Z')
      RETURNING id`;
    await sql`UPDATE deals SET intent_id = ${i.id} WHERE id = ${dealId}`;
  }
  if (s.fee) {
    await sql`
      INSERT INTO platform_fee_ledger (deal_id, amount_minor, currency, fee_pct_at_close, source)
      VALUES (${dealId}, ${s.fee}, 'USDC', 10, 'usdc')`;
  }
  if (s.dispute) {
    await sql`
      INSERT INTO disputes (deal_id, milestone_id, opened_by, reason, status, expires_at, created_at, resolved_at)
      VALUES (${dealId}, ${m.id}, ${b}, 'not as described', ${s.dispute}, '2026-10-05T00:00:00Z',
              '2026-10-01T15:00:00Z', ${s.dispute === "open" ? null : "2026-10-02T09:30:00Z"})`;
  }
  if (s.checksum) {
    await sql`
      INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum)
      VALUES (${m.id}, ${seller}, ${sql.json([{ url: "https://example.com/out.csv" }])}, ${s.checksum})`;
  }
  if (s.judge) {
    await sql`
      INSERT INTO sweeper_decisions (deal_id, outcome, judge, p, rubric_hash, reason, decided_at)
      VALUES (${dealId}, ${s.judge.outcome}, ${s.judge.judge}, ${s.judge.p}, 'rubric-abc', 'test', '2026-10-02T09:50:00Z')`;
  }
  ids[name] = dealId;
  return dealId;
}

const sweepCfg = () => ({ signingKey: SEED, keyId: KEY_ID, maxPerTick: 100 });

beforeAll(async () => {
  const t = await createTestApp();
  app = t.app;
  sql = t.sql;
  await cleanDatabase();
  await sql`TRUNCATE receipts, receipt_anchor_batches, receipt_signing_keys, sweeper_decisions, sweeper_runs, intents CASCADE`;

  buyer = await mkAgent("rc-buyer", W(1));
  seller = await mkAgent("rc-seller", W(2));
  internalBuyer = await mkAgent("rc-house", W(3), true);
  await mkAgent("rc-newcomer", W(4));
  const [o] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price)
    VALUES (${seller}, 'CSV cleanup', 'Clean a CSV', 'Data', 5) RETURNING id`;
  const [n] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, acceptance_criteria)
    VALUES (${buyer}, 'Need CSV', 'Clean my CSV', 'Data', ${sql.json(["need-level criterion"])}) RETURNING id`;
  offerId = String(o.id);
  needId = String(n.id);

  await mkDeal("settled", {
    status: "completed", piStatus: "released", piTx: TX("a"), fee: 500000,
    criteria: ["412 rows", "UTF-8"], checksum: "sha256:" + "e".repeat(64),
    judge: { judge: "jev-1@classifier.dev", outcome: "complete", p: 0.912 },
    updatedAt: "2026-10-02T10:00:00Z",
  });
  await mkDeal("refunded", { status: "cancelled", piStatus: "refunded", piTx: TX("b"), updatedAt: "2026-10-02T11:00:00Z" });
  await mkDeal("disputed_buyer_won", { status: "cancelled", piStatus: "refunded", piTx: "sim_refund_1234abcd", dispute: "resolved_buyer", updatedAt: "2026-10-02T12:00:00Z" });
  await mkDeal("disputed_seller_won", { status: "completed", piStatus: "released", dispute: "timed_out", fee: 500000, updatedAt: "2026-10-02T13:00:00Z" });
  await mkDeal("timed_out", { status: "active", intent: { status: "refunded", expired: true }, updatedAt: "2026-10-02T14:00:00Z" });
  await mkDeal("cancelled_after_funding", { status: "cancelled", piStatus: "funded", updatedAt: "2026-10-02T15:00:00Z" });
  // Funded, settled, but the buyer is internal: a receipt, labelled not-evidence.
  await mkDeal("practice_settled", { status: "completed", piStatus: "released", buyerId: internalBuyer, updatedAt: "2026-10-02T16:00:00Z" });
  // Never get a receipt:
  await mkDeal("unfunded_completed", { status: "completed", piStatus: null });
  await mkDeal("funded_in_progress", { status: "delivered", piStatus: "funded" });
  await mkDeal("refund_in_flight", { status: "cancelled", piStatus: "pending_refund" });
  await mkDeal("dispute_open", { status: "disputed", piStatus: "disputed", dispute: "open" });
  await mkDeal("practice_unfunded", { status: "completed", total: 0, piStatus: null });
});

describe("receipt sweeper (issuance)", () => {
  it("issues exactly one receipt per funded terminal deal, with the right outcome", async () => {
    const r = await runReceiptSweep(sql as never, sweepCfg());
    expect(r.failed).toBe(0);
    expect(r.acted).toBe(7);
    const rows = await sql`SELECT deal_id, outcome, qualifying, capital_at_risk FROM receipts`;
    const byDeal = new Map(rows.map((x) => [String(x.deal_id), x]));
    for (const outcome of ["settled", "refunded", "disputed_buyer_won", "disputed_seller_won", "timed_out", "cancelled_after_funding"]) {
      expect(byDeal.get(ids[outcome])?.outcome, outcome).toBe(outcome);
      expect(byDeal.get(ids[outcome])?.capital_at_risk, outcome).toBe(true);
    }
    expect(byDeal.get(ids.practice_settled)?.outcome).toBe("settled");
    expect(byDeal.get(ids.practice_settled)?.qualifying).toBe(false);
    expect(byDeal.get(ids.practice_settled)?.capital_at_risk).toBe(false);
  });

  it("never issues a receipt for unfunded or non-terminal deals", async () => {
    const rows = await sql`SELECT deal_id FROM receipts`;
    const got = new Set(rows.map((x) => String(x.deal_id)));
    for (const n of ["unfunded_completed", "funded_in_progress", "refund_in_flight", "dispute_open", "practice_unfunded"]) {
      expect(got.has(ids[n]), n).toBe(false);
    }
  });

  it("is idempotent: a second tick and two concurrent ticks issue nothing new", async () => {
    const again = await runReceiptSweep(sql as never, sweepCfg());
    expect(again.acted).toBe(0);
    expect(again.scanned).toBe(0);
    // A new terminal deal + two racing ticks -> still exactly one receipt for it.
    const late = await mkDeal("late_settled", { status: "completed", piStatus: "released", fee: 500000, updatedAt: "2026-10-02T17:00:00Z" });
    const [a, b] = await Promise.all([runReceiptSweep(sql as never, sweepCfg()), runReceiptSweep(sql as never, sweepCfg())]);
    expect(a.failed + b.failed).toBe(0);
    const [{ c }] = await sql`SELECT count(*)::int AS c FROM receipts WHERE deal_id = ${late}`;
    expect(c).toBe(1);
    const [{ total }] = await sql`SELECT count(*)::int AS total FROM receipts`;
    expect(total).toBe(8);
  });

  it("the database is the idempotency guard: issuing again for a receipted deal reports 'exists', never a second row or a throw", async () => {
    // Simulates the loser of a race that selected the deal before the winner inserted.
    const signer = signerFromSeed(SEED, KEY_ID);
    expect(await issueReceiptForDeal(sql as never, signer, ids.settled, new Date())).toBe("exists");
    expect(await issueReceiptForDeal(sql as never, signer, ids.unfunded_completed, new Date())).toBe("held");
    const [{ c }] = await sql`SELECT count(*)::int AS c FROM receipts WHERE deal_id = ${ids.settled}`;
    expect(c).toBe(1);
  });

  it("records every tick in sweeper_runs (alive vs acted stay separately provable)", async () => {
    const runs = await sql`SELECT scanned, acted, finished_at, error FROM sweeper_runs WHERE sweeper = 'receipts'`;
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs.every((r) => r.finished_at !== null && r.error === null)).toBe(true);
  });

  it("builds the payload from the deal's real records (fee from the ledger, judge, criteria, artifact)", async () => {
    const [r] = await sql`SELECT payload, payload_hash FROM receipts WHERE deal_id = ${ids.settled}`;
    const p = r.payload as Record<string, any>;
    expect(r.payload_hash).toBe(payloadHash(p));
    expect(p.amount).toEqual({
      currency: "USDC", decimals: 6, notional_base_units: "5000000",
      fee_base_units: "500000", fee_source: "ledger", fee_pct_at_close: "10.00",
    });
    expect(p.payer.handle).toBe("rc-buyer");
    expect(p.payer.owner_wallet_key).toBe(W(1));
    expect(p.payee.handle).toBe("rc-seller");
    expect(p.settlement.tx_hashes).toEqual([TX("a")]);
    expect(p.acceptance_test.source).toBe("milestones");
    expect(p.acceptance_test.criteria_text).toContain("412 rows");
    expect(p.artifact).toEqual({ deliverable_hash: "0x" + "d".repeat(64), delivery_checksum: "sha256:" + "e".repeat(64) });
    expect(p.judge).toMatchObject({ judge: "jev-1@classifier.dev", verdict: "complete", p: "0.91200", rubric_hash: "rubric-abc" });
    expect(p.timestamps.closed_at).toBe("2026-10-02T10:00:00.000Z");

    const [t] = await sql`SELECT payload FROM receipts WHERE deal_id = ${ids.timed_out}`;
    expect((t.payload as any).funding.tx_hashes).toEqual([TX("f")]);
    expect((t.payload as any).amount.fee_source).toBe("not_charged");
    const [dbw] = await sql`SELECT payload FROM receipts WHERE deal_id = ${ids.disputed_buyer_won}`;
    expect((dbw.payload as any).dispute).toMatchObject({ opened_by: "buyer", status: "resolved_buyer" });
    // A simulation-mode placeholder is not a chain tx and must never appear as one.
    expect((dbw.payload as any).settlement.tx_hashes).toEqual([]);
    // Need-level criteria are the fallback when milestones carry none.
    expect((dbw.payload as any).acceptance_test).toMatchObject({ source: "need", criteria_text: '["need-level criterion"]' });
  });

  it("refuses to sign when the key id is already registered with a different key (no silent key swap)", async () => {
    await expect(runReceiptSweep(sql as never, { ...sweepCfg(), signingKey: generateSeed() })).rejects.toThrow(/key id/i);
  });
});

describe("public receipt routes (anonymous)", () => {
  it("GET /api/receipts/keys publishes the verification key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/receipts/keys" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toContainEqual(expect.objectContaining({ key_id: KEY_ID, alg: "ed25519", public_key: publicKeyFromSeed(SEED) }));
  });

  it("GET /api/agents/:handle/receipts: newest first, paginated, evidence counted by code", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/rc-seller/receipts?limit=3" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.handle).toBe("rc-seller");
    expect(body.receipts).toHaveLength(3);
    const times = body.receipts.map((r: any) => r.closed_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(body.receipts[0]).toMatchObject({ counterparty: { handle: "rc-buyer" }, role: "payee", counts_as_evidence: true });
    expect(body.next_offset).toBe(3);
    expect(body.counts.evidence).toEqual({
      settled: 2, refunded: 1, disputed: 2, disputed_buyer_won: 1, disputed_seller_won: 1,
      timed_out: 1, cancelled_after_funding: 1, total: 7,
    });
    expect(body.counts.not_counted).toBe(1);
    expect(body.summary).toBe("2 paid external deals settled, 1 refunded, 2 disputed, 1 timed out, 1 cancelled after funding");
    expect(body.evidence_state).toBe("sufficient");

    const p2 = (await app.inject({ method: "GET", url: "/api/agents/rc-seller/receipts?limit=3&offset=6" })).json();
    expect(p2.receipts).toHaveLength(2);
    expect(p2.next_offset).toBeNull();
    const practice = p2.receipts.concat(body.receipts).find((r: any) => r.counterparty.handle === "rc-house");
    expect(practice?.counts_as_evidence).toBe(false);
  });

  it("an agent with no capital-at-risk receipts is explicitly in the insufficient-evidence state", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/agents/rc-newcomer/receipts" })).json();
    expect(body.receipts).toEqual([]);
    expect(body.evidence_state).toBe("insufficient");
    expect(body.summary).toBe("0 paid external deals settled, 0 refunded, 0 disputed");
    expect(body.evidence_note).toMatch(/3/);
  });

  it("unknown handle -> 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/nobody-here/receipts" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/receipts/:id returns the signed envelope and verifies via POST /api/receipts/verify", async () => {
    const [row] = await sql`SELECT id FROM receipts WHERE deal_id = ${ids.settled}`;
    const res = await app.inject({ method: "GET", url: `/api/receipts/${row.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receipt).toMatchObject({ version: "apr-1", key_id: KEY_ID });
    expect(body.anchor).toBeNull();

    const ok = await app.inject({ method: "POST", url: "/api/receipts/verify", payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ valid: true, checks: { hash: true, key_known: true, signature: true, anchor: null, issuer_record: true } });

    const tampered = structuredClone(body);
    tampered.receipt.payload.outcome = "refunded";
    const bad = (await app.inject({ method: "POST", url: "/api/receipts/verify", payload: tampered })).json();
    expect(bad.valid).toBe(false);
    expect(bad.checks.hash).toBe(false);
  });

  it("POST /api/receipts/verify rejects a malformed body with 400, not 500", async () => {
    const res = await app.inject({ method: "POST", url: "/api/receipts/verify", payload: { hello: "world" } });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/receipts/:id with a non-uuid or unknown id -> 404", async () => {
    expect((await app.inject({ method: "GET", url: "/api/receipts/not-a-uuid" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/receipts/${randomUUID()}` })).statusCode).toBe(404);
  });
});

describe("hash anchoring", () => {
  it("does nothing while RECEIPT_ANCHOR_ENABLED is off", async () => {
    let called = 0;
    const r = await runReceiptAnchor(sql as never, { enabled: false, broadcast: async () => { called++; return { txHash: TX("1") }; } });
    expect(r.skipped).toMatch(/disabled/);
    expect(called).toBe(0);
    const [{ c }] = await sql`SELECT count(*)::int AS c FROM receipt_anchor_batches`;
    expect(c).toBe(0);
  });

  it("anchors one Merkle root as calldata, recovers from a failed broadcast without orphaning leaves, and serves proofs", async () => {
    const sent: string[] = [];
    let fail = true;
    const broadcast = async (data: `0x${string}`) => {
      sent.push(data);
      if (fail) throw new Error("rpc down");
      return { txHash: TX("c") };
    };
    await expect(runReceiptAnchor(sql as never, { enabled: true, broadcast })).rejects.toThrow(/rpc down/);
    const [pending] = await sql`SELECT id, root, leaf_count, tx_hash FROM receipt_anchor_batches`;
    expect(pending.tx_hash).toBeNull();
    expect(pending.leaf_count).toBe(8);

    fail = false;
    const r = await runReceiptAnchor(sql as never, { enabled: true, broadcast });
    expect(r.anchoredBatchId).toBe(pending.id);
    const batches = await sql`SELECT id, root, tx_hash FROM receipt_anchor_batches`;
    expect(batches).toHaveLength(1);
    expect(batches[0].tx_hash).toBe(TX("c"));
    // Both attempts broadcast the SAME root — the retry reused the batch.
    expect(sent).toEqual([anchorCalldata(pending.root), anchorCalldata(pending.root)]);

    // Not due again for 24h: a third tick opens no new batch.
    const late = await mkDeal("after_anchor", { status: "completed", piStatus: "released", fee: 500000 });
    await runReceiptSweep(sql as never, sweepCfg());
    const r3 = await runReceiptAnchor(sql as never, { enabled: true, broadcast });
    expect(r3.skipped).toMatch(/not due/);
    const [{ un }] = await sql`SELECT count(*)::int AS un FROM receipts WHERE anchor_batch_id IS NULL AND deal_id = ${late}`;
    expect(un).toBe(1);

    const [row] = await sql`SELECT id FROM receipts WHERE deal_id = ${ids.refunded}`;
    const body = (await app.inject({ method: "GET", url: `/api/receipts/${row.id}` })).json();
    expect(body.anchor).toMatchObject({ root: pending.root, tx_hash: TX("c"), chain: "base" });
    expect(body.anchor.proof.leaf_count).toBe(8);

    const ok = (await app.inject({ method: "POST", url: "/api/receipts/verify", payload: body })).json();
    expect(ok).toMatchObject({ valid: true, checks: { anchor: true } });

    const badProof = structuredClone(body);
    badProof.anchor.proof.index = (badProof.anchor.proof.index + 1) % 8;
    const bad = (await app.inject({ method: "POST", url: "/api/receipts/verify", payload: badProof })).json();
    expect(bad.valid).toBe(false);
    expect(bad.checks.anchor).toBe(false);

    // A self-consistent proof to a root AgentPact never anchored proves nothing.
    const forged = structuredClone(body);
    const leaves = [body.receipt.payload_hash, "ab".repeat(32)];
    forged.anchor.root = merkleRoot(leaves);
    forged.anchor.proof = merkleProof(leaves, 0);
    const fg = (await app.inject({ method: "POST", url: "/api/receipts/verify", payload: forged })).json();
    expect(fg.valid).toBe(false);
    expect(fg.checks.anchor).toBe(false);
    expect(fg.errors.join(" ")).toMatch(/not a root AgentPact anchored/);

    const fakeRoot = structuredClone(body);
    fakeRoot.anchor.root = "0".repeat(64);
    const fr = (await app.inject({ method: "POST", url: "/api/receipts/verify", payload: fakeRoot })).json();
    expect(fr.checks.anchor).toBe(false);
  });
});
