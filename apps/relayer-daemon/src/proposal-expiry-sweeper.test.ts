// apps/relayer-daemon/src/proposal-expiry-sweeper.test.ts — moneypath M1 remainder
//
// Unit tests for runProposalExpirySweep. Fake sql, fake fetch — NO real
// Postgres, NO real API. Written against the ways this sweeper could LIE:
//   - it must call the admin route with the admin key (that is the whole job)
//   - it must NOT call the route without a key, and must say so in the run row
//   - `scanned`/`acted`/`held`/`failed` must come from the right sources
//   - a crashed tick must still leave a sweeper_runs row behind
//   - the legacy NULL-expires_at gap must be reported, never expired here

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProposalExpirySweep, type ProposalExpirySweeperConfig } from "./proposal-expiry-sweeper.js";
import type { SqlClient } from "./sweepers.js";

function baseCfg(overrides: Partial<ProposalExpirySweeperConfig> = {}): ProposalExpirySweeperConfig {
  return {
    apiBaseUrl: "https://api.test",
    adminApiKey: "admin-key-test",
    expiryDays: 14,
    now: () => new Date("2026-09-22T12:00:00Z"),
    ...overrides,
  };
}

interface SqlCall { text: string; args: unknown[] }

function makeSql(counts: { eligible: number; legacy: number }, opts: { failCount?: boolean } = {}) {
  const calls: SqlCall[] = [];
  const sql = ((tpl: TemplateStringsArray, ...values: unknown[]) => {
    const text = tpl.join("?");
    calls.push({ text, args: values });
    if (/INSERT INTO sweeper_runs/i.test(text)) {
      return Promise.resolve([{ id: "run-0000-0000-0000-000000000001" }]);
    }
    if (/COUNT\(\*\) FILTER/i.test(text)) {
      if (opts.failCount) return Promise.reject(new Error("relation \"deals\" does not exist"));
      return Promise.resolve([{ eligible: String(counts.eligible), legacy: String(counts.legacy) }]);
    }
    return Promise.resolve([]);
  }) as unknown as SqlClient;
  const runUpdate = () => calls.find((c) => /UPDATE sweeper_runs/i.test(c.text));
  return { sql, calls, runUpdate };
}

function makeFetch(reply: { status?: number; body?: unknown; throws?: Error }) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    if (reply.throws) throw reply.throws;
    return new Response(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}),
      { status: reply.status ?? 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("runProposalExpirySweep", () => {
  it("calls POST /api/admin/expire-stale-proposals with x-admin-key and records acted from the route's results", async () => {
    const { sql, runUpdate } = makeSql({ eligible: 3, legacy: 271 });
    const { fetchImpl, seen } = makeFetch({
      body: {
        processed: 3,
        results: [
          { dealId: "d1", expired: true },
          { dealId: "d2", expired: true },
          { dealId: "d3", expired: false, reason: "status changed concurrently" },
        ],
      },
    });

    const r = await runProposalExpirySweep(sql, baseCfg({ fetchImpl }));

    assert.equal(seen.length, 1, "exactly one route call per tick");
    assert.equal(seen[0].url, "https://api.test/api/admin/expire-stale-proposals");
    assert.equal(seen[0].init?.method, "POST");
    assert.equal((seen[0].init?.headers as Record<string, string>)["x-admin-key"], "admin-key-test");

    assert.equal(r.runId, "run-0000-0000-0000-000000000001");
    assert.equal(r.scanned, 3, "scanned mirrors the route's eligibility predicate");
    assert.equal(r.acted, 2, "acted counts only expired:true");
    assert.equal(r.held, 271, "legacy NULL-expires_at rows are reported as held");
    assert.equal(r.failed, 0, "a lost race (expired:false + reason) is not a failure");

    const upd = runUpdate();
    assert.ok(upd, "run row must be closed");
    assert.deepEqual(upd!.args.slice(1, 5), [3, 2, 271, 0]);
    assert.equal(upd!.args[5], null, "no error on a healthy tick");
  });

  it("opens the run row with sweeper='proposal_expiry' (distinct from 'settlement')", async () => {
    const { sql, calls } = makeSql({ eligible: 0, legacy: 0 });
    const { fetchImpl } = makeFetch({ body: { processed: 0, results: [] } });
    await runProposalExpirySweep(sql, baseCfg({ fetchImpl }));
    const ins = calls.find((c) => /INSERT INTO sweeper_runs/i.test(c.text));
    assert.ok(ins);
    assert.match(ins!.text, /'proposal_expiry'/);
  });

  it("still calls the route when the mirror count is 0 — the mirror is not a gate", async () => {
    const { sql } = makeSql({ eligible: 0, legacy: 0 });
    const { fetchImpl, seen } = makeFetch({ body: { processed: 1, results: [{ dealId: "x", expired: true }] } });
    const r = await runProposalExpirySweep(sql, baseCfg({ fetchImpl }));
    assert.equal(seen.length, 1);
    assert.equal(r.acted, 1, "the route is the authority; a drifted mirror must not hide its work");
  });

  it("fails closed without ADMIN_API_KEY: no route call, failed=1, reason in the run row", async () => {
    const { sql, runUpdate } = makeSql({ eligible: 5, legacy: 0 });
    const { fetchImpl, seen } = makeFetch({ body: { processed: 0, results: [] } });
    const r = await runProposalExpirySweep(sql, baseCfg({ fetchImpl, adminApiKey: undefined }));
    assert.equal(seen.length, 0, "must not hit the route unauthenticated");
    assert.equal(r.failed, 1);
    assert.equal(r.acted, 0);
    assert.match(String(r.reason), /ADMIN_API_KEY unset/);
    assert.match(String(runUpdate()!.args[5]), /ADMIN_API_KEY unset/);
  });

  it("counts a route-level error row as failed", async () => {
    const { sql } = makeSql({ eligible: 2, legacy: 0 });
    const { fetchImpl } = makeFetch({
      body: { processed: 2, results: [{ dealId: "a", expired: true }, { dealId: "b", expired: false, error: "boom" }] },
    });
    const r = await runProposalExpirySweep(sql, baseCfg({ fetchImpl }));
    assert.equal(r.acted, 1);
    assert.equal(r.failed, 1);
  });

  it("records an HTTP failure from the route as failed=1 with the status in the reason, and does not throw", async () => {
    const { sql, runUpdate } = makeSql({ eligible: 1, legacy: 0 });
    const { fetchImpl } = makeFetch({ status: 403, body: { error: "Forbidden" } });
    const r = await runProposalExpirySweep(sql, baseCfg({ fetchImpl }));
    assert.equal(r.failed, 1);
    assert.match(String(r.reason), /HTTP 403/);
    assert.match(String(runUpdate()!.args[5]), /HTTP 403/);
  });

  it("a fetch that never returns is recorded, not retried", async () => {
    const { sql } = makeSql({ eligible: 1, legacy: 0 });
    const { fetchImpl, seen } = makeFetch({ throws: new Error("socket hang up") });
    const r = await runProposalExpirySweep(sql, baseCfg({ fetchImpl }));
    assert.equal(seen.length, 1, "one attempt only");
    assert.equal(r.failed, 1);
    assert.match(String(r.reason), /not retried/);
  });

  it("a crashed tick still closes the run row with the error, then rethrows", async () => {
    const { sql, runUpdate } = makeSql({ eligible: 0, legacy: 0 }, { failCount: true });
    const { fetchImpl, seen } = makeFetch({ body: { processed: 0, results: [] } });
    await assert.rejects(
      () => runProposalExpirySweep(sql, baseCfg({ fetchImpl })),
      /does not exist/,
    );
    assert.equal(seen.length, 0, "the route must not be called after the receipt path broke");
    const upd = runUpdate();
    assert.ok(upd, "run row closed even on crash");
    assert.match(String(upd!.args[1]), /does not exist/);
  });
});
