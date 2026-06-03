-- Phase 3 stabilization: keep payment_intents schema aligned with API code.
-- Stripe rows do not have wallet/provider addresses, and on-chain refund deferral
-- uses pending_refund while buyer/admin action is still required.

BEGIN;

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_status_check
  CHECK (status IN ('created','pending_funding','funded','released','refunded','pending_refund','disputed','failed'));

ALTER TABLE payment_intents ALTER COLUMN buyer_wallet_provider DROP NOT NULL;
ALTER TABLE payment_intents ALTER COLUMN buyer_wallet_address DROP NOT NULL;
ALTER TABLE payment_intents ALTER COLUMN seller_wallet_address DROP NOT NULL;

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_buyer_wallet_provider_check;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_buyer_wallet_provider_check
  CHECK (buyer_wallet_provider IS NULL OR buyer_wallet_provider IN ('metamask','walletconnect','coinbase','phantom','other'));

ALTER TABLE payment_intents
  ALTER COLUMN payment_provider SET DEFAULT 'usdc';

UPDATE payment_intents
SET payment_provider = 'usdc'
WHERE payment_provider IS NULL;

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_payment_provider_check;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_payment_provider_check
  CHECK (payment_provider IS NULL OR payment_provider IN ('usdc','stripe'));

COMMIT;
