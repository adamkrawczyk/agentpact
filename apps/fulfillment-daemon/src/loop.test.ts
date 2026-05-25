import test from "node:test";
import assert from "node:assert/strict";

import type { ApiClient, AuditOrder } from "./api-client.js";
import { OrderAlreadyClaimed } from "./api-client.js";
import { createEmptyState } from "./state.js";
import { runTick } from "./loop.js";

const baseOrder: AuditOrder = {
  id: "order-1",
  stripe_session_id: "cs_test_abc",
  buyer_email: "buyer@test.com",
  contract_address: "0xABC123",
  contract_chain: "base",
  amount_cents: 500,
  currency: "USD",
  status: "paid",
  created_at: new Date().toISOString(),
};

const baseConfig = {
  apiUrl: "https://api.test",
  adminApiKey: "admin-key",
  runnerCliPath: "/app/scripts/audit-runner-cli.ts",
  tickSeconds: 60,
  logLevel: "info" as const,
  dryRun: true,
  stateFilePath: "/tmp/state.json",
};

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listPaidOrders: async () => [baseOrder],
    claimOrder: async () => baseOrder,
    reportOrder: async () => ({ ok: true }),
    refundOrder: async () => ({ ok: true }),
    ...overrides,
  };
}

test("loop: happy path (dry-run) — processes order and marks in state", async () => {
  const reportCalls: string[] = [];
  const client = makeClient({
    reportOrder: async (id) => {
      reportCalls.push(id);
      return { ok: true };
    },
  });

  const result = await runTick({
    apiClient: client,
    config: baseConfig,
    state: createEmptyState(),
    tickN: 1,
    log: () => {},
  });

  assert.equal(result.processed, 1);
  assert.equal(reportCalls[0], "order-1");
  assert.ok(result.state.processedOrderIds.includes("order-1"));
});

test("loop: 409 from claimOrder → skip, not processed", async () => {
  const reportCalls: string[] = [];
  const client = makeClient({
    claimOrder: async (id) => {
      throw new OrderAlreadyClaimed(id);
    },
    reportOrder: async (id) => {
      reportCalls.push(id);
      return { ok: true };
    },
  });

  const result = await runTick({
    apiClient: client,
    config: baseConfig,
    state: createEmptyState(),
    tickN: 1,
    log: () => {},
  });

  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(reportCalls.length, 0);
});

test("loop: already-processed orders are skipped (idempotent)", async () => {
  const claimCalls: string[] = [];
  const client = makeClient({
    claimOrder: async (id) => {
      claimCalls.push(id);
      return baseOrder;
    },
  });

  const stateWithProcessed = {
    processedOrderIds: ["order-1"],
    lastTickAt: null,
  };

  const result = await runTick({
    apiClient: client,
    config: baseConfig,
    state: stateWithProcessed,
    tickN: 1,
    log: () => {},
  });

  assert.equal(claimCalls.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.processed, 0);
});

test("loop: runner fail (non-dry-run) → refundOrder is called", async () => {
  const refundCalls: string[] = [];
  const reportCalls: Array<{ id: string; body: { verdict: string } }> = [];

  // Use non-dry-run config so runner actually runs
  const configNoMock = { ...baseConfig, dryRun: false };

  const client = makeClient({
    reportOrder: async (id, body) => {
      reportCalls.push({ id, body: body as { verdict: string } });
      return { ok: true };
    },
    refundOrder: async (id) => {
      refundCalls.push(id);
      return { ok: true };
    },
  });

  // The runner will fail because the CLI path doesn't exist in test env —
  // we patch the spawn behaviour via dryRun path is off but we can mock the runner:
  // Instead override runnerCliPath to something that produces spawn error.
  // Actually the loop calls runAuditRunner which calls spawn — the easiest is to
  // test runner-fail scenario by using a config where the runner path won't be found
  // and expecting a RunnerError.
  // But to keep this a unit test (no real subprocess), use dryRun = false and
  // inject a config with runnerCliPath that causes spawn to return exit-code 1.
  // Since we can't easily mock spawn in the loop without dependency injection,
  // we verify through a different approach: pass a non-existent runner path and
  // expect refund to be called when spawn/npx tsx errors out.
  // However since tests run in tmpdir, npx tsx /nonexistent.ts will fail fast.

  const failConfig = {
    ...configNoMock,
    runnerCliPath: "/nonexistent/audit-runner-cli.ts",
  };

  const result = await runTick({
    apiClient: client,
    config: failConfig,
    state: createEmptyState(),
    tickN: 1,
    log: () => {},
  });

  assert.equal(result.failed, 1);
  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0], "order-1");
  assert.ok(reportCalls.some((r) => r.body.verdict === "FAIL"));
});

test("loop: listPaidOrders error → returns 0 processed, no crash", async () => {
  const client = makeClient({
    listPaidOrders: async () => {
      throw new Error("network error");
    },
  });

  const result = await runTick({
    apiClient: client,
    config: baseConfig,
    state: createEmptyState(),
    tickN: 1,
    log: () => {},
  });

  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
});
