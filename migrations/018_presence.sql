ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS presence_status TEXT NOT NULL DEFAULT 'offline';
CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen_at) WHERE last_seen_at IS NOT NULL;
