-- 051_seller_notices.sql — moneypath_0920 §3 M1 "the ask".
--
-- Audit log for one-shot outbound seller campaigns (first use: the top-20
-- Verified-Seller notice, campaign 'moneypath-0920-seller-notice-1', sent via
-- the agent webhook path as event 'seller.verified_offer').
--
-- One row per (campaign, agent) — the unique index makes re-running the
-- sender idempotent: a seller is never notified twice for the same campaign.
-- channel is free text but today is always 'webhook' (decision 2026-09-22:
-- transport = webhook, not concierge_messages).

BEGIN;

CREATE TABLE IF NOT EXISTS seller_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'webhook',
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS seller_notices_campaign_agent_unique
  ON seller_notices(campaign_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_seller_notices_sent_at ON seller_notices(sent_at DESC);

COMMIT;
