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
    const second = queue.recomputeNow();
    const third = queue.recomputeNow();

    expect(runs).toBe(1);
    releaseFirstRun();

    await expect(Promise.all([first, second, third])).resolves.toEqual([3, 3, 3]);
    expect(runs).toBe(2);
  });

  it("schedules dirty recomputes without starting duplicate timers", async () => {
    let runs = 0;
    let resolveRun!: () => void;

    const queue = createRecomputeMatchesQueue(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return 1;
    }, { delayMs: 0 });

    queue.scheduleRecompute();
    queue.scheduleRecompute();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs).toBe(1);
    resolveRun();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
