-- 055_telemetry.sql — honest_0710 phase D: telemetry that actually writes.
--
-- 1. api_usage (created in 002_auth.sql, never written until now) gets the
--    columns + indexes the writer in apps/api/src/plugins/telemetry.ts and the
--    report in GET /api/admin/usage need, plus a retention function.
--    Privacy: no IP, no raw user-agent — only a coarse client_kind.
-- 2. funnel_events, written ONLY by the triggers below (no route writes it).
--    Stages: need_posted → proposed → accepted → funded → delivered →
--    accepted_delivery | disputed → settled | refunded, plus reorder.
--    Each stage is recorded at most once per deal (once per need for
--    need_posted), enforced by unique indexes + ON CONFLICT DO NOTHING, so a
--    stage reached through several tables (deal status, milestone,
--    payment_intent, on-chain intent) still counts once.
--    Triggers run only when status actually changes and never fail the
--    parent write: any error is downgraded to a WARNING.
--
-- Additive and idempotent. No existing column or row is modified.

-- ── 1. api_usage ────────────────────────────────────────────────────────
ALTER TABLE api_usage ADD COLUMN IF NOT EXISTS client_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage (created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint_created_at ON api_usage (endpoint, created_at);

-- Retention. Callable from the relayer or a cron: SELECT prune_api_usage();
-- Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION prune_api_usage(days INT DEFAULT 90) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  deleted BIGINT;
BEGIN
  IF days IS NULL OR days < 1 THEN
    RAISE EXCEPTION 'prune_api_usage: days must be >= 1 (got %)', days;
  END IF;
  DELETE FROM api_usage WHERE created_at < NOW() - make_interval(days => days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;

-- ── 2. funnel_events ────────────────────────────────────────────────────
-- No foreign keys on purpose: an event is a historical fact, and a trigger on
-- a hot table must not take extra row locks on agents/deals/needs.
CREATE TABLE IF NOT EXISTS funnel_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage                 TEXT NOT NULL CHECK (stage IN (
                          'need_posted','proposed','accepted','funded','delivered',
                          'accepted_delivery','disputed','settled','refunded','reorder')),
  deal_id               UUID,
  need_id               UUID,
  agent_id              UUID,   -- buyer for deal stages, poster for need_posted
  counterparty_agent_id UUID,   -- seller for deal stages
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_funnel_events_occurred_at ON funnel_events (occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_events_deal_stage
  ON funnel_events (stage, deal_id) WHERE deal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_events_need_posted
  ON funnel_events (need_id) WHERE stage = 'need_posted';

-- Keeps the reorder lookup in the deals INSERT trigger an index probe.
CREATE INDEX IF NOT EXISTS idx_deals_completed_pair
  ON deals (buyer_agent_id, seller_agent_id) WHERE status = 'completed';

-- Record a deal-level stage. Looks the deal up by primary key (one probe).
CREATE OR REPLACE FUNCTION ap_funnel_record_deal(p_stage TEXT, p_deal_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_deal_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO funnel_events (stage, deal_id, need_id, agent_id, counterparty_agent_id)
  SELECT p_stage, d.id, d.need_id, d.buyer_agent_id, d.seller_agent_id
  FROM deals d WHERE d.id = p_deal_id
  ON CONFLICT DO NOTHING;
END
$$;

-- deals.status → stages. 'completed' means the buyer accepted and the deal
-- settled (legacy release, intent claim and $0 completion all land here);
-- 'release_pending_chain' means accepted but the on-chain release is pending.
CREATE OR REPLACE FUNCTION ap_funnel_deal_stages(p_status TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'accepted'              THEN ARRAY['accepted']
    WHEN 'active'                THEN ARRAY['accepted']
    WHEN 'funded'                THEN ARRAY['funded']
    WHEN 'delivered'             THEN ARRAY['delivered']
    WHEN 'release_pending_chain' THEN ARRAY['accepted_delivery']
    WHEN 'completed'             THEN ARRAY['accepted_delivery','settled']
    WHEN 'disputed'              THEN ARRAY['disputed']
    ELSE ARRAY[]::TEXT[]
  END
$$;

CREATE OR REPLACE FUNCTION ap_funnel_on_deal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  s TEXT;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO funnel_events (stage, deal_id, need_id, agent_id, counterparty_agent_id)
      VALUES ('proposed', NEW.id, NEW.need_id, NEW.buyer_agent_id, NEW.seller_agent_id)
      ON CONFLICT DO NOTHING;
      IF EXISTS (
        SELECT 1 FROM deals p
        WHERE p.buyer_agent_id = NEW.buyer_agent_id
          AND p.seller_agent_id = NEW.seller_agent_id
          AND p.status = 'completed'
          AND p.id <> NEW.id
      ) THEN
        INSERT INTO funnel_events (stage, deal_id, need_id, agent_id, counterparty_agent_id)
        VALUES ('reorder', NEW.id, NEW.need_id, NEW.buyer_agent_id, NEW.seller_agent_id)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
    FOREACH s IN ARRAY ap_funnel_deal_stages(NEW.status) LOOP
      INSERT INTO funnel_events (stage, deal_id, need_id, agent_id, counterparty_agent_id)
      VALUES (s, NEW.id, NEW.need_id, NEW.buyer_agent_id, NEW.seller_agent_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'funnel_events (deals %): % [%]', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION ap_funnel_on_need() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO funnel_events (stage, need_id, agent_id)
    VALUES ('need_posted', NEW.id, NEW.agent_id)
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'funnel_events (needs %): % [%]', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END
$$;

-- milestones.status → stages.
CREATE OR REPLACE FUNCTION ap_funnel_on_milestone() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  s TEXT := CASE NEW.status
    WHEN 'funded'    THEN 'funded'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'accepted'  THEN 'accepted_delivery'
    WHEN 'disputed'  THEN 'disputed'
  END;
BEGIN
  IF s IS NOT NULL THEN
    BEGIN
      PERFORM ap_funnel_record_deal(s, NEW.deal_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funnel_events (milestones %): % [%]', NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END
$$;

-- payment_intents.status → stages (the legacy escrow money path).
-- A payment intent belongs to ONE milestone, so 'released' settles the DEAL
-- only when every milestone of the deal has a released payment intent; a
-- partial release (sibling milestone unfunded or unreleased) records nothing
-- and the deal is settled later — by its last release or by deals.status
-- reaching 'completed' (R1-08).
CREATE OR REPLACE FUNCTION ap_funnel_on_payment_intent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_deal UUID;
  s TEXT := CASE NEW.status
    WHEN 'funded'   THEN 'funded'
    WHEN 'released' THEN 'settled'
    WHEN 'refunded' THEN 'refunded'
    WHEN 'disputed' THEN 'disputed'
  END;
BEGIN
  IF s IS NOT NULL THEN
    BEGIN
      SELECT m.deal_id INTO v_deal FROM milestones m WHERE m.id = NEW.milestone_id;
      IF s = 'settled' AND EXISTS (
        SELECT 1 FROM milestones m
        WHERE m.deal_id = v_deal
          AND NOT EXISTS (
            SELECT 1 FROM payment_intents p
            WHERE p.milestone_id = m.id AND p.status = 'released'
          )
      ) THEN
        s := NULL;
      END IF;
      IF s IS NOT NULL THEN
        PERFORM ap_funnel_record_deal(s, v_deal);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funnel_events (payment_intents %): % [%]', NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END
$$;

-- intents.status → stages (the on-chain v2 path; only intents bound to a deal).
-- 'open' is the first status of an intent that exists on chain (created
-- directly on chain, or flipped from 'awaiting_funding' after the relayer's
-- broadcast), i.e. funded. 'claimed' is the seller claim = settled.
CREATE OR REPLACE FUNCTION ap_funnel_on_intent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  s TEXT := CASE NEW.status
    WHEN 'open'      THEN 'funded'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'claimed'   THEN 'settled'
    WHEN 'refunded'  THEN 'refunded'
  END;
BEGIN
  IF s IS NOT NULL AND NEW.deal_id IS NOT NULL THEN
    BEGIN
      PERFORM ap_funnel_record_deal(s, NEW.deal_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funnel_events (intents %): % [%]', NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_funnel_needs_insert ON needs;
CREATE TRIGGER trg_funnel_needs_insert AFTER INSERT ON needs
  FOR EACH ROW EXECUTE FUNCTION ap_funnel_on_need();

DROP TRIGGER IF EXISTS trg_funnel_deals_insert ON deals;
CREATE TRIGGER trg_funnel_deals_insert AFTER INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION ap_funnel_on_deal();
DROP TRIGGER IF EXISTS trg_funnel_deals_status ON deals;
CREATE TRIGGER trg_funnel_deals_status AFTER UPDATE OF status ON deals
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION ap_funnel_on_deal();

DROP TRIGGER IF EXISTS trg_funnel_milestones_insert ON milestones;
CREATE TRIGGER trg_funnel_milestones_insert AFTER INSERT ON milestones
  FOR EACH ROW EXECUTE FUNCTION ap_funnel_on_milestone();
DROP TRIGGER IF EXISTS trg_funnel_milestones_status ON milestones;
CREATE TRIGGER trg_funnel_milestones_status AFTER UPDATE OF status ON milestones
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION ap_funnel_on_milestone();

DROP TRIGGER IF EXISTS trg_funnel_payment_intents_insert ON payment_intents;
CREATE TRIGGER trg_funnel_payment_intents_insert AFTER INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION ap_funnel_on_payment_intent();
DROP TRIGGER IF EXISTS trg_funnel_payment_intents_status ON payment_intents;
CREATE TRIGGER trg_funnel_payment_intents_status AFTER UPDATE OF status ON payment_intents
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION ap_funnel_on_payment_intent();

DROP TRIGGER IF EXISTS trg_funnel_intents_insert ON intents;
CREATE TRIGGER trg_funnel_intents_insert AFTER INSERT ON intents
  FOR EACH ROW EXECUTE FUNCTION ap_funnel_on_intent();
DROP TRIGGER IF EXISTS trg_funnel_intents_status ON intents;
CREATE TRIGGER trg_funnel_intents_status AFTER UPDATE OF status, deal_id ON intents
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.deal_id IS DISTINCT FROM NEW.deal_id)
  EXECUTE FUNCTION ap_funnel_on_intent();
