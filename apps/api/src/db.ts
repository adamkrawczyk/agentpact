import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:***@localhost:5432/agentpact";

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 1800,
  // WIS-985: acquire_timeout is available at runtime but not in postgres.js v3.4.8 types
  // Use spread to avoid TS2353
  ...(process.env.NODE_ENV ? { acquire_timeout: 15_000 } : {}),
} as postgres.Options<Record<string, postgres.PostgresType>>);
