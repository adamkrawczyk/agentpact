// Receipt sweepers (ap_v31 M2): daemon wiring + config switches.
//
// The sweepers' SQL is exercised against the real schema in
// apps/api/src/__tests__/receipts.test.ts (that suite runs in CI with a
// Postgres). This file pins what only the daemon decides: WHEN they run.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSeed, publicKeyFromSeed } from "@agentpact/receipts";
import { startDaemon } from "./index.js";
import { loadConfig } from "./config.js";
import { anchorCalldata, runReceiptAnchor } from "./receipt-sweeper.js";
import type { ChainClient, SqlClient } from "./sweepers.js";

const Q = 20;
const SEED = generateSeed();

function chain(): ChainClient {
  return {
    async acknowledgeTimeout() { return { txHash: "0x1" }; },
    async settleSchelling() { return { txHash: "0x2" }; },
    async createIntentWithAuthorization() { return { txHash: "0x3", onChainId: Buffer.alloc(32) }; },
    async claimIntent() { return { txHash: "0x4" }; },
  };
}

/** Answers just enough of the receipt sweeper's queries; records the rest. */
function fakeSql(seen: string[]): SqlClient {
  return ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    seen.push(text);
    if (text.includes("SELECT public_key FROM receipt_signing_keys")) return Promise.resolve([{ public_key: publicKeyFromSeed(SEED) }]);
    if (text.includes("INSERT INTO sweeper_runs")) return Promise.resolve([{ id: "run-1" }]);
    return Promise.resolve([]);
  }) as unknown as SqlClient;
}

function cfg(port: number, extra: Record<string, unknown> = {}) {
  return {
    ...loadConfig({}),
    relayerPort: port,
    ackSweepIntervalMs: 60_000, schellingSweepIntervalMs: 60_000, streamStaleSweepIntervalMs: 60_000,
    autocloseSweepIntervalMs: 60_000, settlementSweepIntervalMs: 60_000, proposalExpirySweepIntervalMs: 60_000,
    receiptSweepIntervalMs: Q, receiptAnchorCheckIntervalMs: Q,
    ...extra,
  };
}

const port = () => 6100 + Math.floor(Math.random() * 1500);

describe("receipt sweeper wiring", () => {
  it("runs the receipt sweeper when RECEIPT_SIGNING_KEY + RECEIPT_KEY_ID are set", async (t) => {
    const seen: string[] = [];
    const { stop, getHealth } = startDaemon({
      config: cfg(port(), { receiptSigningKey: SEED, receiptKeyId: "k-test" }),
      sql: fakeSql(seen), chain: chain(), log: () => {},
    });
    t.after(stop);
    await new Promise((r) => setTimeout(r, 120));
    const h = getHealth();
    assert.ok(h.receiptSweeper.cycles >= 1, "receipt sweeper never ran");
    assert.equal(h.receiptSweeper.lastError, null);
    assert.ok(seen.some((q) => q.includes("INSERT INTO sweeper_runs") && q.includes("'receipts'")));
    // Anchoring stays off unless explicitly enabled.
    assert.equal(h.receiptAnchorSweeper.cycles, 0);
  });

  it("does not schedule issuance without a signing key, and says so", async (t) => {
    const logs: string[] = [];
    const { stop, getHealth } = startDaemon({
      config: cfg(port()), sql: fakeSql([]), chain: chain(), log: (_l, msg) => logs.push(msg),
    });
    t.after(stop);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(getHealth().receiptSweeper.cycles, 0);
    assert.ok(logs.includes("receiptSweeper.disabled"));
  });

  it("anchors only when RECEIPT_ANCHOR_ENABLED=true AND a broadcaster exists", async (t) => {
    const sent: string[] = [];
    const { stop, getHealth } = startDaemon({
      config: cfg(port(), { receiptAnchorEnabled: true }),
      sql: fakeSql([]), chain: chain(), log: () => {},
      anchorBroadcast: async (d) => { sent.push(d); return { txHash: "0xabc" }; },
    });
    t.after(stop);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(getHealth().receiptAnchorSweeper.cycles >= 1);
    // fakeSql has no unanchored receipts -> nothing broadcast.
    assert.deepEqual(sent, []);

    const logs: string[] = [];
    const second = startDaemon({
      config: cfg(port(), { receiptAnchorEnabled: true }), sql: fakeSql([]), chain: chain(),
      log: (_l, msg) => logs.push(msg),
    });
    t.after(second.stop);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(second.getHealth().receiptAnchorSweeper.cycles, 0);
    assert.ok(logs.includes("receiptAnchorSweeper.disabled"));
  });
});

describe("receipt config", () => {
  it("RECEIPT_ANCHOR_ENABLED: only the literal 'true' enables anchoring", () => {
    assert.equal(loadConfig({}).receiptAnchorEnabled, false);
    assert.equal(loadConfig({ RECEIPT_ANCHOR_ENABLED: "false" }).receiptAnchorEnabled, false);
    assert.equal(loadConfig({ RECEIPT_ANCHOR_ENABLED: "1" }).receiptAnchorEnabled, false);
    assert.equal(loadConfig({ RECEIPT_ANCHOR_ENABLED: "TRUE" }).receiptAnchorEnabled, true);
  });

  it("an empty RECEIPT_SIGNING_KEY counts as unset", () => {
    assert.equal(loadConfig({ RECEIPT_SIGNING_KEY: "", RECEIPT_KEY_ID: "" }).receiptSigningKey, undefined);
  });

  it("runReceiptAnchor refuses to do anything when disabled, even if called directly", async () => {
    const seen: string[] = [];
    const r = await runReceiptAnchor(fakeSql(seen), { enabled: false, broadcast: async () => ({ txHash: "0x" }) });
    assert.match(String(r.skipped), /disabled/);
    assert.deepEqual(seen, []);
  });

  it("anchor calldata = ASCII prefix + 32-byte root, and rejects a malformed root", () => {
    const root = "ab".repeat(32);
    const data = anchorCalldata(root);
    assert.equal(Buffer.from(data.slice(2), "hex").subarray(0, 25).toString("utf8"), "agentpact-receipts:apr-1:");
    assert.ok(data.endsWith(root));
    assert.throws(() => anchorCalldata("AB".repeat(32)), /root/);
  });
});
