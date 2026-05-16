import { app, shutdown, sql } from "./index.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
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
    // Create tracking table so migrations only run once
    await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migration_history (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    const applied = new Set((await sql `SELECT filename FROM _migration_history`).map((r) => String(r.filename)));
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
            await sql.unsafe(ddl);
            await sql `INSERT INTO _migration_history (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
            console.log(`[migrations] ✅ ${file} applied`);
            ok++;
        }
        catch (error) {
            console.error(`[migrations] ❌ ${file} failed: ${error?.message ?? error}`);
            // Don't throw — log and continue so server can still start
            // Critical schema migrations (001, 002) will fail loudly at runtime if broken
            failed++;
        }
    }
    console.log(`[migrations] Done: ${ok} applied, ${skipped} skipped, ${failed} failed`);
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
