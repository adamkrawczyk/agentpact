// apps/relayer-daemon/src/proposal-expiry-sweeper.ts — moneypath M1 remainder
//
// THE BUG THIS CLOSES
// POST /api/admin/expire-stale-proposals (routes/admin.ts) cancels proposals
// whose acceptance deadline has passed. It exists, it is tested, and — like
// the two auto-complete routes before #146 — NOTHING EVER CALLED IT.
//
// Measured on production 2026-09-22: 271 deals in status proposed/countered
// with created_at older than 14 days, none of them ever expired. Every one
// is a seller that can still "accept" an offer the buyer forgot about weeks
// ago. This file is the schedule the route never had.
//
// WHY IT CALLS THE HTTP ROUTE INSTEAD OF DOING THE WORK
// Same reason as settlement-sweeper.ts: the route is the single source of
// truth for the cancel transition (status CAS, milestone cascade,
// negotiation_events row, deal.cancelled notification to both parties). The
// daemon cannot import from apps/api (tsconfig rootDir:"src"), so the only
// way to do it here would be to COPY it, and a copied transition drifts the
// first time either side is patched. So:
//   this file  — WHEN to sweep, and a receipt in sweeper_runs that it did
//   the API    — WHAT gets cancelled and how, unchanged, single-sourced
//
// ELIGIBILITY IS MIRRORED, NEVER LOOSENED
// The daemon's own SELECT below uses the SAME predicate as the route
// (status IN ('proposed','countered') AND expires_at IS NOT NULL AND
// expires_at < NOW()). It is used ONLY to fill `scanned` in the run row so
// "the sweeper saw N stale proposals and the route expired M" stays a
// checkable pair. The daemon never decides per-deal; the route does.
//
// THE LEGACY GAP IS REPORTED, NOT PAPERED OVER
// Proposals created before issue #90 landed have expires_at = NULL and the
// route — correctly — will not touch them: NULL is not "past". They are
// counted here as `held` (proposed/countered, expires_at IS NULL, created_at
// older than PROPOSAL_EXPIRY_DAYS) so the number is visible on every tick
// without this sweeper inventing a deadline the buyer never agreed to.
// Backfilling those rows is a separate, deliberate operator act.

import type { SqlClient } from "./sweepers.js";

export interface ProposalExpirySweeperConfig {
  apiBaseUrl: string;
  adminApiKey?: string;
  /** Legacy-gap window: proposals with NULL expires_at older than this are counted as held. */
  expiryDays: number;
  /** Hard cap on the route call — see settlement-sweeper.ts for why it is mandatory. */
  apiTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ProposalExpirySweepResult {
  runId: string | null;
  /** Deals matching the route's own eligibility predicate at tick start. */
  scanned: number;
  /** Deals the route reported `expired: true`. */
  acted: number;
  /** Legacy proposals (NULL expires_at) past the window — visible, not touched. */
  held: number;
  /** Route results with expired:false + error, or the route call itself failing (counted as 1). */
  failed: number;
  reason: string | null;
}

interface RouteResult {
  dealId: string;
  expired: boolean;
  reason?: string;
  error?: string;
}

export async function runProposalExpirySweep(
  sql: SqlClient,
  cfg: ProposalExpirySweeperConfig,
): Promise<ProposalExpirySweepResult> {
  const now = cfg.now ?? (() => new Date());
  const doFetch = cfg.fetchImpl ?? fetch;
  const result: ProposalExpirySweepResult = {
    runId: null, scanned: 0, acted: 0, held: 0, failed: 0, reason: null,
  };

  // Open the run row FIRST so a crashed tick leaves a null finished_at row
  // behind instead of vanishing (same contract as the settlement sweeper).
  const [run] = await sql<{ id: string }>`
    INSERT INTO sweeper_runs (sweeper, started_at) VALUES ('proposal_expiry', ${now()})
    RETURNING id
  `;
  const runId = run?.id ?? null;
  result.runId = runId;

  try {
    // MIRROR of routes/admin.ts expire-stale-proposals. If this ever selects
    // a deal the route would not, the run row lies about `scanned`; if it
    // selects fewer, it under-reports. Keep the two predicates identical.
    const [counts] = await sql<{ eligible: string | number; legacy: string | number }>`
      SELECT
        COUNT(*) FILTER (
          WHERE expires_at IS NOT NULL AND expires_at < ${now()}::timestamptz
        ) AS eligible,
        COUNT(*) FILTER (
          WHERE expires_at IS NULL
            AND created_at < ${now()}::timestamptz - (${cfg.expiryDays} || ' days')::interval
        ) AS legacy
      FROM deals
      WHERE status IN ('proposed', 'countered')
    `;
    result.scanned = Number(counts?.eligible ?? 0);
    result.held = Number(counts?.legacy ?? 0);

    // Call the route even when scanned = 0: the route is the authority and the
    // counting query above is a mirror, not a gate. A mirror that gates would
    // silently mask a predicate drift as "nothing to do".
    const route = await expireViaApi(cfg, doFetch);
    if (!route.ok) {
      result.failed = 1;
      result.reason = route.reason;
    } else {
      for (const r of route.results) {
        if (r.expired) result.acted++;
        else if (r.error) result.failed++;
        // expired:false with `reason` = lost a race to accept/counter/cancel;
        // that deal is no longer stale, which is not a failure.
      }
      result.reason = `route processed ${route.results.length}`;
    }

    await sql`
      UPDATE sweeper_runs
      SET finished_at = ${now()}, scanned = ${result.scanned}, acted = ${result.acted},
          held = ${result.held}, failed = ${result.failed},
          error = ${route.ok ? null : route.reason}
      WHERE id = ${runId}
    `;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await sql`
        UPDATE sweeper_runs
        SET finished_at = ${now()}, error = ${msg}, scanned = ${result.scanned},
            acted = ${result.acted}, held = ${result.held}, failed = ${result.failed}
        WHERE id = ${runId}
      `;
    } catch { /* the throw below is the real signal */ }
    throw err;
  }
}

type RouteOutcome =
  | { ok: true; results: RouteResult[] }
  | { ok: false; reason: string };

/** Call POST /api/admin/expire-stale-proposals. The ONLY place a proposal is expired. */
async function expireViaApi(
  cfg: ProposalExpirySweeperConfig,
  doFetch: typeof fetch,
): Promise<RouteOutcome> {
  if (!cfg.adminApiKey) {
    // Fail closed and loudly — a silent skip is indistinguishable from
    // "nothing was stale" in every metric we have.
    return { ok: false, reason: "ADMIN_API_KEY unset" };
  }
  const url = `${cfg.apiBaseUrl.replace(/\/$/, "")}/api/admin/expire-stale-proposals`;

  // Timeout is mandatory: ticks are on setInterval, so a hung call would
  // overlap with the next tick. Not retried — the route is idempotent per
  // deal (status CAS), so the next tick simply re-evaluates.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.apiTimeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": cfg.adminApiKey },
      body: "{}",
      signal: ctrl.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `api call did not return (${msg}); not retried — next tick re-evaluates` };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  let body: { processed?: unknown; results?: unknown };
  try {
    body = JSON.parse(text) as { processed?: unknown; results?: unknown };
  } catch {
    return { ok: false, reason: `unparseable response: ${text.slice(0, 120)}` };
  }
  if (!Array.isArray(body.results)) {
    return { ok: false, reason: `unexpected response shape: ${text.slice(0, 120)}` };
  }
  return { ok: true, results: body.results as RouteResult[] };
}
