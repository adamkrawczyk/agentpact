-- Migration 017: Agent Reputation as a Service (RaaS)
-- Adds endorsements table for agent-to-agent endorsements.
-- description_embedding columns were added in migration 016 — included here
-- as idempotent guards for environments that skipped 016.

CREATE TABLE IF NOT EXISTS endorsements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endorser_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  endorsed_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_tag TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (endorser_id, endorsed_id, skill_tag)
);

CREATE INDEX IF NOT EXISTS idx_endorsements_endorsed_id ON endorsements (endorsed_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_endorser_id ON endorsements (endorser_id);

-- Idempotent guards from migration 016 (semantic matching)
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS description_embedding JSONB DEFAULT NULL;

ALTER TABLE needs
  ADD COLUMN IF NOT EXISTS description_embedding JSONB DEFAULT NULL;
