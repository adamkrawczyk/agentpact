import { app, shutdown, sql } from "./index.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import postgres from "postgres";

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";

async function runMigrations() {
  // Check common migration paths (local dev vs Docker)
  const candidates = [
    resolve(process.cwd(), "migrations"),
    "/app/migrations",
    resolve(process.cwd(), "..", "..", "migrations"),
  ];

  const migrationsDir = candidates.find((dir) => existsSync(dir));

  if (!migrationsDir) {
    console.warn("[migrations] No migrations directory found, skipping");
    return;
  }

  console.log(`[migrations] Running migrations from ${migrationsDir}`);

  // Dedicated max:1 client for migrations. The shared app pool (index.ts, max:20)
  // CANNOT run multi-statement DDL that contains explicit BEGIN/COMMIT through
  // sql.unsafe() — postgres.js throws `UNSAFE_TRANSACTION: Only use sql.begin,
  // sql.reserved or max:1`, and the aborted transaction then POISONS the pooled
  // connection so every subsequent migration fails with "current transaction is
  // aborted" (and a boot-time request that lands on the same connection 500s).
  // Migrations 033/037/038/039/040 legitimately use BEGIN/COMMIT for atomic
  // DROP+ADD CONSTRAINT, so we open our own single-connection client here exactly
  // like scripts/migrate.ts. Each migration runs on an isolated connection; a
  // failure can neither poison the app pool nor cascade into later migrations.
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.warn("[migrations] DATABASE_URL not set, skipping migrations");
    return;
  }
  const migrationSql = postgres(DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // silence the expected IF-NOT-EXISTS/IF-EXISTS NOTICEs
  });

  try {
    // Create tracking table so migrations only run once
    await migrationSql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migration_history (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await migrationSql`SELECT filename FROM _migration_history`).map((r: Record<string, unknown>) => String(r.filename))
    );

    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    let ok = 0, skipped = 0, failed = 0;
    for (const file of files) {
      if (applied.has(file)) {
        skipped++;
        continue;
      }
      try {
        const ddl = await readFile(join(migrationsDir, file), "utf8");
        await migrationSql.unsafe(ddl);
        await migrationSql`INSERT INTO _migration_history (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
        console.log(`[migrations] ✅ ${file} applied`);
        ok++;
      } catch (error: any) {
        console.error(`[migrations] ❌ ${file} failed: ${error?.message ?? error}`);
        // Don't throw — log and continue so server can still start.
        // A migration file may have opened an explicit BEGIN that aborted mid-way;
        // issue a best-effort ROLLBACK so the single reserved connection returns to
        // a clean state and the NEXT migration doesn't inherit an aborted txn.
        try { await migrationSql.unsafe("ROLLBACK"); } catch { /* no open txn — fine */ }
        failed++;
      }
    }

    console.log(`[migrations] Done: ${ok} applied, ${skipped} skipped, ${failed} failed`);
  } finally {
    await migrationSql.end({ timeout: 5 });
  }
}

async function start() {
  // Run migrations on startup if enabled
  if (process.env.RUN_MIGRATIONS === "true") {
    await runMigrations();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  app.listen({ port: PORT, host: HOST }).then(() => {
    console.log(`API server listening on ${HOST}:${PORT}`);
  }).catch(async (error) => {
    app.log.error(error);
    await shutdown();
    process.exit(1);
  });
}

start();
