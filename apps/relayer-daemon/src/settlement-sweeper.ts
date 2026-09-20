// apps/relayer-daemon/src/settlement-sweeper.ts — moneypath_0920 M1
//
// THE BUG THIS CLOSES
// `acceptanceTimeoutDays` is promised to every integrator ("the buyer has N
// days to accept, after which the deal auto-completes and the seller is paid")
// and implemented twice — routes/admin.ts `/api/admin/auto-complete-timeouts`
// and routes/fulfillment.ts `/api/deals/:id/fulfillment/auto-complete`. Both
// are operator-triggered. NOTHING EVER CALLED EITHER ONE.
//
// Measured on production 2026-09-20:
//   480 deals, 98 completed, 0 rows in platform_fee_ledger — ever.
//   21 deals sitting in 'delivered' past their own acceptance_timeout_days.
// The mechanism was real and unscheduled. This file is the schedule.
//
// WHY IT CALLS AN HTTP ROUTE INSTEAD OF DOING THE WORK
// The obvious implementation — import completeDealMilestones and release the
// money here — is the one thing this repo must not do again. The API's money
// path is ~80 lines of ordering that is easy to get subtly wrong: verify the
// fulfillment row, call completeDealMilestones, HOLD on `settlement_pending`
// (an unfunded fee-bearing deal must NOT bump reputation or fire
// "auto-completed"), archive the offer, bump reputation, notify both agents.
// `apps/relayer-daemon/tsconfig.json` sets rootDir:"src", so the daemon
// physically cannot import from apps/api — the only way to duplicate that
// logic is to COPY it, and a copied money path drifts from the original the
// first time either is patched. PR #98 in this repo deleted exactly such a
// duplicate.
//
// So the split is:
//   this file  — WHICH deals, and WHETHER the evidence justifies release
//   the API    — the release itself, unchanged, single-sourced
//
// THE JUDGE
// A time-only rule ("N days passed, pay out") pays out on an empty delivery.
// Before release, the seller's actual submitted evidence is judged by Jev
// (jev.ts). Three outcomes, and the two non-release ones are NOT the same:
//   p >= COMPLETE  → call the API route; the money moves
//   p <  COMPLETE  → 'review': a human must look. NOT auto-released.
//   judge down     → 'hold': decide nothing, retry next tick. An outage must
//                    never become an automatic payout.
//
// SELF-DEALS ARE NEVER AUTO-RELEASED
// 45 of the 98 completed deals on prod have buyer_agent_id = seller_agent_id.
// Auto-releasing those would generate platform_fee_ledger rows that look like
// revenue and are not. They are recorded as 'skip_self_deal' and left alone.

import type { SqlClient } from "./sweepers.js";
import { buildEvidence, judgeDelivery, rubricHash, type JevConfig } from "./jev.js";

export interface SettlementSweeperConfig {
  apiBaseUrl: string;
  adminApiKey?: string;
  /** p >= this releases money. */
  completeThreshold: number;
  /** Max deals per tick. Bounds blast radius AND judge spend. */
  maxPerTick: number;
  /** Set false to judge + record decisions without calling the API. */
  autoReleaseEnabled: boolean;
  jev?: JevConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SettlementSweepResult {
  runId: string | null;
  scanned: number;
  acted: number;
  held: number;
  failed: number;
  decisions: Array<{ dealId: string; outcome: string; p: number | null; reason: string }>;
}

interface CandidateRow {
  id: string;
  status: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  title: string | null;
  description: string | null;
  fulfillment_type: string | null;
  fulfillment_data: unknown;
  seller_completed_count: string | number | null;
  is_self_deal: boolean;
}

export type Outcome = "complete" | "review" | "hold" | "skip_self_deal" | "error";

/**
 * One tick. Returns counts; every decision is also persisted to
 * sweeper_decisions and the tick itself to sweeper_runs, so "the sweeper is
 * alive" and "the sweeper acted" stay separately provable (G1 vs G2).
 */
export async function runSettlementSweep(
  sql: SqlClient,
  cfg: SettlementSweeperConfig,
): Promise<SettlementSweepResult> {
  const now = cfg.now ?? (() => new Date());
  const doFetch = cfg.fetchImpl ?? fetch;
  const result: SettlementSweepResult = {
    runId: null, scanned: 0, acted: 0, held: 0, failed: 0, decisions: [],
  };

  // Open the run row FIRST. If this tick then throws, the row survives with a
  // null finished_at — which is how a crashed tick stays visible instead of
  // vanishing. A run row written only at the end can only ever record success.
  const [run] = await sql<{ id: string }>`
    INSERT INTO sweeper_runs (sweeper, started_at) VALUES ('settlement', ${now()})
    RETURNING id
  `;
  const runId = run?.id ?? null;
  result.runId = runId;

  try {
    // The SAME eligibility predicate the API route enforces per-deal:
    // status in (delivered, active, funded) AND updated_at older than the
    // deal's own acceptance_timeout_days (default 7). Deliberately mirrored
    // rather than loosened — if this query selected a deal the route considers
    // ineligible, the route would refuse and the sweeper would retry it every
    // tick forever.
    //
    // WHERE THE TEXT COMES FROM. `deals` has NO title/description column —
    // verified against the real schema 2026-09-20 (and against prod). The
    // human-readable terms live on the linked `offers` (title,
    // description_md) and `needs` (title, description_md,
    // acceptance_criteria). An earlier draft selected d.title/d.description
    // and would have died with 42703 on EVERY tick in production; the
    // fake-sql unit tests cannot catch that, only a real schema can.
    //
    // needs.acceptance_criteria is preferred as the "what was bought" text
    // because it is literally the buyer's own statement of what would satisfy
    // them — the closest thing to ground truth the judge can be given. It is
    // JSONB, not text (verified against the real schema), so it needs an
    // explicit ::text cast: COALESCE across jsonb and text raises 42804
    // "types jsonb and text cannot be matched" and would abort every tick.
    // NULLIF(...,'null') guards the jsonb null literal, which casts to the
    // four-character string "null" rather than SQL NULL and would otherwise
    // be handed to the judge as if it were the buyer's requirements.
    // Both offer_id and need_id are NOT NULL on deals, so the joins never
    // drop a row.
    //
    // Excludes deals already decided 'complete' or 'review' in the last 24h,
    // so a deal a human is reviewing is not re-judged on every tick.
    const candidates = await sql<CandidateRow>`
      SELECT
        d.id, d.status, d.buyer_agent_id, d.seller_agent_id,
        COALESCE(n.title, o.title)                          AS title,
        COALESCE(
          NULLIF(n.acceptance_criteria::text, 'null'),
          n.description_md,
          o.description_md
        )                                                   AS description,
        f.fulfillment_type, f.fulfillment_data,
        (d.buyer_agent_id = d.seller_agent_id) AS is_self_deal,
        (SELECT COUNT(*) FROM deals x
          WHERE x.seller_agent_id = d.seller_agent_id AND x.status = 'completed'
        ) AS seller_completed_count
      FROM deals d
      LEFT JOIN offers o ON o.id = d.offer_id
      LEFT JOIN needs  n ON n.id = d.need_id
      LEFT JOIN LATERAL (
        SELECT fulfillment_type, fulfillment_data
        FROM deal_fulfillment
        WHERE deal_id = d.id AND status NOT IN ('revoked')
        ORDER BY created_at DESC LIMIT 1
      ) f ON TRUE
      WHERE d.status IN ('delivered', 'active', 'funded')
        AND d.updated_at < ${now()}::timestamptz
            - (COALESCE(d.acceptance_timeout_days, 7) || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM sweeper_decisions sd
          WHERE sd.deal_id = d.id
            AND sd.outcome IN ('complete', 'review')
            AND sd.decided_at > ${now()}::timestamptz - INTERVAL '24 hours'
        )
      ORDER BY d.updated_at ASC
      LIMIT ${cfg.maxPerTick}
    `;

    result.scanned = candidates.length;
    const rHash = rubricHash();

    for (const deal of candidates) {
      let outcome: Outcome = "hold";
      let p: number | null = null;
      let judge: string | null = null;
      let reason = "";

      try {
        if (deal.is_self_deal) {
          outcome = "skip_self_deal";
          reason = "buyer_agent_id = seller_agent_id — never auto-released, never counted as revenue";
        } else {
          const evidence = buildEvidence({
            dealTitle: deal.title,
            dealDescription: deal.description,
            fulfillmentType: deal.fulfillment_type,
            fulfillmentData: deal.fulfillment_data,
            sellerCompletedCount: Number(deal.seller_completed_count ?? 0),
          });
          const verdict = await judgeDelivery(evidence, cfg.jev);
          judge = verdict.judge;

          if (!verdict.available) {
            outcome = "hold";
            reason = verdict.reason;
          } else {
            p = verdict.p;
            if (verdict.p >= cfg.completeThreshold) {
              if (!cfg.autoReleaseEnabled) {
                outcome = "review";
                reason = `p=${verdict.p.toFixed(3)} >= threshold but auto-release is disabled (shadow mode)`;
              } else {
                const rel = await releaseViaApi(deal.id, cfg, doFetch);
                if (rel.ok && rel.completed) {
                  outcome = "complete";
                  reason = "released via /api/deals/:id/fulfillment/auto-complete";
                } else if (rel.settlementPending) {
                  // Not a failure: the API correctly refused to complete an
                  // unfunded fee-bearing deal. Recording it as 'hold' keeps it
                  // eligible for a later tick once funding arrives.
                  outcome = "hold";
                  reason = "api: settlement_pending (deal not funded)";
                } else {
                  outcome = "error";
                  reason = `api refused: ${rel.reason}`;
                }
              }
            } else {
              outcome = "review";
              reason = `p=${verdict.p.toFixed(3)} < ${cfg.completeThreshold} — evidence insufficient for automatic release`;
            }
          }
        }
      } catch (err) {
        outcome = "error";
        reason = err instanceof Error ? err.message : String(err);
      }

      if (outcome === "complete") result.acted++;
      else if (outcome === "error") result.failed++;
      else if (outcome === "hold") result.held++;

      result.decisions.push({ dealId: deal.id, outcome, p, reason });

      // Persisting a decision must never abort the sweep: a receipt-write
      // failure would otherwise strand the remaining candidates.
      try {
        await sql`
          INSERT INTO sweeper_decisions (run_id, deal_id, outcome, judge, p, rubric_hash, reason)
          VALUES (${runId}, ${deal.id}, ${outcome}, ${judge}, ${p}, ${rHash}, ${reason})
        `;
      } catch { /* counted in the run row; the tick continues */ }
    }

    await sql`
      UPDATE sweeper_runs
      SET finished_at = ${now()}, scanned = ${result.scanned}, acted = ${result.acted},
          held = ${result.held}, failed = ${result.failed}
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

interface ReleaseOutcome {
  ok: boolean;
  completed: boolean;
  settlementPending: boolean;
  reason: string;
}

/** Call the API's per-deal auto-complete route. The ONLY place money moves. */
async function releaseViaApi(
  dealId: string,
  cfg: SettlementSweeperConfig,
  doFetch: typeof fetch,
): Promise<ReleaseOutcome> {
  if (!cfg.adminApiKey) {
    // Fail closed and loudly. Silently skipping would look identical to
    // "there was nothing to release" in every metric we have.
    return { ok: false, completed: false, settlementPending: false, reason: "ADMIN_API_KEY unset" };
  }
  const url = `${cfg.apiBaseUrl.replace(/\/$/, "")}/api/deals/${dealId}/fulfillment/auto-complete`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": cfg.adminApiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, completed: false, settlementPending: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, completed: false, settlementPending: false, reason: `unparseable response: ${text.slice(0, 120)}` };
  }
  // The route answers 200 with {ok:false, reason} for an ineligible deal, so
  // HTTP status alone is not the success signal.
  return {
    ok: body.ok === true,
    completed: body.completed === true,
    settlementPending: body.settlement_pending === true,
    reason: typeof body.reason === "string" ? body.reason : JSON.stringify(body).slice(0, 200),
  };
}
