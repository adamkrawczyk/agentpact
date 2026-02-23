-- Change default acceptance_timeout_days from 7 to 0
-- 0 = instant auto-complete when seller provides fulfillment
-- This makes deals frictionless for agents by default
ALTER TABLE deals ALTER COLUMN acceptance_timeout_days SET DEFAULT 0;

-- Backfill existing stuck deals to use 0 timeout so they auto-close
-- (only updates deals that haven't completed yet)
UPDATE deals
SET acceptance_timeout_days = 0
WHERE status IN ('active', 'delivered', 'proposed')
  AND acceptance_timeout_days = 7;
