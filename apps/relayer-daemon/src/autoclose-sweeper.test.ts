// apps/relayer-daemon/src/autoclose-sweeper.test.ts — autoclose_0614 Change 3
//
// Unit tests for runAutoCloseSweep. Pure function tested with a fake sql +
// a fake ChainClient — NO real chain / NO real Postgres. Mirrors the style
// of sweepers.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAutoCloseSweep, type AutoCloseSweepResult } from "./autoclose-sweeper.js";
import type { SqlClient, ChainClient } from "./sweepers.js";
import type { Config } from "./config.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Base config used across tests; override fields as needed. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    relayerPort: 4099,
    relayerHost: "127.0.0.1",
    relayerPrivateKey: undefined,
    databaseUrl: undefined,
    baseRpcUrl: "https://mainnet.base.org",
    escrowV2Address: undefined,
    escrowV3Address: undefined,
    platformWallet: undefined,
    ackSweepIntervalMs: 60_000,
    schellingSweepIntervalMs: 60_000,
    streamStaleSweepIntervalMs: 300_000,
    autocloseSweepIntervalMs: 30_000,
    autocloseMaxUsdc: 5,
    logLevel: "warn",
    ...overrides,
  };
}

// Fake sql that records every call and returns pre-programmed row arrays.
// We give each query a sequential index so callers can assert order.
interface SqlCall { args: unknown[] }

function makeSql(responseMap: Record<number, unknown[]>) {
  const calls: SqlCall[] = [];
  const sql = ((_tpl: TemplateStringsArray, ...values: unknown[]) => {
    const idx = calls.length;
    calls.push({ args: values });
    return Promise.resolve(responseMap[idx] ?? []);
  }) as unknown as SqlClient;
  return { sql, calls };
}

/** A single fake fund row with all required fields. */
function fundRow(overrides: Record<string, unknown> = {}) {
  return {
    intent_id: "aaaa0000-0000-0000-0000-000000000001",
    agent_id:  "bbbb0000-0000-0000-0000-000000000001",
    buyer_wallet:    "0xBuyerWallet000000000000000000000000000001",
    verifier_address:"0xVerifier000000000000000000000000000000001",
    predicate_params: Buffer.from("aabbcc", "hex"),
    seller_target:   "0x0000000000000000000000000000000000000000",
    max_price_usdc:  "2.000000",
    expires_at:      new Date(Date.now() + 3600_000),
    auth_id:         "cccc0000-0000-0000-0000-000000000001",
    value_usdc:      "2.000000",
    valid_after:     "0",
    valid_before:    String(Math.floor(Date.now() / 1000) + 3600),
    nonce:           Buffer.alloc(32, 0x1),
    sig_v:           27,
    sig_r:           Buffer.alloc(32, 0x2),
    sig_s:           Buffer.alloc(32, 0x3),
    ...overrides,
  };
}

/** A single fake claim row. */
function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    intent_id:  "dddd0000-0000-0000-0000-000000000001",
    on_chain_id: Buffer.alloc(32, 0xde),
    deal_id:    "eeee0000-0000-0000-0000-000000000001",
    reveal_id:  "ffff0000-0000-0000-0000-000000000001",
    preimage:   Buffer.from("preimage_secret"),
    ciphertext: Buffer.from("encrypted_payload"),
    ...overrides,
  };
}

/** Fake ChainClient — call behaviour driven by per-method options. */
interface FakeChainOpts {
  fundBehavior?:  "ok" | "dup" | "fail";
  claimBehavior?: "ok" | "already_claimed" | "fail";
  onChainId?: Buffer;
}

function fakeChain(opts: FakeChainOpts = {}): ChainClient {
  const onChainId = opts.onChainId ?? Buffer.alloc(32, 0xaa);
  return {
    async acknowledgeTimeout() { return { txHash: "0xack" }; },
    async settleSchelling()    { return { txHash: "0xsch" }; },
    async createIntentWithAuthorization(_args) {
      if (opts.fundBehavior === "dup")  throw new Error("execution reverted: Escrow: dup intent");
      if (opts.fundBehavior === "fail") throw new Error("execution reverted: chain panic");
      return { txHash: "0xfund", onChainId };
    },
    async claimIntent(_id, _ct, _w) {
      if (opts.claimBehavior === "already_claimed") throw new Error("execution reverted: not class a open");
      if (opts.claimBehavior === "fail")            throw new Error("execution reverted: chain panic");
      return { txHash: "0xclaim" };
    },
  };
}

// ── FUND phase tests ─────────────────────────────────────────────────────────

describe("autoclose sweeper — FUND phase", () => {
  it("funds an awaiting_funding intent and marks it open", async () => {
    const fundRows = [fundRow()];
    // query 0 = SELECT intents (fund phase)
    // query 1 = SELECT intents (claim phase — empty, runs in parallel)
    // query 2 = UPDATE intents SET on_chain_id … (fund success)
    // query 3 = UPDATE intent_funding_authorizations (consumed)
    const { sql, calls } = makeSql({
      0: fundRows,
      1: [],   // claim phase: no reveal_ready rows
    });

    const onChainId = Buffer.alloc(32, 0xab);
    const chain = fakeChain({ fundBehavior: "ok", onChainId });
    const res: AutoCloseSweepResult = await runAutoCloseSweep(sql, chain, baseConfig());

    assert.equal(res.fund.scanned, 1);
    assert.equal(res.fund.acted, 1);
    assert.equal(res.fund.failed.length, 0);
    assert.equal(res.claim.scanned, 0);

    // The UPDATE calls come after the SELECT (calls 0+1 are the two SELECTs).
    // We check the on_chain_id Buffer appears somewhere in the update args.
    const updateArgs = calls.slice(2).flatMap((c) => c.args);
    assert.ok(
      updateArgs.some((a) => Buffer.isBuffer(a) && a.equals(onChainId)),
      "on_chain_id buffer should appear in the UPDATE args",
    );
  });

  it("skips intents over the spend cap", async () => {
    // SQL returns no rows because the WHERE clause filters them out.
    // We simulate this by returning an empty array for the fund query.
    const { sql } = makeSql({ 0: [], 1: [] });
    const chain = fakeChain({ fundBehavior: "ok" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig({ autocloseMaxUsdc: 1 }));
    // No rows returned from SQL → nothing acted on.
    assert.equal(res.fund.scanned, 0);
    assert.equal(res.fund.acted, 0);
  });

  it("skips disabled agents (SQL returns no rows)", async () => {
    // The WHERE clause in the sweeper enforces autoclose_enabled=true,
    // so disabled agents simply don't appear in the result set.
    const { sql } = makeSql({ 0: [], 1: [] });
    const chain = fakeChain();
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.fund.scanned, 0);
    assert.equal(res.fund.acted, 0);
  });

  it("treats dup-intent reverts as a benign skip (not a failure)", async () => {
    const { sql } = makeSql({ 0: [fundRow()], 1: [] });
    const chain = fakeChain({ fundBehavior: "dup" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.fund.acted, 0);
    assert.equal(res.fund.failed.length, 0, "dup intent is a skip, not a failure");
  });

  it("records real chain failures", async () => {
    const { sql } = makeSql({ 0: [fundRow()], 1: [] });
    const chain = fakeChain({ fundBehavior: "fail" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.fund.acted, 0);
    assert.equal(res.fund.failed.length, 1);
    assert.match(res.fund.failed[0].error, /chain panic/);
  });

  it("handles multiple intents in one sweep", async () => {
    const rows = [
      fundRow({ intent_id: "aaaa0000-0000-0000-0000-000000000001", auth_id: "cc01" }),
      fundRow({ intent_id: "aaaa0000-0000-0000-0000-000000000002", auth_id: "cc02" }),
      fundRow({ intent_id: "aaaa0000-0000-0000-0000-000000000003", auth_id: "cc03" }),
    ];
    const { sql } = makeSql({ 0: rows, 1: [] });
    const chain = fakeChain({ fundBehavior: "ok" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.fund.scanned, 3);
    assert.equal(res.fund.acted, 3);
  });
});

// ── CLAIM phase tests ────────────────────────────────────────────────────────

describe("autoclose sweeper — CLAIM phase", () => {
  it("claims a reveal_ready intent and flips deal to completed", async () => {
    const claimRows = [claimRow()];
    // query 0 = SELECT fund phase (empty)
    // query 1 = SELECT claim phase
    const { sql, calls } = makeSql({ 0: [], 1: claimRows });

    const chain = fakeChain({ claimBehavior: "ok" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());

    assert.equal(res.claim.scanned, 1);
    assert.equal(res.claim.acted, 1);
    assert.equal(res.claim.failed.length, 0);

    // Verify that we emitted UPDATE calls after the SELECT.
    // calls[0]=fund SELECT, calls[1]=claim SELECT, calls[2]=UPDATE intents, calls[3]=UPDATE deals
    assert.ok(calls.length >= 4, "should have UPDATE intent + UPDATE deal calls");
  });

  it("treats already-claimed reverts as benign skips", async () => {
    const { sql } = makeSql({ 0: [], 1: [claimRow()] });
    const chain = fakeChain({ claimBehavior: "already_claimed" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.claim.acted, 0);
    assert.equal(res.claim.failed.length, 0, "already_claimed is a skip");
  });

  it("records real claim chain failures", async () => {
    const { sql } = makeSql({ 0: [], 1: [claimRow()] });
    const chain = fakeChain({ claimBehavior: "fail" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.claim.acted, 0);
    assert.equal(res.claim.failed.length, 1);
    assert.match(res.claim.failed[0].error, /chain panic/);
  });

  it("handles a reveal with no deal_id gracefully", async () => {
    // Some intents may be standalone (no linked deal). The UPDATE deals step
    // is guarded by `if (row.deal_id)`.
    const { sql } = makeSql({
      0: [],
      1: [claimRow({ deal_id: null })],
    });
    const chain = fakeChain({ claimBehavior: "ok" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.claim.acted, 1);
    assert.equal(res.claim.failed.length, 0);
  });

  it("claims multiple reveal_ready intents per sweep", async () => {
    const rows = [
      claimRow({ intent_id: "dd01", on_chain_id: Buffer.alloc(32, 0x01) }),
      claimRow({ intent_id: "dd02", on_chain_id: Buffer.alloc(32, 0x02) }),
    ];
    const { sql } = makeSql({ 0: [], 1: rows });
    const chain = fakeChain({ claimBehavior: "ok" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.claim.scanned, 2);
    assert.equal(res.claim.acted, 2);
  });
});

// ── combined phase tests ────────────────────────────────────────────────────

describe("autoclose sweeper — combined phases", () => {
  it("runs both phases concurrently and aggregates results", async () => {
    const { sql } = makeSql({
      0: [fundRow()],           // fund SELECT
      1: [claimRow()],          // claim SELECT
    });
    const chain = fakeChain({ fundBehavior: "ok", claimBehavior: "ok" });
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.fund.acted, 1);
    assert.equal(res.claim.acted, 1);
    assert.equal(res.fund.failed.length, 0);
    assert.equal(res.claim.failed.length, 0);
  });

  it("returns zero-scanned result when DB has no eligible rows", async () => {
    const { sql } = makeSql({ 0: [], 1: [] });
    const chain = fakeChain();
    const res = await runAutoCloseSweep(sql, chain, baseConfig());
    assert.equal(res.fund.scanned, 0);
    assert.equal(res.fund.acted, 0);
    assert.equal(res.claim.scanned, 0);
    assert.equal(res.claim.acted, 0);
  });
});
