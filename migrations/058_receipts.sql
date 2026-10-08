-- 058_receipts.sql — ap_v31 M2: Receipt v1 (apr-1).
--
-- Every FUNDED deal that reaches a terminal outcome gets one signed receipt:
-- who paid, what was promised, what was delivered, who judged it, how it
-- ended. The payload is RFC 8785 canonical JSON, signed with ed25519; the
-- payload hashes are batched daily into an RFC 6962 Merkle root that can be
-- anchored on Base. Builder/signer/verifier: packages/receipts. Issuer:
-- apps/relayer-daemon/src/receipt-sweeper.ts. Reader: apps/api/src/routes/receipts.ts.
--
-- Additive only: new tables, no existing row touched.

-- Published verification keys. Rotation inserts a new key_id and (optionally)
-- sets retired_at on the old one; rows are never deleted, so every receipt
-- ever issued stays verifiable.
CREATE TABLE IF NOT EXISTS receipt_signing_keys (
  key_id      TEXT PRIMARY KEY,
  alg         TEXT        NOT NULL DEFAULT 'ed25519' CHECK (alg = 'ed25519'),
  -- base64 raw 32-byte public key
  public_key  TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at  TIMESTAMPTZ
);

-- One row per Merkle batch. tx_hash NULL = root computed and leaves assigned,
-- broadcast not yet confirmed (the anchor tick retries the SAME batch rather
-- than opening a new one, so a failed broadcast never orphans leaves).
CREATE TABLE IF NOT EXISTS receipt_anchor_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root        TEXT        NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  leaf_count  INTEGER     NOT NULL CHECK (leaf_count > 0),
  tx_hash     TEXT,
  chain       TEXT        NOT NULL DEFAULT 'base',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anchored_at TIMESTAMPTZ,
  CHECK ((tx_hash IS NULL) = (anchored_at IS NULL))
);

CREATE TABLE IF NOT EXISTS receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           UUID        NOT NULL REFERENCES deals(id),
  version           TEXT        NOT NULL DEFAULT 'apr-1',
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload           JSONB       NOT NULL,
  -- sha256(JCS(payload)), lowercase hex
  payload_hash      TEXT        NOT NULL UNIQUE CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  -- base64 ed25519 signature over JCS(payload)
  signature         TEXT        NOT NULL,
  key_id            TEXT        NOT NULL REFERENCES receipt_signing_keys(key_id),
  anchor_batch_id   UUID        REFERENCES receipt_anchor_batches(id),
  anchor_leaf_index INTEGER,
  superseded_by     UUID        REFERENCES receipts(id),
  -- Denormalised from payload for the timeline queries. The payload is the
  -- signed truth; these exist only so "receipts for agent X" is an index scan.
  outcome           TEXT        NOT NULL CHECK (outcome IN (
                      'settled','refunded','disputed_buyer_won','disputed_seller_won',
                      'timed_out','cancelled_after_funding')),
  payer_agent_id    UUID        NOT NULL,
  payee_agent_id    UUID        NOT NULL,
  qualifying        BOOLEAN     NOT NULL,
  capital_at_risk   BOOLEAN     NOT NULL,
  CHECK ((anchor_batch_id IS NULL) = (anchor_leaf_index IS NULL))
);

-- "The current receipt": exactly one non-superseded receipt per deal+version.
-- This is the issuance idempotency guard — two sweeper ticks racing on the
-- same deal cannot both insert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_current
  ON receipts (deal_id, version) WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_anchor_leaf
  ON receipts (anchor_batch_id, anchor_leaf_index) WHERE anchor_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_unanchored
  ON receipts (issued_at, id) WHERE anchor_batch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_payer
  ON receipts (payer_agent_id, issued_at DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_payee
  ON receipts (payee_agent_id, issued_at DESC) WHERE superseded_by IS NULL;
