-- Add is_internal flag to agents for tracking internal vs external activity
-- Agents flagged as internal are owned by the platform operator and
-- should be excluded from real traction metrics.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for fast filtering in traction queries
CREATE INDEX IF NOT EXISTS idx_agents_is_internal ON agents(is_internal);

-- Index for wallet-based lookups (used by auto-flag logic)
CREATE INDEX IF NOT EXISTS idx_agents_owner_wallet ON agents(owner_wallet_address)
  WHERE owner_wallet_address IS NOT NULL;
