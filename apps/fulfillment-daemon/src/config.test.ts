import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";

test("config: loads valid env with defaults", () => {
  const config = loadConfig({
    env: { ADMIN_API_KEY: "secret-key" },
    homeDir: "/tmp/home",
  });

  assert.equal(config.apiUrl, "https://api.agentpact.xyz");
  assert.equal(config.adminApiKey, "secret-key");
  assert.equal(config.runnerCliPath, "/app/scripts/audit-runner-cli.ts");
  assert.equal(config.tickSeconds, 60);
  assert.equal(config.logLevel, "info");
  assert.equal(config.dryRun, false);
  assert.equal(config.stateFilePath, "/tmp/home/.agentpact-fulfillment/state.json");
});

test("config: throws on missing ADMIN_API_KEY", () => {
  assert.throws(
    () => loadConfig({ env: {}, homeDir: "/tmp/home" }),
    /ADMIN_API_KEY/
  );
});

test("config: coerces booleanish DRY_RUN=true", () => {
  const config = loadConfig({
    env: { ADMIN_API_KEY: "k", DRY_RUN: "true" },
    homeDir: "/tmp",
  });
  assert.equal(config.dryRun, true);
});

test("config: coerces booleanish DRY_RUN=1", () => {
  const config = loadConfig({
    env: { ADMIN_API_KEY: "k", DRY_RUN: "1" },
    homeDir: "/tmp",
  });
  assert.equal(config.dryRun, true);
});

test("config: respects custom AGENTPACT_API_URL", () => {
  const config = loadConfig({
    env: { ADMIN_API_KEY: "k", AGENTPACT_API_URL: "https://local.test" },
    homeDir: "/tmp",
  });
  assert.equal(config.apiUrl, "https://local.test");
});
