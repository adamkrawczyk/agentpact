import { describe, expect, it } from "vitest";
import { createRecomputeMatchesQueue } from "../routes/matching.js";

describe("matching recompute queue", () => {
  it("collapses concurrent recompute requests into one active run plus one queued rerun", async () => {
    let runs = 0;
    let releaseFirstRun!: () => void;

    const queue = createRecomputeMatchesQueue(async () => {
      runs += 1;
      const currentRun = runs;
      if (currentRun === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
      }
      return currentRun;
    });

    const first = queue.recomputeNow();
    const rest = Array.from({ length: 99 }, () => queue.recomputeNow());

    expect(runs).toBe(1);
    expect(queue.status()).toMatchObject({ inFlight: true, dirty: true });
    releaseFirstRun();

    await expect(Promise.all([first, ...rest])).resolves.toEqual([3, ...Array(99).fill(2)]);
    expect(runs).toBe(2);
    expect(queue.status()).toMatchObject({ inFlight: false, dirty: false, lastError: undefined });
    expect(queue.status().lastStartedAt).toEqual(expect.any(String));
    expect(queue.status().lastFinishedAt).toEqual(expect.any(String));
  });

  it("exposes observable queue status and emits lifecycle events", async () => {
    const events: string[] = [];
    const queue = createRecomputeMatchesQueue(async () => 7, {
      onEvent: (event) => events.push(event),
    });

    expect(queue.status()).toMatchObject({ dirty: false, inFlight: false });
    await expect(queue.recomputeNow()).resolves.toBe(7);

    expect(events).toEqual(["matching.started", "matching.finished"]);
    expect(queue.status()).toMatchObject({
      dirty: false,
      inFlight: false,
      lastError: undefined,
      lastStartedAt: expect.any(String),
      lastFinishedAt: expect.any(String),
    });
  });

  it("records last errors and emits error events", async () => {
    const events: string[] = [];
    const queue = createRecomputeMatchesQueue(async () => {
      throw new Error("boom");
    }, {
      onEvent: (event) => events.push(event),
    });

    await expect(queue.recomputeNow()).rejects.toThrow("boom");
    expect(events).toEqual(["matching.started", "matching.error"]);
    expect(queue.status()).toMatchObject({
      dirty: false,
      inFlight: false,
      lastError: "boom",
      lastStartedAt: expect.any(String),
      lastFinishedAt: expect.any(String),
    });
  });
});
