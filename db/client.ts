import postgres from "postgres";

const connection = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";

export const sql = postgres(connection, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10
});

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
