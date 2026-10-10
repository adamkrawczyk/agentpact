// apps/relayer-daemon/src/cctp-daemon.test.ts — M1 (lane m1-relay)
//
// Daemon wiring for the CCTP sweeper: CCTP_ENABLED gates it completely, a
// forced failure reaches the operator through the daemon's existing alert
// path (structured error log + /health 503), and the chain/binding adapters
// only trust what they should.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem";
import { startDaemon } from "./index.js";
import { loadConfig } from "./config.js";
import { CCTP_GATEWAY_ABI } from "./cctp-gateway-abi.js";
import { decodeGatewayLogs } from "./cctp-chain.js";
import { httpBindingVerifier } from "./cctp-binding.js";
import type { CctpStore, CctpTransfer } from "./cctp-store.js";
import type { CctpChainClient } from "./cctp-sweeper.js";
import type { ChainClient, SqlClient } from "./sweepers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GATEWAY = "0x9999999999999999999999999999999999999999" as const;

function legacyChain(): ChainClient {
  return {
    async acknowledgeTimeout() { return { txHash: "0x" }; },
    async settleSchelling() { return { txHash: "0x" }; },
    async createIntentWithAuthorization() { return { txHash: "0x", onChainId: Buffer.alloc(32) }; },
    async claimIntent() { return { txHash: "0x" }; },
  };
}

function cfg(port: number, over: Record<string, unknown> = {}) {
  return {
    relayerPort: port, relayerHost: "127.0.0.1", baseRpcUrl: "https://mainnet.base.org",
    ackSweepIntervalMs: 60_000, schellingSweepIntervalMs: 60_000, streamStaleSweepIntervalMs: 60_000,
    autocloseSweepIntervalMs: 60_000, autocloseMaxUsdc: 5, settlementSweepIntervalMs: 60_000,
    proposalExpirySweepIntervalMs: 60_000, apiBaseUrl: "http://127.0.0.1:1", settlementCompleteThreshold: 0.85,
    settlementMaxPerTick: 25, settlementAutoRelease: false, proposalExpiryDays: 14, logLevel: "warn",
    cctpSweepIntervalMs: 20, cctpNetwork: "testnet",
    ...over,
  } as any; // partial Config on purpose (same as stall.test.ts): only the fields startDaemon reads
}

const ATTESTED: CctpTransfer = {
  id: "00000000-0000-4000-8000-000000000001", direction: "deposit", dealId: "d1", intentId: null, dealRef: null,
  sourceDomain: 5, destinationDomain: 6, sourceTxHash: `0x${"e".repeat(64)}`, messageHash: `0x${"1".repeat(64)}`,
  nonce: `0x${"2".repeat(64)}`, amount: 5_000_501n, maxFee: null, feeExecuted: null, recipient: null, status: "attested",
  attempts: 0, lastError: null, nextAttemptAt: null, destinationTxHash: null, createdAt: new Date(), updatedAt: new Date(),
  statusChangedAt: new Date(), message: "0x01", attestation: "0x02", onchainIntentId: null, parentTransferId: null,
  payoutDomain: null, payoutRecipient: null, refundRecipient: null, intentExpiresAt: null, stuckReason: null, stuckAt: null,
};

/** One attested row; becomes stuck when the sweeper says so. */
function oneRowStore(calls: string[]): CctpStore {
  let row: CctpTransfer | null = { ...ATTESTED };
  return {
    async openRun() { calls.push("openRun"); return "run"; },
    async finishRun() {},
    async due() { return row && row.status === "attested" ? [{ ...row }] : []; },
    async lease() { return true; },
    async update(_id, expect, patch) {
      if (!row || row.status !== expect) return false;
      row = { ...row, ...(patch as Partial<CctpTransfer>) };
      return true;
    },
    async refundCandidates() { return []; },
    async payoutCandidates() { return []; },
    async insertChild() { return null; },
    async reveal() { return null; },
    async markIntentClaimed() {},
    async stuckSummary() {
      return row?.status === "stuck" ? { count: 1, oldestStuckAt: row.stuckAt } : { count: 0, oldestStuckAt: null };
    },
  };
}

function revertingChain(calls: string[]): CctpChainClient {
  return {
    async isNonceUsed() { calls.push("isNonceUsed"); return false; },
    async relayDeposit() { calls.push("relayDeposit"); throw new Error("execution reverted: forced"); },
    async refund() { throw new Error("unused"); },
    async claimAndForward() { throw new Error("unused"); },
    async getReceipt() { return null; },
    async findDepositOutcome() { return null; },
    async findSettleOutcome() { return null; },
  };
}

function runtime(calls: string[]) {
  return {
    store: oneRowStore(calls),
    chain: revertingChain(calls),
    iris: { async getMessages() { calls.push("iris"); return { kind: "not_found" as const }; } },
    verifyBinding: async () => ({ bound: false as const, reason: "x", retryable: true }),
    quoteForwardFee: async () => ({ maxFee: 0n, minFinalityThreshold: 2000 }),
    config: {
      gateway: GATEWAY, maxPerTick: 5, attestationTimeoutMs: 60_000, bindTimeoutMs: 60_000, forwardTimeoutMs: 60_000,
      maxAttempts: 1, retryBaseMs: 1_000, retryMaxMs: 10_000, txDropAfterMs: 60_000, receiptWaitMs: 0, receiptPollMs: 0,
      refundGraceMs: 0, leaseMs: 60_000,
    },
  };
}

describe("CCTP_ENABLED flag", () => {
  it("parses only the literal 'true' as on; default and 'false' are off", () => {
    assert.equal(loadConfig({}).cctpEnabled, false);
    assert.equal(loadConfig({ CCTP_ENABLED: "false" }).cctpEnabled, false);
    assert.equal(loadConfig({ CCTP_ENABLED: "1" }).cctpEnabled, false);
    assert.equal(loadConfig({ CCTP_ENABLED: "TRUE" }).cctpEnabled, true);
    assert.equal(loadConfig({}).cctpNetwork, "testnet");
    assert.throws(() => loadConfig({ CCTP_NETWORK: "devnet" }));
  });

  it("flag off = no-op: the CCTP runtime is never touched and /health says disabled", async (t) => {
    const port = 9100 + Math.floor(Math.random() * 500);
    const calls: string[] = [];
    const { stop, getHealth } = startDaemon({
      config: cfg(port, { cctpEnabled: false }),
      sql: (() => Promise.resolve([])) as unknown as SqlClient,
      chain: legacyChain(),
      cctp: runtime(calls),
      log: () => {},
    });
    t.after(stop);
    await sleep(150);
    assert.deepEqual(calls, [], "no Iris call, no chain call, no sweeper_runs row");
    assert.equal(getHealth().cctp.enabled, false);
    assert.equal(getHealth().cctpSweeper.cycles, 0);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  });

  it("flag on + forced relay failure → alert through the daemon log, /health 503 with stuck details", async (t) => {
    const port = 9700 + Math.floor(Math.random() * 500);
    const calls: string[] = [];
    const logs: Array<{ lvl: string; msg: string; meta?: Record<string, unknown> }> = [];
    const { stop } = startDaemon({
      config: cfg(port, { cctpEnabled: true }),
      sql: (() => Promise.resolve([])) as unknown as SqlClient,
      chain: legacyChain(),
      cctp: runtime(calls),
      log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }),
    });
    t.after(stop);
    await sleep(200);

    const alerts = logs.filter((l) => l.msg === "cctp.alert");
    assert.equal(alerts.length, 1, "exactly one alert for the stuck episode");
    assert.equal(alerts[0].lvl, "error");
    assert.equal(alerts[0].meta?.kind, "relay_failed");
    assert.equal(alerts[0].meta?.transferId, ATTESTED.id);
    assert.equal(calls.filter((c) => c === "relayDeposit").length, 1);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 503, "a stuck transfer pages through the existing uptime check");
    const body = (await res.json()) as any;
    assert.equal(body.cctp.enabled, true);
    assert.equal(body.cctp.network, "testnet");
    assert.equal(body.cctp.stuckCount, 1);
    assert.equal(typeof body.cctp.oldestStuckAgeMs, "number");
    assert.equal(body.cctp.lastAlert.kind, "relay_failed");
  });
});

describe("decodeGatewayLogs", () => {
  const intentId = `0x${"7".repeat(64)}` as Hex;
  function refundLog(address: string): Log {
    return {
      address: address as Hex,
      topics: encodeEventTopics({ abi: CCTP_GATEWAY_ABI, eventName: "CctpRefundSent", args: { intentId } }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        [5, `0x${"4".repeat(64)}`, 5_000_000n, 1_000n],
      ),
      blockHash: `0x${"b".repeat(64)}`, blockNumber: 1n, logIndex: 0, transactionHash: `0x${"c".repeat(64)}`,
      transactionIndex: 0, removed: false,
    };
  }

  it("decodes an event emitted by the gateway", () => {
    const [x] = decodeGatewayLogs([refundLog(GATEWAY)], GATEWAY);
    assert.deepEqual(x.event, {
      name: "CctpRefundSent", intentId, destinationDomain: 5, recipient: `0x${"4".repeat(64)}`, amount: 5_000_000n, maxFee: 1_000n,
    });
  });

  it("ignores the same event emitted by any other contract (spoof)", () => {
    assert.deepEqual(decodeGatewayLogs([refundLog("0x1111111111111111111111111111111111111111")], GATEWAY), []);
  });
});

describe("httpBindingVerifier", () => {
  const input = {
    transferId: "t1", dealId: null, dealRef: null, sourceDomain: 5,
    relayTxHash: `0x${"a".repeat(64)}` as Hex, messageHash: `0x${"b".repeat(64)}` as Hex, nonce: `0x${"c".repeat(64)}` as Hex,
  };
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("bound only on an explicit bound:true with a bytes32 intent id", async () => {
    const ok = httpBindingVerifier({ apiBaseUrl: "http://api", adminApiKey: "k", fetchImpl: reply(200, { bound: true, intent_id: "i", onchain_intent_id: `0x${"7".repeat(64)}` }) });
    assert.deepEqual(await ok(input), { bound: true, intentId: "i", onchainIntentId: `0x${"7".repeat(64)}` });
    const sloppy = httpBindingVerifier({ apiBaseUrl: "http://api", adminApiKey: "k", fetchImpl: reply(200, { bound: true }) });
    assert.equal((await sloppy(input)).bound, false);
  });

  it("a missing route (404) or no admin key is 'not bound, retryable' — never success", async () => {
    const missing = httpBindingVerifier({ apiBaseUrl: "http://api", adminApiKey: "k", fetchImpl: reply(404, { error: "not found" }) });
    assert.deepEqual(await missing(input), { bound: false, reason: 'bind HTTP 404: {"error":"not found"}', retryable: true });
    const nokey = httpBindingVerifier({ apiBaseUrl: "http://api", fetchImpl: reply(200, { bound: true }) });
    assert.equal((await nokey(input)).bound, false);
  });

  it("passes the API's non-retryable refusal through", async () => {
    const v = httpBindingVerifier({ apiBaseUrl: "http://api", adminApiKey: "k", fetchImpl: reply(200, { bound: false, reason: "dealRef mismatch", retryable: false }) });
    assert.deepEqual(await v(input), { bound: false, reason: "dealRef mismatch", retryable: false });
  });
});
