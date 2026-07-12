// apps/relayer-daemon/src/sweepers.test.ts — settlement protocol Phase D unit tests
//
// Uses Node's built-in test runner (matches apps/fulfillment-daemon). No
// Postgres / no chain — we inject a fake SqlClient and a fake ChainClient.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runAckTimeoutSweep,
  runSchellingSweep,
  runStreamStaleSweep,
  type SqlClient,
  type ChainClient,
} from "./sweepers.js";

function fakeSql(rows: any[]): SqlClient {
  return ((..._args: any[]) => Promise.resolve(rows)) as unknown as SqlClient;
}

function fakeChain(opts: {
  ackBehavior?: "ok" | "race" | "fail";
  schellingBehavior?: "ok" | "race" | "fail";
} = {}): ChainClient {
  return {
    async acknowledgeTimeout() {
      if (opts.ackBehavior === "race") throw new Error("execution reverted: not delivered");
      if (opts.ackBehavior === "fail") throw new Error("execution reverted: chain panic");
      return { txHash: "0xack" };
    },
    async settleSchelling() {
      if (opts.schellingBehavior === "race") throw new Error("execution reverted: round1 still open");
      if (opts.schellingBehavior === "fail") throw new Error("execution reverted: chain panic");
      return { txHash: "0xsch" };
    },
  };
}

describe("ack-timeout sweeper", () => {
  it("acts on all eligible rows", async () => {
    const sql = fakeSql([
      { id: "11111111-1111-1111-1111-111111111111", on_chain_id: Buffer.alloc(32, 1) },
      { id: "22222222-2222-2222-2222-222222222222", on_chain_id: Buffer.alloc(32, 2) },
    ]);
    const res = await runAckTimeoutSweep(sql, fakeChain());
    assert.equal(res.scanned, 2);
    assert.equal(res.acted, 2);
    assert.equal(res.failed.length, 0);
  });

  it("treats race-condition reverts as benign skips", async () => {
    const sql = fakeSql([{ id: "33333333-3333-3333-3333-333333333333", on_chain_id: Buffer.alloc(32, 3) }]);
    const res = await runAckTimeoutSweep(sql, fakeChain({ ackBehavior: "race" }));
    assert.equal(res.acted, 0);
    assert.equal(res.failed.length, 0); // race != failure
  });

  it("collects real failures", async () => {
    const sql = fakeSql([{ id: "44444444-4444-4444-4444-444444444444", on_chain_id: Buffer.alloc(32, 4) }]);
    const res = await runAckTimeoutSweep(sql, fakeChain({ ackBehavior: "fail" }));
    assert.equal(res.acted, 0);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /chain panic/);
  });
});

describe("schelling sweeper", () => {
  it("acts on round-2 deadlines", async () => {
    const sql = fakeSql([
      { id: "55555555-5555-5555-5555-555555555555", on_chain_id: Buffer.alloc(32, 5), status: "reveal_round2" },
    ]);
    const res = await runSchellingSweep(sql, fakeChain());
    assert.equal(res.acted, 1);
  });

  it("treats round-still-open reverts as benign", async () => {
    const sql = fakeSql([
      { id: "66666666-6666-6666-6666-666666666666", on_chain_id: Buffer.alloc(32, 6), status: "reveal_round1" },
    ]);
    const res = await runSchellingSweep(sql, fakeChain({ schellingBehavior: "race" }));
    assert.equal(res.acted, 0);
    assert.equal(res.failed.length, 0);
  });
});

describe("stream-stale sweeper", () => {
  it("flags stale streams (no chain call)", async () => {
    const sql = fakeSql([
      { id: "77777777-7777-7777-7777-777777777777" },
      { id: "88888888-8888-8888-8888-888888888888" },
    ]);
    const res = await runStreamStaleSweep(sql);
    assert.equal(res.stale.length, 2);
  });

  it("returns empty array when no streams are stale", async () => {
    const sql = fakeSql([]);
    const res = await runStreamStaleSweep(sql);
    assert.equal(res.stale.length, 0);
  });
});
