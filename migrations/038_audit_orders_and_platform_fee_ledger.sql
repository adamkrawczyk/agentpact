-- 038_audit_orders_and_platform_fee_ledger.sql
-- levels_2505 Day 0 — dedicated audit-order vertical, decoupled from agent-to-agent deals.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  buyer_email TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  contract_chain TEXT NOT NULL DEFAULT 'base',
  notes TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','in_progress','completed','failed','refunded')),
  report_md TEXT,
  report_severity_counts JSONB,
  report_verdict TEXT CHECK (report_verdict IS NULL OR report_verdict IN ('PASS','CONDITIONAL','FAIL')),
  failure_reason TEXT,
  picked_up_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_orders_status ON audit_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_orders_buyer_email ON audit_orders(buyer_email);

CREATE TABLE IF NOT EXISTS platform_fee_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_order_id UUID REFERENCES audit_orders(id),
  deal_id UUID REFERENCES deals(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  fee_pct_at_close NUMERIC(5,2) NOT NULL,
  credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL CHECK (source IN ('stripe','usdc','manual')),
  stripe_payment_intent_id TEXT,
  CONSTRAINT platform_fee_ledger_one_source CHECK (
    (audit_order_id IS NOT NULL)::int + (deal_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT platform_fee_ledger_unique_audit_order UNIQUE (audit_order_id),
  CONSTRAINT platform_fee_ledger_unique_deal UNIQUE (deal_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_fee_ledger_credited_at ON platform_fee_ledger(credited_at DESC);

COMMIT;
