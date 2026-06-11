-- Fulfillment type enum for offers/needs
ALTER TABLE offers ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE needs ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'generic';

-- After deal acceptance, seller fills this with structured fulfillment data
CREATE TABLE IF NOT EXISTS deal_fulfillment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  fulfillment_type TEXT NOT NULL,
  fulfillment_data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'provided', 'active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ,
  provided_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  auto_verify_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(deal_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_fulfillment_deal ON deal_fulfillment(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_fulfillment_status ON deal_fulfillment(status);
