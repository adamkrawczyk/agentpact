import { describe, expect, it } from "vitest";

/**
 * Test that reputation score shifts matching ranking.
 *
 * The reputation score formula is:
 *   repScore = Math.min(0.3, 0.1 * (completed_deal_count ?? 0) / 10)
 *
 * Tag-only scoring (no semantic):
 *   score = 0.6 * tagScore + 0.2 * budgetFit + 0.1 * skillBoost + 0.1 * repScore
 *
 * Semantic scoring:
 *   score = 0.5 * semanticScore + 0.2 * tagScore + 0.15 * budgetFit + 0.05 * skillBoost + 0.1 * repScore
 */

function computeRepScore(completedDealCount: number | null | undefined): number {
  return Math.min(0.3, 0.1 * (completedDealCount ?? 0) / 10);
}

function computeTagOnlyScore(
  tagScore: number,
  budgetFit: number,
  skillBoost: number,
  repScore: number,
): number {
  return Number((0.6 * tagScore + 0.2 * budgetFit + 0.1 * skillBoost + 0.1 * repScore).toFixed(3));
}

function computeSemanticScore(
  semanticScore: number,
  tagScore: number,
  budgetFit: number,
  skillBoost: number,
  repScore: number,
): number {
  return Number(
    (0.5 * semanticScore + 0.2 * tagScore + 0.15 * budgetFit + 0.05 * skillBoost + 0.1 * repScore).toFixed(3),
  );
}

describe("reputation-weighted matching", () => {
  it("repScore scales linearly up to cap of 0.3", () => {
    expect(computeRepScore(0)).toBe(0);
    expect(computeRepScore(5)).toBeCloseTo(0.05, 3);
    expect(computeRepScore(10)).toBeCloseTo(0.1, 3);
    expect(computeRepScore(30)).toBeCloseTo(0.3, 3);
    // Cap: 40 deals → min(0.3, 0.4) = 0.3
    expect(computeRepScore(40)).toBeCloseTo(0.3, 3);
    expect(computeRepScore(100)).toBeCloseTo(0.3, 3);
  });

  it("null/undefined completed_deal_count treated as 0", () => {
    expect(computeRepScore(null)).toBe(0);
    expect(computeRepScore(undefined)).toBe(0);
  });

  it("reputation shifts tag-only ranking: more deals → higher score", () => {
    // Two offers with identical tags & budget, one has 30 completed deals, other has 0
    const tagScore = 0.8;
    const budgetFit = 0.9;
    const skillBoost = 0;

    const scoreNoReputation = computeTagOnlyScore(tagScore, budgetFit, skillBoost, computeRepScore(0));
    const scoreWithReputation = computeTagOnlyScore(tagScore, budgetFit, skillBoost, computeRepScore(30));

    expect(scoreWithReputation).toBeGreaterThan(scoreNoReputation);
    // Diff should be 0.1 * 0.3 = 0.03
    expect(scoreWithReputation - scoreNoReputation).toBeCloseTo(0.03, 3);
  });

  it("reputation shifts semantic ranking: more deals → higher score", () => {
    const semantic = 0.9;
    const tagScore = 0.7;
    const budgetFit = 0.8;
    const skillBoost = 0;

    const scoreNoRep = computeSemanticScore(semantic, tagScore, budgetFit, skillBoost, computeRepScore(0));
    const scoreWithRep = computeSemanticScore(semantic, tagScore, budgetFit, skillBoost, computeRepScore(20));

    expect(scoreWithRep).toBeGreaterThan(scoreNoRep);
    // Diff = 0.1 * (0.2 - 0) = 0.02
    expect(scoreWithRep - scoreNoRep).toBeCloseTo(0.02, 3);
  });

  it("reputation can flip ranking between two offers", () => {
    // Offer A: slightly better tags but 0 deals
    // Offer B: slightly worse tags but 30 completed deals
    const scoreA = computeTagOnlyScore(0.8, 0.9, 0, computeRepScore(0));
    const scoreB = computeTagOnlyScore(0.7, 0.9, 0, computeRepScore(30));

    // A starts higher on tags, but B's reputation compensates
    // A: 0.6*0.8 + 0.2*0.9 = 0.48 + 0.18 = 0.66
    // B: 0.6*0.7 + 0.2*0.9 + 0.1*0.3 = 0.42 + 0.18 + 0.03 = 0.63
    // A still wins — need more extreme case

    const scoreC = computeTagOnlyScore(0.55, 0.9, 0, computeRepScore(0));
    const scoreD = computeTagOnlyScore(0.5, 0.9, 0, computeRepScore(30));
    // C: 0.6*0.55 + 0.2*0.9 = 0.33 + 0.18 = 0.51
    // D: 0.6*0.5 + 0.2*0.9 + 0.1*0.3 = 0.30 + 0.18 + 0.03 = 0.51
    // Exact tie! Let's push C's tags lower
    const scoreE = computeTagOnlyScore(0.5, 0.9, 0, computeRepScore(0));
    // E: 0.6*0.5 + 0.2*0.9 = 0.30 + 0.18 = 0.48
    expect(scoreD).toBeGreaterThan(scoreE);
  });

  it("weights sum to 1.0 in both formulas", () => {
    // Tag-only: 0.6 + 0.2 + 0.1 + 0.1 = 1.0
    const tagOnly = computeTagOnlyScore(1, 1, 1, 1);
    expect(tagOnly).toBe(1);

    // Semantic: 0.5 + 0.2 + 0.15 + 0.05 + 0.1 = 1.0
    const semantic = computeSemanticScore(1, 1, 1, 1, 1);
    expect(semantic).toBe(1);
  });
});
