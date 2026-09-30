// apps/relayer-daemon/src/stall.test.ts — 2026-09-22 prod incident regression.
//
// One tick never returned (SQL client wedged behind the pooler: no error, no
// log line, sweeper_runs.finished_at NULL). Every sweeper went silent for 8
// days while pm2 said `online` and /health said ok:true. These tests pin the
// three properties that make that failure loud and self-healing:
//   1. a tick in flight past tickStallMs flips /health to 503,
//   2. onStall fires exactly once (production = process.exit -> pm2 restart),
//   3. ticks never overlap on the same sweeper.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startDaemon } from "./index.js";
import type { SqlClient, ChainClient } from "./sweepers.js";

const Q = 20; // ms

function chain(): ChainClient {
  return {
    async acknowledgeTimeout() { return { txHash: "0xack" }; },
    async settleSchelling() { return { txHash: "0xsch" }; },
    async createIntentWithAuthorization() { return { txHash: "0xf", onChainId: Buffer.alloc(32, 0) }; },
    async claimIntent() { return { txHash: "0xc" }; },
  };
}

function cfg(port: number, over: Record<string, unknown> = {}) {
  return {
    relayerPort: port,
    relayerHost: "127.0.0.1",
    relayerPrivateKey: undefined,
    databaseUrl: undefined,
    baseRpcUrl: "https://mainnet.base.org",
    escrowV2Address: undefined,
    escrowV3Address: undefined,
    platformWallet: undefined,
    ackSweepIntervalMs: Q,
    schellingSweepIntervalMs: Q,
    streamStaleSweepIntervalMs: Q,
    autocloseSweepIntervalMs: Q,
    autocloseMaxUsdc: 5,
    settlementSweepIntervalMs: 10 * 60_000,
    proposalExpirySweepIntervalMs: 10 * 60_000,
    apiBaseUrl: "http://127.0.0.1:1",
    settlementCompleteThreshold: 0.85,
    settlementMaxPerTick: 25,
    settlementAutoRelease: false,
    proposalExpiryDays: 14,
    logLevel: "warn" as const,
    ...over,
  } as any;
}

/** A SQL client whose every query hangs forever — the 09-22 failure shape. */
function hangingSql(calls: { n: number }): SqlClient {
  return (() => { calls.n++; return new Promise(() => {}); }) as unknown as SqlClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("relayer-daemon stall liveness (09-22 incident)", () => {
  it("flips /health to 503 and calls onStall once when a tick wedges", async (t) => {
    const port = 6011 + Math.floor(Math.random() * 1000);
    const stalls: Array<{ name: string; ms: number }> = [];
    const calls = { n: 0 };
    const { stop, getHealth } = startDaemon({
      config: cfg(port, { tickStallMs: 80 }),
      sql: hangingSql(calls),
      chain: chain(),
      log: () => {},
      onStall: (name, ms) => stalls.push({ name, ms }),
    });
    t.after(async () => { await stop(); });

    await sleep(400);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 503, "a wedged tick must make /health unhealthy");
    const body = (await res.json()) as any;
    assert.equal(body.ok, false);
    assert.ok(body.ackSweeper.inFlightSince, "health must expose the in-flight tick");
    assert.equal(stalls.length, 1, "onStall fires exactly once per stall episode");
    assert.ok(stalls[0].ms > 80);
    assert.ok(getHealth().ackSweeper.cycles === 0, "no tick completed");
  });

  it("never overlaps ticks on one sweeper — skips are counted instead", async (t) => {
    const port = 7011 + Math.floor(Math.random() * 1000);
    const calls = { n: 0 };
    const { stop, getHealth } = startDaemon({
      config: cfg(port, { tickStallMs: 60_000 }),
      sql: hangingSql(calls),
      chain: chain(),
      log: () => {},
    });
    t.after(async () => { await stop(); });

    await sleep(250); // ~12 intervals at 20ms
    const h = getHealth();
    // One tick per sweeper, ever: ack, schelling, streamStale issue one hung
    // query each; autoclose runs its fund + claim legs in parallel (two). The
    // pre-fix daemon issued ~60 here — a new stacked query every interval.
    assert.ok(calls.n <= 5, `expected <=5 hung queries (one tick per sweeper), got ${calls.n}`);
    assert.ok(h.ackSweeper.overlapSkips >= 5, `expected skipped overlaps, got ${h.ackSweeper.overlapSkips}`);
    assert.equal(h.ok, true, "below the stall threshold a slow tick is not yet unhealthy");
  });

  it("stays healthy and clears inFlightSince when ticks complete", async (t) => {
    const port = 8011 + Math.floor(Math.random() * 1000);
    const { stop, getHealth } = startDaemon({
      config: cfg(port, { tickStallMs: 80 }),
      sql: (() => Promise.resolve([])) as unknown as SqlClient,
      chain: chain(),
      log: () => {},
      onStall: () => { throw new Error("must not stall"); },
    });
    t.after(async () => { await stop(); });
    await sleep(300);
    const h = getHealth();
    assert.ok(h.ackSweeper.cycles >= 3);
    assert.equal(h.ok, true);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  });
});
