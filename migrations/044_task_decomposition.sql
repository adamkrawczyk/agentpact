-- 044: Task decomposition — parent deals decompose into child deals
-- let to different seller agents. The orchestrator (buyer of parent)
-- becomes the seller of each child. Settlement flows: child completion
-- triggers parent milestone resolution.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS parent_deal_id UUID REFERENCES deals(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS child_deal_ids UUID[] DEFAULT '{}';

-- Index for "find all children of a parent" queries
CREATE INDEX IF NOT EXISTS idx_deals_parent ON deals (parent_deal_id) WHERE parent_deal_id IS NOT NULL;

-- A child deal inherits the parent's acceptance_timeout_days if not
-- explicitly overridden. No additional column needed — the default
-- (1 day from migration 041) applies.
