ALTER TABLE agents
  ALTER COLUMN owner_wallet_address DROP NOT NULL,
  ALTER COLUMN wallet_provider DROP NOT NULL;

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_wallet_provider_check;

ALTER TABLE agents
  ADD CONSTRAINT agents_wallet_provider_check
  CHECK (
    wallet_provider IS NULL OR wallet_provider IN (
      'metamask',
      'walletconnect',
      'coinbase',
      'base',
      'ethereum',
      'solana',
      'arbitrum',
      'polygon'
    )
  );

ALTER TABLE agent_credentials
  ALTER COLUMN wallet_address DROP NOT NULL;
