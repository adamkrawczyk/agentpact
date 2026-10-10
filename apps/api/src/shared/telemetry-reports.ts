// honest_0710 phase D — read side of telemetry for GET /api/admin/usage and
// GET /api/admin/funnel. Plan v3.1 gates are evaluated from these numbers.
//
// "External" for a deal stage is the ONE shared definition: the deal appears
// in the `qualifying_deals` view (migration 052), and capital_at_risk is that
// view's column. Nothing here re-derives the rule inline.
import { z } from "zod";
import type { sql as dbSql } from "../db.js";
import type { TelemetryStats } from "../plugins/telemetry.js";

type Db = typeof dbSql;

export const FUNNEL_STAGES = [
  "need_posted",
  "proposed",
  "accepted",
  "funded",
  "delivered",
  "accepted_delivery",
  "disputed",
  "settled",
  "refunded",
  "reorder",
] as const;

const DEFAULT_WINDOW_DAYS = 7;

const sinceQuerySchema = z.object({
  since: z
    .union([z.string().date(), z.string().datetime({ offset: true })])
    .optional(),
});

/** Parses `?since=`; defaults to 7 days ago. Throws a ZodError (→ 400) when malformed. */
export function parseSince(query: unknown, now: Date = new Date()): Date {
  const { since } = sinceQuerySchema.parse(query ?? {});
  return since ? new Date(since) : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
}

export async function usageReport(sql: Db, since: Date, writer: TelemetryStats | null) {
  const [totals] = await sql`
    SELECT
      COUNT(*)::int AS requests,
      COUNT(DISTINCT u.agent_id)::int AS distinct_agents,
      COUNT(DISTINCT u.agent_id) FILTER (WHERE a.is_internal = FALSE)::int AS distinct_external_agents,
      COUNT(*) FILTER (WHERE u.agent_id IS NULL)::int AS anonymous_requests
    FROM api_usage u
    LEFT JOIN agents a ON a.id = u.agent_id
    WHERE u.created_at >= ${since}
  `;

  const perDay = await sql`
    SELECT
      to_char(date_trunc('day', u.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS requests,
      COUNT(DISTINCT u.agent_id)::int AS distinct_agents,
      COUNT(DISTINCT u.agent_id) FILTER (WHERE a.is_internal = FALSE)::int AS distinct_external_agents
    FROM api_usage u
    LEFT JOIN agents a ON a.id = u.agent_id
    WHERE u.created_at >= ${since}
    GROUP BY 1
    ORDER BY 1
  `;

  // Per-endpoint distinct external callers: the M2 diagnostic ("are external
  // agents calling check_agent?") reads distinctExternalAgents here.
  const endpoints = await sql`
    SELECT
      u.endpoint,
      u.method,
      COUNT(*)::int AS requests,
      COUNT(*) FILTER (WHERE u.status_code >= 500)::int AS errors,
      COUNT(DISTINCT u.agent_id)::int AS distinct_agents,
      COUNT(DISTINCT u.agent_id) FILTER (WHERE a.is_internal = FALSE)::int AS distinct_external_agents,
      COUNT(*) FILTER (WHERE u.agent_id IS NULL)::int AS anonymous_requests,
      COALESCE(ROUND(AVG(u.response_time_ms)), 0)::int AS avg_ms
    FROM api_usage u
    LEFT JOIN agents a ON a.id = u.agent_id
    WHERE u.created_at >= ${since}
    GROUP BY u.endpoint, u.method
    ORDER BY requests DESC, u.endpoint ASC, u.method ASC
    LIMIT 50
  `;

  const clientKinds = await sql`
    SELECT COALESCE(client_kind, 'other') AS kind, COUNT(*)::int AS requests
    FROM api_usage
    WHERE created_at >= ${since}
    GROUP BY 1
  `;

  return {
    since: since.toISOString(),
    totals: {
      requests: Number(totals.requests),
      distinctAgents: Number(totals.distinct_agents),
      distinctExternalAgents: Number(totals.distinct_external_agents),
      anonymousRequests: Number(totals.anonymous_requests),
    },
    perDay: perDay.map((r) => ({
      day: String(r.day),
      requests: Number(r.requests),
      distinctAgents: Number(r.distinct_agents),
      distinctExternalAgents: Number(r.distinct_external_agents),
    })),
    endpoints: endpoints.map((r) => ({
      endpoint: String(r.endpoint),
      method: String(r.method),
      requests: Number(r.requests),
      errors: Number(r.errors),
      distinctAgents: Number(r.distinct_agents),
      distinctExternalAgents: Number(r.distinct_external_agents),
      anonymousRequests: Number(r.anonymous_requests),
      avgMs: Number(r.avg_ms),
    })),
    clientKinds: Object.fromEntries(clientKinds.map((r) => [String(r.kind), Number(r.requests)])),
    // Process-local writer health since this API instance booted.
    writer,
  };
}

export async function funnelEventsReport(sql: Db, since: Date) {
  const rows = await sql`
    SELECT
      fe.stage,
      COUNT(*)::int AS all_count,
      COUNT(*) FILTER (
        WHERE (fe.deal_id IS NULL AND a.is_internal = FALSE) OR qd.deal_id IS NOT NULL
      )::int AS external_count,
      COUNT(*) FILTER (WHERE qd.capital_at_risk)::int AS capital_at_risk_count
    FROM funnel_events fe
    LEFT JOIN qualifying_deals qd ON qd.deal_id = fe.deal_id
    LEFT JOIN agents a ON a.id = fe.agent_id
    WHERE fe.occurred_at >= ${since}
    GROUP BY fe.stage
  `;
  const byStage = new Map(rows.map((r) => [String(r.stage), r]));
  return {
    since: since.toISOString(),
    definitions: {
      all: "every funnel event in the window",
      external: "deal stages: deal is in qualifying_deals; need_posted: poster is not internal",
      capitalAtRisk: "deal stages: qualifying_deals.capital_at_risk; null for need_posted (no deal yet)",
    },
    stages: FUNNEL_STAGES.map((stage) => {
      const r = byStage.get(stage);
      return {
        stage,
        all: Number(r?.all_count ?? 0),
        external: Number(r?.external_count ?? 0),
        capitalAtRisk: stage === "need_posted" ? null : Number(r?.capital_at_risk_count ?? 0),
      };
    }),
  };
}
