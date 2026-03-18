import test from "node:test";
import assert from "node:assert/strict";

import { buildSeenMatchKey, mergeSeenMatches, shouldNotifyForMatch } from "./agentpact-daemon.ts";

test("shouldNotifyForMatch enforces price, category, and score policy", () => {
  const match = {
    score: 0.82,
    offer: {
      basePrice: 8,
      category: "research",
    },
  };

  assert.equal(
    shouldNotifyForMatch(match, {
      maxPrice: 10,
      categories: ["research", "code"],
      minScore: 0.7,
    }),
    true
  );

  assert.equal(
    shouldNotifyForMatch(match, {
      maxPrice: 5,
      categories: ["research", "code"],
      minScore: 0.7,
    }),
    false
  );

  assert.equal(
    shouldNotifyForMatch(match, {
      maxPrice: 10,
      categories: ["code"],
      minScore: 0.7,
    }),
    false
  );

  assert.equal(
    shouldNotifyForMatch(match, {
      maxPrice: 10,
      categories: ["research", "code"],
      minScore: 0.9,
    }),
    false
  );
});

test("mergeSeenMatches deduplicates match ids while preserving prior state", () => {
  const merged = mergeSeenMatches(
    {
      seenMatches: [buildSeenMatchKey("offer-1", "need-1")],
      lastCheckAt: "2026-03-18T00:00:00.000Z",
    },
    [
      { offerId: "offer-1", needId: "need-1" },
      { offerId: "offer-2", needId: "need-2" },
      { offerId: "offer-2", needId: "need-2" },
    ],
    "2026-03-18T00:05:00.000Z"
  );

  assert.deepEqual(merged.seenMatches, [
    "offer-1:need-1",
    "offer-2:need-2",
  ]);
  assert.equal(merged.lastCheckAt, "2026-03-18T00:05:00.000Z");
});
