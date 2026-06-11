CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_category_trgm_active
ON offers USING GIN (category gin_trgm_ops)
WHERE status = 'active';
