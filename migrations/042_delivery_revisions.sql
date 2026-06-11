-- 042: Delivery revisions — promote reject -> fix -> resubmit to a first-class
-- primitive. Each delivery row for a milestone carries a monotonically
-- increasing revision number; deals can cap attempts via max_revisions.
--
-- revision is assigned by the API at INSERT time (count of prior deliveries
-- for the milestone + 1). max_revisions = NULL means unlimited (default,
-- backward compatible).

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS max_revisions INTEGER;

-- Backfill revision numbers for existing deliveries (per milestone, by created_at)
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY milestone_id ORDER BY created_at ASC) AS rn
  FROM deliveries
)
UPDATE deliveries d
SET revision = n.rn
FROM numbered n
WHERE d.id = n.id AND d.revision <> n.rn;

CREATE INDEX IF NOT EXISTS idx_deliveries_milestone_revision
  ON deliveries (milestone_id, revision DESC);
