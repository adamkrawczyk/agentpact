import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { diffMatches, loadState, saveState } from "./state.js";

test("diffMatches returns only unseen match fingerprints", () => {
  const diff = diffMatches(
    [{ fingerprint: "offer-1:need-1" }],
    [
      { fingerprint: "offer-1:need-1", score: 0.9 },
      { fingerprint: "offer-2:need-2", score: 0.8 },
    ],
  );

  assert.deepEqual(diff.map((match) => match.fingerprint), ["offer-2:need-2"]);
});

test("saveState persists seen matches and autopilot history", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentpact-daemon-state-"));
  const statePath = join(dir, "daemon-state.json");

  saveState(statePath, {
    seenMatchFingerprints: ["offer-1:need-1"],
    autopilotDeals: [{ matchFingerprint: "offer-1:need-1", createdAt: "2026-03-18T08:00:00.000Z" }],
    lastWatchAt: "2026-03-18T08:05:00.000Z",
  });

  const state = loadState(statePath);
  assert.equal(state.lastWatchAt, "2026-03-18T08:05:00.000Z");
  assert.deepEqual(state.seenMatchFingerprints, ["offer-1:need-1"]);
  assert.deepEqual(state.autopilotDeals, [{ matchFingerprint: "offer-1:need-1", createdAt: "2026-03-18T08:00:00.000Z" }]);

  const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(raw.lastWatchAt, "2026-03-18T08:05:00.000Z");
});
