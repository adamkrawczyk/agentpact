// apps/relayer-daemon/src/index.test.ts — settlement_2705 Phase D
//
// Integration test for the daemon's wiring: interval timers fire, health
// state updates, /health endpoint reports the right status code.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startDaemon } from "./index.js";
import type { SqlClient, ChainClient } from "./sweepers.js";

const QUICK_INTERVAL = 25; // ms

function staticSql(rows: any[] = []): SqlClient {
  return (() => Promise.resolve(rows)) as unknown as SqlClient;
}

function staticChain(): ChainClient {
  return {
    async acknowledgeTimeout() { return { txHash: "0xack" }; },
    async settleSchelling() { return { txHash: "0xsch" }; },
    async createIntentWithAuthorization() { return { txHash: "0xfund", onChainId: Buffer.alloc(32, 0) }; },
    async claimIntent() { return { txHash: "0xclaim" }; },
  };
}

function tinyConfig(port: number) {
  return {
    relayerPort: port,
    relayerHost: "127.0.0.1",
    relayerPrivateKey: undefined,
    databaseUrl: undefined,
    baseRpcUrl: "https://mainnet.base.org",
    escrowV2Address: undefined,
    escrowV3Address: undefined,
    platformWallet: undefined,
    ackSweepIntervalMs: QUICK_INTERVAL,
    schellingSweepIntervalMs: QUICK_INTERVAL,
    streamStaleSweepIntervalMs: QUICK_INTERVAL,
    autocloseSweepIntervalMs: QUICK_INTERVAL,
    autocloseMaxUsdc: 5,
    logLevel: "warn" as const,
  };
}

describe("relayer-daemon wiring", () => {
  it("starts, runs sweepers, returns 200 on /health, and stops cleanly", async (t) => {
    const port = 4011 + Math.floor(Math.random() * 1000);
    const logs: any[] = [];
    const { stop, getHealth } = startDaemon({
      config: tinyConfig(port),
      sql: staticSql([]),
      chain: staticChain(),
      log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }),
    });
    t.after(async () => { await stop(); });

    // Allow at least one full sweep cycle.
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; ackSweeper: { cycles: number } };
    assert.equal(body.ok, true);
    assert.ok(body.ackSweeper.cycles >= 1, "ack sweeper should have run at least once");

    const h = getHealth();
    assert.ok(h.schellingSweeper.cycles >= 1);
    assert.ok(h.streamStaleSweeper.cycles >= 1);
  });

  it("flips to 503 when 3+ sweepers fail consecutively", async (t) => {
    const port = 5011 + Math.floor(Math.random() * 1000);
    const failingChain: ChainClient = {
      async acknowledgeTimeout() { throw new Error("chain panic"); },
      async settleSchelling() { throw new Error("chain panic"); },
      async createIntentWithAuthorization() { throw new Error("chain panic"); },
      async claimIntent() { throw new Error("chain panic"); },
    };
    const failingSql = (() => {
      throw new Error("db panic");
    }) as unknown as SqlClient;
    const { stop } = startDaemon({
      config: tinyConfig(port),
      sql: failingSql,
      chain: failingChain,
      log: () => {},
    });
    t.after(async () => { await stop(); });

    // Wait long enough for all three sweepers to fail at least once.
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 503);
  });
});
