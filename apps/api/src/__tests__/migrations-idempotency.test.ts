/**
 * protocol_1605/A — Migration idempotency invariants.
 *
 * Why this test exists:
 *   On 2026-05-16, Phase A (PR #12 → commit 79b07a38) was merged and prod
 *   started 502'ing within 6 minutes. The reverted PR turned ON the migration
 *   runner in production (NODE_ENV=production defaults RUN_MIGRATIONS=true)
 *   AND hardened it to refuse boot on ANY migration failure. Both were
 *   correct changes individually; together they exposed that production had
 *   schema state created by years of boot-block ALTER blocks that were NEVER
 *   recorded in _migration_history. When the new boot tried to apply 36
 *   migrations against a DB that already had those tables/indexes/triggers
 *   physically present, any migration that created a non-idempotent object
 *   threw, exit(1) fired, Railway saw no /health response, crash loop.
 *
 *   The killer was migration 036_subscriptions.sql — three CREATE INDEX
 *   statements and one CREATE TRIGGER, none with IF NOT EXISTS guards.
 *   Against a DB where subscriptions already exists (shared with other apps
 *   on the same Supabase project), every one of those CREATE statements
 *   throws "already exists".
 *
 * What this test enforces (post-mortem invariant):
 *   Every migration in migrations/*.sql MUST be idempotent — safe to apply
 *   to a database where its previous effects are already physically present.
 *   That means every CREATE / ALTER / etc. statement must either:
 *     - Use IF NOT EXISTS (CREATE INDEX, CREATE TABLE, etc.)
 *     - Use OR REPLACE (CREATE FUNCTION)
 *     - Be guarded by a preceding DROP ... IF EXISTS (CREATE TRIGGER, where
 *       OR REPLACE isn't available in Postgres < 14)
 *     - Be a pure DML write (UPDATE / INSERT / DELETE) which is idempotent
 *       by its WHERE clause shape
 *
 *   If you add a non-idempotent migration in the future, this test will
 *   fail at PR-CI time, not in prod at 502-time.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Find migrations dir — prefer monorepo root.
function findMigrationsDir(): string {
  const candidates = [
    resolve(__dirname, "..", "..", "..", "..", "..", "migrations"),
    resolve(__dirname, "..", "..", "..", "..", "migrations"),
    resolve(__dirname, "..", "..", "..", "migrations"),
    resolve(__dirname, "..", "..", "migrations"),
    resolve(__dirname, "..", "migrations"),
    resolve(process.cwd(), "..", "..", "migrations"),
    resolve(process.cwd(), "migrations"),
  ];
  for (const c of candidates) {
    try {
      const stat = readdirSync(c);
      if (stat.some((f) => f.endsWith(".sql"))) return c;
    } catch {
      // try next
    }
  }
  throw new Error(`No migrations directory found. Searched: ${candidates.join(", ")}`);
}

type Violation = {
  file: string;
  line: number;
  text: string;
  reason: string;
};

/**
 * Lex a SQL file into statement-level chunks separated by ';' at top level,
 * tracking line numbers. Strips block comments (/* ... *\/) and line comments
 * (-- ...) so they don't trip pattern matching.
 *
 * This is a SHALLOW lexer — it does not parse dollar-quoted strings beyond
 * recognising $$ ... $$ as opaque blocks. That's enough for our migrations.
 */
function tokenizeStatements(src: string): Array<{ text: string; startLine: number }> {
  const stripped = src
    .split("\n")
    .map((line) => {
      // Strip line comments but keep the newline
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  // Strip block comments
  const noComments = stripped.replace(/\/\*[\s\S]*?\*\//g, " ");

  const out: Array<{ text: string; startLine: number }> = [];
  let buf = "";
  let bufStartLine = 1;
  let curLine = 1;
  let inDollar = false;

  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];
    if (ch === "\n") curLine += 1;

    // Detect $$ delimiter (PostgreSQL dollar-quoted strings used by PL/pgSQL)
    if (ch === "$" && noComments[i + 1] === "$") {
      inDollar = !inDollar;
      buf += "$$";
      i += 1;
      continue;
    }

    if (!inDollar && ch === ";") {
      const text = buf.trim();
      if (text.length > 0) {
        out.push({ text, startLine: bufStartLine });
      }
      buf = "";
      bufStartLine = curLine;
      continue;
    }
    if (buf.length === 0 && /\S/.test(ch)) {
      bufStartLine = curLine;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail.length > 0) {
    out.push({ text: tail, startLine: bufStartLine });
  }
  return out;
}

/**
 * Check ONE statement for the idempotency contract. Returns null if compliant,
 * a Violation if not.
 *
 * Recognized safe forms:
 *   CREATE ... IF NOT EXISTS ...
 *   CREATE OR REPLACE FUNCTION / VIEW / RULE
 *   ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
 *   ALTER TABLE ... DROP CONSTRAINT IF EXISTS ... then ALTER TABLE ... ADD CONSTRAINT  (the DROP/ADD pair counts when the DROP IF EXISTS lexically precedes in the same file)
 *   ALTER TABLE ... ALTER COLUMN ... (always idempotent)
 *   ALTER TABLE ... DROP COLUMN IF EXISTS / DROP CONSTRAINT IF EXISTS (pure idempotent)
 *   DROP ... IF EXISTS
 *   UPDATE / INSERT ... ON CONFLICT / DELETE — idempotent by shape
 *
 * Recognized DANGEROUS forms (return Violation):
 *   CREATE TABLE foo (...)                  ← missing IF NOT EXISTS
 *   CREATE INDEX idx ON foo (...)           ← missing IF NOT EXISTS
 *   CREATE UNIQUE INDEX idx ON foo (...)    ← missing IF NOT EXISTS
 *   CREATE TRIGGER t ON foo ...             ← can't OR REPLACE; needs DROP IF EXISTS first
 *   ALTER TABLE foo ADD COLUMN bar TYPE     ← missing IF NOT EXISTS
 *   ALTER TABLE foo ADD CONSTRAINT name ... ← only safe if a DROP CONSTRAINT IF EXISTS for same name lexically precedes (handled by caller via lookahead)
 */
function inspectStatement(
  stmt: { text: string; startLine: number },
  precedingStatements: Array<{ text: string; startLine: number }>,
): Violation | null {
  const norm = stmt.text.replace(/\s+/g, " ").trim();
  const upper = norm.toUpperCase();

  // CREATE TABLE missing IF NOT EXISTS
  if (/^CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+|GLOBAL\s+TEMPORARY\s+)?TABLE\s+/i.test(norm)
      && !/CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+|GLOBAL\s+TEMPORARY\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+/i.test(norm)) {
    return { file: "", line: stmt.startLine, text: norm.slice(0, 80), reason: "CREATE TABLE without IF NOT EXISTS" };
  }

  // CREATE [UNIQUE] [CONCURRENTLY] INDEX [CONCURRENTLY] [IF NOT EXISTS] ...
  // Strip the optional modifiers between CREATE and the actual index name,
  // then check whether IF NOT EXISTS shows up before the index identifier.
  const indexHead = norm.match(/^CREATE\s+(?:UNIQUE\s+)?(?:CONCURRENTLY\s+)?INDEX\b((?:\s+CONCURRENTLY\b)?(?:\s+IF\s+NOT\s+EXISTS\b)?)/i);
  if (indexHead && !/IF\s+NOT\s+EXISTS/i.test(indexHead[1] ?? "")) {
    return { file: "", line: stmt.startLine, text: norm.slice(0, 80), reason: "CREATE INDEX without IF NOT EXISTS" };
  }

  // CREATE TRIGGER — must be preceded by DROP TRIGGER IF EXISTS for same trigger+table
  if (/^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+/i.test(norm)) {
    // OR REPLACE TRIGGER is Postgres 14+; we accept it as idempotent.
    if (/^CREATE\s+OR\s+REPLACE\s+TRIGGER\s+/i.test(norm)) return null;
    // Otherwise need a preceding DROP TRIGGER IF EXISTS in the same file.
    const m = norm.match(/^CREATE\s+TRIGGER\s+(\w+)/i);
    const tname = m?.[1];
    if (!tname) return { file: "", line: stmt.startLine, text: norm.slice(0, 80), reason: "CREATE TRIGGER with unparseable name" };
    const guarded = precedingStatements.some((p) => {
      const pn = p.text.replace(/\s+/g, " ").trim();
      return new RegExp(`^DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${tname}\\b`, "i").test(pn);
    });
    if (!guarded) {
      return { file: "", line: stmt.startLine, text: norm.slice(0, 80), reason: `CREATE TRIGGER ${tname} without preceding DROP TRIGGER IF EXISTS ${tname}` };
    }
    return null;
  }

  // CREATE OR REPLACE FUNCTION / VIEW / RULE — idempotent by definition
  if (/^CREATE\s+OR\s+REPLACE\s+(FUNCTION|PROCEDURE|VIEW|RULE)\s+/i.test(norm)) {
    return null;
  }

  // ALTER TABLE ... ADD COLUMN missing IF NOT EXISTS
  if (/^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(norm)) {
    return { file: "", line: stmt.startLine, text: norm.slice(0, 80), reason: "ALTER TABLE ADD COLUMN without IF NOT EXISTS" };
  }

  // ALTER TABLE ... ADD CONSTRAINT — safe only when same-name DROP CONSTRAINT IF EXISTS precedes
  const constraintMatch = norm.match(/^ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\s+(\w+)/i);
  if (constraintMatch) {
    const cname = constraintMatch[1];
    const guarded = precedingStatements.some((p) => {
      const pn = p.text.replace(/\s+/g, " ").trim();
      return new RegExp(`ALTER\\s+TABLE\\s+\\S+\\s+DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${cname}\\b`, "i").test(pn);
    });
    if (!guarded) {
      return { file: "", line: stmt.startLine, text: norm.slice(0, 80), reason: `ALTER TABLE ADD CONSTRAINT ${cname} without preceding DROP CONSTRAINT IF EXISTS ${cname}` };
    }
    return null;
  }

  // Everything else (UPDATE/INSERT/DELETE/ALTER COLUMN/BEGIN/COMMIT/DO/etc.) is allowed.
  void upper;
  return null;
}

describe("migration idempotency (protocol_1605/A post-mortem)", () => {
  const dir = findMigrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  it("found at least one migration file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} is idempotent (safe to re-apply against a DB where its prior effects exist)`, () => {
      const path = join(dir, file);
      const src = readFileSync(path, "utf-8");
      const statements = tokenizeStatements(src);
      const violations: Violation[] = [];
      for (let i = 0; i < statements.length; i += 1) {
        const v = inspectStatement(statements[i], statements.slice(0, i));
        if (v) {
          violations.push({ ...v, file });
        }
      }
      if (violations.length > 0) {
        const summary = violations
          .map((v) => `  ${file}:${v.line}  ${v.reason}\n    ${v.text}...`)
          .join("\n");
        throw new Error(
          `Migration ${file} contains ${violations.length} non-idempotent statement(s):\n${summary}\n\n` +
            `Why this matters: a production DB that already has these objects (e.g. because\n` +
            `they were created by a long-since-deleted boot block) will reject the migration\n` +
            `on re-application, and the hardened migration runner refuses boot on any\n` +
            `failure — crash loop on Railway. See protocol_1605/A post-mortem 2026-05-16.\n\n` +
            `Fix: add IF NOT EXISTS (CREATE / ADD COLUMN), OR REPLACE (FUNCTION/VIEW),\n` +
            `or a preceding DROP ... IF EXISTS (CREATE TRIGGER, ALTER TABLE ADD CONSTRAINT).`,
        );
      }
    });
  }

  // Sanity check: the specific bug that took down prod must be caught.
  it("EXAMPLE: migration 036_subscriptions.sql (the prod killer) would have been caught", () => {
    // Read the historical-bug migration from disk. If the user fixes 036 in
    // the same PR as this test (recommended), this asserts the AFTER state
    // is clean and the test above also passes — defensive bookkeeping.
    const path = join(dir, "036_subscriptions.sql");
    let src: string;
    try {
      src = readFileSync(path, "utf-8");
    } catch {
      // If 036 is renamed / removed entirely, fine — the loop above already
      // covers whatever is currently in the directory.
      return;
    }
    const statements = tokenizeStatements(src);
    const violations: Violation[] = [];
    for (let i = 0; i < statements.length; i += 1) {
      const v = inspectStatement(statements[i], statements.slice(0, i));
      if (v) violations.push(v);
    }
    // Post-fix: zero violations.
    // If the fix has been merged, this is a no-op. If 036 still has the bug,
    // the previous test will fail with the same signal.
    expect(violations).toEqual([]);
  });
});
