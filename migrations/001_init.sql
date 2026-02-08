CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  owner_wallet_address TEXT NOT NULL,
  wallet_provider TEXT NOT NULL CHECK (wallet_provider IN ('metamask', 'walletconnect', 'coinbase')),
  auto_buy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reputation_score NUMERIC(4,3) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  description_md TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  currency TEXT NOT NULL DEFAULT 'USDC',
  base_price NUMERIC(18,6) NOT NULL,
  max_price_delta_pct NUMERIC(5,2) NOT NULL DEFAULT 15,
  sla_days INTEGER NOT NULL DEFAULT 7,
  proofs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS needs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  description_md TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  budget_min NUMERIC(18,6),
  budget_max NUMERIC(18,6),
  currency TEXT NOT NULL DEFAULT 'USDC',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  need_id UUID NOT NULL REFERENCES needs(id) ON DELETE CASCADE,
  score NUMERIC(4,3) NOT NULL,
  reason_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_id, need_id)
);

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_agent_id UUID NOT NULL REFERENCES agents(id),
  seller_agent_id UUID NOT NULL REFERENCES agents(id),
  offer_id UUID NOT NULL REFERENCES offers(id),
  need_id UUID NOT NULL REFERENCES needs(id),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (
    status IN (
      'proposed','countered','accepted','active','delivered','completed','cancelled','disputed'
    )
  ),
  negotiated_total NUMERIC(18,6) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC',
  max_price_delta_pct NUMERIC(5,2) NOT NULL,
  acceptance_timeout_days INTEGER NOT NULL DEFAULT 7,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  amount NUMERIC(18,6) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','funded','in_progress','delivered','accepted','disputed','cancelled')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, idx)
);

CREATE TABLE IF NOT EXISTS negotiation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  actor_agent_id UUID NOT NULL REFERENCES agents(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('propose','counter','accept','cancel')),
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  buyer_agent_id UUID NOT NULL REFERENCES agents(id),
  seller_agent_id UUID NOT NULL REFERENCES agents(id),
  amount NUMERIC(18,6) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC',
  chain TEXT NOT NULL DEFAULT 'base',
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','funded','released','refunded','disputed','failed')),
  buyer_wallet_provider TEXT NOT NULL CHECK (buyer_wallet_provider IN ('metamask','walletconnect','coinbase')),
  buyer_wallet_address TEXT NOT NULL,
  seller_wallet_address TEXT NOT NULL,
  platform_wallet_address TEXT NOT NULL,
  tx_hash TEXT,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  submitted_by UUID NOT NULL REFERENCES agents(id),
  artifact_manifest JSONB NOT NULL,
  checksum TEXT NOT NULL,
  verification_notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_agent_id UUID NOT NULL REFERENCES agents(id),
  to_agent_id UUID NOT NULL REFERENCES agents(id),
  rating_quality INTEGER NOT NULL CHECK (rating_quality BETWEEN 1 AND 5),
  rating_timeliness INTEGER NOT NULL CHECK (rating_timeliness BETWEEN 1 AND 5),
  rating_communication INTEGER NOT NULL CHECK (rating_communication BETWEEN 1 AND 5),
  rating_accuracy INTEGER NOT NULL CHECK (rating_accuracy BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, from_agent_id, to_agent_id)
);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  opened_by UUID NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_buyer','resolved_seller','timed_out')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('offers','needs')),
  filter_json JSONB NOT NULL,
  webhook_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_agent_id UUID REFERENCES agents(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id UUID,
  idempotency_key TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offers_tags ON offers USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_needs_tags ON needs USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_matches_score ON matches(score DESC);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status);
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_intents(status);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
