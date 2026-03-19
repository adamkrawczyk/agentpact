import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readdir, readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import postgres from "postgres";

let pgContainer: StartedPostgreSqlContainer | null = null;

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });

  // Create migration tracking table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migration_history (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await sql`SELECT filename FROM _migration_history`).map((r: Record<string, unknown>) => String(r.filename))
  );

  // Find migrations dir — prefer monorepo root (has all migrations)
  // apps/api/migrations only has partial overrides, so check root first
  const candidates = [
    resolve(process.cwd(), "..", "..", "migrations"),
    resolve(process.cwd(), "..", "..", "..", "migrations"),
    resolve(process.cwd(), "migrations"),
  ];

  let migrationsDir: string | null = null;
  for (const candidate of candidates) {
    if (await dirExists(candidate)) {
      migrationsDir = candidate;
      break;
    }
  }

  if (!migrationsDir) {
    console.warn("[globalSetup] No migrations directory found, skipping");
    await sql.end();
    return;
  }

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ok = 0;
  let skipped = 0;
  for (const file of files) {
    if (applied.has(file)) {
      skipped++;
      continue;
    }
    try {
      const ddl = await readFile(join(migrationsDir, file), "utf8");
      await sql.unsafe(ddl);
      await sql`INSERT INTO _migration_history (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
      ok++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[globalSetup] migration ${file} failed (non-fatal): ${msg}`);
    }
  }

  console.log(`[globalSetup] Migrations: ${ok} applied, ${skipped} skipped`);
  await sql.end();
}

export default async function globalSetup() {
  console.log("[globalSetup] Starting Postgres test container...");

  pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("agentpact_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  console.log(`[globalSetup] Postgres ready at ${databaseUrl}`);

  await runMigrations(databaseUrl);

  // Teardown: called after all tests complete
  return async () => {
    try {
      const { shutdown } = await import("../../index.js");
      await shutdown();
    } catch {
      // ignore shutdown errors
    }
    if (pgContainer) {
      await pgContainer.stop();
      console.log("[globalSetup] Postgres container stopped");
    }
  };
}
