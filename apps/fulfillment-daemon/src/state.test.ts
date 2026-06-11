import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadState, saveState, markProcessed, isProcessed, createEmptyState } from "./state.js";

test("state: roundtrips processedOrderIds", () => {
  const dir = mkdtempSync(join(tmpdir(), "fulfillment-state-"));
  const path = join(dir, "state.json");

  const state = createEmptyState();
  const updated = markProcessed(state, "order-1");
  saveState(path, updated);

  const loaded = loadState(path);
  assert.ok(isProcessed(loaded, "order-1"));
  assert.equal(loaded.processedOrderIds.length, 1);
});

test("state: prunes to 100 entries", () => {
  let state = createEmptyState();
  for (let i = 0; i < 110; i++) {
    state = markProcessed(state, `order-${i}`);
  }
  assert.equal(state.processedOrderIds.length, 100);
  // should have last 100 (order-10 through order-109)
  assert.ok(!isProcessed(state, "order-0"));
  assert.ok(isProcessed(state, "order-109"));
});

test("state: markProcessed is idempotent", () => {
  let state = createEmptyState();
  state = markProcessed(state, "order-abc");
  state = markProcessed(state, "order-abc");
  state = markProcessed(state, "order-abc");
  assert.equal(state.processedOrderIds.length, 1);
});

test("state: loadState returns empty state on missing file", () => {
  const state = loadState("/tmp/nonexistent-path-xyz/state.json");
  assert.deepEqual(state.processedOrderIds, []);
  assert.equal(state.lastTickAt, null);
});
