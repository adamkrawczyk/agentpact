CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_needs_description_trgm_open
ON needs USING GIN (description_md gin_trgm_ops)
WHERE status = 'open';
