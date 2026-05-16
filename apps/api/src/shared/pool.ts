/**
 * protocol_1605/A — Single Postgres pool (Phase A step 1).
 *
 * Prior to this refactor THREE independent pools competed for Supabase's
 * tiny connection cap (~20 on free tier):
 *   - apps/api/src/index.ts:92-114  → max:20  (the "main" pool)
 *   - apps/api/src/db.ts:5-13       → max:10  (used by admin/feedback/shared)
 *   - apps/api/src/auth.ts:64-69    → max:3   (fallback when no sql is injected)
 *
 * Total cap: 33 connections vs. a 20-connection plan. The result was
 * pool-acquire timeouts on /api/needs|offers|deals that manifested as 16s
 * hangs returning 0 bytes (see plan §2 live probe evidence).
 *
 * One pool. One shutdown path. Configuration here is the single source of truth.
 */

import postgres from "postgres";
import type { Sql } from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:***@localhost:5432/agentpact";

// Pool sizing rationale (do not change without re-checking Supabase plan):
// - max:20         — Supabase free tier supports ~20 connections; one pool means
//                    one process can saturate the cap. The matching worker
//                    (Phase A step 2 — deferred) will eventually take its own
//                    slice; until then 20 covers steady state.
// - idle_timeout:30 — release idle sockets to keep us under the cap when warm.
// - connect_timeout:10 — fail fast on cold pool acquisition.
// - max_lifetime:1800 — recycle stale sockets every 30 min.
// - acquire_timeout:15000 — when the pool is full, requests fail fast instead
//                          of queueing indefinitely (defense-in-depth from WIS-985).
// - statement_timeout:25000 — Postgres-side cancel slightly below Fastify's 30s
//                            request timeout so cancelled queries free the
//                            connection (WIS-985 defense-in-depth).
// - idle_in_transaction_session_timeout:60000 — safety net for stuck txns.
// - application_name — makes pg_stat_activity rows grep-able under audit.
export const sql: Sql<Record<string, unknown>> = postgres(DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  max_lifetime: 1800,
  // acquire_timeout is real at runtime but missing from postgres@3.4.x types
  ...(process.env.NODE_ENV ? { acquire_timeout: 15_000 } : {}),
  connection: {
    statement_timeout: 25_000,
    idle_in_transaction_session_timeout: 60_000,
    application_name: "agentpact-api",
  },
} as postgres.Options<Record<string, postgres.PostgresType>>);

/**
 * Close the shared pool. Called from server.ts shutdown handler exactly once.
 * postgres.js' .end() is idempotent so duplicate calls are safe, but the
 * canonical owner of this lifecycle is index.ts → server.ts.
 */
export async function closeSharedPool(timeoutSec = 5): Promise<void> {
  await sql.end({ timeout: timeoutSec });
}
