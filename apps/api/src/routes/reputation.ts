import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { Deps } from "./types.js";

export const NEUTRAL_REPUTATION_SCORE = 50;

export type ReputationProfile = {
  agent_id: string;
  overall_score: number;
  delivery_rate: number;
  avg_response_time: number | null;
  deal_completion_rate: number;
  dispute_rate: number;
  trust_tier: { tier: string; label: string; color: string };
  total_deals: number;
  total_reviews: number;
  total_completed_deals: number;
  rating_breakdown: {
    quality: number | null;
    timeliness: number | null;
    communication: number | null;
    accuracy: number | null;
  };
};

function roundMetric(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function normalizeResponseTimeScore(avgResponseTime: number | null): number {
  if (avgResponseTime === null) return NEUTRAL_REPUTATION_SCORE;
  const dayInMinutes = 24 * 60;
  const bounded = Math.max(0, Math.min(avgResponseTime, dayInMinutes));
  return roundMetric(100 - (bounded / dayInMinutes) * 100);
}

function computeOverallReputationScore(metrics: {
  averageRating: number | null;
  deliveryRate: number;
  dealCompletionRate: number;
  disputeRate: number;
  avgResponseTime: number | null;
  totalDeals: number;
  totalReviews: number;
}): number {
  if (metrics.totalDeals === 0 && metrics.totalReviews === 0) {
    return NEUTRAL_REPUTATION_SCORE;
  }

  const ratingScore = metrics.averageRating === null
    ? NEUTRAL_REPUTATION_SCORE
    : roundMetric((metrics.averageRating / 5) * 100);
  const deliveryScore = metrics.totalDeals === 0 ? NEUTRAL_REPUTATION_SCORE : metrics.deliveryRate;
  const completionScore = metrics.totalDeals === 0 ? NEUTRAL_REPUTATION_SCORE : metrics.dealCompletionRate;
  const disputeScore = metrics.totalDeals === 0 ? NEUTRAL_REPUTATION_SCORE : roundMetric(100 - metrics.disputeRate);
  const responseScore = normalizeResponseTimeScore(metrics.avgResponseTime);

  return roundMetric(
    ratingScore * 0.4 +
    deliveryScore * 0.2 +
    completionScore * 0.15 +
    responseScore * 0.15 +
    disputeScore * 0.1,
  );
}

// Pure transform from the raw aggregate row (produced by the stats query below
// and by the single-query leaderboard) into a ReputationProfile. Extracted so
// the leaderboard can score every agent from ONE query instead of issuing one
// getReputationProfile round-trip per agent (the N+1 that saturated the pool).
function computeProfileFromStats(
  agentId: string,
  stats: Record<string, unknown>,
  computeTrustTier: Deps["computeTrustTier"],
): ReputationProfile {
  const totalDeals = Number(stats.total_deals ?? 0);
  const totalCompletedDeals = Number(stats.total_completed_deals ?? 0);
  const totalReviews = Number(stats.review_count ?? 0);
  const sellerDeals = Number(stats.seller_deals ?? 0);
  const sellerCompletedDeals = Number(stats.seller_completed_deals ?? 0);
  const disputedDeals = Number(stats.disputed_deals ?? 0);
  const averageRating = stats.avg_rating === null || stats.avg_rating === undefined ? null : Number(stats.avg_rating);
  const avgResponseTime = stats.avg_response_time === null || stats.avg_response_time === undefined ? null : roundMetric(Number(stats.avg_response_time));
  const deliveryRate = sellerDeals > 0 ? roundMetric((sellerCompletedDeals / sellerDeals) * 100) : 0;
  const dealCompletionRate = totalDeals > 0 ? roundMetric((totalCompletedDeals / totalDeals) * 100) : 0;
  const disputeRate = totalDeals > 0 ? roundMetric((disputedDeals / totalDeals) * 100) : 0;
  const trustTier = computeTrustTier(totalCompletedDeals, averageRating ?? 0);

  return {
    agent_id: agentId,
    overall_score: computeOverallReputationScore({
      averageRating,
      deliveryRate,
      dealCompletionRate,
      disputeRate,
      avgResponseTime,
      totalDeals,
      totalReviews,
    }),
    delivery_rate: deliveryRate,
    avg_response_time: avgResponseTime,
    deal_completion_rate: dealCompletionRate,
    dispute_rate: disputeRate,
    trust_tier: trustTier,
    total_deals: totalDeals,
    total_reviews: totalReviews,
    total_completed_deals: totalCompletedDeals,
    rating_breakdown: {
      quality: stats.avg_quality === null || stats.avg_quality === undefined ? null : roundMetric(Number(stats.avg_quality)),
      timeliness: stats.avg_timeliness === null || stats.avg_timeliness === undefined ? null : roundMetric(Number(stats.avg_timeliness)),
      communication: stats.avg_communication === null || stats.avg_communication === undefined ? null : roundMetric(Number(stats.avg_communication)),
      accuracy: stats.avg_accuracy === null || stats.avg_accuracy === undefined ? null : roundMetric(Number(stats.avg_accuracy)),
    },
  };
}

export async function getReputationProfile(
  db: Sql<Record<string, unknown>>,
  computeTrustTier: Deps["computeTrustTier"],
  agentId: string,
): Promise<ReputationProfile | null> {
  const [agent] = await db`
    SELECT id
    FROM agents
    WHERE id = ${agentId}
  `;

  if (!agent) {
    return null;
  }

  const [stats] = await db`
    SELECT
      fb.review_count,
      fb.avg_quality,
      fb.avg_timeliness,
      fb.avg_communication,
      fb.avg_accuracy,
      fb.avg_rating,
      deals.total_deals,
      deals.total_completed_deals,
      deals.disputed_deals,
      deals.seller_deals,
      deals.seller_completed_deals,
      resp.avg_response_time
    FROM (SELECT ${agentId}::uuid AS agent_id) subject
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS review_count,
        AVG(rating_quality) AS avg_quality,
        AVG(rating_timeliness) AS avg_timeliness,
        AVG(rating_communication) AS avg_communication,
        AVG(rating_accuracy) AS avg_accuracy,
        AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) AS avg_rating
      FROM feedback
      WHERE to_agent_id = subject.agent_id
    ) fb ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS total_deals,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS total_completed_deals,
        COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed_deals,
        COUNT(*) FILTER (WHERE seller_agent_id = subject.agent_id)::int AS seller_deals,
        COUNT(*) FILTER (WHERE seller_agent_id = subject.agent_id AND status = 'completed')::int AS seller_completed_deals
      FROM deals
      WHERE buyer_agent_id = subject.agent_id OR seller_agent_id = subject.agent_id
    ) deals ON true
    LEFT JOIN LATERAL (
      SELECT
        AVG(GREATEST(EXTRACT(EPOCH FROM (accept_event.created_at - d.created_at)) / 60.0, 0)) AS avg_response_time
      FROM deals d
      JOIN LATERAL (
        SELECT created_at
        FROM negotiation_events
        WHERE deal_id = d.id
          AND actor_agent_id = subject.agent_id
          AND event_type = 'accept'
        ORDER BY created_at ASC
        LIMIT 1
      ) accept_event ON true
      WHERE d.seller_agent_id = subject.agent_id
    ) resp ON true
  `;

  return computeProfileFromStats(agentId, stats as Record<string, unknown>, computeTrustTier);
}

async function listReputationLeaderboard(
  db: Sql<Record<string, unknown>>,
  computeTrustTier: Deps["computeTrustTier"],
  opts: { limit: number; category?: string | null },
): Promise<Array<ReputationProfile & { rank: number; agent_name: string; category_match_count: number }>> {
  // Single-query leaderboard. Previously this loaded every agent and then issued
  // one getReputationProfile round-trip PER agent via Promise.all — an unbounded
  // N+1 that fired ~1.4k concurrent queries against a 20-connection pool and
  // produced CONNECTION_CLOSED / pool-saturation cascades once the marketplace
  // grew past a few dozen agents. We now compute all per-agent aggregates in ONE
  // statement (LATERAL subqueries mirror getReputationProfile's stats query),
  // then score + sort + slice in JS. Ranking semantics are unchanged.
  const category = opts.category ?? null;
  const rows = await db`
    SELECT
      a.id,
      a.display_name,
      fb.review_count,
      fb.avg_quality,
      fb.avg_timeliness,
      fb.avg_communication,
      fb.avg_accuracy,
      fb.avg_rating,
      deals.total_deals,
      deals.total_completed_deals,
      deals.disputed_deals,
      deals.seller_deals,
      deals.seller_completed_deals,
      resp.avg_response_time,
      COALESCE(cat.category_match_count, 0)::int AS category_match_count
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS review_count,
        AVG(rating_quality) AS avg_quality,
        AVG(rating_timeliness) AS avg_timeliness,
        AVG(rating_communication) AS avg_communication,
        AVG(rating_accuracy) AS avg_accuracy,
        AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) AS avg_rating
      FROM feedback
      WHERE to_agent_id = a.id
    ) fb ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS total_deals,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS total_completed_deals,
        COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed_deals,
        COUNT(*) FILTER (WHERE seller_agent_id = a.id)::int AS seller_deals,
        COUNT(*) FILTER (WHERE seller_agent_id = a.id AND status = 'completed')::int AS seller_completed_deals
      FROM deals
      WHERE buyer_agent_id = a.id OR seller_agent_id = a.id
    ) deals ON true
    LEFT JOIN LATERAL (
      SELECT
        AVG(GREATEST(EXTRACT(EPOCH FROM (accept_event.created_at - d.created_at)) / 60.0, 0)) AS avg_response_time
      FROM deals d
      JOIN LATERAL (
        SELECT created_at
        FROM negotiation_events
        WHERE deal_id = d.id
          AND actor_agent_id = a.id
          AND event_type = 'accept'
        ORDER BY created_at ASC
        LIMIT 1
      ) accept_event ON true
      WHERE d.seller_agent_id = a.id
    ) resp ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS category_match_count
      FROM offers o
      WHERE o.agent_id = a.id
        AND o.status = 'active'
        AND ${category}::text IS NOT NULL
        AND o.category = ${category}::text
    ) cat ON true
    WHERE ${category}::text IS NULL
      OR EXISTS (
        SELECT 1
        FROM offers match_offer
        WHERE match_offer.agent_id = a.id
          AND match_offer.status = 'active'
          AND match_offer.category = ${category}::text
      )
  `;

  return rows
    .map((row) => ({
      ...computeProfileFromStats(String(row.id), row as Record<string, unknown>, computeTrustTier),
      agent_name: String(row.display_name),
      category_match_count: Number(row.category_match_count ?? 0),
    }))
    .sort((left, right) =>
      right.overall_score - left.overall_score ||
      right.total_completed_deals - left.total_completed_deals ||
      right.total_reviews - left.total_reviews ||
      left.agent_name.localeCompare(right.agent_name))
    .slice(0, opts.limit)
    .map((profile, index) => ({ ...profile, rank: index + 1 }));
}

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, deps: Deps): Promise<void> {
  app.get("/api/agents/:id/reputation", async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await getReputationProfile(sql, deps.computeTrustTier, id);
    if (!profile) return reply.code(404).send({ error: "Agent not found" });
    return profile;
  });

  app.get("/api/leaderboard", async (request) => {
    const q = request.query as { limit?: string; category?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const entries = await listReputationLeaderboard(sql, deps.computeTrustTier, { limit, category: q.category ?? null });
    return entries.map((entry) => ({
      rank: entry.rank,
      agentId: entry.agent_id,
      name: entry.agent_name,
      trustTier: entry.trust_tier.tier,
      reputationScore: entry.overall_score,
      reviewCount: entry.total_reviews,
      completedDeals: entry.total_completed_deals,
      disputeRate: entry.dispute_rate,
      categoryMatchCount: entry.category_match_count,
    }));
  });
}
