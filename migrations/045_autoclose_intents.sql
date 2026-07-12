-- 045_autoclose_intents.sql — autoclose rollout Change 1 + Change 2 API surface
--
-- 1. Make intents.on_chain_id NULLABLE (needed for auto-minted intents that
--    are awaiting broadcast by the relayer daemon — the chain ID is not
--    known until broadcast).
-- 2. Add 'awaiting_funding' and 'reveal_ready' to the intents status index
--    so the relayer sweep can efficiently walk pending rows.
-- 3. Add deliverable_hash BYTEA to deals (the hash-preimage commitment that
--    becomes the Class-A predicate).
-- 4. Add autoclose_enabled BOOLEAN to agents (opt-in per agent, default false).
-- 5. Add intent_id FK to deals so auto-minted intents are traceable back to
--    the deal that spawned them (one intent per deal, nullable).
-- 6. Create intent_funding_authorizations — stores the buyer's EIP-3009
--    receiveWithAuthorization signature components queued for the relayer.
-- 7. Create intent_reveals — stores the seller's preimage submitted via
--    POST /api/intents/:id/reveal, consumed by the relayer's CLAIM sweep.
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS / OR REPLACE.

BEGIN;

-- 1. Make on_chain_id nullable (was NOT NULL UNIQUE) --------------
ALTER TABLE intents
  ALTER COLUMN on_chain_id DROP NOT NULL;

-- UNIQUE constraint stays: two intents may not share the same on_chain_id,
-- but NULL values are not compared under UNIQUE (SQL standard), so multiple
-- awaiting_funding rows can all have on_chain_id = NULL — that's correct.

-- 2. Widen the partial index to include the new autoclose statuses ---------
DROP INDEX IF EXISTS idx_intents_status_expires;
CREATE INDEX IF NOT EXISTS idx_intents_status_expires
  ON intents(status, expires_at)
  WHERE status IN (
    'open','accepted','delivered','reveal_round1','reveal_round2','streaming',
    'awaiting_funding','reveal_ready'
  );

-- 3. deliverable_hash on deals -------------------------------------------
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS deliverable_hash BYTEA;

-- 4. autoclose_enabled on agents -----------------------------------------
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS autoclose_enabled BOOLEAN NOT NULL DEFAULT false;

-- 5. intent_id FK on deals (nullable — most deals will never have one) ----
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS intent_id UUID REFERENCES intents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deals_intent_id
  ON deals(intent_id) WHERE intent_id IS NOT NULL;

-- 5b. Reverse link + on-chain tx hashes on intents. The relayer's CLAIM sweep
--     reads intents.deal_id to flip the originating deal to 'completed', and
--     records the funding/claim transaction hashes for the two-ledger
--     reconciliation watchdog.
ALTER TABLE intents
  ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS on_chain_funding_tx TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_claim_tx TEXT;

CREATE INDEX IF NOT EXISTS idx_intents_deal_id
  ON intents(deal_id) WHERE deal_id IS NOT NULL;

-- 6. intent_funding_authorizations ----------------------------------------
--    Stores the buyer's EIP-3009 signature components.  The relayer sweep
--    reads rows with status='queued' and broadcasts createIntentWithAuthorization.
CREATE TABLE IF NOT EXISTS intent_funding_authorizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id    UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  value_usdc   NUMERIC(20,6) NOT NULL,
  valid_after  BIGINT NOT NULL,
  valid_before BIGINT NOT NULL,
  nonce        BYTEA NOT NULL,
  sig_v        INT NOT NULL,
  sig_r        BYTEA NOT NULL,
  sig_s        BYTEA NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id)   -- one authorization per intent (replace by re-inserting if needed)
);

CREATE INDEX IF NOT EXISTS idx_intent_funding_auth_status
  ON intent_funding_authorizations(status)
  WHERE status = 'queued';

-- 7. intent_reveals --------------------------------------------------------
--    Stores the seller's hash-preimage submitted via POST /api/intents/:id/reveal.
--    The relayer consumes preimage as the witness to claimIntent on-chain.
CREATE TABLE IF NOT EXISTS intent_reveals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id   UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  preimage    BYTEA NOT NULL,
  ciphertext  BYTEA,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id)   -- one reveal per intent (idempotent upsert pattern)
);

COMMIT;
