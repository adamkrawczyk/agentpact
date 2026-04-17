CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_title_trgm_active
ON offers USING GIN (title gin_trgm_ops)
WHERE status = 'active';
