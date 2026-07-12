-- 041: Protective review window by default
-- The previous default (0, set in 013) auto-completed deals the moment the
-- seller marked fulfillment — the buyer never got a review window unless they
-- explicitly opted in to one at proposal time. For buyer-verifies-work flows
-- that inverts the protection: funds release BEFORE review.
--
-- New default: 1 day (24h review window). 0 (instant auto-complete) remains
-- fully supported as an explicit opt-in at proposal time.
-- Existing rows are NOT modified: deals already proposed keep whatever window
-- the parties agreed to.

ALTER TABLE deals ALTER COLUMN acceptance_timeout_days SET DEFAULT 1;
