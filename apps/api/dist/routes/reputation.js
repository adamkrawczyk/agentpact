export const NEUTRAL_REPUTATION_SCORE = 50;
function roundMetric(value, digits = 2) {
    return Number(value.toFixed(digits));
}
function normalizeResponseTimeScore(avgResponseTime) {
    if (avgResponseTime === null)
        return NEUTRAL_REPUTATION_SCORE;
    const dayInMinutes = 24 * 60;
    const bounded = Math.max(0, Math.min(avgResponseTime, dayInMinutes));
    return roundMetric(100 - (bounded / dayInMinutes) * 100);
}
function computeOverallReputationScore(metrics) {
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
    return roundMetric(ratingScore * 0.4 +
        deliveryScore * 0.2 +
        completionScore * 0.15 +
        responseScore * 0.15 +
        disputeScore * 0.1);
}
export async function getReputationProfile(db, computeTrustTier, agentId) {
    const [agent] = await db `
    SELECT id
    FROM agents
    WHERE id = ${agentId}
  `;
    if (!agent) {
        return null;
    }
    const [stats] = await db `
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
    const totalDeals = Number(stats.total_deals ?? 0);
    const totalCompletedDeals = Number(stats.total_completed_deals ?? 0);
    const totalReviews = Number(stats.review_count ?? 0);
    const sellerDeals = Number(stats.seller_deals ?? 0);
    const sellerCompletedDeals = Number(stats.seller_completed_deals ?? 0);
    const disputedDeals = Number(stats.disputed_deals ?? 0);
    const averageRating = stats.avg_rating === null ? null : Number(stats.avg_rating);
    const avgResponseTime = stats.avg_response_time === null ? null : roundMetric(Number(stats.avg_response_time));
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
            quality: stats.avg_quality === null ? null : roundMetric(Number(stats.avg_quality)),
            timeliness: stats.avg_timeliness === null ? null : roundMetric(Number(stats.avg_timeliness)),
            communication: stats.avg_communication === null ? null : roundMetric(Number(stats.avg_communication)),
            accuracy: stats.avg_accuracy === null ? null : roundMetric(Number(stats.avg_accuracy)),
        },
    };
}
async function listReputationLeaderboard(db, computeTrustTier, opts) {
    const candidates = await db `
    SELECT
      a.id,
      a.display_name,
      COUNT(*) FILTER (
        WHERE ${opts.category ?? null}::text IS NOT NULL
          AND o.category = ${opts.category ?? null}::text
          AND o.status = 'active'
      )::int AS category_match_count
    FROM agents a
    LEFT JOIN offers o ON o.agent_id = a.id
    WHERE ${opts.category ?? null}::text IS NULL
      OR EXISTS (
        SELECT 1
        FROM offers match_offer
        WHERE match_offer.agent_id = a.id
          AND match_offer.status = 'active'
          AND match_offer.category = ${opts.category ?? null}::text
      )
    GROUP BY a.id, a.display_name
  `;
    const profiles = await Promise.all(candidates.map(async (row) => {
        const profile = await getReputationProfile(db, computeTrustTier, String(row.id));
        if (!profile)
            return null;
        return {
            ...profile,
            agent_name: String(row.display_name),
            category_match_count: Number(row.category_match_count ?? 0),
        };
    }));
    return profiles
        .filter((profile) => profile !== null)
        .sort((left, right) => right.overall_score - left.overall_score ||
        right.total_completed_deals - left.total_completed_deals ||
        right.total_reviews - left.total_reviews ||
        left.agent_name.localeCompare(right.agent_name))
        .slice(0, opts.limit)
        .map((profile, index) => ({ ...profile, rank: index + 1 }));
}
export async function registerRoutes(app, sql, deps) {
    app.get("/api/agents/:id/reputation", async (request, reply) => {
        const { id } = request.params;
        const profile = await getReputationProfile(sql, deps.computeTrustTier, id);
        if (!profile)
            return reply.code(404).send({ error: "Agent not found" });
        return profile;
    });
    app.get("/api/leaderboard", async (request) => {
        const q = request.query;
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
