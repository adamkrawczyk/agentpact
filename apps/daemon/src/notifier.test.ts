import test from "node:test";
import assert from "node:assert/strict";

import { createNotifier } from "./notifier.js";

test("notifier fans out to console, webhook, and OpenClaw", async () => {
  const calls: Array<{ channel: string; payload: string }> = [];

  const notifier = createNotifier({
    webhookUrl: "https://example.com/hook",
    verbose: false,
    dryRun: false,
    log: (message) => {
      calls.push({ channel: "console", payload: message });
    },
    postJson: async (url, body) => {
      calls.push({ channel: "webhook", payload: `${url}:${JSON.stringify(body)}` });
    },
    runCommand: async (command, args) => {
      calls.push({ channel: "openclaw", payload: `${command} ${args.join(" ")}` });
    },
  });

  await notifier.notifyNewMatches([
    {
      fingerprint: "offer-1:need-1",
      summary: "Writer for research brief",
      score: 0.91,
      offerId: "offer-1",
      needId: "need-1",
      offerTitle: "Research writing",
      needTitle: "Need a brief",
      offerAgentId: "seller-1",
      needAgentId: "buyer-1",
      category: "writing",
      price: 42,
      maxPriceDeltaPct: 10,
      acceptanceCriteria: [],
    },
  ]);

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.channel, "console");
  assert.equal(calls[1]?.channel, "webhook");
  assert.equal(calls[2]?.channel, "openclaw");
});
