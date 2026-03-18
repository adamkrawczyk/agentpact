import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
test("dry-run flag is exposed through runtime config", () => {
    const config = loadConfig({
        env: {
            AGENTPACT_API_KEY: "key-123",
            AGENTPACT_AGENT_ID: "agent-123",
        },
        argv: ["--dry-run"],
        homeDir: "/tmp/agent-home",
    });
    assert.equal(config.flags.dryRun, true);
});
