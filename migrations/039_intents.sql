-- 039_intents.sql — settlement protocol Phase E
-- AgentPact v2 Verifiable Settlement Protocol: API/DB surface for the new
-- on-chain primitive. Per plan-doc § 3.2 (Phase 0 corrected — no
-- agent_reputation rollup table; reputation is computed live).
--
-- Idempotency: every CREATE / ALTER uses IF NOT EXISTS so the file is safe
-- to re-apply against staging or a host that partially-applied it earlier.

BEGIN;

-- Encryption pubkey storage on the agents table (per plan § 2.6).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS encryption_pubkey BYTEA,
  ADD COLUMN IF NOT EXISTS encryption_pubkey_registered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS intents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  on_chain_id            BYTEA UNIQUE NOT NULL,
  buyer_agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  seller_agent_id        UUID REFERENCES agents(id) ON DELETE RESTRICT,
  seller_target_agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  settlement_class       TEXT NOT NULL CHECK (settlement_class IN ('A','B','C')),
  predicate_type         TEXT NOT NULL,
  predicate_params       JSONB NOT NULL,
  max_price_usdc         NUMERIC(20,6) NOT NULL CHECK (max_price_usdc > 0),
  buyer_stake_usdc       NUMERIC(20,6) NOT NULL DEFAULT 0,
  seller_stake_usdc      NUMERIC(20,6) NOT NULL DEFAULT 0,
  relay_gas_usdc         NUMERIC(20,6) NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'open',
  expires_at             TIMESTAMPTZ NOT NULL,
  ack_deadline_at        TIMESTAMPTZ,
  round1_deadline_at     TIMESTAMPTZ,
  round2_deadline_at     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intents_status_expires
  ON intents(status, expires_at)
  WHERE status IN ('open','accepted','delivered','reveal_round1','reveal_round2','streaming');
CREATE INDEX IF NOT EXISTS idx_intents_ack_deadline
  ON intents(ack_deadline_at) WHERE status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_intents_seller_status
  ON intents(seller_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_intents_buyer_status
  ON intents(buyer_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_intents_seller_target
  ON intents(seller_target_agent_id) WHERE seller_target_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS intent_units (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id    UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  unit_index   INTEGER NOT NULL,
  witness_hash BYTEA NOT NULL,
  tx_hash      BYTEA,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id, unit_index)
);

CREATE INDEX IF NOT EXISTS idx_intent_units_intent
  ON intent_units(intent_id, unit_index);

COMMIT;
