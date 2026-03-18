ALTER TABLE deals
ADD COLUMN IF NOT EXISTS is_free_tier BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_deals_is_free_tier ON deals(is_free_tier);
