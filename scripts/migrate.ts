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
 */
const connection =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";

const migrationSql = postgres(connection, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});

async function main() {
  const migrationsDir = resolve(process.cwd(), "migrations");
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const migrationPath = resolve(migrationsDir, file);
    const ddl = await readFile(migrationPath, "utf8");
    await migrationSql.unsafe(ddl);
    console.log(`Migration ${file} applied`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await migrationSql.end({ timeout: 5 });
  });
