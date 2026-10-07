-- 053_cctp.sql — M1 multi-chain reach (Base escrow + Solana/Ethereum via Circle CCTP v2).
--
-- Shared schema for the M1 lanes (contracts / relay / api). Owned by the
-- orchestrator; lanes change it only through a NEW migration.
--
-- Domains (CCTP v2): ethereum = 0, solana = 5, base = 6.
-- Amounts are USDC base units (6 decimals) as NUMERIC(38,0) — never floats.

-- Seller/buyer payout + refund destinations, one row per verified address.
CREATE TABLE IF NOT EXISTS agent_payout_routes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chain              TEXT NOT NULL CHECK (chain IN ('base','ethereum','solana')),
  cctp_domain        INTEGER NOT NULL CHECK (cctp_domain IN (0,5,6)),
  address            TEXT NOT NULL,          -- native form: 0x… (EVM) or base58 owner (Solana)
  recipient_bytes32  TEXT NOT NULL,          -- 0x + 64 hex: CCTP mintRecipient form
  proof_message      TEXT NOT NULL,          -- the exact challenge text that was signed
  proof_signature    TEXT NOT NULL,          -- EVM personal_sign hex, or Solana ed25519 base58
  verified_at        TIMESTAMPTZ NOT NULL,
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_payout_routes_domain_matches_chain CHECK (
    (chain = 'ethereum' AND cctp_domain = 0) OR
    (chain = 'solana'   AND cctp_domain = 5) OR
    (chain = 'base'     AND cctp_domain = 6)
  ),
  UNIQUE (agent_id, chain, address)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_payout_routes_default
  ON agent_payout_routes(agent_id) WHERE is_default AND revoked_at IS NULL;

-- Every cross-chain USDC movement (deposit into escrow, payout to seller,
-- refund to buyer). The relayer state machine + watchdogs run off this table.
CREATE TABLE IF NOT EXISTS cctp_transfers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction                   TEXT NOT NULL CHECK (direction IN ('deposit','payout','refund')),
  deal_id                     UUID REFERENCES deals(id) ON DELETE SET NULL,
  intent_id                   UUID REFERENCES intents(id) ON DELETE SET NULL,
  deal_ref                    TEXT,          -- bytes32 hex bound in hookData (deposits)
  source_domain               INTEGER NOT NULL CHECK (source_domain IN (0,5,6)),
  destination_domain          INTEGER NOT NULL CHECK (destination_domain IN (0,5,6)),
  source_tx_hash              TEXT,          -- burn tx on the source chain
  message_hash                TEXT,          -- keccak256(message)
  nonce                       TEXT,          -- CCTP v2 nonce (bytes32 hex) — replay key
  amount_base_units           NUMERIC(38,0) NOT NULL CHECK (amount_base_units > 0),
  max_fee_base_units          NUMERIC(38,0),
  fee_executed_base_units     NUMERIC(38,0),
  forwarding_fee_base_units   NUMERIC(38,0),
  quoted_fee_base_units       NUMERIC(38,0), -- total fee SHOWN to the user before signing
  sender                      TEXT,          -- source-chain burner (native form)
  recipient                   TEXT,          -- destination recipient (native form)
  status                      TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
                                'submitted','attestation_pending','attested','relayed',
                                'bound','forwarded','completed','failed','stuck','refunded')),
  attempts                    INTEGER NOT NULL DEFAULT 0,
  last_error                  TEXT,
  next_attempt_at             TIMESTAMPTZ,
  destination_tx_hash         TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cctp_transfers_source_nonce
  ON cctp_transfers(source_domain, nonce) WHERE nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cctp_transfers_source_tx
  ON cctp_transfers(direction, source_domain, source_tx_hash) WHERE source_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cctp_transfers_work
  ON cctp_transfers(status, next_attempt_at)
  WHERE status NOT IN ('completed','refunded','failed');
CREATE INDEX IF NOT EXISTS idx_cctp_transfers_deal ON cctp_transfers(deal_id) WHERE deal_id IS NOT NULL;

-- Which chain funded the deal (diagnostic: share of funded deals by source chain).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS funding_chain TEXT
  CHECK (funding_chain IS NULL OR funding_chain IN ('base','ethereum','solana'));
