-- 057_cctp_relay.sql — M1 relayer state machine for cctp_transfers (lane m1-relay).
--
-- 053 gave every cross-chain movement a row; this adds what the relayer needs
-- to move a row through its states safely:
--   message / attestation     the attested CCTP message, so a relay retry never
--                             depends on Iris still serving it
--   status_changed_at         watchdog clock (stuck attestation / unbound mint)
--   lease_until               compare-and-set lease: one broadcaster per row,
--                             even if two relayer processes ever run at once
--   stuck_reason / stuck_at / alerted_at
--                             why a row needs a human, since when, and that the
--                             alert already fired (one alert per stuck episode)
--   onchain_intent_id         bytes32 EscrowV3 intent the gateway opened
--   parent_transfer_id        refund/payout row -> the deposit it settles
--   payout_domain / payout_recipient / refund_recipient / intent_expires_at
--                             decoded from the deposit's hookData v1
--
-- Additive + idempotent. No row is rewritten; no constraint is dropped.

ALTER TABLE cctp_transfers
  ADD COLUMN IF NOT EXISTS message             TEXT,
  ADD COLUMN IF NOT EXISTS attestation         TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS lease_until         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stuck_reason        TEXT,
  ADD COLUMN IF NOT EXISTS stuck_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerted_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onchain_intent_id   TEXT,
  ADD COLUMN IF NOT EXISTS parent_transfer_id  UUID REFERENCES cctp_transfers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payout_domain       INTEGER CHECK (payout_domain IS NULL OR payout_domain IN (0,5,6)),
  ADD COLUMN IF NOT EXISTS payout_recipient    TEXT,
  ADD COLUMN IF NOT EXISTS refund_recipient    TEXT,
  ADD COLUMN IF NOT EXISTS intent_expires_at   TIMESTAMPTZ;

-- A deposit is settled exactly once: by a refund OR by a payout, never both,
-- never twice. The relayer inserts the child row BEFORE broadcasting, so this
-- index is what makes a crashed-and-restarted tick unable to double-send.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cctp_transfers_one_child
  ON cctp_transfers(parent_transfer_id) WHERE parent_transfer_id IS NOT NULL;

-- Base-funded intents with a cross-chain payout route have no deposit row;
-- one payout row per intent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cctp_transfers_payout_intent
  ON cctp_transfers(intent_id) WHERE direction = 'payout' AND intent_id IS NOT NULL;

-- Refund scan: bound deposits ordered by expiry.
CREATE INDEX IF NOT EXISTS idx_cctp_transfers_bound_expiry
  ON cctp_transfers(intent_expires_at)
  WHERE direction = 'deposit' AND status = 'bound';

-- /health: stuck count + oldest stuck age on every tick.
CREATE INDEX IF NOT EXISTS idx_cctp_transfers_stuck
  ON cctp_transfers(stuck_at) WHERE status = 'stuck';
