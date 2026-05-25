# `levels_2505` Day 0 wire contract (LOCKED)

> Every subagent MUST treat this file as immutable. If something here is wrong, STOP and report — DO NOT improvise a divergent wire format.
> Version: 1. Sealed 2026-05-25 by Tori. Echoes plan-doc `2026-05-25-levels-2505-execution-plan.md` with recon-driven evolutions.

## Codebase reality (verified 2026-05-25)

- Monorepo: `apps/api/` (Fastify + postgres.js, NOT packages/api), `apps/web/` (Vite+React), `apps/mcp/`, `apps/daemon/` (customer-side, NOT touched in this sprint).
- Migrations live in `~/agentpact/migrations/` (repo-root, NOT `apps/api/migrations` — `scripts/migrate.ts` uses `resolve(process.cwd(), "migrations")`).
- Last applied migration filename: `037_payment_intents_stripe_and_refund_status.sql`. We ship `038_audit_orders_and_platform_fee_ledger.sql`.
- Existing `apps/api/src/stripe.ts` is a stub. `constructWebhookEvent` and the real `createPaymentIntent` both throw "not yet implemented". This sprint replaces both with real Stripe SDK calls.
- Existing webhook route `/api/payments/stripe-webhook` (payments.ts:511) handles `payment_intent.succeeded` for milestone funding. WE DO NOT TOUCH IT. Audit flow uses a NEW endpoint at a NEW path.
- `deals` table status check is `created|funded|released|refunded|disputed|failed`. Audit flow does NOT use the `deals` table — it uses a dedicated `audit_orders` table (cleaner, zero blast radius).

## Architecture (final, Pieter-clean)

```
agentpact.xyz/audit  →  Stripe Checkout Link  →  Stripe webhook
       ↓
  POST /api/audit/webhook/stripe (NEW, public, sig-verified)
       ↓
  INSERT audit_orders (status='paid', stripe_session_id, buyer_email, contract_address, amount_cents=500)
       ↓
  Discord ping to ${DISCORD_WEBHOOK_AGENTPACT_ORDERS or DISCORD_WEBHOOK_TORI}
       ↓
  agentpact-fulfillment daemon (NEW, separate Railway service) ticks every 60s
       ↓
  GET /api/audit/orders?status=paid&limit=10  (admin-auth, ADMIN_API_KEY header)
       ↓
  for each: call audit-runner-cli (slither + Claude) → produces {report_md, severity_counts, verdict}
       ↓
  POST /api/audit/orders/:id/report  (admin-auth, ADMIN_API_KEY header)
       ↓
  - inserts platform_fee_ledger row (fee = 10% of amount = 50 cents)
  - sends email to buyer via gws (fallback Resend)
  - flips audit_orders.status='completed'
       ↓
  Daemon marks deal handled in its local state.json
```

## DB contract — `038_audit_orders_and_platform_fee_ledger.sql`

```sql
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
```

## Route contract

### `POST /api/audit/webhook/stripe` (NEW, public, Stripe sig-verified)

- **File:** `apps/api/src/routes/audit-webhook.ts` (NEW)
- **rawBody:** required (Fastify `config: { rawBody: true }`)
- **Header:** `stripe-signature` required → 400 if missing
- **Env:** `STRIPE_WEBHOOK_SECRET_AUDIT` (DISTINCT from `STRIPE_WEBHOOK_SECRET` used by /api/payments/stripe-webhook — two webhook endpoints, two secrets, NO MIXING)
- **Event handled:** `checkout.session.completed` only. Any other event_type → 200 ok no-op.
- **Idempotency:** `INSERT ... ON CONFLICT (stripe_session_id) DO NOTHING`. Returns the order_id either way.
- **Body shape from Stripe:**
  - `data.object.id` → `stripe_session_id`
  - `data.object.payment_intent` → `stripe_payment_intent_id`
  - `data.object.customer_details.email` OR `data.object.customer_email` → `buyer_email`
  - `data.object.custom_fields[]` → find `key === "contract_address"` → `contract_address`; find `key === "notes"` → `notes`
  - `data.object.amount_total` (in cents) → `amount_cents`
  - `data.object.currency` → uppercased → `currency`
- **On insert success:** post Discord webhook to `process.env.DISCORD_WEBHOOK_AGENTPACT_ORDERS ?? process.env.DISCORD_WEBHOOK_TORI` with formatted summary (failures non-fatal, log & continue).
- **Response:** `200 { received: true, order_id: "<uuid>" }` ALWAYS on valid sig (even no-op events).
- **Errors:** 400 sig-missing/sig-invalid; 500 db-error.

### `POST /api/audit/orders/:id/report` (NEW, admin-auth)

- **File:** `apps/api/src/routes/audit-orders.ts` (NEW)
- **Auth:** `x-admin-api-key` header MUST equal `process.env.ADMIN_API_KEY`. If missing/mismatch → 401.
- **Body schema (zod-validated):**
  ```ts
  {
    report_md: string (1..200_000 chars),
    severity_counts: { high: int>=0, medium: int>=0, low: int>=0, info: int>=0 },
    verdict: "PASS" | "CONDITIONAL" | "FAIL",
    deliverable_url: string (url, optional),
    failure_reason: string (optional — only set if verdict===FAIL or runner blew up)
  }
  ```
- **Behavior (transactional):**
  1. SELECT FOR UPDATE the audit_orders row by :id. 404 if not found, 409 if status already `completed`/`refunded`.
  2. UPDATE audit_orders SET status='completed' (or 'failed' if `failure_reason` is set AND verdict===FAIL), report_md, report_severity_counts, report_verdict, completed_at=NOW(), updated_at=NOW().
  3. If status set to 'completed': INSERT platform_fee_ledger (audit_order_id, amount_minor = floor(amount_cents * 0.10), currency, fee_pct_at_close=10.00, source='stripe', stripe_payment_intent_id) ON CONFLICT DO NOTHING (idempotent).
  4. Send email to buyer_email via email helper (see below). Capture `email_sent_at=NOW()` on success.
  5. Return `200 { ok: true, order_id, status, fee_credited_minor }`.
- **Side effects:** Discord ping to `#agentpact-orders` (or fallback) on completion: `✅ Order ${id} delivered — $${amount_cents/100} → fee $${amount_cents*0.10/100}`.

### `GET /api/audit/orders` (NEW, admin-auth, daemon polls this)

- **File:** `apps/api/src/routes/audit-orders.ts`
- **Auth:** `x-admin-api-key` header.
- **Query params:** `status` (one of statuses, default paid), `limit` (int 1..50, default 10).
- **Behavior:**
  - SELECT id, stripe_session_id, buyer_email, contract_address, contract_chain, notes, amount_cents, currency, status, created_at FROM audit_orders WHERE status = $status ORDER BY created_at ASC LIMIT $limit.
  - Returns `{ orders: [...] }`.

### `PATCH /api/audit/orders/:id/claim` (NEW, admin-auth)

- **File:** `apps/api/src/routes/audit-orders.ts`
- **Purpose:** Daemon marks a paid order as in_progress to prevent duplicate pickup.
- **Behavior:** Atomic `UPDATE audit_orders SET status='in_progress', picked_up_at=NOW(), updated_at=NOW() WHERE id=$id AND status='paid' RETURNING *`. Returns 200 with order on success, 409 if row not updated (already picked up by another worker).

## Email helper

- **File:** `apps/api/src/services/email.ts` (NEW).
- **Primary:** `gws` CLI (Adam's Google Workspace bridge). Adam confirmed `/home/adam/.npm-global/bin/gws` exists.
- **Fallback:** if `gws` exits non-zero OR `RESEND_API_KEY` env present and `EMAIL_PROVIDER=resend`, use Resend HTTP API (POST https://api.resend.com/emails).
- **From:** `audits@agentpact.xyz` (gws sends from Adam's domain alias; Resend uses verified domain).
- **Subject:** `Your AgentPact audit for ${contract_address.slice(0,10)}...`
- **Body:** the `report_md` rendered to plain text + a polite header + a tagline footer.
- **Returns:** `{ ok: boolean, provider: 'gws'|'resend', message_id?: string, error?: string }`.

## Fulfillment-daemon contract

- **Location:** `apps/fulfillment-daemon/` (NEW workspace — sibling to `apps/daemon/`, separate package `@agentpact/fulfillment-daemon`).
- **Entry:** `node apps/fulfillment-daemon/dist/index.js`.
- **Env vars:** `AGENTPACT_API_URL` (e.g. `https://api.agentpact.xyz`), `ADMIN_API_KEY` (REQUIRED — same key audit endpoints check), `AUDIT_RUNNER_CLI_PATH` (default `./scripts/audit-runner-cli.ts`), `FULFILLMENT_TICK_SECONDS` (default 60), `LOG_LEVEL` (default `info`), `DRY_RUN` (default false).
- **Tick loop:**
  1. Log heartbeat (`heartbeat fulfillment-daemon tick=N orders_in_progress=K`).
  2. GET `${AGENTPACT_API_URL}/api/audit/orders?status=paid&limit=10` with `x-admin-api-key`.
  3. For each order:
     - PATCH `${API}/api/audit/orders/${id}/claim` to mark in_progress. If 409, skip (another worker claimed).
     - Run `audit-runner-cli ${contract_address} ${buyer_email} ${id}` via child_process. 10-minute hard timeout.
     - On stdout JSON success → POST `/api/audit/orders/:id/report` with the runner's output.
     - On timeout/crash/non-zero exit → POST `/api/audit/orders/:id/report` with `verdict: "FAIL"`, `failure_reason: <message>`, `severity_counts: {high:0,medium:0,low:0,info:0}`, `report_md: "Audit could not be completed. <reason>. Your $5 has been refunded automatically. Reply to this email if you need help."`.
       → AND attempt Stripe refund via Stripe SDK `stripe.refunds.create({payment_intent: stripe_payment_intent_id})` (admin endpoint exposes a `POST /api/audit/orders/:id/refund` helper for this — see below).
- **State file:** `state.json` under `process.env.HOME/.agentpact-fulfillment/state.json` — tracks last-N processed order ids for idempotency.
- **Heartbeat:** structured log every tick.
- **Tests required (≥10):** picks up new paid orders; respects 409 claim conflict (parallel-safe); reports correct fee; retries on transient API failure; marks failed gracefully on runner timeout; idempotent within a single tick (does not double-claim).

### `POST /api/audit/orders/:id/refund` (NEW, admin-auth)

- **Purpose:** Daemon-invoked refund path when audit-runner fails. Calls Stripe `refunds.create`, flips status to `refunded`.
- **Body:** `{ reason: string }`.
- **Idempotent:** if status already `refunded`, returns 200 with existing refund record.

## Slither + Claude runner CLI

- **File:** `scripts/audit-runner-cli.ts` (NEW; standalone executable via `npx tsx`).
- **Usage:** `npx tsx scripts/audit-runner-cli.ts <contract_address> <buyer_email> <order_id> [--dry-run]`.
- **Steps:**
  1. Fetch verified source from BaseScan v2 API (`https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getsourcecode&address=<addr>&apikey=${BASESCAN_API_KEY}`). If not verified → `{verdict:"FAIL", failure_reason:"contract not verified on BaseScan"}`.
  2. Write flattened source to `/tmp/audit-<order_id>.sol`.
  3. Run `slither /tmp/audit-<order_id>.sol --json /tmp/audit-<order_id>.json --no-fail-pedantic`. Parse JSON.
  4. Count findings by impact: High → high; Medium → medium; Low → low; Informational/Optimization → info.
  5. Call Claude Sonnet via Anthropic SDK with prompt: *"Summarize this Slither JSON as a markdown audit report. Categorize findings by 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW / ℹ️ INFO. End with one-line verdict (PASS / CONDITIONAL / FAIL). PASS = 0 high, 0 medium. CONDITIONAL = 0 high, any medium. FAIL = ≥1 high."*. Model: `claude-sonnet-4-6` (or whatever `ANTHROPIC_MODEL` env says; default to `claude-sonnet-4-6`).
  6. Hard timeout: 600 seconds wall clock for the WHOLE script. SIGKILL slither after 480s if not done.
  7. Output to stdout: single-line JSON `{report_md, severity_counts: {high,medium,low,info}, verdict, raw_slither_path}`.
- **Env required:** `BASESCAN_API_KEY` (Adam's existing v2-multi-chain key), `ANTHROPIC_API_KEY` (Tori — IMPORTANT: in production Railway, this will be Adam's separate audit-budget key, NOT a Tori-personality OAuth token; daemon job is `no_agent=False` only for cron drafts, NOT for runner).
- **Tests (≥6):** verified-contract happy path against USDC-Base; unverified contract returns FAIL; slither timeout returns FAIL with reason; severity bucketing correct against fixture JSON; verdict mapping correct (0/0 = PASS, 0/2 = CONDITIONAL, 2/0 = FAIL).

## Landing page (apps/web)

- **Files:** `apps/web/src/routes/audit.tsx`, `apps/web/src/routes/audit-thank-you.tsx`.
- **Routing:** register both in existing router. Public, no auth.
- **/audit content:**
  - H1: `Smart-Contract Audit. $5. 60 minutes.`
  - Subhead: `Drop a Base mainnet contract address. Get a Slither + Claude audit in your inbox in 60 minutes. We take 10%.`
  - CTA button → href = `${STRIPE_AUDIT_PAYMENT_LINK}` (Adam pastes after Step 6). Until then, button is `data-stripe-link` placeholder.
  - Sections (≤5 components total, no heavy deps): What you get / Why us / The deal.
  - Footer: `Escrow contract: <baseScan-verified link>`. Footer also: `If your audit doesn't arrive in 60 min, mail adam@agentpact.xyz — full refund, no questions.`
  - Lighthouse: target mobile ≥85.
- **/audit-thank-you content:** `🎉 Order received. Your audit will arrive within 60 minutes.`

## Hardcoded identifier audit (grep-verified pre-seal)

- Migration filename `038_audit_orders_and_platform_fee_ledger.sql` — `ls migrations/038*` returns nothing. ✅ safe.
- Route path `/api/audit/webhook/stripe` — `grep "audit/webhook" apps/` returns nothing. ✅ safe.
- Route path `/api/audit/orders` — `grep "audit/orders" apps/` returns nothing. ✅ safe.
- Workspace name `@agentpact/fulfillment-daemon` — `grep fulfillment-daemon package.json apps/*/package.json` returns nothing. ✅ safe.
- Env var `STRIPE_WEBHOOK_SECRET_AUDIT` — `grep STRIPE_WEBHOOK_SECRET_AUDIT .` returns nothing. ✅ safe.
- Env var `DISCORD_WEBHOOK_AGENTPACT_ORDERS` — `grep DISCORD_WEBHOOK_AGENTPACT .` returns nothing. ✅ safe.
- Table names `audit_orders`, `platform_fee_ledger` — `grep "CREATE TABLE.*audit_orders\|CREATE TABLE.*platform_fee_ledger" migrations/ apps/` returns nothing. ✅ safe.

## NPM dependencies to add

- `apps/api/`: `stripe` (latest 4.x). `resend` (optional; only if Resend fallback wired). Both as deps, not devDeps.
- `apps/fulfillment-daemon/`: `node-fetch` (or use native `fetch` if Node 20+ confirmed), `zod`. Mirror `apps/daemon/`'s tsconfig + package.json structure.

## Commit/PR discipline

- Branch per subagent, branched from `origin/main` (at `a2b527e`):
  - `feat/levels_2505-api-audit-vertical`
  - `feat/levels_2505-fulfillment-daemon`
  - `feat/levels_2505-runner-cli-and-web`
- Each PR title: `[levels_2505] <scope>` + WIS-tag if applicable.
- Every PR closes with the §0.5 audit block from plan-doc.
- Squash-merge via `gh pr merge <n> --admin --squash --delete-branch` once `npm run build` + `npm run test` + `bash scripts/lint-routes.sh` all green (per repo AGENTS.md hard gate).

## Acceptance gates (Day 0 SHIP)

| # | Gate | How verified |
|---|------|--------------|
| 1 | Migration applied | `psql -c "SELECT 1 FROM information_schema.tables WHERE table_name='audit_orders'"` returns 1 |
| 2 | Stripe SDK installed + sig-verify works | Stripe Dashboard "Send test webhook" to `/api/audit/webhook/stripe` reaches Discord |
| 3 | Runner CLI green vs USDC-Base | `npx tsx scripts/audit-runner-cli.ts 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 test@example.com test-id --dry-run` produces valid JSON |
| 4 | Fulfillment-daemon Railway-deployed | `railway logs --service agentpact-fulfillment --tail 50 \| grep heartbeat` returns ≥1 line |
| 5 | Landing live | `curl -sI https://agentpact.xyz/audit` returns 200; H1 in body |
| 6 | Stripe Payment Link live | Adam confirms in Stripe Dashboard |
| 7 | Marketing cron registered | `hermes cron list \| grep agentpact-marketing-drafts` returns 1 |
| 8 | Self-deal end-to-end | `SELECT * FROM platform_fee_ledger ORDER BY credited_at DESC LIMIT 1` returns a row with amount_minor=50, source='stripe' |
| 9 | Day 1 drafts pre-loaded | `~/obsidian-vault/projects/agentpact/levels_2505-day-1-drafts.md` exists, non-empty |

---

Sealed. Subagents start here.
