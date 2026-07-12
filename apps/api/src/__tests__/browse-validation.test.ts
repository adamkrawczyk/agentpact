/**
 * Unit tests for browse endpoint tag/query validation.
 *
 * Self-contained — doesn't import from the module graph (which has
 * unresolvable viem/pino deps). The validation functions are pure
 * and small enough to duplicate here for testing.
 *
 * Originally written against `node:test`; converted to vitest-compatible
 * imports so it runs alongside the rest of the api test suite via
 * `npm test`. The vitest globals (describe/it/expect) are enabled in
 * apps/api/vitest.config.ts (`globals: true`), so importing from "vitest"
 * here is equivalent and keeps the file IDE-friendly. Both `node:assert`
 * and vitest's `expect` are available; we keep `node:assert/strict`
 * because the assertions below are already written against it.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

// ── Constants & functions duplicated from schemas.ts ────────────────────
const MAX_TAGS_COUNT = 20;
const MAX_TAG_LENGTH = 64;
const MAX_QUERY_LENGTH = 200;

function parseAndValidateTags(tagsStr: string | undefined): { tags: string[]; error: string | null } {
  if (!tagsStr) return { tags: [], error: null };
  const tagsRaw = tagsStr.split(",").filter(Boolean);
  if (tagsRaw.length > MAX_TAGS_COUNT) {
    return { tags: [], error: `tags must contain at most ${MAX_TAGS_COUNT} items (got ${tagsRaw.length})` };
  }
  for (const tag of tagsRaw) {
    if (tag.length > MAX_TAG_LENGTH) {
      return { tags: [], error: `each tag must be at most ${MAX_TAG_LENGTH} characters (got ${tag.length}: "${tag.slice(0, 20)}...")` };
    }
  }
  return { tags: tagsRaw, error: null };
}

function validateAndTruncateQuery(query: string | undefined): string {
  if (!query) return "";
  const trimmed = query.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters (got ${trimmed.length})`);
  }
  return trimmed;
}
// ── End duplication ────────────────────────────────────────────────────

describe("parseAndValidateTags", () => {
  it("returns empty array for undefined input", () => {
    const result = parseAndValidateTags(undefined);
    assert.deepStrictEqual(result, { tags: [], error: null });
  });

  it("parses a single tag", () => {
    const result = parseAndValidateTags("ai");
    assert.deepStrictEqual(result, { tags: ["ai"], error: null });
  });

  it("parses multiple comma-separated tags", () => {
    const result = parseAndValidateTags("ai,ml,nlp");
    assert.deepStrictEqual(result, { tags: ["ai", "ml", "nlp"], error: null });
  });

  it("filters empty segments from trailing comma", () => {
    const result = parseAndValidateTags("ai,ml,");
    assert.deepStrictEqual(result, { tags: ["ai", "ml"], error: null });
  });

  it("rejects more than MAX_TAGS_COUNT tags", () => {
    const tags = Array(MAX_TAGS_COUNT + 1).fill("tag");
    const input = tags.join(",");
    const result = parseAndValidateTags(input);
    assert.strictEqual(result.error, `tags must contain at most ${MAX_TAGS_COUNT} items (got ${MAX_TAGS_COUNT + 1})`);
    assert.deepStrictEqual(result.tags, []);
  });

  it("accepts exactly MAX_TAGS_COUNT tags", () => {
    const tags = Array(MAX_TAGS_COUNT).fill("tag");
    const input = tags.join(",");
    const result = parseAndValidateTags(input);
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.tags.length, MAX_TAGS_COUNT);
  });

  it("rejects a tag exceeding MAX_TAG_LENGTH characters", () => {
    const longTag = "a".repeat(MAX_TAG_LENGTH + 1);
    const result = parseAndValidateTags(longTag);
    assert.ok(result.error?.includes(`at most ${MAX_TAG_LENGTH} characters`));
    assert.deepStrictEqual(result.tags, []);
  });

  it("accepts a tag at exactly MAX_TAG_LENGTH characters", () => {
    const tag = "a".repeat(MAX_TAG_LENGTH);
    const result = parseAndValidateTags(tag);
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.tags[0], tag);
  });

  it("rejects when one tag in the middle is too long", () => {
    const result = parseAndValidateTags(`ok,${"b".repeat(MAX_TAG_LENGTH + 1)},also-ok`);
    assert.ok(result.error?.includes("at most"));
    assert.deepStrictEqual(result.tags, []);
  });
});

describe("validateAndTruncateQuery", () => {
  it("returns empty string for undefined input", () => {
    assert.strictEqual(validateAndTruncateQuery(undefined), "");
  });

  it("returns empty string for empty string input", () => {
    assert.strictEqual(validateAndTruncateQuery(""), "");
  });

  it("trims whitespace from query", () => {
    assert.strictEqual(validateAndTruncateQuery("  hello world  "), "hello world");
  });

  it("accepts a query at exactly MAX_QUERY_LENGTH characters", () => {
    const query = "a".repeat(MAX_QUERY_LENGTH);
    assert.strictEqual(validateAndTruncateQuery(query), query);
  });

  it("throws for a query exceeding MAX_QUERY_LENGTH characters", () => {
    const query = "a".repeat(MAX_QUERY_LENGTH + 1);
    assert.throws(
      () => validateAndTruncateQuery(query),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(`at most ${MAX_QUERY_LENGTH} characters`));
        return true;
      }
    );
  });

  it("trims before checking length", () => {
    // 200 'a' chars surrounded by whitespace — trimmed = 200 chars, should pass
    const query = "  " + "a".repeat(MAX_QUERY_LENGTH) + "  ";
    assert.strictEqual(validateAndTruncateQuery(query).length, MAX_QUERY_LENGTH);
  });

  it("throws when trimmed query exceeds limit", () => {
    // 201 'a' chars with leading/trailing spaces — trimmed = 201 chars, should throw
    const query = "  " + "a".repeat(MAX_QUERY_LENGTH + 1) + "  ";
    assert.throws(() => validateAndTruncateQuery(query));
  });
});
