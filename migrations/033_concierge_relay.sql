-- Concierge relay schema for welcome/first-transaction messages
-- Replaces the broken JSONL queue with authoritative DB state

CREATE TABLE IF NOT EXISTS concierge_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL CHECK (message_type IN ('welcome', 'first-transaction', 'match-suggestion', 'activation-nudge')),
  priority INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  body_md TEXT NOT NULL,
  related_offer_id UUID REFERENCES offers(id) ON DELETE SET NULL,
  related_need_id UUID REFERENCES needs(id) ON DELETE SET NULL,
  related_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_concierge_status ON concierge_messages (status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_concierge_agent ON concierge_messages (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_concierge_type ON concierge_messages (message_type, status);

-- Audit log for concierge relay runs
CREATE TABLE IF NOT EXISTS concierge_relay_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL DEFAULT 'manual' CHECK (run_type IN ('manual', 'cron', 'api', 'daemon')),
  messages_found INTEGER NOT NULL DEFAULT 0,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  messages_failed INTEGER NOT NULL DEFAULT 0,
  messages_skipped INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_summary TEXT
);
