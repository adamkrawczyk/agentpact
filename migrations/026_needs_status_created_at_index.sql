CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_needs_status_created_at
ON needs (status, created_at DESC);
