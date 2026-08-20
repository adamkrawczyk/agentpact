-- 046_funding_auth_updated_at.sql
--
-- Fix: the relayer's autoclose-sweeper (apps/relayer-daemon/src/autoclose-sweeper.ts)
-- reads `ORDER BY i.updated_at` and writes `updated_at = NOW()` on the
-- intent_funding_authorizations table when it consumes a funding authorization
-- and again on the claim leg. But migration 045 created that table WITHOUT an
-- updated_at column, so every gasless CLAIM leg failed with:
--   column "updated_at" of relation "intent_funding_authorizations" does not exist
--
-- This blocked the gasless settlement path end-to-end (FUND succeeded on-chain,
-- but the relayer could never record the claim). Add the column with a sane
-- default so existing rows backfill and the sweeper's UPDATE ... updated_at = NOW()
-- and ORDER BY updated_at both work.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE intent_funding_authorizations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
