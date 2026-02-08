import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, closeDb } from "../db/client.js";

async function main() {
  const migrationPath = resolve(process.cwd(), "migrations/001_init.sql");
  const ddl = await readFile(migrationPath, "utf8");
  await sql.unsafe(ddl);
  console.log("Migration 001_init.sql applied");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
