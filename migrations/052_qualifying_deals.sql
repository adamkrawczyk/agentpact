-- 052_qualifying_deals.sql — honest_0710 foundation.
--
-- ONE definition of "a deal that counts", shared by every consumer
-- (reputation, trust tier, leaderboard, homepage counters, receipts,
-- check_agent, milestone gates). The TypeScript twin lives in
-- apps/api/src/shared/qualifying.ts; qualifying.test.ts pins the two
-- definitions to each other on the same fixtures. Change both or neither.
--
-- Two levels:
--   qualifying       = priced, distinct agents, distinct KNOWN owner wallets,
--                      neither party internal, not quarantined.
--   capital_at_risk  = qualifying AND real money moved (a payment intent that
--                      reached funded/released/refunded/disputed, or an
--                      on-chain escrow intent bound to the deal).
-- Reputation, receipts and public "paid" counters use capital_at_risk.
--
-- Additive and reversible: no row is modified or deleted.

-- Integrity classification (set by the quarantine lane; NULL = clean).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS integrity_class TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS integrity_note TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS integrity_classified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_deals_integrity_class
  ON deals(integrity_class) WHERE integrity_class IS NOT NULL;

-- Canonical wallet key. NULL means "unknown" (missing, zero address, Solana
-- system program, or a non-address placeholder such as a config default).
-- EVM addresses compare case-insensitively; Solana base58 is case-sensitive.
-- Superseded by 056_wallet_key_placeholders.sql (36+ leading zero hex digits
-- = placeholder = unknown); this file keeps its original body for history.
CREATE OR REPLACE FUNCTION ap_wallet_key(w TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN w IS NULL THEN NULL
    WHEN btrim(w) ~* '^0x[0-9a-f]{40}$' AND btrim(w) !~* '^0x0{40}$' THEN lower(btrim(w))
    WHEN btrim(w) ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND btrim(w) !~ '^1+$' THEN btrim(w)
    ELSE NULL
  END
$$;

CREATE OR REPLACE VIEW deal_integrity AS
SELECT
  d.id                                   AS deal_id,
  d.status                               AS status,
  d.negotiated_total                     AS negotiated_total,
  d.buyer_agent_id                       AS buyer_agent_id,
  d.seller_agent_id                      AS seller_agent_id,
  d.created_at                           AS created_at,
  d.updated_at                           AS updated_at,
  d.integrity_class                      AS integrity_class,
  (
    d.negotiated_total > 0
    AND d.buyer_agent_id <> d.seller_agent_id
    AND ap_wallet_key(b.owner_wallet_address) IS NOT NULL
    AND ap_wallet_key(s.owner_wallet_address) IS NOT NULL
    AND ap_wallet_key(b.owner_wallet_address) <> ap_wallet_key(s.owner_wallet_address)
    AND NOT b.is_internal
    AND NOT s.is_internal
    AND d.integrity_class IS NULL
  )                                      AS qualifying,
  (
    EXISTS (
      SELECT 1 FROM milestones m
      JOIN payment_intents pi ON pi.milestone_id = m.id
      WHERE m.deal_id = d.id
        AND pi.status IN ('funded','released','refunded','disputed')
    )
    OR EXISTS (
      SELECT 1 FROM intents i
      WHERE i.id = d.intent_id OR i.deal_id = d.id
    )
  )                                      AS funded
FROM deals d
JOIN agents b ON b.id = d.buyer_agent_id
JOIN agents s ON s.id = d.seller_agent_id;

-- Convenience view: the deals that are allowed to count as evidence.
CREATE OR REPLACE VIEW qualifying_deals AS
SELECT di.*, (di.qualifying AND di.funded) AS capital_at_risk
FROM deal_integrity di
WHERE di.qualifying;
