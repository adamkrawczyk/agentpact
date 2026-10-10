/**
 * Evidence-only public aggregates (honest_0710 R1-04 / R1-10).
 *
 * Every public number shown next to a trust tier — both leaderboards, the
 * reputation profile, the attestation and /api/agents/:id/reputation — comes
 * from here, so practice deals, self/same-owner/fleet deals, unfunded deals and
 * dust deals can never upgrade a tier, a score, a review count or a volume.
 *
 *  - reviews, ratings, completed deals, volume: `reputation_evidence_deals`
 *    (migration 054: completed, capital_at_risk, >= $0.01 escrowed). Volume is
 *    the USDC escrowed for those deals, capped at the agreed price.
 *  - total / disputed / seller deals and response time (the rate
 *    denominators): funded qualifying deals (`qualifying_deals` WHERE
 *    capital_at_risk), any status.
 */
import type { Sql } from "postgres";
import { MIN_EVIDENCE_USDC, QUALIFYING_DEALS_VIEW, REPUTATION_EVIDENCE_VIEW } from "./qualifying.js";

type Db = Sql<Record<string, unknown>>;

/** One-line label shipped next to every evidence-only aggregate. */
export const EVIDENCE_BASIS =
  `Counts, ratings and volume use paid, external, settled deals only (real USDC escrowed, at least $${MIN_EVIDENCE_USDC.toFixed(2)}, ` +
  "between different owners, no fleet agents). Practice ($0) deals and their reviews never count.";

/**
 * Raw aggregate row in the shape reputation.ts computeProfileFromStats() reads
 * (snake_case), plus total_volume.
 */
export type EvidenceAggregateRow = {
  agent_id: string;
  review_count: number;
  avg_quality: number | null;
  avg_timeliness: number | null;
  avg_communication: number | null;
  avg_accuracy: number | null;
  avg_rating: number | null;
  total_deals: number;
  total_completed_deals: number;
  disputed_deals: number;
  seller_deals: number;
  seller_completed_deals: number;
  total_volume: number;
  avg_response_time: number | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function getEvidenceAggregates(db: Db, agentIds: string[]): Promise<Map<string, EvidenceAggregateRow>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db`
    SELECT
      subj.agent_id,
      fb.review_count, fb.avg_quality, fb.avg_timeliness, fb.avg_communication, fb.avg_accuracy, fb.avg_rating,
      funded.total_deals, funded.disputed_deals, funded.seller_deals,
      ev.total_completed_deals, ev.seller_completed_deals, ev.total_volume,
      resp.avg_response_time
    FROM (SELECT DISTINCT unnest(${agentIds}::uuid[]) AS agent_id) subj
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS review_count,
        AVG(f.rating_quality) AS avg_quality,
        AVG(f.rating_timeliness) AS avg_timeliness,
        AVG(f.rating_communication) AS avg_communication,
        AVG(f.rating_accuracy) AS avg_accuracy,
        AVG((f.rating_quality + f.rating_timeliness + f.rating_communication + f.rating_accuracy) / 4.0) AS avg_rating
      FROM feedback f
      JOIN ${db(REPUTATION_EVIDENCE_VIEW)} e ON e.deal_id = f.deal_id
      WHERE f.to_agent_id = subj.agent_id
    ) fb ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS total_deals,
        COUNT(*) FILTER (WHERE q.status = 'disputed')::int AS disputed_deals,
        COUNT(*) FILTER (WHERE q.seller_agent_id = subj.agent_id)::int AS seller_deals
      FROM ${db(QUALIFYING_DEALS_VIEW)} q
      WHERE q.capital_at_risk
        AND (q.buyer_agent_id = subj.agent_id OR q.seller_agent_id = subj.agent_id)
    ) funded ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS total_completed_deals,
        COUNT(*) FILTER (WHERE e.seller_agent_id = subj.agent_id)::int AS seller_completed_deals,
        COALESCE(SUM(e.settled_usdc), 0) AS total_volume
      FROM ${db(REPUTATION_EVIDENCE_VIEW)} e
      WHERE e.buyer_agent_id = subj.agent_id OR e.seller_agent_id = subj.agent_id
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT AVG(GREATEST(EXTRACT(EPOCH FROM (accept_event.created_at - q.created_at)) / 60.0, 0)) AS avg_response_time
      FROM ${db(QUALIFYING_DEALS_VIEW)} q
      JOIN LATERAL (
        SELECT created_at FROM negotiation_events
        WHERE deal_id = q.deal_id AND actor_agent_id = subj.agent_id AND event_type = 'accept'
        ORDER BY created_at ASC
        LIMIT 1
      ) accept_event ON true
      WHERE q.capital_at_risk AND q.seller_agent_id = subj.agent_id
    ) resp ON true
  `;
  return new Map(rows.map((r) => [String(r.agent_id), {
    agent_id: String(r.agent_id),
    review_count: Number(r.review_count ?? 0),
    avg_quality: num(r.avg_quality),
    avg_timeliness: num(r.avg_timeliness),
    avg_communication: num(r.avg_communication),
    avg_accuracy: num(r.avg_accuracy),
    avg_rating: num(r.avg_rating),
    total_deals: Number(r.total_deals ?? 0),
    total_completed_deals: Number(r.total_completed_deals ?? 0),
    disputed_deals: Number(r.disputed_deals ?? 0),
    seller_deals: Number(r.seller_deals ?? 0),
    seller_completed_deals: Number(r.seller_completed_deals ?? 0),
    total_volume: Number(r.total_volume ?? 0),
    avg_response_time: num(r.avg_response_time),
  }]));
}

export async function getEvidenceAggregate(db: Db, agentId: string): Promise<EvidenceAggregateRow> {
  return (await getEvidenceAggregates(db, [agentId])).get(agentId) as EvidenceAggregateRow;
}

// ── Paid settled external: the ONE money number (admin + public) ────────────

/**
 * Definition label shipped next to every consumer of computePaidSettledExternal().
 * Same wording family as PUBLIC_STATS_METHOD.
 */
export const PAID_SETTLED_EXTERNAL_DEFINITION =
  "qualifying_deals.capital_at_risk AND status='completed'; volume = LEAST(negotiated_total, escrowed)";

export type PaidSettledExternal = {
  deals: number;
  /** Integer US cents as a decimal string (USDC is 1:1 USD), floored. */
  volumeCents: string;
};

/**
 * Completed, capital-at-risk, qualifying deals and the USDC actually escrowed
 * for them (capped at the agreed price — R1-06). `/api/stats/public` and
 * `/api/admin/metrics` both read this, so "external" can only mean one thing.
 * Uncached: callers that need caching (the public route) cache around it.
 */
export async function computePaidSettledExternal(db: Db): Promise<PaidSettledExternal> {
  const [row] = await db`
    SELECT
      count(*)::int AS deals,
      floor(coalesce(sum(LEAST(negotiated_total, ap_deal_escrowed_usdc(deal_id))), 0) * 100)::bigint::text AS volume_cents
    FROM ${db(QUALIFYING_DEALS_VIEW)}
    WHERE capital_at_risk AND status = 'completed'
  `;
  return { deals: Number(row.deals ?? 0), volumeCents: String(row.volume_cents ?? "0") };
}
