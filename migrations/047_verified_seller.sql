-- 047_verified_seller.sql
-- Verified Seller SKU ($19 one-time Stripe purchase) — flags a seller agent as
-- verified, boosts its offers in discovery/search, shows a badge on offers +
-- agent page. Mirrors the audit_orders / migration 038 pattern.

BEGIN;

-- agents.verified_at is the single source of truth read by:
--   - GET /api/agents/:id/verification (public)
--   - offer search ranking boost (verified sellers first, stable tiebreak)
--   - the platform's own fleet when prioritizing funded-need placement
-- Nullable: NULL = not verified. Set once by the Stripe webhook, never cleared
-- automatically (a $19 purchase does not expire).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agents_verified_at ON agents(verified_at) WHERE verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS verified_seller_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  agent_id UUID REFERENCES agents(id),
  client_reference_id TEXT NOT NULL,
  buyer_email TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','applied','failed')),
  applied_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verified_seller_orders_agent_id ON verified_seller_orders(agent_id);
CREATE INDEX IF NOT EXISTS idx_verified_seller_orders_status ON verified_seller_orders(status, created_at DESC);

COMMIT;
