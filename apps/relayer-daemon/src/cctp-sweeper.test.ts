// apps/relayer-daemon/src/cctp-sweeper.test.ts — M1 (lane m1-relay)
//
// The CCTP relayer state machine with mocked Iris + chain. Every scenario runs
// twice: against an in-memory CctpStore (always — CI has no Postgres for this
// workspace) and against the real SQL store on Postgres when TEST_DATABASE_URL
// points at a migrated database (053 + 057), so the SQL is exercised against
// the real schema, not a fake.
//
// Written against the ways this could lose or strand money:
//   - double broadcast (two ticks, a crash between send and persist)
//   - a message someone else already received, retried forever
//   - a mint called "done" without the binding check
//   - a stuck transfer nobody hears about

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import {
  IrisRateLimitedError,
  encodeHookData,
  messageHash as keccak256OfMessage,
  type IrisMessage,
  type IrisMessagesResult,
} from "@agentpact/payouts";
import {
  runCctpSweep,
  type CctpAlert,
  type CctpChainClient,
  type CctpSweeperConfig,
  type GatewayEvent,
  type GatewayReceipt,
} from "./cctp-sweeper.js";
import { sqlCctpStore, type CctpStore, type CctpTransfer, type NewChildTransfer, type TransferPatch, type CctpStatus } from "./cctp-store.js";
import type { CctpBindingResult } from "./cctp-binding.js";
import type { SqlClient } from "./sweepers.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const GATEWAY = "0x9999999999999999999999999999999999999999" as const;
const GATEWAY32 = `0x${"0".repeat(24)}${"9".repeat(40)}` as Hex;
const DEAL_UUID = "0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f";
const DEAL_REF = "0xd3a02653d32272d7ee7a5766b56d29f5f1401deb279481a3d5e204f268c0420f" as Hex;
const INTENT_ID = `0x${"7".repeat(64)}` as Hex;
const T0 = new Date("2026-10-07T12:00:00Z");
const MIN = 60_000;

const u32 = (n: number) => n.toString(16).padStart(8, "0");
const u256 = (n: bigint) => n.toString(16).padStart(64, "0");
const txh = (c: string) => `0x${c.repeat(64)}` as Hex;
const nonceOf = (c: string) => `0x${c.repeat(64)}` as Hex;

function cctpMessage(o: {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  mintRecipient: Hex;
  destinationCaller: Hex;
  messageSender: Hex;
  amount: bigint;
  feeExecuted: bigint;
  hookData: Hex;
}): Hex {
  return ("0x" +
    u32(1) + u32(o.sourceDomain) + u32(o.destinationDomain) + o.nonce.slice(2) +
    "a".repeat(64) + "b".repeat(64) + o.destinationCaller.slice(2) + u32(1000) + u32(1000) +
    u32(1) + "c".repeat(64) + o.mintRecipient.slice(2) + u256(o.amount) + o.messageSender.slice(2) +
    u256(1_000n) + u256(o.feeExecuted) + u256(0n) + o.hookData.slice(2)) as Hex;
}

function depositHook(o: { payoutDomain?: number; expiresAt?: bigint; dealRef?: Hex } = {}): Hex {
  return encodeHookData({
    version: 1,
    dealRef: o.dealRef ?? DEAL_REF,
    verifier: "0x2222222222222222222222222222222222222222",
    params: "0x",
    sellerTarget: (o.payoutDomain ?? 6) === 6 ? "0x3333333333333333333333333333333333333333" : GATEWAY,
    expiresAt: o.expiresAt ?? BigInt(Math.floor(T0.getTime() / 1000) + 3600),
    price: 5_000_000n,
    refundRecipient: `0x${"4".repeat(64)}`,
    payoutDomain: o.payoutDomain ?? 6,
    payoutRecipient: `0x${"5".repeat(64)}`,
  });
}

function depositMessage(nonce: Hex, hook = depositHook(), sourceDomain = 5): Hex {
  return cctpMessage({
    sourceDomain, destinationDomain: 6, nonce, mintRecipient: GATEWAY32, destinationCaller: GATEWAY32,
    messageSender: `0x${"d".repeat(64)}`, amount: 5_000_501n, feeExecuted: 500n, hookData: hook,
  });
}

function gatewayBurnMessage(destinationDomain: number, nonce: Hex): Hex {
  return cctpMessage({
    sourceDomain: 6, destinationDomain, nonce, mintRecipient: `0x${"5".repeat(64)}`, destinationCaller: `0x${"0".repeat(64)}`,
    messageSender: GATEWAY32, amount: 4_000_000n, feeExecuted: 0n, hookData: "0x636374702d666f72776172640000000000000000000000000000000000000000",
  });
}

const complete = (message: Hex, extra: Partial<IrisMessage> = {}): IrisMessagesResult => ({
  kind: "found",
  messages: [{ message, attestation: "0xa77e57", eventNonce: null, status: "complete", cctpVersion: 2, delayReason: null, forwardState: null, forwardTxHash: null, ...extra }],
});
const pending: IrisMessagesResult = {
  kind: "found",
  messages: [{ message: null, attestation: null, eventNonce: null, status: "pending_confirmations", cctpVersion: 2, delayReason: null, forwardState: null, forwardTxHash: null }],
};

// ── fakes ───────────────────────────────────────────────────────────────────

class Clock {
  t = T0.getTime();
  now = () => new Date(this.t);
  advance(ms: number) { this.t += ms; }
}

class FakeIris {
  answers = new Map<string, IrisMessagesResult | Error>();
  calls: string[] = [];
  async getMessages(domain: number, tx: Hex): Promise<IrisMessagesResult> {
    this.calls.push(`${domain}:${tx}`);
    const a = this.answers.get(tx) ?? { kind: "not_found" as const };
    if (a instanceof Error) throw a;
    return a;
  }
}

class FakeChain implements CctpChainClient {
  usedNonces = new Set<string>();
  receipts = new Map<string, GatewayReceipt | null>();
  relayCalls: Array<{ message: Hex; attestation: Hex }> = [];
  refundCalls: Array<{ intentId: Hex; maxFee: bigint }> = [];
  claimCalls: Array<{ intentId: Hex; witness: Hex; maxFee: bigint }> = [];
  /** What the next relayDeposit/refund/claim tx produces. */
  nextReceipt: (kind: string) => GatewayReceipt | null = () => null;
  relayError: Error | null = null;
  depositOutcome: { txHash: Hex; event: GatewayEvent } | null = null;
  settleOutcome: { txHash: Hex; event: GatewayEvent } | null = null;
  private n = 0;

  private send(kind: string): Hex {
    const h = txh((++this.n).toString(16).slice(-1));
    this.receipts.set(h, this.nextReceipt(kind));
    return h;
  }
  async isNonceUsed(nonce: Hex) { return this.usedNonces.has(nonce); }
  async relayDeposit(message: Hex, attestation: Hex) {
    if (this.relayError) throw this.relayError;
    this.relayCalls.push({ message, attestation });
    return this.send("relay");
  }
  async refund(intentId: Hex, maxFee: bigint) {
    this.refundCalls.push({ intentId, maxFee });
    return this.send("refund");
  }
  async claimAndForward(intentId: Hex, _c: Hex, witness: Hex, maxFee: bigint) {
    this.claimCalls.push({ intentId, witness, maxFee });
    return this.send("payout");
  }
  async getReceipt(h: Hex) { return this.receipts.get(h) ?? null; }
  async findDepositOutcome() { return this.depositOutcome; }
  async findSettleOutcome() { return this.settleOutcome; }
}

const boundEvent = (nonce: Hex): GatewayEvent => ({
  name: "CctpDepositBound", intentId: INTENT_ID, dealRef: DEAL_REF, sourceDomain: 5, amount: 5_000_501n, feeExecuted: 500n, nonce,
});

// ── stores ──────────────────────────────────────────────────────────────────

interface Seed {
  direction?: CctpTransfer["direction"];
  status?: CctpStatus;
  sourceDomain?: number;
  destinationDomain?: number;
  sourceTxHash?: Hex | null;
  dealRef?: Hex | null;
  amount?: bigint;
  createdAt?: Date;
  patch?: TransferPatch;
  /** Attach an intents row in this status (+ a reveal when reveal_ready). */
  intentStatus?: string;
}

interface Harness {
  store: CctpStore;
  seed(s: Seed): Promise<string>;
  get(id: string): Promise<CctpTransfer>;
  children(parentId: string): Promise<CctpTransfer[]>;
  intentStatus(intentId: string): Promise<string | null>;
  runs(): Promise<number>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** In-memory CctpStore with the SQL store's compare-and-set semantics. */
function memoryHarness(): Harness {
  const rows = new Map<string, CctpTransfer & { leaseUntil: Date | null }>();
  const intents = new Map<string, { status: string; reveal: boolean }>();
  let runs = 0;
  let seq = 0;
  const WORK: CctpStatus[] = ["submitted", "attestation_pending", "attested", "relayed", "forwarded"];
  const clone = (r: CctpTransfer) => ({ ...r });
  const base = (over: Partial<CctpTransfer>): CctpTransfer & { leaseUntil: Date | null } => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    direction: "deposit", dealId: null, intentId: null, dealRef: null, sourceDomain: 5, destinationDomain: 6,
    sourceTxHash: null, messageHash: null, nonce: null, amount: 5_000_501n, maxFee: null, feeExecuted: null,
    recipient: null, status: "submitted", attempts: 0, lastError: null, nextAttemptAt: null, destinationTxHash: null,
    createdAt: T0, updatedAt: T0, statusChangedAt: T0, message: null, attestation: null, onchainIntentId: null,
    parentTransferId: null, payoutDomain: null, payoutRecipient: null, refundRecipient: null, intentExpiresAt: null,
    stuckReason: null, stuckAt: null, leaseUntil: null, ...over,
  });
  const store: CctpStore = {
    async openRun() { runs++; return `run-${runs}`; },
    async finishRun() {},
    async due(now, limit) {
      return [...rows.values()]
        .filter((r) => WORK.includes(r.status) && (!r.nextAttemptAt || r.nextAttemptAt <= now) && (!r.leaseUntil || r.leaseUntil <= now))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit).map(clone);
    },
    async lease(id, status, attempts, now, until) {
      const r = rows.get(id);
      if (!r || r.status !== status || r.attempts !== attempts || (r.leaseUntil && r.leaseUntil > now)) return false;
      r.leaseUntil = until;
      r.updatedAt = now;
      return true;
    },
    async update(id, expect, patch, now) {
      const r = rows.get(id);
      if (!r || r.status !== expect) return false;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || k === "alertedAt") continue;
        (r as unknown as Record<string, unknown>)[k] = v;
      }
      if (patch.status && patch.status !== expect) r.statusChangedAt = now;
      r.leaseUntil = null;
      r.updatedAt = now;
      return true;
    },
    async refundCandidates(cutoff, limit) {
      return [...rows.values()].filter((r) => {
        if (r.direction !== "deposit" || r.status !== "bound" || !r.onchainIntentId || !r.intentExpiresAt || r.intentExpiresAt >= cutoff) return false;
        const i = r.intentId ? intents.get(r.intentId) : undefined;
        if (i && ["claimed", "refunded", "reveal_ready"].includes(i.status)) return false;
        return ![...rows.values()].some((c) => c.parentTransferId === r.id);
      }).slice(0, limit).map(clone);
    },
    async payoutCandidates(limit) {
      return [...rows.values()].filter((r) => {
        if (r.direction !== "deposit" || r.status !== "bound" || !r.onchainIntentId) return false;
        if (r.payoutDomain === null || r.payoutDomain === 6) return false;
        const i = r.intentId ? intents.get(r.intentId) : undefined;
        if (!i || i.status !== "reveal_ready" || !i.reveal) return false;
        return ![...rows.values()].some((c) => c.parentTransferId === r.id);
      }).slice(0, limit).map(clone);
    },
    async insertChild(parent, child: NewChildTransfer, now) {
      if ([...rows.values()].some((c) => c.parentTransferId === parent.id)) return null;
      if (child.direction === "payout" && parent.intentId && [...rows.values()].some((c) => c.direction === "payout" && c.intentId === parent.intentId)) return null;
      const r = base({
        direction: child.direction, dealId: parent.dealId, intentId: parent.intentId, dealRef: parent.dealRef,
        sourceDomain: child.sourceDomain, destinationDomain: child.destinationDomain, sourceTxHash: child.sourceTxHash ?? null,
        amount: child.amount, recipient: child.recipient, status: child.status ?? "submitted",
        onchainIntentId: parent.onchainIntentId, parentTransferId: parent.id, createdAt: now, updatedAt: now, statusChangedAt: now,
      });
      rows.set(r.id, r);
      return clone(r);
    },
    async reveal(intentId) {
      const i = intents.get(intentId);
      return i?.reveal ? { ciphertext: "0x" as Hex, witness: "0x5ec2e7" as Hex } : null;
    },
    async markIntentClaimed(intentId) {
      const i = intents.get(intentId);
      if (i && i.status === "reveal_ready") i.status = "claimed";
    },
    async stuckSummary() {
      const s = [...rows.values()].filter((r) => r.status === "stuck");
      const oldest = s.map((r) => r.stuckAt!).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      return { count: s.length, oldestStuckAt: oldest };
    },
  };
  return {
    store,
    async seed(s) {
      const r = base({
        direction: s.direction ?? "deposit", status: s.status ?? "submitted", sourceDomain: s.sourceDomain ?? 5,
        destinationDomain: s.destinationDomain ?? 6, sourceTxHash: s.sourceTxHash === undefined ? txh("e") : s.sourceTxHash,
        dealRef: s.dealRef === undefined ? DEAL_REF : s.dealRef, amount: s.amount ?? 5_000_501n,
        createdAt: s.createdAt ?? T0, updatedAt: s.createdAt ?? T0, statusChangedAt: s.createdAt ?? T0,
      });
      if (s.intentStatus) {
        const intentId = `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
        intents.set(intentId, { status: s.intentStatus, reveal: s.intentStatus === "reveal_ready" });
        r.intentId = intentId;
      }
      for (const [k, v] of Object.entries(s.patch ?? {})) if (k !== "alertedAt") (r as unknown as Record<string, unknown>)[k] = v;
      rows.set(r.id, r);
      return r.id;
    },
    async get(id) { return clone(rows.get(id)!); },
    async children(pid) { return [...rows.values()].filter((r) => r.parentTransferId === pid).map(clone); },
    async intentStatus(iid) { return intents.get(iid)?.status ?? null; },
    async runs() { return runs; },
    async reset() { rows.clear(); intents.clear(); },
    async close() {},
  };
}

/** The production SQL store on a real, migrated Postgres. */
async function pgHarness(url: string): Promise<Harness> {
  const { default: postgres } = await import("postgres");
  const pg = postgres(url, { prepare: false, max: 2, onnotice: () => {} });
  const sql = pg as unknown as SqlClient;
  await pg`DELETE FROM cctp_transfers`;
  await pg`DELETE FROM sweeper_runs WHERE sweeper = 'cctp'`;
  const [agent] = await pg`
    INSERT INTO agents (handle, display_name) VALUES (${"m1relay-" + Date.now()}, 'm1-relay test') RETURNING id
  `;
  const store = sqlCctpStore(sql);
  let txn = 0;
  return {
    store,
    async seed(s) {
      let intentId: string | null = null;
      if (s.intentStatus) {
        const [i] = await pg`
          INSERT INTO intents (on_chain_id, buyer_agent_id, settlement_class, predicate_type, predicate_params, max_price_usdc, status, expires_at)
          VALUES (${Buffer.from(String(++txn).padStart(64, "0"), "hex")}, ${agent.id}, 'A', 'hash-preimage-v1', '{}'::jsonb, 5, ${s.intentStatus}, ${T0})
          RETURNING id
        `;
        intentId = i.id;
        if (s.intentStatus === "reveal_ready") {
          await pg`INSERT INTO intent_reveals (intent_id, preimage, ciphertext) VALUES (${intentId}, ${Buffer.from("5ec2e7", "hex")}, NULL)`;
        }
      }
      const created = s.createdAt ?? T0;
      const [r] = await pg`
        INSERT INTO cctp_transfers (direction, intent_id, deal_ref, source_domain, destination_domain, source_tx_hash,
          amount_base_units, status, created_at, updated_at, status_changed_at)
        VALUES (${s.direction ?? "deposit"}, ${intentId}, ${s.dealRef === undefined ? DEAL_REF : s.dealRef}, ${s.sourceDomain ?? 5},
          ${s.destinationDomain ?? 6}, ${s.sourceTxHash === undefined ? `0x${randomBytes(32).toString("hex")}` : s.sourceTxHash},
          ${(s.amount ?? 5_000_501n).toString()}, ${s.status ?? "submitted"}, ${created}, ${created}, ${created})
        RETURNING id
      `;
      if (s.patch) await store.update(r.id, s.status ?? "submitted", s.patch, created);
      return r.id;
    },
    async get(id) {
      const { rowToTransfer } = await import("./cctp-store.js");
      const [r] = await pg`SELECT * FROM cctp_transfers WHERE id = ${id}`;
      return rowToTransfer(r as never);
    },
    async children(pid) {
      const { rowToTransfer } = await import("./cctp-store.js");
      const rs = await pg`SELECT * FROM cctp_transfers WHERE parent_transfer_id = ${pid}`;
      return rs.map((r) => rowToTransfer(r as never));
    },
    async intentStatus(iid) {
      const [r] = await pg`SELECT status FROM intents WHERE id = ${iid}`;
      return (r?.status as string) ?? null;
    },
    async runs() {
      const [r] = await pg`SELECT COUNT(*)::int AS n FROM sweeper_runs WHERE sweeper = 'cctp' AND finished_at IS NOT NULL`;
      return r.n as number;
    },
    async reset() {
      await pg`DELETE FROM cctp_transfers`;
    },
    async close() {
      await pg`DELETE FROM cctp_transfers`;
      await pg`DELETE FROM intent_reveals WHERE intent_id IN (SELECT id FROM intents WHERE buyer_agent_id = ${agent.id})`;
      await pg`DELETE FROM intents WHERE buyer_agent_id = ${agent.id}`;
      await pg`DELETE FROM agents WHERE id = ${agent.id}`;
      await pg.end();
    },
  };
}

// ── harness wiring ──────────────────────────────────────────────────────────

const CFG: CctpSweeperConfig = {
  gateway: GATEWAY,
  maxPerTick: 20,
  attestationTimeoutMs: 45 * MIN,
  bindTimeoutMs: 30 * MIN,
  forwardTimeoutMs: 60 * MIN,
  maxAttempts: 3,
  retryBaseMs: MIN,
  retryMaxMs: 30 * MIN,
  txDropAfterMs: 10 * MIN,
  receiptWaitMs: 0,
  receiptPollMs: 0,
  refundGraceMs: 5 * MIN,
  leaseMs: 10 * MIN,
};

function rig(h: Harness, over: Partial<CctpSweeperConfig> = {}) {
  const clock = new Clock();
  const iris = new FakeIris();
  const chain = new FakeChain();
  const alerts: CctpAlert[] = [];
  let binding: CctpBindingResult = { bound: true, intentId: null, onchainIntentId: INTENT_ID };
  const bindCalls: string[] = [];
  const tick = () => runCctpSweep({
    get store() { return h.store; },
    chain,
    iris,
    verifyBinding: async (i) => { bindCalls.push(i.transferId); return binding; },
    quoteForwardFee: async () => ({ maxFee: 308_810n, minFinalityThreshold: 2000 }),
    alert: (a) => alerts.push(a),
    config: { ...CFG, ...over },
    now: clock.now,
    sleep: async () => {},
    random: () => 0.5,
  });
  return {
    clock, iris, chain, alerts, tick, bindCalls,
    setBinding(b: CctpBindingResult) { binding = b; },
  };
}

// ── scenarios ───────────────────────────────────────────────────────────────

function scenarios(name: string, make: () => Promise<Harness>) {
  describe(`cctp sweeper [${name} store]`, () => {
    let h: Harness;
    before(async () => { h = await make(); });
    beforeEach(async () => { await h.reset(); });
    after(async () => { await h.close(); });

    it("deposit happy path: submitted → attestation_pending → attested → relayed → bound", async () => {
      const r = rig(h);
      const src = txh("e");
      const id = await h.seed({ sourceTxHash: src });
      const n = nonceOf("1");

      await r.tick();
      assert.equal((await h.get(id)).status, "attestation_pending", "Iris has nothing yet");

      r.iris.answers.set(src, pending);
      r.clock.advance(MIN);
      await r.tick();
      assert.equal((await h.get(id)).status, "attestation_pending", "pending attestation is not relayable");

      const msg = depositMessage(n, depositHook({ payoutDomain: 5 }));
      r.iris.answers.set(src, complete(msg));
      r.clock.advance(MIN);
      await r.tick();
      let row = await h.get(id);
      assert.equal(row.status, "attested");
      assert.equal(row.nonce, n);
      assert.equal(row.message, msg);
      assert.equal(row.payoutDomain, 5);
      assert.equal(row.feeExecuted, 500n);
      assert.equal(row.refundRecipient, `0x${"4".repeat(64)}`);

      r.chain.nextReceipt = () => ({ status: "success", events: [boundEvent(n)] });
      r.clock.advance(MIN);
      await r.tick();
      row = await h.get(id);
      assert.equal(r.chain.relayCalls.length, 1);
      assert.equal(r.chain.relayCalls[0].message, msg);
      assert.equal(row.status, "relayed", "a mint is NOT bound until the binding check says so");
      assert.equal(row.onchainIntentId, INTENT_ID);
      assert.ok(row.destinationTxHash);
      assert.equal(r.bindCalls.length, 0);

      r.clock.advance(MIN);
      const res = await r.tick();
      row = await h.get(id);
      assert.equal(row.status, "bound");
      assert.deepEqual(r.bindCalls, [id]);
      assert.equal(r.alerts.length, 0);
      assert.equal(res.stuck.count, 0);
    });

    it("idempotency: an unconfirmed relay is re-checked by receipt, never re-broadcast", async () => {
      const r = rig(h);
      const n = nonceOf("2");
      const id = await h.seed({ status: "attested", patch: { message: depositMessage(n), attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(depositMessage(n)) } });
      r.chain.nextReceipt = () => null; // broadcast, not mined yet

      await r.tick();
      const sent = (await h.get(id)).destinationTxHash;
      assert.ok(sent, "tx hash persisted right after broadcast");
      r.clock.advance(MIN);
      await r.tick();
      r.clock.advance(MIN);
      await r.tick();
      assert.equal(r.chain.relayCalls.length, 1, "two more ticks, still exactly one broadcast");

      r.chain.receipts.set(sent!, { status: "success", events: [boundEvent(n)] });
      r.clock.advance(MIN);
      await r.tick();
      assert.equal((await h.get(id)).status, "relayed");
      assert.equal(r.chain.relayCalls.length, 1);
    });

    it("idempotency: two concurrent sweeps on the same row broadcast once (lease)", async () => {
      const r = rig(h);
      const n = nonceOf("3");
      const id = await h.seed({ status: "attested", patch: { message: depositMessage(n), attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(depositMessage(n)) } });
      r.chain.nextReceipt = () => ({ status: "success", events: [boundEvent(n)] });
      await Promise.all([r.tick(), r.tick()]);
      assert.equal(r.chain.relayCalls.length, 1);
      // The losing sweep may legitimately run the NEXT step (bind) on the row.
      assert.ok(["relayed", "bound"].includes((await h.get(id)).status));
    });

    it("idempotency: a sweep holding a stale copy of the row cannot broadcast again", async () => {
      const r = rig(h);
      const n = nonceOf("a");
      const id = await h.seed({ status: "attested", patch: { message: depositMessage(n), attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(depositMessage(n)) } });
      const stale = await h.store.due(r.clock.now(), 20); // read before the first sweep acts
      r.chain.nextReceipt = () => null; // sent, not mined yet: nonce not used, no event
      await r.tick();
      assert.equal(r.chain.relayCalls.length, 1);
      const real = h.store;
      h.store = { ...real, due: async () => stale };
      try {
        await r.tick();
      } finally {
        h.store = real;
      }
      assert.equal(r.chain.relayCalls.length, 1, "the stale reader must lose the lease");
      assert.ok((await h.get(id)).destinationTxHash);
    });

    it("nonce already used on Base → reconciled from the gateway event, no broadcast", async () => {
      const r = rig(h);
      const n = nonceOf("4");
      const id = await h.seed({ status: "attested", patch: { message: depositMessage(n), attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(depositMessage(n)) } });
      r.chain.usedNonces.add(n);
      r.chain.depositOutcome = { txHash: txh("f"), event: boundEvent(n) };
      await r.tick();
      const row = await h.get(id);
      assert.equal(r.chain.relayCalls.length, 0, "never re-send a received message");
      assert.equal(row.status, "relayed");
      assert.equal(row.destinationTxHash, txh("f"));
      assert.equal(r.alerts.length, 0);
    });

    it("nonce used but no gateway event found → stuck + alert (not retried forever)", async () => {
      const r = rig(h);
      const n = nonceOf("5");
      const id = await h.seed({ status: "attested", patch: { message: depositMessage(n), attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(depositMessage(n)) } });
      r.chain.usedNonces.add(n);
      await r.tick();
      assert.equal((await h.get(id)).status, "stuck");
      assert.equal(r.alerts.length, 1);
      assert.equal(r.alerts[0].kind, "nonce_used_unreconciled");
    });

    it("relay revert → retry with growing backoff → stuck after max attempts, alert fires once", async () => {
      const r = rig(h);
      const n = nonceOf("6");
      const id = await h.seed({ status: "attested", patch: { message: depositMessage(n), attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(depositMessage(n)) } });
      r.chain.nextReceipt = () => ({ status: "reverted", events: [] });

      await r.tick();
      let row = await h.get(id);
      assert.equal(row.status, "attested");
      assert.equal(row.attempts, 1);
      assert.equal(row.destinationTxHash, null, "reverted tx hash cleared so the retry is a fresh send");
      const wait1 = row.nextAttemptAt!.getTime() - r.clock.t;
      assert.match(row.lastError ?? "", /reverted/);

      await r.tick();
      assert.equal(r.chain.relayCalls.length, 1, "backoff respected: no resend before nextAttemptAt");

      r.clock.t = row.nextAttemptAt!.getTime();
      await r.tick();
      row = await h.get(id);
      assert.equal(row.attempts, 2);
      const wait2 = row.nextAttemptAt!.getTime() - r.clock.t;
      assert.ok(wait2 > wait1, `backoff grows (${wait1} → ${wait2})`);

      r.clock.t = row.nextAttemptAt!.getTime();
      const res = await r.tick();
      row = await h.get(id);
      assert.equal(row.status, "stuck");
      assert.equal(r.chain.relayCalls.length, 3);
      assert.match(row.stuckReason ?? "", /^relay_failed/);
      assert.equal(r.alerts.length, 1);
      assert.equal(r.alerts[0].kind, "relay_failed");
      assert.equal(r.alerts[0].transferId, id);
      assert.equal(res.stuck.count, 1);

      r.clock.advance(60 * MIN);
      const res2 = await r.tick();
      assert.equal(r.alerts.length, 1, "a stuck row is not re-alerted every tick");
      assert.equal(res2.stuck.oldestStuckAgeMs, 60 * MIN);
    });

    it("attestation timeout → stuck + alert", async () => {
      const r = rig(h);
      const src = txh("8");
      const id = await h.seed({ sourceTxHash: src, createdAt: new Date(T0.getTime() - 46 * MIN) });
      r.iris.answers.set(src, pending);
      await r.tick();
      const row = await h.get(id);
      assert.equal(row.status, "stuck");
      assert.equal(r.alerts.length, 1);
      assert.equal(r.alerts[0].kind, "attestation_timeout");
      assert.equal(r.iris.calls.length, 0, "a timed-out row does not keep hammering Iris");
    });

    it("binding never confirms → retries, then stuck as mint_without_bound_intent + alert", async () => {
      const r = rig(h);
      const n = nonceOf("9");
      const id = await h.seed({ status: "relayed", patch: { nonce: n, messageHash: keccak256OfMessage(depositMessage(n)), destinationTxHash: txh("a"), onchainIntentId: INTENT_ID } });
      r.setBinding({ bound: false, reason: "IntentCreated not found", retryable: true });
      await r.tick();
      let row = await h.get(id);
      assert.equal(row.status, "relayed");
      assert.equal(row.attempts, 1);
      r.clock.advance(31 * MIN);
      await r.tick();
      row = await h.get(id);
      assert.equal(row.status, "stuck");
      assert.equal(r.alerts.at(-1)?.kind, "mint_without_bound_intent");
    });

    it("gateway rejected the deposit → refunded, return leg tracked as a refund row, no alert", async () => {
      const r = rig(h);
      const n = nonceOf("b");
      const msg = depositMessage(n);
      const id = await h.seed({ status: "attested", patch: { message: msg, attestation: "0xa77e57", nonce: n, messageHash: keccak256OfMessage(msg), refundRecipient: `0x${"4".repeat(64)}` } });
      r.chain.nextReceipt = () => ({ status: "success", events: [{ name: "CctpDepositRejected", messageHash: keccak256OfMessage(msg), reason: "expired" }] });
      await r.tick();
      const row = await h.get(id);
      assert.equal(row.status, "refunded");
      const [child] = await h.children(id);
      assert.equal(child.direction, "refund");
      assert.equal(child.status, "attestation_pending");
      assert.equal(child.destinationDomain, 5);
      assert.equal(child.sourceTxHash, row.destinationTxHash);
      assert.equal(r.alerts.length, 0);
    });

    it("a burn not addressed to the gateway is failed + alerted, never relayed", async () => {
      const r = rig(h);
      const src = txh("c");
      const id = await h.seed({ sourceTxHash: src });
      const foreign = cctpMessage({
        sourceDomain: 5, destinationDomain: 6, nonce: nonceOf("c"), mintRecipient: `0x${"1".repeat(64)}`,
        destinationCaller: `0x${"0".repeat(64)}`, messageSender: `0x${"d".repeat(64)}`, amount: 1n, feeExecuted: 0n, hookData: "0x01",
      });
      r.iris.answers.set(src, complete(foreign));
      await r.tick();
      assert.equal((await h.get(id)).status, "failed");
      assert.equal(r.alerts[0]?.kind, "burn_not_for_gateway");
      assert.equal(r.chain.relayCalls.length, 0);
    });

    it("Iris 429 lockout: one call, rows pushed past the lockout, no error", async () => {
      const r = rig(h);
      const a = txh("d"); const b = txh("0");
      const ia = await h.seed({ sourceTxHash: a });
      const ib = await h.seed({ sourceTxHash: b });
      r.iris.answers.set(a, new IrisRateLimitedError(300_000));
      r.iris.answers.set(b, new IrisRateLimitedError(300_000));
      await r.tick();
      assert.equal(r.iris.calls.length, 1);
      for (const id of [ia, ib]) {
        const row = await h.get(id);
        assert.equal(row.nextAttemptAt?.getTime(), r.clock.t + 300_000);
      }
      assert.equal(r.alerts.length, 0);
    });

    it("refund happy path: expired bound deposit → gateway.refund → attestation → forwarded → completed", async () => {
      const r = rig(h);
      const dep = await h.seed({
        status: "bound", intentStatus: "open",
        patch: { onchainIntentId: INTENT_ID, feeExecuted: 501n, refundRecipient: `0x${"4".repeat(64)}`, intentExpiresAt: new Date(T0.getTime() - 10 * MIN) },
      });
      r.chain.nextReceipt = (k) => k === "refund"
        ? { status: "success", events: [{ name: "CctpRefundSent", intentId: INTENT_ID, destinationDomain: 5, recipient: `0x${"4".repeat(64)}`, amount: 5_000_000n, maxFee: 308_810n }] }
        : null;

      const res = await r.tick();
      assert.equal(res.spawned, 1);
      const [child] = await h.children(dep);
      assert.equal(r.chain.refundCalls.length, 1);
      assert.equal(r.chain.refundCalls[0].intentId, INTENT_ID);
      assert.equal(r.chain.refundCalls[0].maxFee, 308_810n);
      let c = await h.get(child.id);
      assert.equal(c.status, "attestation_pending");
      assert.equal(c.amount, 5_000_000n);
      assert.equal((await h.get(dep)).status, "refunded");

      r.iris.answers.set(c.sourceTxHash!, complete(gatewayBurnMessage(5, nonceOf("e")), { forwardState: "PENDING" }));
      r.clock.advance(MIN);
      await r.tick();
      assert.equal((await h.get(child.id)).status, "forwarded");

      r.iris.answers.set(c.sourceTxHash!, complete(gatewayBurnMessage(5, nonceOf("e")), { forwardTxHash: "5ignatureOnSolana" }));
      r.clock.advance(MIN);
      await r.tick();
      c = await h.get(child.id);
      assert.equal(c.status, "completed");
      assert.equal(c.destinationTxHash, "5ignatureOnSolana");

      r.clock.advance(MIN);
      await r.tick();
      assert.equal(r.chain.refundCalls.length, 1, "a settled deposit is never refunded twice");
      assert.equal((await h.children(dep)).length, 1);
    });

    it("payout happy path: reveal on a cross-chain intent → claimAndForward → intent claimed → completed", async () => {
      const r = rig(h);
      const dep = await h.seed({
        status: "bound", intentStatus: "reveal_ready",
        patch: { onchainIntentId: INTENT_ID, feeExecuted: 501n, payoutDomain: 0, payoutRecipient: `0x${"0".repeat(24)}${"5".repeat(40)}`, intentExpiresAt: new Date(T0.getTime() + 60 * MIN) },
      });
      r.chain.nextReceipt = (k) => k === "payout"
        ? { status: "success", events: [{ name: "CctpPayoutSent", intentId: INTENT_ID, domain: 0, recipient: `0x${"0".repeat(24)}${"5".repeat(40)}`, amount: 4_500_000n, maxFee: 308_810n }] }
        : null;
      await r.tick();
      const [child] = await h.children(dep);
      assert.equal(child.direction, "payout");
      assert.equal(r.chain.claimCalls.length, 1);
      assert.equal(r.chain.claimCalls[0].witness, "0x5ec2e7");
      const c = await h.get(child.id);
      assert.equal(c.status, "attestation_pending");
      assert.equal(c.destinationDomain, 0);
      assert.equal(c.amount, 4_500_000n);
      assert.equal((await h.get(dep)).status, "completed");
      assert.equal(await h.intentStatus(child.intentId!), "claimed");

      r.iris.answers.set(c.sourceTxHash!, complete(gatewayBurnMessage(0, nonceOf("f")), { forwardTxHash: txh("1") }));
      r.clock.advance(MIN);
      await r.tick();
      assert.equal((await h.get(child.id)).status, "completed");
    });

    it("a refund that landed before a crash is reconciled, not re-sent", async () => {
      const r = rig(h);
      const dep = await h.seed({
        status: "bound", intentStatus: "open",
        patch: { onchainIntentId: INTENT_ID, intentExpiresAt: new Date(T0.getTime() - 10 * MIN) },
      });
      await r.tick(); // spawns + sends; receipt unknown (null) → held with hash
      const [child] = await h.children(dep);
      assert.equal(r.chain.refundCalls.length, 1);
      // Simulate a crash that lost the hash: clear it as an operator restore would.
      await h.store.update(child.id, "submitted", { sourceTxHash: null }, r.clock.now());
      r.chain.settleOutcome = {
        txHash: txh("9"),
        event: { name: "CctpRefundSent", intentId: INTENT_ID, destinationDomain: 5, recipient: `0x${"4".repeat(64)}`, amount: 5_000_000n, maxFee: 1n },
      };
      r.clock.advance(MIN);
      await r.tick();
      assert.equal(r.chain.refundCalls.length, 1, "attempts>0 → look for the landed refund first");
      const c = await h.get(child.id);
      assert.equal(c.status, "attestation_pending");
      assert.equal(c.sourceTxHash, txh("9"));
    });

    it("records a sweeper_runs row per tick", async () => {
      const r = rig(h);
      const before = await h.runs();
      await r.tick();
      assert.equal(await h.runs(), before + 1);
    });
  });
}

scenarios("memory", async () => memoryHarness());

const PG_URL = process.env.TEST_DATABASE_URL;
if (PG_URL) {
  scenarios("postgres", () => pgHarness(PG_URL));
} else {
  describe("cctp sweeper [postgres store]", () => {
    it("skipped: set TEST_DATABASE_URL to a migrated database to run the SQL store", { skip: true }, () => {});
  });
}
