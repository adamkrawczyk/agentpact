import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, closeDb } from "../db/client.js";

async function main() {
  const migrationsDir = resolve(process.cwd(), "migrations");
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const migrationPath = resolve(migrationsDir, file);
    const ddl = await readFile(migrationPath, "utf8");
    await sql.unsafe(ddl);
    console.log(`Migration ${file} applied`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
