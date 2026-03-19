-- Migration 020: Offer deduplication & spam controls
-- WIS-108: Deduplicate spam offers — compound similar into categories

-- 1. Index to speed up per-agent active offer count checks (rate limiting)
CREATE INDEX IF NOT EXISTS idx_offers_agent_status
  ON offers (agent_id, status)
  WHERE status = 'active';

-- 2. Index to speed up category grouping queries
CREATE INDEX IF NOT EXISTS idx_offers_category_status
  ON offers (category, status)
  WHERE status = 'active';

-- 3. Track zero-deal stale offers for auto-archiving
-- (uses existing created_at + deals table — no new column needed)

-- 4. Rate-limit config stored as a comment/constant — enforced at API layer (max 15 active per agent)
-- No hard DB constraint so we can raise the limit without a migration.
