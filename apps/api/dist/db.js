/**
 * protocol_1605/A — single-pool re-export.
 *
 * Prior to Phase A this file owned a SECOND Postgres pool with its own
 * connection budget, fighting the index.ts pool for Supabase's cap. The
 * historical reason was that admin/feedback/shared/deal-helpers were written
 * against a local `sql` import instead of taking it as a parameter — too
 * disruptive to refactor right now.
 *
 * Compromise: keep the local-import surface but funnel it to the ONE pool
 * defined in shared/pool.ts. Future cleanup can rewrite call sites to take
 * sql as a dep and delete this file entirely.
 */
export { sql, closeSharedPool } from "./shared/pool.js";
