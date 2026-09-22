// apps/relayer-daemon/src/settlement-sweeper.test.ts — moneypath_0920 M1
//
// Unit tests for runSettlementSweep + the jev.ts judge. Fake sql, fake fetch —
// NO real Postgres, NO real classifier call, NO real money. Mirrors the style
// of autoclose-sweeper.test.ts.
//
// These tests are written against the ways this sweeper could LOSE MONEY or
// PAY OUT WRONGLY, not against its happy path:
//   - a self-deal must never be released (45 of 98 completed prod deals are)
//   - a judge outage must HOLD, never release (fail-closed)
//   - a malformed judge response must not read as "confidently bad" (p=0)
//   - settlement_pending must not be counted as a completion
//   - credentials in a fulfillment payload must never reach the judge
//   - a crashed tick must still leave a sweeper_runs row behind

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSettlementSweep, type SettlementSweeperConfig } from "./settlement-sweeper.js";
import { buildEvidence, parseVerdict, rubricHash, judgeDelivery } from "./jev.js";
import type { SqlClient } from "./sweepers.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function baseCfg(overrides: Partial<SettlementSweeperConfig> = {}): SettlementSweeperConfig {
  return {
    apiBaseUrl: "https://api.test",
    adminApiKey: "test-admin-key",
    completeThreshold: 0.85,
    maxPerTick: 25,
    autoReleaseEnabled: true,
    now: () => new Date("2026-09-20T12:00:00Z"),
    ...overrides,
  };
}

interface SqlCall { text: string; args: unknown[] }

/**
 * Fake sql. Routes by the SQL text itself rather than by call index, because
 * this sweeper's call order varies with the decisions it makes — an
 * index-keyed fake would silently feed deal rows to an INSERT.
 */
function makeSql(candidates: unknown[], opts: { failInsertDecisions?: boolean } = {}) {
  const calls: SqlCall[] = [];
  const sql = ((tpl: TemplateStringsArray, ...values: unknown[]) => {
    const text = tpl.join("?");
    calls.push({ text, args: values });
    if (/INSERT INTO sweeper_runs/i.test(text)) {
      return Promise.resolve([{ id: "run-0000-0000-0000-000000000001" }]);
    }
    if (/INSERT INTO sweeper_decisions/i.test(text)) {
      if (opts.failInsertDecisions) return Promise.reject(new Error("decisions table gone"));
      return Promise.resolve([]);
    }
    if (/FROM deals d/i.test(text)) return Promise.resolve(candidates);
    return Promise.resolve([]);
  }) as unknown as SqlClient;
  const decisionFor = (dealId: string) =>
    calls.filter((c) => /INSERT INTO sweeper_decisions/i.test(c.text))
         .find((c) => c.args[1] === dealId);
  return { sql, calls, decisionFor };
}

function dealRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-0000-0000-0000-000000000001",
    status: "delivered",
    buyer_agent_id: "buyer-1",
    seller_agent_id: "seller-1",
    title: "Scrape 3 marketplaces",
    description: "CSV of all listings with price and url",
    fulfillment_type: "data-delivery",
    fulfillment_data: { description: "412 rows delivered", artifact_urls: ["https://x.test/out.csv"] },
    seller_completed_count: 4,
    is_self_deal: false,
    ...overrides,
  };
}

/** Fake fetch returning a fixed judge probability, then a fixed API reply. */
function makeFetch(opts: {
  p?: number;
  judgeStatus?: number;
  judgeBody?: unknown;
  apiBody?: unknown;
  apiStatus?: number;
}) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, init });
    if (u.includes("classifier.dev") || u.includes("judge.test")) {
      const status = opts.judgeStatus ?? 200;
      const body = opts.judgeBody ?? {
        model: "jev-1.13.0",
        results: [{ label: "satisfied", confidence: 0.9, scores: { satisfied: opts.p ?? 0.95, unsatisfied: 1 - (opts.p ?? 0.95) } }],
      };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(opts.apiBody ?? { ok: true, completed: true }), {
      status: opts.apiStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

// ── jev.ts: evidence redaction ──────────────────────────────────────────────

describe("buildEvidence — credential boundary", () => {
  it("never sends auth/token/secret fields to the judge", () => {
    const ev = buildEvidence({
      dealTitle: "API access",
      dealDescription: "read-only key",
      fulfillmentType: "api-access",
      fulfillmentData: {
        endpoint_url: "https://api.test/v1",
        auth_type: "bearer",
        auth_value: "SUPERSECRET-TOKEN-VALUE",
        auth_header: "Authorization",
        access_method: "http",
      },
    });
    assert.ok(ev.includes("https://api.test/v1"), "allowlisted field must survive");
    assert.ok(!ev.includes("SUPERSECRET-TOKEN-VALUE"), "credential value must never reach the judge");
    assert.ok(!/auth_value/.test(ev), "credential key must not appear either");
    assert.ok(/withheld/.test(ev), "judge must be told fields were withheld, not shown an empty delivery");
  });

  it("handles a string payload and a null payload without throwing", () => {
    assert.ok(buildEvidence({ dealTitle: "t", fulfillmentData: "just text" }).includes("just text"));
    assert.ok(buildEvidence({ dealTitle: "t", fulfillmentData: null }).includes("no structured payload"));
  });
});

describe("rubricHash", () => {
  it("is stable for the same rubric and changes when the rubric changes", () => {
    assert.equal(rubricHash(), rubricHash());
    assert.notEqual(rubricHash(), rubricHash(["different rubric"]));
    assert.match(rubricHash(), /^fnv1a32:[0-9a-f]{8}$/);
  });
});

// ── jev.ts: verdict parsing ─────────────────────────────────────────────────

describe("parseVerdict", () => {
  it("reads the live classifier.dev shape", () => {
    const v = parseVerdict({
      model: "jev-1.13.0",
      results: [{ label: "satisfied", confidence: 0.92, scores: { satisfied: 0.96, unsatisfied: 0.04 } }],
    });
    assert.equal(v.available, true);
    assert.equal(v.p, 0.96);
    assert.equal(v.judge, "jev-1.13.0@classifier.dev", "receipt must name judge@version, never bare 'jev'");
  });

  it("returns UNAVAILABLE (not p=0) when the probability is missing", () => {
    const v = parseVerdict({ model: "jev-1.13.0", results: [{ label: "satisfied" }] });
    assert.equal(v.available, false, "a parseable response with no score is not a confident 'bad delivery'");
    assert.equal(v.p, 0);
  });

  it("returns unavailable for junk", () => {
    assert.equal(parseVerdict(null).available, false);
    assert.equal(parseVerdict({ results: [] }).available, false);
    assert.equal(parseVerdict({ results: [{ scores: { satisfied: "high" } }] }).available, false);
  });

  it("prefers the per-result model over the batch header", () => {
    const v = parseVerdict({ model: "jev-fast", results: [{ scores: { satisfied: 0.9 }, model: "jev-1.13.0-escalated" }] });
    assert.equal(v.judge, "jev-1.13.0-escalated@classifier.dev");
  });
});

describe("judgeDelivery — fail closed", () => {
  it("returns unavailable (never a release) when the endpoint is down", async () => {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const v = await judgeDelivery("evidence", { fetchImpl: boom, attempts: 1, endpoint: "https://judge.test" });
    assert.equal(v.available, false);
    assert.match(v.reason, /ECONNREFUSED/);
  });

  it("does not retry a hard 4xx", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response("nope", { status: 400 }); }) as unknown as typeof fetch;
    await judgeDelivery("e", { fetchImpl: f, attempts: 3, endpoint: "https://judge.test" });
    assert.equal(n, 1, "a 400 will not become a 200 on retry");
  });

  it("posts to the bare endpoint with a labels LIST (the live contract)", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const f = (async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ model: "jev-1.13.0", results: [{ scores: { satisfied: 0.9 } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await judgeDelivery("e", { fetchImpl: f, endpoint: "https://judge.test" });
    assert.equal(captured!.url, "https://judge.test", "no /v1/classify suffix — the bare endpoint is the API");
    assert.ok(Array.isArray(captured!.body.labels), "labels must be a LIST, not a description map");
    assert.ok(String((captured!.init as never) ?? "") !== "x");
  });
});

// ── the sweeper ─────────────────────────────────────────────────────────────

describe("runSettlementSweep", () => {
  it("releases a well-evidenced expired deal and records judge+p+rubric", async () => {
    const { sql, decisionFor } = makeSql([dealRow()]);
    const { impl, seen } = makeFetch({ p: 0.96 });
    const r = await runSettlementSweep(sql, baseCfg({ fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));

    assert.equal(r.acted, 1);
    assert.equal(r.scanned, 1);
    const apiCall = seen.find((s) => s.url.includes("/fulfillment/auto-complete"));
    assert.ok(apiCall, "money must move through the API route, not through this daemon");
    assert.equal((apiCall!.init!.headers as Record<string, string>)["x-admin-key"], "test-admin-key");

    const d = decisionFor("deal-0000-0000-0000-000000000001")!;
    assert.equal(d.args[2], "complete");
    assert.equal(d.args[3], "jev-1.13.0@classifier.dev");
    assert.equal(d.args[4], 0.96);
    assert.match(String(d.args[5]), /^fnv1a32:/, "every receipt carries the rubric hash");
  });

  it("NEVER releases a self-deal, and never even calls the judge for one", async () => {
    const { sql, decisionFor } = makeSql([dealRow({ is_self_deal: true, seller_agent_id: "buyer-1" })]);
    const { impl, seen } = makeFetch({ p: 0.99 });
    const r = await runSettlementSweep(sql, baseCfg({ fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));

    assert.equal(r.acted, 0, "a self-deal must never generate a platform fee row");
    assert.equal(seen.length, 0, "no judge spend and no API call on a self-deal");
    assert.equal(decisionFor("deal-0000-0000-0000-000000000001")!.args[2], "skip_self_deal");
  });

  it("HOLDS when the judge is unavailable — an outage is not a payout", async () => {
    const { sql, decisionFor } = makeSql([dealRow()]);
    const judgeDown = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("judge.test")) throw new Error("judge down");
      return new Response(JSON.stringify({ ok: true, completed: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runSettlementSweep(sql, baseCfg({ fetchImpl: judgeDown, jev: { fetchImpl: judgeDown, attempts: 1, endpoint: "https://judge.test" } }));

    assert.equal(r.acted, 0);
    assert.equal(r.held, 1);
    assert.equal(decisionFor("deal-0000-0000-0000-000000000001")!.args[2], "hold");
  });

  it("sends a weakly-evidenced deal to review instead of releasing it", async () => {
    const { sql, decisionFor } = makeSql([dealRow({ fulfillment_data: { description: "will send soon" } })]);
    const { impl, seen } = makeFetch({ p: 0.22 });
    const r = await runSettlementSweep(sql, baseCfg({ fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));

    assert.equal(r.acted, 0);
    assert.ok(!seen.some((s) => s.url.includes("auto-complete")), "no release below threshold");
    const d = decisionFor("deal-0000-0000-0000-000000000001")!;
    assert.equal(d.args[2], "review");
    assert.equal(d.args[4], 0.22, "the probability is recorded even when it does not release");
  });

  it("does not count settlement_pending as a completion", async () => {
    const { sql, decisionFor } = makeSql([dealRow()]);
    const { impl } = makeFetch({ p: 0.97, apiBody: { ok: true, completed: false, settlement_pending: true } });
    const r = await runSettlementSweep(sql, baseCfg({ fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));

    assert.equal(r.acted, 0, "an unfunded deal held at 'delivered' has not completed");
    assert.equal(r.held, 1);
    assert.match(String(decisionFor("deal-0000-0000-0000-000000000001")!.args[6]), /settlement_pending/);
  });

  it("shadow mode judges and records but never calls the API", async () => {
    const { sql, decisionFor } = makeSql([dealRow()]);
    const { impl, seen } = makeFetch({ p: 0.99 });
    const r = await runSettlementSweep(sql, baseCfg({ autoReleaseEnabled: false, fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));

    assert.equal(r.acted, 0);
    assert.ok(!seen.some((s) => s.url.includes("auto-complete")), "shadow mode must not move money");
    assert.equal(decisionFor("deal-0000-0000-0000-000000000001")!.args[2], "review");
  });

  it("fails closed when ADMIN_API_KEY is unset rather than silently skipping", async () => {
    const { sql, decisionFor } = makeSql([dealRow()]);
    const { impl } = makeFetch({ p: 0.99 });
    const r = await runSettlementSweep(sql, baseCfg({ adminApiKey: undefined, fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));

    assert.equal(r.failed, 1);
    assert.match(String(decisionFor("deal-0000-0000-0000-000000000001")!.args[6]), /ADMIN_API_KEY unset/);
  });

  it("opens the run row BEFORE working, so a crashed tick stays visible", async () => {
    const calls: string[] = [];
    const sql = ((tpl: TemplateStringsArray) => {
      const text = tpl.join("?");
      calls.push(text);
      if (/INSERT INTO sweeper_runs/i.test(text)) return Promise.resolve([{ id: "run-1" }]);
      if (/FROM deals d/i.test(text)) return Promise.reject(new Error("db exploded mid-scan"));
      return Promise.resolve([]);
    }) as unknown as SqlClient;

    await assert.rejects(() => runSettlementSweep(sql, baseCfg()), /db exploded/);
    assert.match(calls[0], /INSERT INTO sweeper_runs/i, "run row is opened first");
    assert.ok(calls.some((c) => /UPDATE sweeper_runs/i.test(c) && /error/i.test(c)), "the error is written to the run row");
  });

  it("a failing decisions insert does not abort the remaining candidates", async () => {
    const { sql } = makeSql([dealRow({ id: "d1" }), dealRow({ id: "d2" })], { failInsertDecisions: true });
    const { impl } = makeFetch({ p: 0.96 });
    const r = await runSettlementSweep(sql, baseCfg({ fetchImpl: impl, jev: { fetchImpl: impl, endpoint: "https://judge.test" } }));
    assert.equal(r.scanned, 2);
    assert.equal(r.acted, 2, "both deals still processed despite receipt-write failure");
  });

  it("bounds each tick by maxPerTick", async () => {
    const { sql, calls } = makeSql([]);
    await runSettlementSweep(sql, baseCfg({ maxPerTick: 7 }));
    const scan = calls.find((c) => /FROM deals d/i.test(c.text))!;
    assert.ok(scan.args.includes(7), "LIMIT is parameterised from config, bounding blast radius and judge spend");
  });

  it("caps the release call and treats a timeout as AMBIGUOUS, never retrying it", async () => {
    // A lost response on a money-moving call may mean the release SUCCEEDED.
    // Retrying it is how you double-pay; the receipt must say so out loud.
    const { sql, decisionFor } = makeSql([dealRow()]);
    let apiCalls = 0, sawSignal = false, aborted = false;
    const hang = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("judge.test")) {
        return new Response(JSON.stringify({ model: "jev-1.13.0", results: [{ scores: { satisfied: 0.97 } }] }), { status: 200 });
      }
      apiCalls++;
      // Record whether a signal arrived AND whether it actually fired. The
      // first version of this test rejected on a missing signal — useless,
      // because the sweeper's catch block wraps EVERY error into the same
      // "AMBIGUOUS" reason, so the assertion passed even with the signal
      // removed. Mutation-tested: deleting `signal: ctrl.signal` must fail.
      sawSignal = Boolean(init?.signal);
      return await new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => { aborted = true; reject(new Error("The operation was aborted")); });
        // No signal => hang past the test's own budget, so a sweeper that
        // forgot the timeout cannot quietly pass.
        setTimeout(() => reject(new Error("fetch was never aborted — no timeout on the money call")), 2000);
      });
    }) as unknown as typeof fetch;

    const r = await runSettlementSweep(sql, baseCfg({
      apiTimeoutMs: 50, fetchImpl: hang, jev: { fetchImpl: hang, endpoint: "https://judge.test" },
    }));

    assert.ok(sawSignal, "the release call must carry an AbortSignal — otherwise there is no timeout");
    assert.ok(aborted, "the signal must actually fire, capping the call");
    assert.equal(apiCalls, 1, "an ambiguous money call must NOT be retried");
    assert.equal(r.acted, 0, "a lost response is never counted as a completion");
    assert.match(String(decisionFor("deal-0000-0000-0000-000000000001")!.args[6]), /AMBIGUOUS/);
  });

  it("uses the per-deal route's timeout default (1), not the admin route's (7)", async () => {
    // routes/fulfillment.ts:795 defaults to 1; routes/admin.ts:473 to 7. This
    // sweeper calls the FORMER, so selecting on 7 would leave a NULL-timeout
    // deal unreleased for six extra days.
    const { sql, calls } = makeSql([]);
    await runSettlementSweep(sql, baseCfg());
    const scan = calls.find((c) => /FROM deals d/i.test(c.text))!.text;
    assert.match(scan, /COALESCE\(d\.acceptance_timeout_days, 1\)/);
  });

  // REGRESSION GUARD. These assertions exist because the first version of the
  // candidate query selected d.title / d.description — columns that DO NOT
  // EXIST on `deals` (the text lives on the joined offers/needs rows). Every
  // unit test above passed, because a fake sql client cannot reject a column
  // name; the bug would have thrown 42703 on the first production tick and the
  // sweeper would have been dead on arrival. The second version then raised
  // 42804 by COALESCE-ing jsonb acceptance_criteria with text columns.
  //
  // A fake-sql test can never fully replace running against a real schema
  // (see ap-live-probe in the PR), but it CAN pin the two specific mistakes so
  // a future refactor cannot silently reintroduce them.
  it("does not select title/description from deals, and casts jsonb criteria", async () => {
    const { sql, calls } = makeSql([]);
    await runSettlementSweep(sql, baseCfg());
    const scan = calls.find((c) => /FROM deals d/i.test(c.text))!.text;

    assert.ok(!/\bd\.title\b/.test(scan), "deals has no title column — it lives on offers/needs");
    assert.ok(!/\bd\.description\b/.test(scan), "deals has no description column — it lives on offers/needs");
    assert.ok(/JOIN\s+offers/i.test(scan) && /JOIN\s+needs/i.test(scan), "the human-readable terms must be joined in");
    assert.ok(
      /acceptance_criteria::text/.test(scan),
      "acceptance_criteria is jsonb; COALESCE with text raises 42804 without an explicit cast",
    );
    assert.ok(
      /NULLIF\(\s*n\.acceptance_criteria::text,\s*'null'\s*\)/.test(scan),
      "a jsonb null casts to the string 'null' and must not be handed to the judge as requirements",
    );
  });
});
