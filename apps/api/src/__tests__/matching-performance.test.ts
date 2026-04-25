import Fastify from "fastify";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { recomputeMatches, createRecomputeMatchesQueue } from "../routes/matching.js";
import { cosineSimilarity } from "../semantic-match.js";

// --- SQL capture helper ---

type SqlCapture = {
  statements: string[];
  unsafeStatements: string[];
  sql: any;
};

function createSqlCapture(offers: any[], needs: any[]): SqlCapture {
  const statements: string[] = [];
  const unsafeStatements: string[] = [];

  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const key = strings.join("?");
    statements.push(key);
    // Return offers or needs based on query content
    if (key.includes("FROM offers o")) return offers;
    if (key.includes("FROM needs WHERE")) return needs;
    return [];
  }) as any;

  sql.unsafe = (statement: string, params: unknown[] = []) => {
    unsafeStatements.push(statement);
    return [];
  };
  sql.begin = async (handler: (txn: typeof sql) => unknown) => handler(sql);
  return { statements, unsafeStatements, sql };
}

// --- Helpers ---

function makeOffer(id: string, tags: string[], embedding?: number[]) {
  return {
    id, agent_id: `agent-${id}`, title: `Offer ${id}`, description_md: `Desc ${id}`,
    category: "dev", tags, base_price: 100, status: "active",
    seller_skill_verification_count: 0, offer_completed_deal_count: 0,
    description_embedding: embedding ?? null, max_price_delta_pct: 10,
  };
}

function makeNeed(id: string, tags: string[], embedding?: number[]) {
  return {
    id, agent_id: `agent-need-${id}`, title: `Need ${id}`, description_md: `Desc ${id}`,
    category: "dev", tags, budget_max: 200, status: "open",
    description_embedding: embedding ?? null, acceptance_criteria: [],
  };
}

function makeEmbedding(seed: number): number[] {
  const v = [Math.sin(seed) * 0.5, Math.cos(seed) * 0.5, Math.sin(seed * 2) * 0.3];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : [1, 0, 0];
}

const createApp = () => Fastify({ logger: false });

// --- Tests ---

describe("matching performance", () => {
  const originalEnv = process.env;

  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; vi.restoreAllMocks(); });

  // 1. Batch INSERT verification — 50 matches → 1 batch
  it("batch INSERTs in chunks of 200 instead of individual queries", async () => {
    const offers = Array.from({ length: 5 }, (_, i) => makeOffer(`o${i}`, ["dev", "web"]));
    const needs = Array.from({ length: 10 }, (_, i) => makeNeed(`n${i}`, ["dev", "web"]));
    const capture = createSqlCapture(offers, needs);

    delete process.env.OPENAI_API_KEY;
    const writes = await recomputeMatches(createApp(), capture.sql);

    expect(writes).toBe(50);
    const insertCount = capture.unsafeStatements.filter((s) => s.includes("INSERT INTO matches")).length;
    expect(insertCount).toBe(1); // ceil(50/200) = 1
  });

  // 1b. Larger dataset — 300 matches → 2 batches
  it("produces ceil(N*M/200) batch INSERTs for large datasets", async () => {
    const offers = Array.from({ length: 10 }, (_, i) => makeOffer(`o${i}`, ["dev", "web"]));
    const needs = Array.from({ length: 30 }, (_, i) => makeNeed(`n${i}`, ["dev", "web"]));
    const capture = createSqlCapture(offers, needs);

    delete process.env.OPENAI_API_KEY;
    const writes = await recomputeMatches(createApp(), capture.sql);

    expect(writes).toBe(300);
    const insertCount = capture.unsafeStatements.filter((s) => s.includes("INSERT INTO matches")).length;
    expect(insertCount).toBe(2); // ceil(300/200) = 2
  });

  // 2. No per-pair API calls when embeddings are pre-stored
  it("does NOT call generateEmbeddings when all embeddings are stored", async () => {
    const offers = [makeOffer("o1", ["dev"], makeEmbedding(1))];
    const needs = [makeNeed("n1", ["dev"], makeEmbedding(2))];
    const capture = createSqlCapture(offers, needs);

    process.env.OPENAI_API_KEY = "test-key";

    // Spy on fetch to ensure no API calls
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [] }) });
    vi.stubGlobal("fetch", fetchSpy);

    const writes = await recomputeMatches(createApp(), capture.sql);

    expect(writes).toBe(1);
    // No fetch calls = no OpenAI API calls
    expect(fetchSpy).not.toHaveBeenCalled();
    // No UPDATE statements for missing embeddings
    const updateStatements = capture.statements.filter((s) => s.includes("UPDATE"));
    expect(updateStatements.length).toBe(0);
  });

  // 3. cosineSimilarity on stored embeddings
  it("cosineSimilarity works correctly on stored embeddings", () => {
    const a = makeEmbedding(1);
    const b = makeEmbedding(2);

    // Valid scores
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThan(-1);
    expect(score).toBeLessThan(1);

    // Self-similarity = 1.0
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);

    // Orthogonal → 0
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);

    // Edge cases
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0); // length mismatch
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0); // zero vector
  });

  // 4. Tag-only fallback without OPENAI_API_KEY
  it("tag-only matching works without OPENAI_API_KEY and no embeddings", async () => {
    const offers = [makeOffer("o1", ["dev", "web"]), makeOffer("o2", ["design"])];
    const needs = [makeNeed("n1", ["dev", "web"]), makeNeed("n2", ["dev"])];
    const capture = createSqlCapture(offers, needs);

    delete process.env.OPENAI_API_KEY;
    const writes = await recomputeMatches(createApp(), capture.sql);

    // o1↔n1 (dev,web), o1↔n2 (dev), o2 has no overlap → 2 matches
    expect(writes).toBe(2);
    expect(capture.unsafeStatements.filter((s) => s.includes("INSERT INTO matches")).length).toBe(1);
  });

  it("skips pairs with no tag overlap in tag-only mode", async () => {
    const capture = createSqlCapture(
      [makeOffer("o1", ["music"])],
      [makeNeed("n1", ["dev"])],
    );

    delete process.env.OPENAI_API_KEY;
    const writes = await recomputeMatches(createApp(), capture.sql);

    expect(writes).toBe(0);
  });

  // 5. Default debounce is 60s
  it("createRecomputeMatchesQueue defaults to 60s debounce", () => {
    const queue = createRecomputeMatchesQueue(async () => 0);
    // scheduleRecompute should not fire immediately
    let called = false;
    const q2 = createRecomputeMatchesQueue(async () => { called = true; return 0; });
    q2.scheduleRecompute();
    expect(called).toBe(false);
  });
});
