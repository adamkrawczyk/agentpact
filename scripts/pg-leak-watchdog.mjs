#!/usr/bin/env node
/**
 * pg-leak-watchdog.mjs — surgical leaked-transaction reaper for AgentPact's
 * Supabase Postgres, run as a scheduled cron job (e.g. via
 * `railway run -s @agentpact/api`, which injects DATABASE_URL — no
 * credential stored on disk).
 *
 * WHY THIS EXISTS (2026-06-17 postmortem, ~12h 503-on-everything outage):
 * AgentPact connects through the Supabase transaction-mode pooler (Supavisor,
 * :6543). Empirically verified that Supavisor DEFEATS every server-side
 * idle-in-transaction timer:
 *   - connection.* startup params (postgres.js) -> STRIPPED (SHOW app_name = "Supavisor")
 *   - ALTER ROLE ... SET idle_in_transaction_session_timeout -> backend still SHOWs 0 on :6543
 *   - SET LOCAL inside the txn -> value applies but timer does not reap through the pooler
 * Net: a browse request whose socket drops right after withBrowseStatementTimeout's
 * sql.begin() can leave a bare `begin` txn open for HOURS (observed 11h55m),
 * pinning a postgres.js pool slot until every DB route queues behind it and 503s.
 *
 * This external poller is the ONLY proven recurrence defense: it issues
 * pg_terminate_backend (a normal SQL command on the wire, immune to the pooler)
 * against leaked/wedged backends. Recovery is <1s. It does NOT restart anything.
 *
 * Output protocol:
 *   clean   -> "HEARTBEAT_OK pg-leak-watchdog | agentpact-supabase: clean"
 *   action  -> above + a "=== TERMINATIONS ===" block (wire this to your
 *              alerting of choice; escalate if it fires 3+ times in 30min)
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("pg-leak-watchdog: DATABASE_URL not set"); process.exit(2); }

const IDLE_TX_THRESHOLD = "60 seconds";
const WEDGED_THRESHOLD = "5 minutes";

const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });

function clip(s) { return (s ?? "").replace(/\s+/g, " ").slice(0, 70); }

try {
  // 1) Leaked idle-in-transaction backends (the pool-pinners)
  const leaked = await sql`
    SELECT pid,
           EXTRACT(EPOCH FROM (now() - state_change))::int AS age_sec,
           state,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 70) AS q
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
      AND state IN ('idle in transaction', 'idle in transaction (aborted)')
      AND now() - state_change > ${IDLE_TX_THRESHOLD}::interval
    ORDER BY age_sec DESC LIMIT 20`;

  // 2) Wedged active backends stuck waiting on the client (crashed/dropped client)
  const wedged = await sql`
    SELECT pid,
           EXTRACT(EPOCH FROM (now() - query_start))::int AS age_sec,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 70) AS q
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
      AND state = 'active'
      AND wait_event = 'ClientRead'
      AND now() - query_start > ${WEDGED_THRESHOLD}::interval
    ORDER BY age_sec DESC LIMIT 10`;

  const actions = [];
  for (const r of leaked) {
    await sql`SELECT pg_terminate_backend(${r.pid})`;
    actions.push(`leaked_tx pid=${r.pid} age=${r.age_sec}s state="${r.state}" q="${clip(r.q)}"`);
  }
  for (const r of wedged) {
    await sql`SELECT pg_terminate_backend(${r.pid})`;
    actions.push(`wedged_active pid=${r.pid} age=${r.age_sec}s q="${clip(r.q)}"`);
  }

  if (actions.length === 0) {
    // Script-only cron jobs deliver non-empty stdout verbatim. Stay SILENT on
    // a clean run (log to stderr only) so the channel isn't spammed every 5 min.
    console.error("pg-leak-watchdog: agentpact-supabase clean");
  } else {
    // Only print to stdout when there are terminations -> delivered as an alert.
    console.log(`pg-leak-watchdog: agentpact-supabase terminated_${actions.length}`);
    console.log("");
    console.log("=== POSTGRES_LEAKED_TX_WATCHDOG: TERMINATIONS ===");
    console.log("target=agentpact-supabase");
    for (const a of actions) console.log(`  - ${a}`);
    console.log(
      "Recommendation: if this fires >2x in 30min, the upstream leak is faster " +
      "than 60s — investigate withBrowseStatementTimeout / any sql.begin() that " +
      "wraps an external call. Supavisor strips server-side idle-in-tx timers, " +
      "so this poller is the durable defense."
    );
  }
  process.exit(0);
} catch (e) {
  console.error(`pg-leak-watchdog: error ${e.message}`);
  process.exit(1);
} finally {
  try { await sql.end({ timeout: 5 }); } catch {}
}
