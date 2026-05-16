import { app, performShutdown, sql } from "./index.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
/**
 * protocol_1605/A — Hardened migration runner.
 *
 * Pre-A behavior: failures were logged-and-skipped, server started anyway.
 * That masked real schema drift and let bugs ship to prod with no signal.
 *
 * Post-A behavior:
 *   - On migration error, log the error and ABORT BOOT (refuse to listen).
 *   - Migration application is tracked in _migration_history.
 *   - Already-applied migrations are silently skipped — idempotent re-runs are safe.
 *   - RUN_MIGRATIONS defaults to true in production (Railway), false elsewhere
 *     so test suites that use testcontainers can still drive their own runner.
 */
async function runMigrations() {
    // Check common migration paths (local dev vs Docker)
    const candidates = [
        resolve(process.cwd(), "migrations"),
        "/app/migrations",
        resolve(process.cwd(), "..", "..", "migrations"),
    ];
    const migrationsDir = candidates.find((dir) => existsSync(dir));
    if (!migrationsDir) {
        // No migrations directory is a fatal misconfiguration in any environment
        // that runs RUN_MIGRATIONS=true. Refuse boot.
        throw new Error(`[migrations] FATAL: no migrations directory found. Looked in: ${candidates.join(", ")}`);
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
    let ok = 0, skipped = 0;
    const failures = [];
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
            const msg = error?.message ?? String(error);
            console.error(`[migrations] ❌ ${file} failed: ${msg}`);
            failures.push({ file, error: msg });
        }
    }
    console.log(`[migrations] Done: ${ok} applied, ${skipped} skipped, ${failures.length} failed`);
    // protocol_1605/A — REFUSE BOOT on any migration failure.
    // Pre-A this loop was log-and-continue; that masked real schema drift in
    // production. If a migration broke at deploy, the server would still
    // listen but the DB layer might be missing columns/constraints and queries
    // would fail with confusing runtime errors instead of a clear deploy-time
    // signal.
    if (failures.length > 0) {
        const detail = failures.map((f) => `  - ${f.file}: ${f.error}`).join("\n");
        throw new Error(`[migrations] FATAL: ${failures.length} migration(s) failed — refusing boot.\n${detail}`);
    }
}
function shouldRunMigrationsAtBoot() {
    // protocol_1605/A — RUN_MIGRATIONS now defaults to true in production so a
    // freshly-deployed Railway build always applies migrations before listening.
    // Anywhere else (local dev, CI) requires an explicit opt-in to avoid
    // surprising the testcontainer-driven test suite that bootstraps its own
    // schema independently.
    const explicit = process.env.RUN_MIGRATIONS;
    if (explicit === "true")
        return true;
    if (explicit === "false")
        return false;
    return process.env.NODE_ENV === "production";
}
async function start() {
    if (shouldRunMigrationsAtBoot()) {
        try {
            await runMigrations();
        }
        catch (err) {
            console.error(err?.message ?? err);
            // Don't even attempt to listen — the schema is broken or unknown.
            process.exit(1);
        }
    }
    process.on("SIGINT", performShutdown);
    process.on("SIGTERM", performShutdown);
    app.listen({ port: PORT, host: HOST }).then(() => {
        console.log(`API server listening on ${HOST}:${PORT}`);
    }).catch(async (error) => {
        app.log.error(error);
        await performShutdown();
        process.exit(1);
    });
}
start();
