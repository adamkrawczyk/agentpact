-- payment-methods rollout — per-listing payment preference (Q1 dual-rail design).
--
-- Adds accepted_payment_methods to offers AND needs so each listing declares
-- which settlement rails it accepts: 'usdc' (on-chain escrow), 'stripe' (fiat
-- via Stripe application-fee), or 'both'. A deal is viable only where
-- buyer-payable ∩ seller-acceptable ≠ ∅; matching + propose filter on the
-- intersection. DEFAULT 'both' so liquidity stays unified unless an agent
-- deliberately opts out — fragmentation becomes a conscious choice, never a
-- structural default.
--
-- Safe additive change: NOT NULL with a DEFAULT backfills every existing row to
-- 'both' atomically, and the CHECK constrains the value set. Idempotent via
-- IF NOT EXISTS so re-running (or the repo's re-run-all migrate script) is safe.

BEGIN;

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS accepted_payment_methods TEXT NOT NULL DEFAULT 'both';

ALTER TABLE needs
  ADD COLUMN IF NOT EXISTS accepted_payment_methods TEXT NOT NULL DEFAULT 'both';

-- Constrain the value set. Drop-and-re-add so re-running the migration is safe.
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_accepted_payment_methods_check;
ALTER TABLE offers
  ADD CONSTRAINT offers_accepted_payment_methods_check
  CHECK (accepted_payment_methods IN ('usdc', 'stripe', 'both'));

ALTER TABLE needs DROP CONSTRAINT IF EXISTS needs_accepted_payment_methods_check;
ALTER TABLE needs
  ADD CONSTRAINT needs_accepted_payment_methods_check
  CHECK (accepted_payment_methods IN ('usdc', 'stripe', 'both'));

-- Explicit backfill of any pre-existing NULLs (defensive — the DEFAULT already
-- covers rows created before this migration, but a column added without the
-- default in a prior partial run could leave NULLs).
UPDATE offers SET accepted_payment_methods = 'both' WHERE accepted_payment_methods IS NULL;
UPDATE needs  SET accepted_payment_methods = 'both' WHERE accepted_payment_methods IS NULL;

-- Re-assert DEFAULT + NOT NULL so a partial prior run that created the column
-- WITHOUT them is fully repaired (ADD COLUMN IF NOT EXISTS is a no-op when the
-- column already exists, so these explicit ALTERs are what make 040 idempotent
-- under partial-run recovery). Safe to run repeatedly.
ALTER TABLE offers ALTER COLUMN accepted_payment_methods SET DEFAULT 'both';
ALTER TABLE offers ALTER COLUMN accepted_payment_methods SET NOT NULL;
ALTER TABLE needs  ALTER COLUMN accepted_payment_methods SET DEFAULT 'both';
ALTER TABLE needs  ALTER COLUMN accepted_payment_methods SET NOT NULL;

COMMIT;
