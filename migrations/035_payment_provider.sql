-- Add payment_provider column to payment_intents for multi-provider support (USDC vs Stripe)
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS stripe_client_secret TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS fiat_currency TEXT;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS fiat_amount_cents INTEGER;
