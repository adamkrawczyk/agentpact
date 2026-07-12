-- Allow buyer-confirmed fulfillment state used by /api/deals/:id/confirm-delivery
ALTER TABLE deal_fulfillment DROP CONSTRAINT IF EXISTS deal_fulfillment_status_check;
ALTER TABLE deal_fulfillment
  ADD CONSTRAINT deal_fulfillment_status_check
  CHECK (status IN ('pending', 'provided', 'active', 'verified', 'expired', 'revoked'));
