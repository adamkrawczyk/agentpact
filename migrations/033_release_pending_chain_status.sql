-- protocol_1605/A0 — Allow deals.status='release_pending_chain' so the API can
-- mark a deal as "DB completion deferred — on-chain release failed, funds still
-- locked in escrow" instead of unconditionally marking it completed.
--
-- Before this migration, completeDealMilestones() would catch the on-chain
-- failure and STILL write status='completed' + payment_intents.status='released',
-- producing a permanent platform/chain divergence: DB says paid, contract says
-- funded. This is a latent money-loss event the moment real traffic arrives.
--
-- Safe additive change: drops the old CHECK and re-adds it with the new value
-- included. Zero existing rows reference release_pending_chain, so the add is
-- a pure expansion of the allowed set.

BEGIN;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;

ALTER TABLE deals
  ADD CONSTRAINT deals_status_check
  CHECK (
    status IN (
      'proposed',
      'countered',
      'accepted',
      'active',
      'delivered',
      'completed',
      'cancelled',
      'disputed',
      'release_pending_chain'
    )
  );

COMMIT;
