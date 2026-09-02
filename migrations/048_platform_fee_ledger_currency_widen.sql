-- 048_platform_fee_ledger_currency_widen.sql
-- platform_fee_ledger.currency was CHAR(3) (fits 'USD'). The milestone-release
-- path (issue #133) now writes rows with currency='USDC' (deals are USDC-
-- denominated on Base) — CHAR(3) rejects a 4-char value, so widen to CHAR(4)
-- before that INSERT path ships. audit-orders.ts rows keep writing 'USD',
-- which still fits (CHAR(4) blank-pads shorter values, no data change).

BEGIN;

ALTER TABLE platform_fee_ledger ALTER COLUMN currency TYPE CHAR(4);

COMMIT;
