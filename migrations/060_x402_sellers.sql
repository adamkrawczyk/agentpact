-- 060_x402_sellers.sql — M3 self-serve sellers + x402 → escrow upgrade.
--
-- Additive and idempotent. Touches no column of deals/agents/milestones/
-- payment_intents/intents, so the 052 views are unaffected.

-- One row per deal whose escrowed x402 response has been served.
-- deal_id is the PRIMARY KEY: two concurrent consumes race on the same key,
-- exactly one INSERT wins, the other sees the conflict. That uniqueness is the
-- whole replay guard — a funded deal buys exactly one served response.
CREATE TABLE IF NOT EXISTS x402_consumptions (
  deal_id            UUID PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  seller_agent_id    UUID NOT NULL REFERENCES agents(id),
  -- Random per-request key chosen by the seller middleware. A retry with the
  -- same key is an idempotent replay (the first response was lost in transit);
  -- any other key is a replay attempt and is refused.
  consume_key        TEXT NOT NULL CHECK (length(consume_key) BETWEEN 8 AND 128),
  price_base_units   NUMERIC(38,0) NOT NULL CHECK (price_base_units > 0),
  resource           TEXT,
  consumed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_x402_consumptions_seller ON x402_consumptions(seller_agent_id, consumed_at DESC);

-- Optional: the seller's public x402 endpoint(s), shown on the readiness
-- checklist and usable by discovery. Never fetched by the API.
CREATE TABLE IF NOT EXISTS seller_x402_endpoints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url                TEXT NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 2048),
  offer_id           UUID REFERENCES offers(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, url)
);

-- USDC base units currently HELD in escrow for a deal (funded, not yet
-- released/refunded). Single place to extend when another funding path
-- (e.g. CCTP-bound intents) starts recording held funds elsewhere.
-- payment_intents.amount is NUMERIC(18,6); * 1e6 is exact in NUMERIC.
CREATE OR REPLACE FUNCTION ap_deal_escrowed_base_units(p_deal_id UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(pi.amount * 1000000), 0)::NUMERIC(38,0)
  FROM milestones m
  JOIN payment_intents pi ON pi.milestone_id = m.id
  WHERE m.deal_id = p_deal_id
    AND pi.status = 'funded'
$$;
