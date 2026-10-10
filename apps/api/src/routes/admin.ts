import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";
import { completeDealMilestones } from "../shared/deal-helpers.js";
import { creditReputation } from "../shared/reputation.js";
import { notifyAgents } from "../webhooks.js";
import { PLATFORM_FEE_PCT, requireAdminKey } from "./utils.js";
import { funnelEventsReport, parseSince, usageReport } from "../shared/telemetry-reports.js";
import { computePaidSettledExternal, PAID_SETTLED_EXTERNAL_DEFINITION } from "../shared/evidence-stats.js";
import { EXCLUDED_BUCKETS, type ExcludedBucket, externalSplitIntegrity } from "../shared/external-split.js";
import {
  isOnChainMode,
  resolveDisputeOnChain,
} from "../chain.js";

export default async function adminRoutes(app: FastifyInstance) {
  // Both local copies of this gate were deleted; `checkAdminKey` (8 call sites)
  // and `requireAdminKey` (2) were byte-identical. Both names now resolve to the
  // single shared implementation in ./utils.js so they cannot drift apart.
  const checkAdminKey = requireAdminKey;



  function conversion(from: string, to: string, fromCount: number, toCount: number) {
    return {
      from,
      to,
      fromCount,
      toCount,
      rate: fromCount > 0 ? Number((toCount / fromCount).toFixed(4)) : null,
    };
  }

  // Bare conversion ratio (0..1) or null when the denominator is 0.
  function rate(fromCount: number, toCount: number): number | null {
    return fromCount > 0 ? Number((toCount / fromCount).toFixed(4)) : null;
  }

  // Point-in-time deal-state funnel (all deals, current status). Shared by
  // /api/admin/metrics and /api/admin/funnel so the two cannot disagree.
  async function dealStateFunnelRow() {
    const [row] = await sql`
      SELECT
        COUNT(*)::int AS deal_proposals_created,
        COUNT(*) FILTER (WHERE status IN ('accepted', 'active', 'funded', 'delivered', 'completed'))::int AS proposals_accepted,
        COUNT(*) FILTER (
          WHERE status IN ('funded', 'delivered', 'completed')
             OR EXISTS (
               SELECT 1
               FROM milestones m
               JOIN payment_intents pi ON pi.milestone_id = m.id
               WHERE m.deal_id = deals.id
                 AND pi.status IN ('funded', 'released')
             )
        )::int AS deals_funded,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS deals_completed,
        COALESCE(SUM(negotiated_total) FILTER (WHERE status = 'completed'), 0)::float AS gmv
      FROM deals
    `;
    return row;
  }

  async function getMetrics() {
    const browseByEndpoint = await sql`
      SELECT
        COALESCE(payload_json->>'endpoint', 'unknown') AS endpoint,
        COUNT(*)::int AS count,
        ROUND(AVG((payload_json->>'durationMs')::numeric), 2)::float AS avg_ms,
        MIN((payload_json->>'durationMs')::numeric)::float AS min_ms,
        MAX((payload_json->>'durationMs')::numeric)::float AS max_ms,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2)::float AS p50_ms,
        ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2)::float AS p95_ms
      FROM audit_log
      WHERE action = 'browse.latency'
        AND payload_json ? 'durationMs'
      GROUP BY 1
      ORDER BY count DESC, endpoint ASC
    `;

    const [browseOverall] = await sql`
      SELECT
        COUNT(*)::int AS count,
        COALESCE(ROUND(AVG((payload_json->>'durationMs')::numeric), 2), 0)::float AS avg_ms,
        COALESCE(MIN((payload_json->>'durationMs')::numeric), 0)::float AS min_ms,
        COALESCE(MAX((payload_json->>'durationMs')::numeric), 0)::float AS max_ms,
        COALESCE(ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2), 0)::float AS p50_ms,
        COALESCE(ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2), 0)::float AS p95_ms
      FROM audit_log
      WHERE action = 'browse.latency'
        AND payload_json ? 'durationMs'
    `;

    const [offerViewStats] = await sql`
      SELECT COUNT(*)::int AS total
      FROM audit_log
      WHERE action = 'offer.view'
    `;

    const topViewedOffers = await sql`
      SELECT
        al.object_id AS offer_id,
        COALESCE(o.title, '') AS title,
        COUNT(*)::int AS views
      FROM audit_log al
      LEFT JOIN offers o ON o.id = al.object_id
      WHERE al.action = 'offer.view'
      GROUP BY al.object_id, o.title
      ORDER BY views DESC, offer_id ASC
      LIMIT 20
    `;

    const funnelStats = await dealStateFunnelRow();

    const [auditedFeeStats] = await sql`
      SELECT COALESCE(SUM((payload_json->>'feeAmount')::numeric), 0)::float AS platform_fee_revenue
      FROM audit_log
      WHERE action = 'payment.release'
        AND payload_json ? 'feeAmount'
    `;

    // ── DEAD-INTENT-SWEEP SLA (issue #107) ────────────────────────────────
    //
    // #102 added POST /api/admin/expire-stale-proposals: a cron/operator-driven
    // sweeper that cancels 'proposed'/'countered' deals past their expires_at
    // deadline before they accumulate silently (the exact defect #102 fixed —
    // 200+ dead deals, oldest 2026-04-27, that nothing ever swept). #102/#104
    // shipped the CURE but no metric watches whether the cure keeps working —
    // a cron that silently stops firing regresses the funnel back to the
    // pre-#102 state with zero visibility. Two numbers close that gap:
    //
    //   overdueUnswept — deals PAST their acceptance deadline that the next
    //     sweep run has not yet cancelled. This is the SLA number: healthy
    //     operation keeps it at (or very near) zero between sweep cycles. A
    //     sustained non-zero value means the sweeper cron is not running, is
    //     erroring, or a code change reopened the leak — same failure shape
    //     issue #104 found for the 'countered' status gap.
    //   sweptLast7d / sweptByDay — actual sweep throughput, sourced from the
    //     negotiation_events audit trail the sweeper itself writes
    //     (event_type='cancel', reason='acceptance_deadline_expired',
    //     automated=true) — no new table, no new write path, purely additive.
    const [sweepBacklog] = await sql`
      SELECT COUNT(*)::int AS overdue_unswept
      FROM deals
      WHERE status IN ('proposed', 'countered')
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
    `;

    // Defensive read-side normalization: negotiation_events.payload_json can
    // be DOUBLE-JSON-ENCODED — the sweeper's own INSERT (this file, below)
    // binds `JSON.stringify(...)::jsonb`, the exact double-encode class
    // documented in routes/utils.ts (coerceJsonArray / enrichOfferRow):
    // postgres.js's own jsonb serializer then re-stringifies the already-
    // stringified value, so the column holds a JSON *string scalar*
    // containing the JSON text, not a JSON object. `payload->>'reason'` on a
    // string scalar is NULL, silently zeroing this metric. Rather than touch
    // the sweeper's write path (out of scope — additive/read-only change),
    // normalize on read exactly like the existing app-layer pattern: unwrap
    // the string scalar to its inner jsonb when present, object as-is
    // otherwise. Works for old AND (if the write path is ever fixed)
    // correctly-encoded rows alike.
    const [sweepRecent] = await sql`
      WITH normalized AS (
        SELECT
          created_at,
          (CASE
            -- Only unwrap when the inner text is actually a JSON OBJECT.
            -- A bare ::jsonb cast on arbitrary inner text turns ONE malformed
            -- historical row (an empty string, or a plain string scalar like
            -- "hello") into a hard 500 for the whole metrics endpoint --
            -- adversarial review finding, 2026-08-18. Excluding the bad row
            -- is always the right failure mode for an observability query.
            WHEN jsonb_typeof(payload_json) = 'string'
                 AND (payload_json #>> '{}') ~ '^\\s*\\{'
              THEN (payload_json #>> '{}')::jsonb
            WHEN jsonb_typeof(payload_json) = 'string'
              THEN '{}'::jsonb
            ELSE payload_json
          END) AS payload
        FROM negotiation_events
        WHERE event_type = 'cancel'
      )
      SELECT
        COUNT(*)::int AS swept_last_7d,
        MAX(created_at) AS last_swept_at
      FROM normalized
      WHERE payload->>'reason' = 'acceptance_deadline_expired'
        AND (payload->>'automated')::boolean = true
        AND created_at > NOW() - INTERVAL '7 days'
    `;

    const sweptByDay = await sql`
      WITH normalized AS (
        SELECT
          created_at,
          (CASE
            -- Only unwrap when the inner text is actually a JSON OBJECT.
            -- A bare ::jsonb cast on arbitrary inner text turns ONE malformed
            -- historical row (an empty string, or a plain string scalar like
            -- "hello") into a hard 500 for the whole metrics endpoint --
            -- adversarial review finding, 2026-08-18. Excluding the bad row
            -- is always the right failure mode for an observability query.
            WHEN jsonb_typeof(payload_json) = 'string'
                 AND (payload_json #>> '{}') ~ '^\\s*\\{'
              THEN (payload_json #>> '{}')::jsonb
            WHEN jsonb_typeof(payload_json) = 'string'
              THEN '{}'::jsonb
            ELSE payload_json
          END) AS payload
        FROM negotiation_events
        WHERE event_type = 'cancel'
      )
      SELECT
        date_trunc('day', created_at)::date AS day,
        COUNT(*)::int AS swept
      FROM normalized
      WHERE payload->>'reason' = 'acceptance_deadline_expired'
        AND (payload->>'automated')::boolean = true
        AND created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1
      ORDER BY 1 DESC
    `;

    // ── FUNNEL-PROGRESSION HEALTH (issue #107) ────────────────────────────
    // What fraction of deals PROPOSED in the last N days have reached escrow
    // (funded) as of now? A dropping rate over time is an early silent-decay
    // signal the point-in-time funnel counts above cannot show, because those
    // mix deals of every age together. "Reached escrow" mirrors the exact
    // dealsFunded predicate above (status shortcut OR a funded/released
    // payment_intent) so this can never disagree with the funnel numbers.
    const funnelProgressionWindowDays = 7;
    const [progression] = await sql`
      SELECT
        COUNT(*)::int AS created_in_window,
        COUNT(*) FILTER (
          WHERE deals.status IN ('funded', 'delivered', 'completed')
             OR EXISTS (
               SELECT 1
               FROM milestones m
               JOIN payment_intents pi ON pi.milestone_id = m.id
               WHERE m.deal_id = deals.id
                 AND pi.status IN ('funded', 'released')
             )
        )::int AS reached_escrow_in_window
      FROM deals
      WHERE created_at > NOW() - (${funnelProgressionWindowDays} || ' days')::interval
    `;

    // ── ECONOMICS: two HARD-SEPARATED signals (autoclose rollout metrics loop) ──
    //
    // The naive GMV above (SUM negotiated_total WHERE completed) is wash-trade
    // blind: it counts a fleet agent paying ANOTHER fleet agent — or itself — as
    // "revenue". We compute:
    //
    //   ENGINEERING signal  — funnel conversion (proposals→funded→completed).
    //     Answers "is the settlement machine working?". Improves the moment our
    //     own relayer auto-funds dogfood deals — so it is NOT proof of demand.
    //
    //   BUSINESS signal     — paid settled external deals: completed
    //     qualifying_deals with capital_at_risk (migration 052/054), volume =
    //     USDC escrowed capped at the quote. Answers "does anyone real want
    //     this?" and is the only number allowed to mean "money". It is read
    //     through the SAME helper as /api/stats/public (uncached here), so the
    //     admin and public "external" numbers cannot drift apart.
    //
    //   EXCLUDED            — every other completed deal, bucketed by the FIRST
    //     reason it is not business, so the gap to naive GMV is explained,
    //     never hidden. Invariant: sum(excluded.*.deals) + business = completed.
    //
    // BLIND-SPOT HONESTY: "external" depends on agents.is_internal. Flagging is
    // per agent, so a fleet owner wallet can hold flagged AND unflagged agents
    // (partial flagging) and the unflagged ones read as outsiders. The guard
    // below trips whenever any canonical owner wallet owns both kinds.
    const paidSettled = await computePaidSettledExternal(sql);

    const [{ completed_total }] = await sql`
      SELECT COUNT(*)::int AS completed_total FROM deals WHERE status = 'completed'
    `;

    // First-failing-reason buckets over the deal_integrity view. "business" is
    // decided by the view's own flags (never re-derived); a completed deal that
    // matches none of the branches lands in "unclassified" and breaks the
    // reconciliation flag instead of disappearing.
    const excludedRows = await sql`
      SELECT bucket, COUNT(*)::int AS deals, COALESCE(SUM(negotiated_total), 0)::float AS negotiated
      FROM (
        SELECT
          di.negotiated_total,
          CASE
            WHEN di.qualifying AND di.funded THEN 'business'
            WHEN b.is_internal OR s.is_internal THEN 'internal_party'
            WHEN di.buyer_agent_id = di.seller_agent_id THEN 'self_deal'
            WHEN NOT COALESCE(di.negotiated_total > 0, false) THEN 'unpriced'
            WHEN ap_wallet_key(b.owner_wallet_address) IS NULL
              OR ap_wallet_key(s.owner_wallet_address) IS NULL THEN 'unknown_owner_wallet'
            WHEN ap_wallet_key(b.owner_wallet_address) = ap_wallet_key(s.owner_wallet_address) THEN 'same_owner'
            WHEN di.integrity_class IS NOT NULL THEN 'quarantined'
            WHEN di.qualifying THEN 'qualifying_unfunded'
            ELSE 'unclassified'
          END AS bucket
        FROM deal_integrity di
        JOIN agents b ON b.id = di.buyer_agent_id
        JOIN agents s ON s.id = di.seller_agent_id
        WHERE di.status = 'completed'
      ) c
      GROUP BY bucket
    `;

    // Wallet coherence: one canonical owner wallet ⇒ one internal status.
    // Unknown wallets (ap_wallet_key NULL) are never treated as a shared owner.
    const [walletCoherence] = await sql`
      WITH k AS (
        SELECT id, ap_wallet_key(owner_wallet_address) AS w, is_internal FROM agents
      ), mixed AS (
        SELECT w FROM k WHERE w IS NOT NULL
        GROUP BY w HAVING bool_or(is_internal) AND bool_or(NOT is_internal)
      )
      SELECT
        (SELECT count(*) FILTER (WHERE is_internal) FROM k)::int AS internal_agent_count,
        (SELECT count(*) FROM mixed)::int AS mixed_owner_wallets,
        (SELECT count(*) FROM k WHERE NOT is_internal AND w IN (SELECT w FROM mixed))::int AS unflagged_agents_on_internal_wallets,
        (SELECT count(*) FROM qualifying_deals q
           JOIN agents b ON b.id = q.buyer_agent_id
           JOIN agents s ON s.id = q.seller_agent_id
          WHERE q.capital_at_risk AND q.status = 'completed'
            AND (ap_wallet_key(b.owner_wallet_address) IN (SELECT w FROM mixed)
              OR ap_wallet_key(s.owner_wallet_address) IN (SELECT w FROM mixed)))::int AS external_deals_on_mixed_wallets
    `;

    const dealProposalsCreated = Number(funnelStats.deal_proposals_created ?? 0);
    const proposalsAccepted = Number(funnelStats.proposals_accepted ?? 0);
    const dealsFunded = Number(funnelStats.deals_funded ?? 0);
    const dealsCompleted = Number(funnelStats.deals_completed ?? 0);
    const gmv = Number(funnelStats.gmv ?? 0);
    const calculatedPlatformFeeRevenue = Number(((gmv * PLATFORM_FEE_PCT) / 100).toFixed(6));
    const auditedPlatformFeeRevenue = Number(auditedFeeStats.platform_fee_revenue ?? 0);

    return {
      generatedAt: new Date().toISOString(),
      browseLatency: {
        overall: {
          count: Number(browseOverall?.count ?? 0),
          avgMs: Number(browseOverall?.avg_ms ?? 0),
          minMs: Number(browseOverall?.min_ms ?? 0),
          maxMs: Number(browseOverall?.max_ms ?? 0),
          p50Ms: Number(browseOverall?.p50_ms ?? 0),
          p95Ms: Number(browseOverall?.p95_ms ?? 0),
        },
        byEndpoint: browseByEndpoint.map((row) => ({
          endpoint: String(row.endpoint),
          count: Number(row.count),
          avgMs: Number(row.avg_ms ?? 0),
          minMs: Number(row.min_ms ?? 0),
          maxMs: Number(row.max_ms ?? 0),
          p50Ms: Number(row.p50_ms ?? 0),
          p95Ms: Number(row.p95_ms ?? 0),
        })),
      },
      offerPageViews: {
        total: Number(offerViewStats.total ?? 0),
        topOffers: topViewedOffers.map((row) => ({
          offerId: row.offer_id ? String(row.offer_id) : null,
          title: String(row.title ?? ""),
          views: Number(row.views),
        })),
      },
      funnel: {
        dealProposalsCreated,
        proposalsAccepted,
        dealsFunded,
        dealsCompleted,
        conversions: [
          conversion("offerPageViews", "dealProposalsCreated", Number(offerViewStats.total ?? 0), dealProposalsCreated),
          conversion("dealProposalsCreated", "proposalsAccepted", dealProposalsCreated, proposalsAccepted),
          conversion("proposalsAccepted", "dealsFunded", proposalsAccepted, dealsFunded),
          conversion("dealsFunded", "dealsCompleted", dealsFunded, dealsCompleted),
        ],
      },
      // Dead-intent-sweep SLA (issue #107) — is the #102/#104 stale-proposal
      // sweeper still doing its job? See the getMetrics query comment above.
      deadIntentSweep: {
        overdueUnswept: Number(sweepBacklog.overdue_unswept ?? 0),
        sweptLast7d: Number(sweepRecent.swept_last_7d ?? 0),
        lastSweptAt: sweepRecent.last_swept_at ? new Date(sweepRecent.last_swept_at).toISOString() : null,
        sweptByDay: sweptByDay.map((row) => ({
          day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
          swept: Number(row.swept),
        })),
      },
      // Funnel-progression health (issue #107) — of deals PROPOSED in the
      // last N days, what fraction have reached escrow (funded+) so far?
      // Complements the point-in-time funnel above with an age-bounded rate
      // that can catch a slow decay the all-time funnel numbers smear over.
      funnelProgression: {
        windowDays: funnelProgressionWindowDays,
        createdInWindow: Number(progression.created_in_window ?? 0),
        reachedEscrowInWindow: Number(progression.reached_escrow_in_window ?? 0),
        escrowRate: rate(Number(progression.created_in_window ?? 0), Number(progression.reached_escrow_in_window ?? 0)),
      },
      revenue: {
        gmv,
        platformFeePct: PLATFORM_FEE_PCT,
        platformFeeRevenue: calculatedPlatformFeeRevenue,
        auditedPlatformFeeRevenue,
      },
      economics: (() => {
        const completedTotal = Number(completed_total ?? 0);
        const completedExternal = paidSettled.deals;
        const gmvExternal = Number(paidSettled.volumeCents) / 100;
        const bucketOf = new Map(excludedRows.map((r) => [String(r.bucket), r]));
        const excluded = Object.fromEntries(
          EXCLUDED_BUCKETS.map((name) => {
            const r = bucketOf.get(name);
            return [name, {
              deals: Number(r?.deals ?? 0),
              negotiatedUsdc: Number(Number(r?.negotiated ?? 0).toFixed(6)),
            }];
          }),
        ) as Record<ExcludedBucket, { deals: number; negotiatedUsdc: number }>;
        const excludedDeals = EXCLUDED_BUCKETS.reduce((n, name) => n + excluded[name].deals, 0);
        const completedNotEvidence = completedTotal - completedExternal;
        const split = externalSplitIntegrity({
          internalAgentCount: Number(walletCoherence.internal_agent_count ?? 0),
          mixedOwnerWallets: Number(walletCoherence.mixed_owner_wallets ?? 0),
          unflaggedAgentsOnInternalWallets: Number(walletCoherence.unflagged_agents_on_internal_wallets ?? 0),
          externalDealsOnMixedWallets: Number(walletCoherence.external_deals_on_mixed_wallets ?? 0),
        });
        return {
          // ENGINEERING signal — is the settlement machine working?
          engineering: {
            proposalsAccepted,
            dealsFunded,
            dealsCompleted,
            acceptToFundRate: rate(proposalsAccepted, dealsFunded),
            fundToCompleteRate: rate(dealsFunded, dealsCompleted),
          },
          // BUSINESS signal — does anyone real want this? (the only "money"
          // number). Same helper as /api/stats/public paidDealsSettledExternal /
          // paidVolumeSettledExternalUsd; externalGmv is escrowed USDC capped
          // at the quote, not the quote.
          business: {
            completedExternalDeals: completedExternal,
            externalGmv: gmvExternal,
            externalFeeRevenue: Number(((gmvExternal * PLATFORM_FEE_PCT) / 100).toFixed(6)),
            definition: PAID_SETTLED_EXTERNAL_DEFINITION,
          },
          // Completed deals NOT in business, by first failing reason.
          excluded,
          // Self-honesty: what the business number is NOT counting + whether it can be trusted.
          integrity: {
            completedTotal,
            completedNotEvidence,
            /** @deprecated alias of completedNotEvidence (now includes unpriced/unknown-wallet/unfunded deals). */
            completedInternalOrSelf: completedNotEvidence,
            // false ⇒ a completed deal matched no bucket (definition drift) —
            // the breakdown does not reconcile and must not be trusted.
            excludedReconciles: excludedDeals + completedExternal === completedTotal,
            ...split,
          },
        };
      })(),
    };
  }

  function renderMetricsHtml(metrics: Awaited<ReturnType<typeof getMetrics>>): string {
    const cards = [
      ["Offer views", metrics.offerPageViews.total],
      ["Proposals", metrics.funnel.dealProposalsCreated],
      ["Accepted", metrics.funnel.proposalsAccepted],
      ["Funded", metrics.funnel.dealsFunded],
      ["Completed", metrics.funnel.dealsCompleted],
      ["GMV (all completed, unfiltered)", `${metrics.revenue.gmv.toFixed(2)} USDC`],
      ["External paid settled", `${metrics.economics.business.externalGmv.toFixed(2)} USDC`],
      ["External split", metrics.economics.integrity.externalSplitStatus],
      ["Fee revenue", `${metrics.revenue.platformFeeRevenue.toFixed(2)} USDC`],
      ["Browse p95", `${metrics.browseLatency.overall.p95Ms.toFixed(2)} ms`],
      ["Overdue unswept intents", metrics.deadIntentSweep.overdueUnswept],
      ["Swept (7d)", metrics.deadIntentSweep.sweptLast7d],
      [`Escrow rate (${metrics.funnelProgression.windowDays}d)`, metrics.funnelProgression.escrowRate === null ? "n/a" : `${(metrics.funnelProgression.escrowRate * 100).toFixed(1)}%`],
    ];
    const rows = metrics.browseLatency.byEndpoint
      .map((row) => `<tr><td>${row.endpoint}</td><td>${row.count}</td><td>${row.avgMs}</td><td>${row.p50Ms}</td><td>${row.p95Ms}</td></tr>`)
      .join("");
    const conversions = metrics.funnel.conversions
      .map((item) => `<tr><td>${item.from} to ${item.to}</td><td>${item.fromCount}</td><td>${item.toCount}</td><td>${item.rate === null ? "n/a" : `${(item.rate * 100).toFixed(1)}%`}</td></tr>`)
      .join("");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AgentPact Metrics</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #111; background: #f7f7f7; }
    main { max-width: 1080px; margin: 0 auto; }
    h1, h2 { margin: 0 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 24px 0; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
    .label { color: #555; font-size: 13px; }
    .value { font-size: 24px; font-weight: 700; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ddd; margin-bottom: 24px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e5e5; }
  </style>
</head>
<body>
  <main>
    <h1>AgentPact Metrics</h1>
    <p>Generated ${metrics.generatedAt}</p>
    <section class="grid">${cards.map(([label, value]) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("")}</section>
    <h2>Browse Latency</h2>
    <table><thead><tr><th>Endpoint</th><th>Count</th><th>Avg ms</th><th>P50 ms</th><th>P95 ms</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Conversions</h2>
    <table><thead><tr><th>Step</th><th>From</th><th>To</th><th>Rate</th></tr></thead><tbody>${conversions}</tbody></table>
  </main>
</body>
</html>`;
  }

  app.get("/api/admin/metrics", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;
    return getMetrics();
  });

  app.get("/api/admin/metrics.html", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;
    const metrics = await getMetrics();
    return reply.type("text/html").send(renderMetricsHtml(metrics));
  });

  // ── Telemetry (honest_0710 phase D) ──────────────────────────────
  // api_usage is written by plugins/telemetry.ts; funnel_events by the
  // migration-055 triggers. Report SQL lives in shared/telemetry-reports.ts.
  app.get("/api/admin/usage", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;
    const since = parseSince(request.query);
    return usageReport(sql, since, app.hasDecorator("telemetry") ? app.telemetry.stats() : null);
  });

  app.get("/api/admin/funnel", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;
    const since = parseSince(request.query);
    const [events, state] = await Promise.all([funnelEventsReport(sql, since), dealStateFunnelRow()]);
    return {
      ...events,
      // All-time, current-status view (same numbers as /api/admin/metrics
      // funnel) — a cross-check while funnel_events history is still short.
      stateSnapshot: {
        dealProposalsCreated: Number(state.deal_proposals_created ?? 0),
        proposalsAccepted: Number(state.proposals_accepted ?? 0),
        dealsFunded: Number(state.deals_funded ?? 0),
        dealsCompleted: Number(state.deals_completed ?? 0),
      },
    };
  });

  app.post("/api/admin/auto-complete-timeouts", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const expiredDeals = await sql`
      SELECT id, acceptance_timeout_days, updated_at, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE status IN ('delivered', 'active', 'funded')
        AND updated_at < NOW() - (COALESCE(acceptance_timeout_days, 7) || ' days')::interval
    `;

    const results = [];
    for (const deal of expiredDeals) {
      try {
        await sql`UPDATE deal_fulfillment SET status = 'verified', verified_at = NOW(), updated_at = NOW() WHERE deal_id = ${deal.id} AND status NOT IN ('verified', 'revoked')`;
        const releaseResult = await completeDealMilestones(String(deal.id), { skipOnChainRelease: false });
        // payment-methods rollout — the guard holds unfunded fee-bearing deals at
        // 'delivered'. This cron selects ('delivered','active','funded') deals, so
        // a held deal would be re-selected every run; do NOT bump reputation or
        // fire "auto-completed" on a settlement_pending result, or the cron would
        // repeatedly false-reward an unpaid seller. Report it as pending instead.
        if (releaseResult.action === "settlement_pending") {
          results.push({ dealId: deal.id, completed: false, settlement_pending: true });
          continue;
        }
        await creditReputation(sql, String(deal.id), "completion");
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
          dealId: String(deal.id),
          message: "Deal auto-completed! Leave feedback via POST /api/feedback to build your reputation.",
          feedbackUrl: "https://api.agentpact.xyz/api/feedback",
        });
        results.push({ dealId: deal.id, completed: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ dealId: deal.id, completed: false, error: message });
      }
    }

    return { processed: results.length, results };
  });

  // DEFECT B fix (GitHub issue #90) — proposals never expire.
  // Verified live: ≥200 deals sat in 'proposed' (oldest since 2026-04-27); 112
  // of 138 sampled had no expires_at at all, and 26 were already past their
  // deadline yet still 'proposed'. The only transitions out of 'proposed' were
  // accept/counter/cancel — nothing swept the timeout direction. This mirrors
  // /api/admin/auto-complete-timeouts exactly: same auth (checkAdminKey), same
  // response shape ({ processed, results }), same per-row try/catch so one bad
  // row can't abort the batch.
  //
  // Deliberately does NOT auto-accept on the seller's behalf — AGENTS.md /
  // product doctrine rules that out. A stale proposal just dies (cancelled),
  // same terminal state a manual cancel produces, so nothing downstream (web
  // UI status rendering, the deals_status_check CHECK constraint) needs to
  // learn a new status value.
  app.post("/api/admin/expire-stale-proposals", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    // Issue #104 — 'countered' MUST be swept too. Countering sets
    // status='countered' (routes/deals.ts) without touching expires_at, and
    // accept permits BOTH ('proposed','countered'), so a countered proposal is
    // still a live, acceptable offer that now never expires. Sweeping only
    // 'proposed' left the exact lifecycle leak this sweeper exists to close,
    // one counter-offer away.
    const staleProposals = await sql`
      SELECT id, buyer_agent_id, seller_agent_id, status
      FROM deals
      WHERE status IN ('proposed', 'countered')
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
    `;

    const results = [];
    for (const deal of staleProposals) {
      try {
        const [updated] = await sql`
          UPDATE deals SET status = 'cancelled', updated_at = NOW()
          WHERE id = ${deal.id} AND status = ${deal.status}
          RETURNING id
        `;
        if (!updated) {
          // Lost a race with a manual accept/counter/cancel between SELECT and
          // UPDATE — leave it alone, it is no longer stale.
          results.push({ dealId: deal.id, expired: false, reason: "status changed concurrently" });
          continue;
        }
        await sql`UPDATE milestones SET status = 'cancelled' WHERE deal_id = ${deal.id} AND status = 'pending'`;
        await sql`
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES (${deal.id}, ${deal.buyer_agent_id}, 'cancel', ${JSON.stringify({ reason: "acceptance_deadline_expired", automated: true })}::jsonb)
        `;
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.cancelled", {
          dealId: String(deal.id),
          cancelledBy: null,
          reason: "acceptance_deadline_expired",
          automated: true,
        });
        results.push({ dealId: deal.id, expired: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ dealId: deal.id, expired: false, error: message });
      }
    }

    return { processed: results.length, results };
  });
      // DEFECT D (intent/deal divergence) — DELIBERATELY NOT IMPLEMENTED HERE.
      //
      // A POST /api/admin/reconcile-expired-intents route was added in #102 and
      // is REMOVED again here (issue #104) because it was unsafe and dormant:
      //
      //   * UNSAFE: it selected every expired, non-terminal intent and cancelled
      //     the parent deal on a clock comparison alone, with no chain read. The
      //     relayer's autoclose sweeper BROADCASTS `claimIntent` and only THEN
      //     performs its status CAS (apps/relayer-daemon/src/autoclose-sweeper.ts).
      //     A reconciliation sweep landing inside that window marks the deal
      //     'cancelled' while the claim succeeds on-chain — the database and the
      //     chain permanently disagree about who was paid. That is strictly worse
      //     than the wedged-'active' deal it set out to fix: a stuck deal is
      //     visible and recoverable; a false 'cancelled' over a real on-chain
      //     payout is neither.
      //
      //   * DORMANT: nothing invoked it. No cron, no daemon, no test, no doc.
      //
      // Whatever replaces it MUST read chain state (or coordinate with the
      // relayer's CAS) before writing a terminal deal status, and must carry its
      // own RED-proof for the broadcast-window race. A clock comparison is not
      // sufficient evidence that a settlement is dead.


  app.post("/api/admin/force-close", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const body = z
      .object({
        dealId: z.string().uuid(),
        reason: z.string().optional().default("Admin force-close"),
      })
      .parse(request.body);

    const [deal] = await sql`
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
      FROM deals WHERE id = ${body.dealId}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (deal.status === "completed") return { ok: true, alreadyCompleted: true };

    await sql`UPDATE deal_fulfillment SET status = 'verified', verified_at = NOW(), updated_at = NOW() WHERE deal_id = ${body.dealId} AND status NOT IN ('verified', 'revoked')`;
    const releaseResult = await completeDealMilestones(body.dealId, { skipOnChainRelease: false });

    // payment-methods rollout — even on an operator force-close, do not archive the
    // offer, reward the seller, or claim completion if the guard held the deal at
    // 'delivered' (settlement_pending). Surface it so the operator funds first.
    if (releaseResult.action === "settlement_pending") {
      notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.settlement_pending", {
        dealId: body.dealId,
        reason: body.reason,
      });
      const [pendingDeal] = await sql`SELECT * FROM deals WHERE id = ${body.dealId}`;
      return { ok: true, deal: pendingDeal, release: releaseResult, settlement_pending: true };
    }

    if (deal.offer_id) {
      await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }
    await creditReputation(sql, body.dealId, "completion");

    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
      dealId: body.dealId,
      reason: body.reason,
    });
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
      dealId: body.dealId,
      message: "Deal closed! Leave feedback via POST /api/feedback to build your reputation.",
      feedbackUrl: "https://api.agentpact.xyz/api/feedback",
      buyerAgentId: deal.buyer_agent_id,
      sellerAgentId: deal.seller_agent_id,
    });

    const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${body.dealId}`;
    return { ok: true, deal: updatedDeal, release: releaseResult };
  });

  app.post("/api/admin/force-release", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) return reply.code(503).send({ error: "Admin API not configured" });

    const authHeader =
      (request.headers["x-admin-key"] as string | undefined) ||
      String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (authHeader !== adminKey) return reply.code(403).send({ error: "Invalid admin key" });

    const body = z
      .object({
        milestoneId: z.string().uuid(),
        reason: z.string().optional(),
      })
      .parse(request.body);

    const [milestone] = await sql`
      SELECT m.*, d.id AS deal_id, d.status AS deal_status, d.seller_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    if (!milestone) return reply.code(404).send({ error: "Milestone not found" });

    const mode = isOnChainMode() ? "on-chain" : "simulation";
    let txHash: string | null = null;

    if (mode === "on-chain") {
      try {
        const result = await resolveDisputeOnChain(body.milestoneId, false);
        txHash = result.txHash;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[admin/force-release] On-chain resolveDispute failed: ${message}`);
        // CRITICAL: do NOT update DB when on-chain release failed — funds would
        // be locked in escrow with no recoverable state.
        return reply.code(502).send({ error: "On-chain release failed; DB not updated", reason: message });
      }
    }

    await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = ${body.milestoneId}`;
    await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${milestone.deal_id}`;
    await sql`UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ${body.milestoneId} AND status = 'funded'`;

    console.log(
      `[admin/force-release] Milestone ${body.milestoneId} released. Reason: ${body.reason || "admin action"}. TxHash: ${txHash || "N/A"}`
    );

    return {
      ok: true,
      milestoneId: body.milestoneId,
      dealId: milestone.deal_id,
      mode,
      txHash,
      reason: body.reason || "admin force-release",
    };
  });

  // ── Admin-adjudicated buyer-favor refund ─────────────────────────
  // Issue #104 — the missing counterpart to force-release.
  //
  // #99 correctly closed the hole where a BUYER could open their own on-chain
  // dispute and then make the platform key sign `resolveDispute(..., true)` on
  // their own request — no seller consent, no evidence, no review. But closing
  // it left NO caller anywhere passing refundBuyer=true: every remaining
  // production call site passes `false` (force-release here, plus the two
  // completion tails in deal-helpers.ts / index.ts). A genuine buyer-win
  // adjudication had no execution path at all, so escrowed funds could not be
  // returned through the application — the dispute simply parked at
  // `pending_refund` forever.
  //
  // The fix is NOT to relax the buyer-facing route. It is to give the operator
  // an explicit, admin-gated decision surface, exactly mirroring force-release:
  // same auth, same on-chain-first ordering, same refusal to touch the DB when
  // the chain call fails.
  app.post("/api/admin/force-refund", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const body = z
      .object({
        milestoneId: z.string().uuid(),
        reason: z.string().optional(),
      })
      .parse(request.body);

    const [milestone] = await sql`
      SELECT m.*, d.id AS deal_id, d.status AS deal_status, d.buyer_agent_id, d.seller_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    if (!milestone) return reply.code(404).send({ error: "Milestone not found" });

    const mode = isOnChainMode() ? "on-chain" : "simulation";
    let txHash: string | null = null;

    if (mode === "on-chain") {
      try {
        // refundBuyer = true — the ONLY place in the codebase that does this,
        // and it is reachable only with the admin key.
        const result = await resolveDisputeOnChain(body.milestoneId, true);
        txHash = result.txHash;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[admin/force-refund] On-chain resolveDispute failed: ${message}`);
        // Same invariant as force-release: never update the DB when the chain
        // call failed, or the database claims a refund that never happened.
        return reply.code(502).send({ error: "On-chain refund failed; DB not updated", reason: message });
      }
    }

    await sql`UPDATE milestones SET status = 'cancelled' WHERE id = ${body.milestoneId}`;
    await sql`UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = ${milestone.deal_id}`;
    await sql`
      UPDATE payment_intents
      SET status = 'refunded', updated_at = NOW(), tx_hash = ${txHash}
      WHERE milestone_id = ${body.milestoneId} AND status IN ('funded', 'pending_refund')
    `;

    notifyAgents(sql, [milestone.buyer_agent_id, milestone.seller_agent_id], "payment.refunded", {
      dealId: String(milestone.deal_id),
      milestoneId: body.milestoneId,
      mode,
      txHash,
      reason: body.reason || "admin force-refund",
    });

    console.log(
      `[admin/force-refund] Milestone ${body.milestoneId} refunded to buyer. Reason: ${body.reason || "admin action"}. TxHash: ${txHash || "N/A"}`
    );

    return {
      ok: true,
      milestoneId: body.milestoneId,
      dealId: milestone.deal_id,
      mode,
      txHash,
      reason: body.reason || "admin force-refund",
    };
  });

  // ── Mark agent as internal (operator-owned) ──────────────────────
  app.patch("/api/admin/agents/:id/mark-internal", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ isInternal: z.boolean() }).parse(request.body);

    const [agent] = await sql`
      UPDATE agents
      SET is_internal = ${body.isInternal}
      WHERE id = ${id}
      RETURNING id, handle, display_name, is_internal
    `;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    return { ok: true, agent };
  });

  // ── Bulk-mark agents by wallet prefix / handle pattern ──────────
  app.post("/api/admin/agents/bulk-mark-internal", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const body = z.object({
      walletAddresses: z.array(z.string()).optional(),
      handlePatterns: z.array(z.string()).optional(),
      isInternal: z.boolean(),
    }).parse(request.body);

    const results: Array<{ id: string; handle: string; isInternal: boolean }> = [];

    if (body.walletAddresses && body.walletAddresses.length > 0) {
      const wallets = body.walletAddresses;
      const rows = await sql`
        UPDATE agents
        SET is_internal = ${body.isInternal}
        WHERE owner_wallet_address = ANY(${wallets}::text[])
        RETURNING id, handle, is_internal
      `;
      results.push(...(rows as unknown as Array<{ id: string; handle: string; is_internal: boolean }>).map(r => ({
        id: String(r.id), handle: String(r.handle), isInternal: Boolean(r.is_internal)
      })));
    }

    if (body.handlePatterns && body.handlePatterns.length > 0) {
      for (const pattern of body.handlePatterns) {
        const rows = await sql`
          UPDATE agents
          SET is_internal = ${body.isInternal}
          WHERE handle ILIKE ${"%" + pattern + "%"}
          RETURNING id, handle, is_internal
        `;
        results.push(...(rows as unknown as Array<{ id: string; handle: string; is_internal: boolean }>).map(r => ({
          id: String(r.id), handle: String(r.handle), isInternal: Boolean(r.is_internal)
        })));
      }
    }

    return { ok: true, updated: results.length, agents: results };
  });

  // ── Real traction metrics (external agents only) ─────────────────
  app.get("/api/admin/traction", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const [overview] = await sql`
      SELECT
        COUNT(*)::int AS total_agents,
        COUNT(*) FILTER (WHERE NOT is_internal)::int AS external_agents,
        COUNT(*) FILTER (WHERE is_internal)::int AS internal_agents
      FROM agents
    `;

    const [offerStats] = await sql`
      SELECT
        COUNT(*)::int AS total_active_offers,
        COUNT(*) FILTER (WHERE a.is_internal = FALSE)::int AS external_active_offers
      FROM offers o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'active'
    `;

    const [dealStats] = await sql`
      SELECT
        COUNT(*)::int AS total_deals,
        COUNT(*) FILTER (
          WHERE a_buyer.is_internal = FALSE OR a_seller.is_internal = FALSE
        )::int AS deals_with_external_party,
        COUNT(*) FILTER (
          WHERE a_buyer.is_internal = FALSE AND a_seller.is_internal = FALSE
        )::int AS fully_external_deals
      FROM deals d
      JOIN agents a_buyer ON a_buyer.id = d.buyer_agent_id
      JOIN agents a_seller ON a_seller.id = d.seller_agent_id
    `;

    const [needStats] = await sql`
      SELECT
        COUNT(*)::int AS total_open_needs,
        COUNT(*) FILTER (WHERE a.is_internal = FALSE)::int AS external_open_needs
      FROM needs n
      JOIN agents a ON a.id = n.agent_id
      WHERE n.status = 'open'
    `;

    const recentExternal = await sql`
      SELECT id, handle, display_name, created_at, reputation_score, is_internal
      FROM agents
      WHERE is_internal = FALSE
      ORDER BY created_at DESC
      LIMIT 10
    `;

    return {
      agents: {
        total: overview.total_agents,
        external: overview.external_agents,
        internal: overview.internal_agents,
        externalPct: overview.total_agents > 0
          ? Number(((overview.external_agents / overview.total_agents) * 100).toFixed(1))
          : 0,
      },
      offers: {
        totalActive: offerStats.total_active_offers,
        externalActive: offerStats.external_active_offers,
      },
      deals: {
        total: dealStats.total_deals,
        withExternalParty: dealStats.deals_with_external_party,
        fullyExternal: dealStats.fully_external_deals,
        // Not the same "external" as /api/admin/metrics economics.business.
        definition: "is_internal-only split, all statuses, no wallet/price/funding checks — NOT a money metric (see /api/admin/metrics economics.business)",
      },
      needs: {
        totalOpen: needStats.total_open_needs,
        externalOpen: needStats.external_open_needs,
      },
      recentExternalAgents: recentExternal,
    };
  });
}
