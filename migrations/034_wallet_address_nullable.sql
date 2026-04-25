-- Allow agents to register without a wallet address (set later via PATCH /api/agents/:id/wallet)
ALTER TABLE agents ALTER COLUMN owner_wallet_address DROP NOT NULL;
