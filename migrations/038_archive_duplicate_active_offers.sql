-- protocol_1605/A — One-shot data migration: archive duplicate active offers,
-- previously handled by ensureOfferCompoundingSchema() in apps/api/src/index.ts
-- on every app boot.
--
-- The boot-block compromise was: keep only ONE active offer per
-- (agent_id, lower(btrim(category)), lower(btrim(title))) tuple — anyone
-- creating exact duplicates gets older copies auto-archived. After deletion
-- of the boot block in this PR, the unique index (already shipped in
-- migration 022) enforces this at INSERT time so the cleanup only needs to
-- run once at deploy.
--
-- Idempotent: if no duplicates exist (the steady state under the unique
-- index), this is a no-op. The unique index from migration 022 means new
-- duplicates can't get inserted; this migration just sweeps any historical
-- duplicates that survived in a pre-022 row that escaped CI/dev cleanup.

BEGIN;

WITH archive_targets AS (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY agent_id, lower(btrim(category)), lower(btrim(title))
        ORDER BY created_at DESC
      ) AS rn
    FROM offers
    WHERE status = 'active'
  ) ranked
  WHERE rn > 1
)
UPDATE offers
SET status = 'archived', updated_at = NOW()
WHERE id IN (SELECT id FROM archive_targets);

COMMIT;
