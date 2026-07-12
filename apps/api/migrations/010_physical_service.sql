ALTER TABLE offers ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL;
ALTER TABLE needs ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL;
ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS buyer_data JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_offers_location_country
  ON offers ((location->>'country'))
  WHERE location IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_needs_location_country
  ON needs ((location->>'country'))
  WHERE location IS NOT NULL;
