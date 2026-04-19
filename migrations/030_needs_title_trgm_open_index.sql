CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_needs_title_trgm_open
ON needs USING GIN (title gin_trgm_ops)
WHERE status = 'open';
