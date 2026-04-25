# Migrations

This directory contains DB migrations applied at deploy time by `npm run migrate`
(see `scripts/migrate.ts`). The script reads `*.sql` files from this directory in
lexicographic order and runs each against the production database.

## ⚠️ Two migrations directories — known footgun

There is a SECOND migrations directory at `apps/api/migrations/` that contains
**stray migrations** (`012_enable_rls.sql`, `020_concierge_relay.sql`, plus dups
of `002_auth.sql` and `010_physical_service.sql`). Files placed in
`apps/api/migrations/` are **NEVER run automatically** — only this root directory
is wired into the migrate script.

**Production incident 2026-04-25:** `concierge_messages` table was missing in
production for ~2 weeks because `apps/api/migrations/020_concierge_relay.sql`
was never picked up by the migrate script. This caused 500 errors on
`/api/concierge/stats` and the entire concierge-relay activation flow.

**Resolution:** the missing migration was copied into this directory as
`033_concierge_relay.sql` and applied via the next deploy.

## Adding a new migration

1. Pick the next sequential number (`ls migrations/ | tail -1` to see the
   highest, then increment by 1).
2. Use `IF NOT EXISTS` / `IF EXISTS` everywhere — migrations must be idempotent
   so a re-run is safe.
3. Wrap large changes in `BEGIN ... COMMIT` for atomicity.
4. Place ONLY in this root `migrations/` dir. Do NOT put files in
   `apps/api/migrations/`.

## Cleanup TODO

The four files in `apps/api/migrations/` should be deleted once we've confirmed
production is healthy. They are no longer the source of truth.
