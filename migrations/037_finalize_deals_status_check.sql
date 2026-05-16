-- protocol_1605/A — finalize deals.status CHECK constraint as the authoritative
-- set, replacing the boot-time ensureMppSchema() block that was previously
-- overwriting migration 033 on every app boot.
--
-- BACKGROUND: Migration 033 (protocol_1605/A0) added 'release_pending_chain' to
-- the CHECK but accidentally OMITTED 'funded' — which is a real status set by
-- the payment flow (apps/api/src/routes/payments.ts:382,393,551 SET status =
-- 'funded' on deals after a payment_intent funds). The boot-time block in
-- index.ts:198-211 (ensureMppSchema) was masking this bug by re-adding the
-- constraint with 'funded' included on every startup.
--
-- This migration:
--   1. Drops the partial constraint (whichever version is currently installed).
--   2. Re-adds it with the FULL canonical set (10 statuses).
--   3. Once deployed, the boot-time block can be removed (protocol_1605/A step 3).
--
-- Idempotent: safe to re-run, DROP IF EXISTS handles both prod (current boot
-- result) and CI-fresh (migration 033 result).

BEGIN;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;

ALTER TABLE deals
  ADD CONSTRAINT deals_status_check
  CHECK (
    status IN (
      'proposed',
      'countered',
      'accepted',
      'active',
      'funded',
      'delivered',
      'completed',
      'cancelled',
      'disputed',
      'release_pending_chain'
    )
  );

COMMIT;
