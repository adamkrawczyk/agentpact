import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

/**
 * Migration runner.
 *
 * Why a dedicated postgres client instead of importing `sql` from `db/client.ts`:
 *   postgres.js refuses to run multi-statement DDL with explicit BEGIN/COMMIT through
 *   `sql.unsafe()` on a multi-connection pool — it throws
 *   `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`.
 *   Migration 033_release_pending_chain_status.sql introduced an explicit BEGIN; ... COMMIT;
 *   block (legitimate — DROP + ADD CONSTRAINT needs atomicity), which crashed the E2E CI
 *   run dated 2026-05-25. The shared client uses max:10, so we open our own max:1 client
 *   here and close it when done. This keeps the app-side pool untouched.
 *
 * Idempotency: this script tracks applied migrations in _migration_history (same
 * table/pattern as apps/api/src/server.ts's runMigrations()) and only replays files
 * NOT already recorded there. Before this fix it unconditionally re-ran every .sql
 * file on every invocation — harmless for genuinely idempotent DDL (CREATE TABLE IF
 * NOT EXISTS, ADD COLUMN IF NOT EXISTS) but fatal for non-idempotent statements like
 * `CREATE UNIQUE INDEX idx_subscriptions_one_active` (no IF NOT EXISTS on indexes in
 * 036_subscriptions.sql), which crashed with `relation already exists` on every
 * re-run against an already-migrated database — verified live 2026-09-01, deploy.yml
 * workflow_dispatch run 33554039052, blocking every CD deploy at the migrate step.
 */
const connection =
  process.env.DATABASE_URL ?? "postgres://postgres:***@localhost:5432/agentpact";

const migrationSql = postgres(connection, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});

async function main() {
  await migrationSql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migration_history (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await migrationSql`SELECT filename FROM _migration_history`).map((r: Record<string, unknown>) => String(r.filename))
  );

  const migrationsDir = resolve(process.cwd(), "migrations");
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let ok = 0, skipped = 0;
  for (const file of files) {
    if (applied.has(file)) {
      skipped++;
      continue;
    }
    const migrationPath = resolve(migrationsDir, file);
    const ddl = await readFile(migrationPath, "utf8");
    await migrationSql.unsafe(ddl);
    await migrationSql`INSERT INTO _migration_history (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
    console.log(`Migration ${file} applied`);
    ok++;
  }

  console.log(`Done: ${ok} applied, ${skipped} already applied (skipped)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await migrationSql.end({ timeout: 5 });
  });
