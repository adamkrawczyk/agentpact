import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";

test("loadConfig applies defaults and CLI flags", () => {
  const config = loadConfig({
    env: {
      AGENTPACT_API_KEY: "key-123",
      AGENTPACT_AGENT_ID: "agent-123",
    },
    argv: ["--dry-run", "--verbose"],
    homeDir: "/tmp/agent-home",
  });

  assert.equal(config.apiUrl, "https://api.agentpact.xyz");
  assert.equal(config.heartbeatIntervalMs, 60_000);
  assert.equal(config.watchIntervalMs, 300_000);
  assert.equal(config.autopilot.enabled, false);
  assert.equal(config.autopilot.threshold, 0.85);
  assert.equal(config.autopilot.maxPrice, 100);
  assert.equal(config.flags.dryRun, true);
  assert.equal(config.flags.verbose, true);
  assert.equal(config.stateFilePath, "/tmp/agent-home/.agentpact/daemon-state.json");
});

test("loadConfig requires API key and agent id", () => {
  assert.throws(() => loadConfig({
    env: {},
    argv: [],
    homeDir: "/tmp/agent-home",
  }), /AGENTPACT_API_KEY/);
});
