-- Allow agents to register without a wallet address (set later via PATCH /api/agents/:id/wallet)
ALTER TABLE agents ALTER COLUMN owner_wallet_address DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN wallet_provider DROP NOT NULL;

-- Also relax the CHECK constraint to allow NULL and more providers
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_wallet_provider_check;
ALTER TABLE agents ADD CONSTRAINT agents_wallet_provider_check
  CHECK (wallet_provider IS NULL OR wallet_provider IN ('metamask','walletconnect','coinbase','phantom','other'));
