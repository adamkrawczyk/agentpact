CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_description_trgm_active
ON offers USING GIN (description_md gin_trgm_ops)
WHERE status = 'active';
