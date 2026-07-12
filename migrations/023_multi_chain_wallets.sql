-- Multi-chain wallet support (Solana, Arbitrum, Polygon)
-- Adds chain resolution at agent registration + deal time.
-- Base L2 remains default; Solana (USDC-SPL), Arbitrum, Polygon now also accepted.

-- 1. Add preferred_chain to agents so we know what chain their wallet lives on.
--    Inferred at registration from wallet address format.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS preferred_chain TEXT NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS wallet_provider_raw TEXT; -- preserves the original string before normalisation

-- 2. Widen wallet_provider constraint to accept 'phantom' (Solana) in addition to EVM providers.
--    Drop old check, replace with a wider one.
ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_wallet_provider_check;

ALTER TABLE agents
  ADD CONSTRAINT agents_wallet_provider_check
    CHECK (wallet_provider IN ('metamask', 'walletconnect', 'coinbase', 'phantom', 'other'));

-- 3. Add chain column to deals so the agreed payment chain is stored on the deal.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'base';

-- 4. Index for chain-based queries on deals.
CREATE INDEX IF NOT EXISTS idx_deals_chain ON deals (chain);

-- 5. Seed preferred_chain for existing agents based on wallet address format:
--    Solana addresses are base58, 32-44 chars, no '0x' prefix.
--    EVM addresses start with '0x' and are 42 chars.
UPDATE agents
SET preferred_chain = CASE
  WHEN owner_wallet_address LIKE '0x%' THEN 'base'
  ELSE 'solana'
END
WHERE preferred_chain = 'base';
