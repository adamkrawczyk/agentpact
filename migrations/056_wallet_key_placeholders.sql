-- 056_wallet_key_placeholders.sql — honest_0710 follow-up to 052.
--
-- ap_wallet_key() (052) treated only the all-zero EVM address as "unknown".
-- Other low placeholder addresses (0x…0001-style precompiles, the 0x…dEaD burn
-- address) passed as KNOWN owner wallets, so the same-owner and unknown-owner
-- rules in deal_integrity / qualifying_deals treated agents on such a
-- placeholder as real, distinct owners — and agents of unrelated people that
-- all default to 0x…0001 as the SAME owner.
--
-- New rule: an EVM address whose first 36 hex digits (after 0x) are all zero
-- is unknown. That covers the zero address, every 0x0…01–0x0…ffff precompile /
-- system-style placeholder and 0x000000000000000000000000000000000000dEaD.
-- No usable key has 144 leading zero bits, so no real owner is affected.
--
-- TS twin: walletKey() in apps/api/src/shared/qualifying.ts. qualifying.test.ts
-- pins the two to each other on the same fixtures — change both or neither.
--
-- Reputation (054) is derived from qualifying_deals, but replacing a function
-- fires no trigger, so the scores it feeds are recomputed here. The new rule
-- only ever turns a known key into NULL, so only deals with a placeholder
-- party can change, and only their sellers' scores can move: the recompute is
-- scoped to exactly those sellers (no full-table pass).
--
-- Reversible. Affected sellers' scores are snapshotted once into
-- agents_reputation_backup_056 before the recompute. To roll back:
--   1. re-run 052's CREATE OR REPLACE FUNCTION ap_wallet_key (zero-only rule);
--   2. UPDATE agents a SET reputation_score = b.reputation_score
--        FROM agents_reputation_backup_056 b WHERE b.agent_id = a.id;
-- Idempotent: re-running re-snapshots nothing and recomputes the same values.

CREATE OR REPLACE FUNCTION ap_wallet_key(w TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN w IS NULL THEN NULL
    WHEN btrim(w) ~* '^0x[0-9a-f]{40}$' AND btrim(w) !~* '^0x0{36}' THEN lower(btrim(w))
    WHEN btrim(w) ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND btrim(w) !~ '^1+$' THEN btrim(w)
    ELSE NULL
  END
$$;

-- Sellers of completed deals with a party on a placeholder wallet: the only
-- scores the rule change can move (raw-text match, independent of which
-- ap_wallet_key version is installed).
CREATE TABLE IF NOT EXISTS agents_reputation_backup_056 (
  agent_id         UUID PRIMARY KEY,
  reputation_score NUMERIC(4,3),
  snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agents_reputation_backup_056 (agent_id, reputation_score, snapshot_at)
SELECT a.id, a.reputation_score, NOW()
FROM agents a
WHERE a.id IN (
  SELECT d.seller_agent_id
  FROM deals d
  JOIN agents b ON b.id = d.buyer_agent_id
  JOIN agents s ON s.id = d.seller_agent_id
  WHERE d.status = 'completed'
    AND (btrim(b.owner_wallet_address) ~* '^0x0{36}[0-9a-f]{4}$'
         OR btrim(s.owner_wallet_address) ~* '^0x0{36}[0-9a-f]{4}$')
)
ON CONFLICT (agent_id) DO NOTHING;

UPDATE agents a
SET reputation_score = ap_reputation_score(a.id)
FROM agents_reputation_backup_056 bk
WHERE bk.agent_id = a.id
  AND a.reputation_score IS DISTINCT FROM ap_reputation_score(a.id);
