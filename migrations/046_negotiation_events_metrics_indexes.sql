-- Index negotiation_events for the admin dead-intent-sweep metrics.
--
-- Added 2026-08-18 after an adversarial review (Codex gpt-5.6-sol) observed
-- that the new /api/admin/metrics dead-intent-sweep aggregates each scan
-- negotiation_events with NO supporting index: the table is created in
-- 001_init.sql:95 and the index list at 001_init.sql:182 contains no
-- negotiation-event entry. negotiation_events is an append-only audit table,
-- so it grows without bound and every admin-metrics request would perform
-- two full sequential scans plus JSON normalization.
--
-- Both new aggregates filter on event_type = 'cancel' and bound created_at,
-- so a composite (event_type, created_at) index serves both. Partial on
-- 'cancel' keeps it small: the sweep metrics only ever look at cancels, and
-- cancels are a minority of all negotiation events.
CREATE INDEX IF NOT EXISTS idx_negotiation_events_cancel_created_at
  ON negotiation_events (created_at)
  WHERE event_type = 'cancel';

-- General-purpose companion for non-cancel event-type lookups (deal timeline
-- rendering, audit queries) so this table is not left entirely unindexed.
CREATE INDEX IF NOT EXISTS idx_negotiation_events_deal_created_at
  ON negotiation_events (deal_id, created_at DESC);
