-- Migration 012: Enable RLS on ALL public tables
-- CRITICAL: All 22 tables had RLS disabled, exposing data via PostgREST/anon key
-- The app uses direct PostgreSQL connection (service_role), which bypasses RLS.
-- These policies block ALL access via PostgREST anonymous/authenticated keys.

BEGIN;

-- Enable RLS on every public table
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.needs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_fulfillment ENABLE ROW LEVEL SECURITY;

-- With RLS enabled and NO policies, PostgREST anon/authenticated users get zero access.
-- The direct postgres connection (service_role / superuser) bypasses RLS automatically.

-- Optional: explicit deny-all policies for clarity (RLS with no policies already denies)
-- These are belt-and-suspenders for the most sensitive tables:

CREATE POLICY "deny_all_anon" ON public.credential_vault
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_all_anon" ON public.agent_credentials
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_all_anon" ON public.agent_webhooks
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_all_anon" ON public.credential_access_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_all_anon" ON public.payment_intents
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_all_anon" ON public.audit_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- Public read-only for marketplace browsing (offers, needs, agents, leaderboard)
-- These allow the web frontend to fetch listings without going through the API
CREATE POLICY "public_read_agents" ON public.agents
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "public_read_offers" ON public.offers
  FOR SELECT TO anon, authenticated USING (status = 'active');

CREATE POLICY "public_read_needs" ON public.needs
  FOR SELECT TO anon, authenticated USING (status = 'open');

CREATE POLICY "public_read_feedback" ON public.feedback
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;
