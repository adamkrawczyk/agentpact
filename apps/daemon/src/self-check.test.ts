import { test } from "node:test";
import * as assert from "node:assert/strict";

import { runSelfCheck } from "./self-check.js";
import type { RuntimeConfig } from "./config.js";

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    apiUrl: "http://api.test",
    apiKey: "key-123",
    agentId: "agent-123",
    heartbeatIntervalMs: 60_000,
    watchIntervalMs: 300_000,
    stateFilePath: "/tmp/agentpact-daemon-self-check-test.json",
    autopilot: {
      enabled: false,
      threshold: 0.85,
      maxPrice: 100,
      rateLimitPerHour: 3,
    },
    flags: {
      dryRun: true,
      verbose: false,
    },
    ...overrides,
  };
}

test("runSelfCheck verifies API, auth, agent, heartbeat, recommendations, and autopilot config", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.endsWith("/api/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/api/auth/verify")) {
      return new Response(JSON.stringify({ agentId: "agent-123" }), { status: 200 });
    }
    if (url.endsWith("/api/agents/agent-123")) {
      return new Response(JSON.stringify({ id: "agent-123" }), { status: 200 });
    }
    if (url.endsWith("/api/agents/agent-123/heartbeat")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/api/matches/recommendations")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;

  const results = await runSelfCheck({ config: makeConfig(), fetchFn, log: () => undefined });

  assert.equal(results.length, 6);
  assert.deepEqual(results.map((result) => [result.name, result.ok]), [
    ["API reachable", true],
    ["auth works", true],
    ["agent exists", true],
    ["heartbeat works", true],
    ["recommendations endpoint works", true],
    ["autopilot config valid", true],
  ]);
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "GET /api/health",
    "GET /api/auth/verify",
    "GET /api/agents/agent-123",
    "POST /api/agents/agent-123/heartbeat",
    "GET /api/matches/recommendations",
  ]);
});

test("runSelfCheck fails auth when API key belongs to a different agent", async () => {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/auth/verify")) {
      return new Response(JSON.stringify({ agentId: "other-agent" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const results = await runSelfCheck({ config: makeConfig(), fetchFn, log: () => undefined });
  const auth = results.find((result) => result.name === "auth works");

  assert.equal(auth?.ok, false);
  assert.match(auth?.detail ?? "", /belongs to other-agent/);
});
