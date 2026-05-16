/**
 * protocol_1605/A — pool configuration test.
 *
 * Pre-A this test asserted db.ts had a literal `max: 10` because db.ts owned
 * its own second postgres pool. As of Phase A the codebase has ONE pool
 * (shared/pool.ts) and db.ts is a thin re-export.
 *
 * Contract this test now defends:
 *   1. db.ts MUST NOT contain a `postgres(...)` call — that would mean someone
 *      reintroduced a second pool.
 *   2. shared/pool.ts MUST set max:20 (the Supabase free-tier ceiling), and
 *      MUST set statement_timeout below Fastify's 30s onRequest timeout, and
 *      MUST set application_name so pg_stat_activity rows are grep-able.
 *
 * If a future PR ever needs a second pool, change this test deliberately —
 * don't silently allow another duplicate.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";

async function readSrc(relativeFromTests: string): Promise<string> {
  const fs = await import("fs");
  const path = await import("path");
  return fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), relativeFromTests),
    "utf-8",
  );
}

describe("Postgres pool — single-source-of-truth invariants (protocol_1605/A)", () => {
  it("db.ts is a thin re-export, NOT a second postgres() pool", async () => {
    const source = await readSrc("../db.ts");
    expect(source).not.toMatch(/postgres\(/);
    expect(source).toMatch(/from\s+["']\.\/shared\/pool\.js["']/);
  });

  it("shared/pool.ts caps connections at 20 (Supabase free-tier ceiling)", async () => {
    const source = await readSrc("../shared/pool.ts");
    expect(source).toMatch(/max:\s*20\b/);
    // No higher cap allowed without re-checking the Supabase plan.
    expect(source).not.toMatch(/max:\s*(2[1-9]|[3-9]\d|\d{3,})\b/);
  });

  it("shared/pool.ts sets statement_timeout < Fastify onRequest timeout (defense-in-depth)", async () => {
    const source = await readSrc("../shared/pool.ts");
    // Match 25_000 / 25000 / 25 000 — we accept any underscore/digit grouping
    // but the value MUST be < 30000.
    const match = source.match(/statement_timeout:\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const value = Number((match?.[1] ?? "0").replace(/_/g, ""));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(30_000);
  });

  it("shared/pool.ts sets application_name so pg_stat_activity is grep-able", async () => {
    const source = await readSrc("../shared/pool.ts");
    expect(source).toMatch(/application_name:\s*["']agentpact-api["']/);
  });

  it("auth.ts does NOT instantiate its own postgres pool", async () => {
    const source = await readSrc("../auth.ts");
    // Strip line comments + block comments before pattern matching so that
    // historical references in explanatory comments don't trip the test.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(stripped).not.toMatch(/postgres\(\s*DATABASE_URL/);
    expect(stripped).not.toMatch(/new postgres\(/);
  });

  it("index.ts does NOT instantiate its own postgres pool (inline pool removed)", async () => {
    const source = await readSrc("../index.ts");
    // Match `postgres(DATABASE_URL,` or `postgres(\n   DATABASE_URL,` etc.
    expect(source).not.toMatch(/postgres\(\s*DATABASE_URL/);
  });
});
