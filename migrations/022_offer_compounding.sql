CREATE UNIQUE INDEX IF NOT EXISTS offers_active_agent_category_title_unique
ON offers (agent_id, lower(btrim(category)), lower(btrim(title)))
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_offers_status_created_at
ON offers (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deals_offer_status
ON deals (offer_id, status);
