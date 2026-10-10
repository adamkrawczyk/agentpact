-- 054_reputation_recompute.sql — honest_0710 phase A (lane m0-integrity).
--
-- Reputation is evidence, so it may only come from deals that count as
-- evidence: completed deals that are capital_at_risk in the qualifying_deals
-- view (052). Self deals, same-owner deals, $0 practice deals, deals with an
-- internal party, quarantined deals and unfunded deals earn nothing.
--
-- THE FORMULA (ap_reputation_score below is the only implementation; the
-- runtime helper apps/api/src/shared/reputation.ts creditReputation() calls it,
-- so the API and this recompute can never disagree):
--
--   reputation_score(agent) =
--     LEAST(9.999, ROUND( SUM over d IN reputation_evidence_deals
--                              (completed, capital_at_risk, >= $0.01 escrowed)
--                              WHERE d.seller = agent
--                           OF rating(d) / 10 , 3))
--
--   rating(d) = the buyer's review of the seller for d, first match wins:
--     1. the buyer's feedback row on d (mean of the four 1–5 ratings),
--     2. the rating the buyer gave when confirming delivery / closing d
--        (audit_log 'deal.buyer_review' / 'deal.close', latest row),
--     3. 5 — a completed deal with no review earns the neutral +0.5 it
--        always earned.
--
-- Agents earn reputation as sellers only (delivering is what is reviewed).
-- 9.999 is the column's NUMERIC(4,3) ceiling.
--
-- Reversible. A snapshot of every agent's score before the first recompute is
-- kept in agents_reputation_backup_20261007 (one row per agent, never
-- overwritten by a re-run). To restore:
--
--   UPDATE agents a SET reputation_score = b.reputation_score
--   FROM agents_reputation_backup_20261007 b WHERE b.agent_id = a.id;
--
-- To also stop automatic recomputation:
--   DROP TRIGGER IF EXISTS trg_deals_recompute_seller_reputation ON deals;
--   DROP TRIGGER IF EXISTS trg_agents_recompute_counterparty_reputation ON agents;
--   DROP TRIGGER IF EXISTS trg_payment_intents_recompute_seller_reputation ON payment_intents;
--   DROP TRIGGER IF EXISTS trg_intents_recompute_seller_reputation ON intents;
-- To restore 052's funding rule, re-run 052's CREATE OR REPLACE VIEW deal_integrity.
--
-- Idempotent: re-running re-snapshots nothing and recomputes the same values.

-- ── R1-01: "funded" means money moved, never "an intent row exists" ───────────
-- 052 counted ANY intent bound to the deal as funding. Accepting a paid deal
-- with a deliverable_hash auto-mints an intent in 'awaiting_funding' (no
-- on_chain_id, zero dollars escrowed), so every just-accepted deal became
-- capital_at_risk. An intent is funding evidence only once it exists on chain
-- (on_chain_id set by the buyer-broadcast route or the relayer) and has left
-- 'awaiting_funding'. Same columns as 052, so CREATE OR REPLACE is safe and
-- qualifying_deals (SELECT di.*) is unaffected.
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
      WHERE (i.id = d.intent_id OR i.deal_id = d.id)
        AND i.on_chain_id IS NOT NULL
        AND i.status <> 'awaiting_funding'
    )
  )                                      AS funded
FROM deals d
JOIN agents b ON b.id = d.buyer_agent_id
JOIN agents s ON s.id = d.seller_agent_id;

CREATE TABLE IF NOT EXISTS agents_reputation_backup_20261007 (
  agent_id         UUID PRIMARY KEY,
  reputation_score NUMERIC(4,3),
  snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agents_reputation_backup_20261007 (agent_id, reputation_score, snapshot_at)
SELECT id, reputation_score, NOW() FROM agents
ON CONFLICT (agent_id) DO NOTHING;

-- audit_log.payload_json holds either a JSON object or (most API writers) a
-- JSON *string* containing the serialized object. Unwrap the latter; anything
-- unparseable reads as NULL rather than failing the caller.
CREATE OR REPLACE FUNCTION ap_jsonb_unwrap(j JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(j) = 'string' THEN
    RETURN (j #>> '{}')::jsonb;
  END IF;
  RETURN j;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- ── R1-07: evidence needs a meaningful amount of money, not dust ─────────────
-- capital_at_risk says money moved; it does not say how much. Three funded
-- $0.000001 deals across throwaway wallets cost nothing and must not mint a
-- track record. A deal is REPUTATION EVIDENCE only when it is completed,
-- capital_at_risk, and the USDC actually escrowed for it (capped at the
-- negotiated total) is at least ap_min_evidence_usdc() = $0.01.
-- Escrowed = payment intents that reached funded/released/refunded/disputed
-- (the same set as deal_integrity.funded) + settlement intents on chain.
-- TS twin of the constant: MIN_EVIDENCE_USDC in apps/api/src/shared/qualifying.ts.
CREATE OR REPLACE FUNCTION ap_min_evidence_usdc() RETURNS NUMERIC
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.01::numeric $$;

CREATE OR REPLACE FUNCTION ap_deal_escrowed_usdc(p_deal UUID) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE((
      SELECT SUM(pi.amount) FROM milestones m
      JOIN payment_intents pi ON pi.milestone_id = m.id
      WHERE m.deal_id = p_deal
        AND pi.status IN ('funded','released','refunded','disputed')
    ), 0)
    + COALESCE((
      SELECT SUM(i.max_price_usdc) FROM intents i
      JOIN deals d ON d.id = p_deal
      WHERE (i.id = d.intent_id OR i.deal_id = d.id)
        AND i.on_chain_id IS NOT NULL
        AND i.status <> 'awaiting_funding'
    ), 0)
$$;

CREATE OR REPLACE VIEW reputation_evidence_deals AS
SELECT q.*, LEAST(q.negotiated_total, ap_deal_escrowed_usdc(q.deal_id)) AS settled_usdc
FROM qualifying_deals q
WHERE q.capital_at_risk
  AND q.status = 'completed'
  AND LEAST(q.negotiated_total, ap_deal_escrowed_usdc(q.deal_id)) >= ap_min_evidence_usdc();

CREATE OR REPLACE FUNCTION ap_reputation_score(p_agent UUID) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT LEAST(9.999, ROUND(COALESCE(SUM(
    COALESCE(
      (SELECT (f.rating_quality + f.rating_timeliness + f.rating_communication + f.rating_accuracy) / 4.0
         FROM feedback f
        WHERE f.deal_id = q.deal_id
          AND f.from_agent_id = q.buyer_agent_id
          AND f.to_agent_id = q.seller_agent_id),
      (SELECT LEAST(GREATEST((ap_jsonb_unwrap(al.payload_json)->>'rating')::numeric, 1), 5)
         FROM audit_log al
        WHERE al.object_type = 'deal'
          AND al.object_id = q.deal_id
          AND al.action IN ('deal.buyer_review', 'deal.close')
          AND jsonb_typeof(ap_jsonb_unwrap(al.payload_json)->'rating') = 'number'
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT 1),
      5
    ) / 10.0
  ), 0), 3))
  FROM reputation_evidence_deals q
  WHERE q.seller_agent_id = p_agent
$$;

-- Deals complete on more paths than the API routes that call
-- creditReputation() (buyer-signed on-chain release, the relayer daemon's
-- sweepers, operator tools). Whenever a deal enters or leaves 'completed', or
-- its integrity_class (quarantine) changes, recompute its seller from the
-- evidence so the stored score always equals ap_reputation_score().
CREATE OR REPLACE FUNCTION ap_deals_recompute_seller_reputation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents SET reputation_score = ap_reputation_score(id)
  WHERE id = NEW.seller_agent_id;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_recompute_seller_reputation ON deals;
CREATE TRIGGER trg_deals_recompute_seller_reputation
  AFTER UPDATE OF status, integrity_class ON deals
  FOR EACH ROW
  WHEN ((NEW.status = 'completed') IS DISTINCT FROM (OLD.status = 'completed')
        OR NEW.integrity_class IS DISTINCT FROM OLD.integrity_class)
  EXECUTE FUNCTION ap_deals_recompute_seller_reputation();

-- ── R1-05: recompute on every other event that changes the evidence ─────────
-- The deals trigger above sees status/quarantine changes only. Evidence also
-- changes when (a) a party's is_internal flag or owner wallet changes
-- (mark-internal, bulk-mark-internal, PATCH wallet — qualifying flips for every
-- deal the agent is party to), and (b) funding evidence arrives or changes after
-- completion (payment_intents status, settlement intents going on chain).
-- Each recomputes the affected sellers from ap_reputation_score(), so the
-- stored score never drifts from the derived one.
-- To stop: DROP TRIGGER IF EXISTS trg_agents_recompute_counterparty_reputation ON agents;
--          DROP TRIGGER IF EXISTS trg_payment_intents_recompute_seller_reputation ON payment_intents;
--          DROP TRIGGER IF EXISTS trg_intents_recompute_seller_reputation ON intents;
CREATE OR REPLACE FUNCTION ap_agents_recompute_counterparty_reputation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents a SET reputation_score = ap_reputation_score(a.id)
  WHERE a.id IN (
    SELECT d.seller_agent_id FROM deals d
    WHERE d.status = 'completed'
      AND (d.buyer_agent_id = NEW.id OR d.seller_agent_id = NEW.id)
  )
    AND a.reputation_score IS DISTINCT FROM ap_reputation_score(a.id);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_agents_recompute_counterparty_reputation ON agents;
CREATE TRIGGER trg_agents_recompute_counterparty_reputation
  AFTER UPDATE OF is_internal, owner_wallet_address ON agents
  FOR EACH ROW
  WHEN (NEW.is_internal IS DISTINCT FROM OLD.is_internal
        OR NEW.owner_wallet_address IS DISTINCT FROM OLD.owner_wallet_address)
  EXECUTE FUNCTION ap_agents_recompute_counterparty_reputation();

CREATE OR REPLACE FUNCTION ap_payment_intents_recompute_seller_reputation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_milestone UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.milestone_id ELSE NEW.milestone_id END;
BEGIN
  UPDATE agents a SET reputation_score = ap_reputation_score(a.id)
  FROM milestones m JOIN deals d ON d.id = m.deal_id
  WHERE m.id = v_milestone
    AND d.status = 'completed'
    AND a.id = d.seller_agent_id;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_intents_recompute_seller_reputation ON payment_intents;
CREATE TRIGGER trg_payment_intents_recompute_seller_reputation
  AFTER INSERT OR DELETE OR UPDATE OF status, milestone_id ON payment_intents
  FOR EACH ROW
  EXECUTE FUNCTION ap_payment_intents_recompute_seller_reputation();

CREATE OR REPLACE FUNCTION ap_intents_recompute_seller_reputation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents a SET reputation_score = ap_reputation_score(a.id)
  FROM deals d
  WHERE (d.intent_id = NEW.id OR d.id = NEW.deal_id)
    AND d.status = 'completed'
    AND a.id = d.seller_agent_id;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_intents_recompute_seller_reputation ON intents;
CREATE TRIGGER trg_intents_recompute_seller_reputation
  AFTER INSERT OR UPDATE OF status, on_chain_id, deal_id ON intents
  FOR EACH ROW
  EXECUTE FUNCTION ap_intents_recompute_seller_reputation();

UPDATE agents a
SET reputation_score = s.score
FROM (SELECT id, ap_reputation_score(id) AS score FROM agents) s
WHERE s.id = a.id
  AND a.reputation_score IS DISTINCT FROM s.score;
