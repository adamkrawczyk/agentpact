-- Migration: 036_subscriptions.sql
-- AgentPact Pro subscription tier
-- Issue: WIS-262 (AP-REV-1)
--
-- protocol_1605/A post-mortem (2026-05-16): originally shipped without
-- IF NOT EXISTS guards on indexes and without DROP TRIGGER IF EXISTS before
-- the trigger create. On production this was masked by an unconditional skip
-- of the migration runner (RUN_MIGRATIONS was never "true" on Railway), but
-- the moment Phase A turned migrations ON in production, this file rejected
-- application against the live DB (where subscriptions already existed from
-- a sibling project on the shared Supabase) and crashed boot. Idempotency
-- restored below; the migrations-idempotency.test.ts contract enforces it
-- for every future migration.

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('pro_monthly', 'pro_annual')),
    status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'past_due', 'canceled', 'expired')),
    period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    period_end TIMESTAMPTZ NOT NULL,
    trial_ends_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    stripe_subscription_id TEXT,
    stripe_customer_id TEXT,
    gmv_waiver_used_cents INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active subscription per agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_active
    ON subscriptions (agent_id)
    WHERE status IN ('trial', 'active');

-- Webhook lookup by Stripe ID
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_id
    ON subscriptions (stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

-- Fast lookup of agent's current subscription
CREATE INDEX IF NOT EXISTS idx_subscriptions_agent_id ON subscriptions (agent_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Idempotent trigger install: drop then re-create.
DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_subscriptions_updated_at();
