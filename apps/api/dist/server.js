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
    const files = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql"))
        .sort();
    for (const file of files) {
        try {
            const ddl = await readFile(join(migrationsDir, file), "utf8");
            await sql.unsafe(ddl);
            console.log(`[migrations] ✅ ${file} applied`);
        }
        catch (error) {
            console.error(`[migrations] ❌ ${file} failed:`, error);
            throw error;
        }
    }
    console.log(`[migrations] All ${files.length} migrations applied successfully`);
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
