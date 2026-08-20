// Schema contract: every column the relayer's autoclose-sweeper WRITES or ORDERS BY
// must actually exist in the migrated schema.
//
// WHY THIS EXISTS (prod defect, found 2026-08-20):
// Migration 045 created `intent_funding_authorizations` WITHOUT an `updated_at`
// column, but apps/relayer-daemon/src/autoclose-sweeper.ts issues
//   UPDATE intent_funding_authorizations SET status='consumed', updated_at = NOW()
// on the FUND leg. Against a schema built purely from git migrations that
// statement dies with:
//   column "updated_at" of relation "intent_funding_authorizations" does not exist
// …which broke the gasless settlement path end-to-end: FUND succeeded on-chain
// but the relayer could never record consumption, so the CLAIM leg never ran.
//
// Production had been hot-patched with a migration file that existed ONLY on the
// box and in NO commit — so `main` stayed broken for any fresh deploy while prod
// looked fine. Migration 046 ports that fix into git; this test pins it so the
// column can never be dropped or the migration lost again.
//
// This is a SCHEMA test, deliberately not a mock: mocking the sweeper's sql client
// would assert our beliefs about the schema rather than the schema itself, which is
// precisely the failure mode that let this defect ship.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

type Sql = ReturnType<typeof postgres>;
let sql: Sql;

beforeAll(() => {
  sql = postgres(DATABASE_URL, { max: 2, prepare: false });
});

afterAll(async () => {
  await sql?.end();
});

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

describe("relayer autoclose-sweeper ↔ schema contract", () => {
  it("intent_funding_authorizations.updated_at exists (migration 046)", async () => {
    expect(await columnExists("intent_funding_authorizations", "updated_at")).toBe(true);
  });

  it("executes the sweeper's exact FUND-leg UPDATE without erroring", async () => {
    // The literal statement from autoclose-sweeper.ts's fund phase. Runs inside a
    // rolled-back transaction and matches zero rows — we are proving the statement
    // PARSES AND PLANS against the live schema, which is what actually broke.
    await expect(
      sql.begin(async (txn) => {
        await txn`
          UPDATE intent_funding_authorizations
          SET status = 'consumed',
              updated_at = NOW()
          WHERE id = ${"00000000-0000-0000-0000-000000000000"}
        `;
        throw new Error("__rollback__");
      }),
    ).rejects.toThrow("__rollback__");
  });

  it("supports ORDER BY updated_at on the funding-authorization table", async () => {
    const rows = await sql`
      SELECT id FROM intent_funding_authorizations ORDER BY updated_at ASC LIMIT 1
    `;
    expect(Array.isArray(rows)).toBe(true);
  });

  it("updated_at is NOT NULL with a default so existing rows backfill", async () => {
    const [col] = await sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'intent_funding_authorizations' AND column_name = 'updated_at'
    `;
    expect(col).toBeTruthy();
    // NOT NULL without a default would fail on a table that already has rows.
    expect(col.is_nullable).toBe("NO");
    expect(String(col.column_default ?? "")).toMatch(/now\(\)/i);
  });
});
