-- Add pending_funding status to payment_intents
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check 
  CHECK (status IN ('created','pending_funding','funded','released','refunded','disputed','failed'));
