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
--     LEAST(9.999, ROUND( SUM over d IN completed capital_at_risk deals
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
--
-- Idempotent: re-running re-snapshots nothing and recomputes the same values.

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
  FROM qualifying_deals q
  WHERE q.capital_at_risk
    AND q.status = 'completed'
    AND q.seller_agent_id = p_agent
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

UPDATE agents a
SET reputation_score = s.score
FROM (SELECT id, ap_reputation_score(id) AS score FROM agents) s
WHERE s.id = a.id
  AND a.reputation_score IS DISTINCT FROM s.score;
