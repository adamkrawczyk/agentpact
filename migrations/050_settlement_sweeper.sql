-- 050_settlement_sweeper.sql — moneypath_0920 M1.
--
-- WHY
-- `acceptanceTimeoutDays` is promised in the integration guide and implemented
-- in two admin routes (routes/admin.ts:466 auto-complete-timeouts,
-- routes/fulfillment.ts:777 the per-deal variant). NOTHING EVER CALLED THEM.
-- Measured on prod 2026-09-20: 21 deals sit in 'delivered' past their own
-- promised acceptance_timeout_days, and 271 proposals older than 14 days have
-- never expired. The mechanism was real and unscheduled.
--
-- This migration adds the two tables the in-process sweeper needs so its work
-- is auditable, plus the one column that makes "a stranger paid us" a
-- queryable fact rather than a story.
--
-- Three tables/columns, three distinct jobs:
--   sweeper_runs       — one row per tick. Proves the sweeper is ALIVE, which
--                        is a different question from whether it acted.
--   sweeper_decisions  — one row per deal considered. Carries the judge, the
--                        probability, and the rubric hash, so a release can be
--                        re-examined months later against the rubric that
--                        actually produced it.
--   platform_fee_ledger.payer_class
--                      — 'stranger' | 'fleet' | 'self'. 45 of 98 completed
--                        deals on prod today are self-deals (buyer = seller),
--                        and 74 of one month's deals came from a single
--                        anonymous bot dealing with itself for three hours.
--                        Without this column every revenue number we publish
--                        silently includes our own noise.

CREATE TABLE IF NOT EXISTS sweeper_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sweeper       text        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT NOW(),
  finished_at   timestamptz,
  scanned       integer     NOT NULL DEFAULT 0,
  acted         integer     NOT NULL DEFAULT 0,
  held          integer     NOT NULL DEFAULT 0,
  failed        integer     NOT NULL DEFAULT 0,
  -- An error string, not a boolean: "the tick failed" without the reason sends
  -- the next person to the logs, and the logs rotate.
  error         text
);

-- G1 asks "is the newest row younger than 2h", which is an ORDER BY ... LIMIT 1
-- on every tick of every sweeper. Descending index so that is an index-only
-- backwards scan rather than a growing sort.
CREATE INDEX IF NOT EXISTS idx_sweeper_runs_sweeper_started
  ON sweeper_runs (sweeper, started_at DESC);

CREATE TABLE IF NOT EXISTS sweeper_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid        REFERENCES sweeper_runs(id) ON DELETE SET NULL,
  deal_id       uuid        NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT NOW(),
  -- complete | review | hold | skip_self_deal | error
  outcome       text        NOT NULL,
  -- The judge identity INCLUDING its version. A receipt naming only "jev" is
  -- unauditable the moment the model moves; §9/F11 requires judge@version.
  judge         text,
  p             numeric(6,5),
  rubric_hash   text,
  reason        text,
  CONSTRAINT sweeper_decisions_p_range CHECK (p IS NULL OR (p >= 0 AND p <= 1))
);

CREATE INDEX IF NOT EXISTS idx_sweeper_decisions_decided_at
  ON sweeper_decisions (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_sweeper_decisions_deal
  ON sweeper_decisions (deal_id, decided_at DESC);

ALTER TABLE platform_fee_ledger
  ADD COLUMN IF NOT EXISTS payer_class text;

-- Deliberately NOT a NOT NULL with a default of 'stranger'. Backfilling an
-- unknown payer as a stranger would manufacture exactly the number this whole
-- cycle exists to earn honestly. Existing rows stay NULL = unclassified.
COMMENT ON COLUMN platform_fee_ledger.payer_class IS
  'stranger | fleet | self. NULL = classified by nothing (pre-050 rows). Never defaulted.';

CREATE INDEX IF NOT EXISTS idx_platform_fee_ledger_payer_class
  ON platform_fee_ledger (payer_class);
