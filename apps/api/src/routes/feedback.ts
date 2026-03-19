import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { sql } from "../db.js";
import { notifyAgents } from "../webhooks.js";
import { getRequesterAgentId } from "./utils.js";
import { computeTrustTier, computeRaaSScore, computeBadges } from "../shared/utils.js";
import { TRUST_TIERS } from "./utils.js";
import { feedbackSchema } from "./schemas.js";

export default async function feedbackRoutes(app: FastifyInstance) {
  // ── Feedback ──────────────────────────────────────────────────────
  app.post("/api/feedback", async (request, reply) => {
    const body = feedbackSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.fromAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql`
      SELECT buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${body.dealId}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.fromAgentId !== deal.buyer_agent_id && body.fromAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    if (body.toAgentId !== deal.buyer_agent_id && body.toAgentId !== deal.seller_agent_id) {
      return reply.code(400).send({ error: "Feedback target must be a participant in the deal" });
    }
    if (body.fromAgentId === body.toAgentId) {
      return reply.code(400).send({ error: "Feedback target must differ from author" });
    }
    const comment = body.comment ?? null;
    const [entry] = await sql`
      INSERT INTO feedback (
        deal_id, from_agent_id, to_agent_id,
        rating_quality, rating_timeliness, rating_communication, rating_accuracy, comment
      ) VALUES (
        ${body.dealId}, ${body.fromAgentId}, ${body.toAgentId},
        ${body.ratingQuality}, ${body.ratingTimeliness}, ${body.ratingCommunication}, ${body.ratingAccuracy}, ${comment}
      )
      ON CONFLICT (deal_id, from_agent_id, to_agent_id)
      DO UPDATE SET
        rating_quality = EXCLUDED.rating_quality,
        rating_timeliness = EXCLUDED.rating_timeliness,
        rating_communication = EXCLUDED.rating_communication,
        rating_accuracy = EXCLUDED.rating_accuracy,
        comment = EXCLUDED.comment
      RETURNING *
    `;

    const [aggregate] = await sql`
      SELECT COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score
      FROM feedback WHERE to_agent_id = ${body.toAgentId}
    `;

    await sql`UPDATE agents SET reputation_score = ${Number(aggregate.score)} WHERE id = ${body.toAgentId}`;

    notifyAgents(sql, [body.toAgentId], "feedback.received", {
      dealId: body.dealId,
      fromAgentId: body.fromAgentId,
      ratingQuality: body.ratingQuality,
      ratingTimeliness: body.ratingTimeliness,
      ratingCommunication: body.ratingCommunication,
      ratingAccuracy: body.ratingAccuracy,
    });

    return reply.code(201).send(entry);
  });

  // ── Public overview ───────────────────────────────────────────────
  app.get("/api/public/overview", async () => {
    const [stats] = await sql`
      SELECT
        (SELECT COUNT(*) FROM offers WHERE status = 'active')::int AS active_offers,
        (SELECT COUNT(*) FROM needs WHERE status = 'open')::int AS open_needs,
        (SELECT COUNT(*) FROM deals WHERE status IN ('active','delivered','completed'))::int AS live_deals,
        (SELECT COUNT(*) FROM agents)::int AS total_agents
    `;
    return stats;
  });

  // ── Leaderboard ───────────────────────────────────────────────────
  app.get("/api/leaderboard", async (request) => {
    const q = request.query as { sortBy?: string; limit?: string; period?: string };
    const sortBy = q.sortBy ?? "reputation";
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const period = q.period ?? "all";

    let periodFilter = "";
    if (period === "30d") periodFilter = "AND d.created_at >= NOW() - INTERVAL '30 days'";
    else if (period === "7d") periodFilter = "AND d.created_at >= NOW() - INTERVAL '7 days'";

    let orderClause = "reputation_score DESC";
    if (sortBy === "deals") orderClause = "completed_deals DESC";
    else if (sortBy === "volume") orderClause = "total_volume DESC";
    else if (sortBy === "skills") orderClause = "skill_verification_count DESC";

    const rows = await sql.unsafe(`
      SELECT
        a.id AS agent_id,
        a.display_name AS name,
        a.created_at AS member_since,
        COALESCE(a.skills_verified, '{}'::text[]) AS skills_verified,
        COALESCE(a.skill_verification_count, 0)::int AS skill_verification_count,
        COALESCE(f.avg_score, 0) AS reputation_score,
        COALESCE(f.review_count, 0)::int AS review_count,
        COALESCE(ds.completed_deals, 0)::int AS completed_deals,
        COALESCE(ds.total_volume, 0) AS total_volume,
        COALESCE(ds.disputed_deals, 0)::int AS disputed_deals,
        COALESCE(ds.total_deals, 0)::int AS total_deals
      FROM agents a
      LEFT JOIN LATERAL (
        SELECT
          AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) AS avg_score,
          COUNT(*)::int AS review_count
        FROM feedback WHERE to_agent_id = a.id
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE d.status = 'completed')::int AS completed_deals,
          COALESCE(SUM(d.negotiated_total) FILTER (WHERE d.status = 'completed'), 0) AS total_volume,
          COUNT(*) FILTER (WHERE d.status = 'disputed')::int AS disputed_deals,
          COUNT(*)::int AS total_deals
        FROM deals d
        WHERE (d.buyer_agent_id = a.id OR d.seller_agent_id = a.id)
          ${periodFilter}
      ) ds ON true
      ORDER BY ${orderClause}
      LIMIT ${limit}
    `);

    return rows.map((row: Record<string, unknown>, idx: number) => {
      const completedDeals = Number(row.completed_deals);
      const reputationScore = Number(Number(row.reputation_score).toFixed(2));
      const totalDeals = Number(row.total_deals);
      const disputedDeals = Number(row.disputed_deals);
      const trustTier = computeTrustTier(completedDeals, reputationScore);
      return {
        rank: idx + 1,
        agentId: row.agent_id,
        name: row.name,
        trustTier: trustTier.tier,
        reputationScore,
        reviewCount: Number(row.review_count),
        completedDeals,
        skillsVerified: row.skills_verified,
        verificationCount: Number(row.skill_verification_count),
        totalVolume: Number(Number(row.total_volume).toFixed(2)),
        disputeRate: totalDeals > 0 ? Number((disputedDeals / totalDeals).toFixed(4)) : 0,
        memberSince: row.member_since,
      };
    });
  });

  // ── Reputation as a Service (RaaS) ────────────────────────────────

  app.get("/api/reputation/leaderboard", async (request) => {
    const q = request.query as { limit?: string; tier?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const tierFilter = q.tier ?? null;

    const rows = await sql`
      SELECT
        a.id AS agent_id,
        a.display_name AS name,
        a.created_at AS member_since,
        COALESCE(f.avg_score, 0) AS avg_rating,
        COALESCE(f.review_count, 0)::int AS review_count,
        COALESCE(ds.completed_deals, 0)::int AS completed_deals,
        COALESCE(ds.total_volume, 0) AS total_volume,
        COALESCE(ds.disputed_deals, 0)::int AS disputed_deals,
        COALESCE(ds.total_deals, 0)::int AS total_deals,
        COALESCE(e.endorsement_count, 0)::int AS endorsement_count
      FROM agents a
      LEFT JOIN LATERAL (
        SELECT
          AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) AS avg_score,
          COUNT(*)::int AS review_count
        FROM feedback WHERE to_agent_id = a.id
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE d.status = 'completed')::int AS completed_deals,
          COALESCE(SUM(d.negotiated_total) FILTER (WHERE d.status = 'completed'), 0) AS total_volume,
          COUNT(*) FILTER (WHERE d.status = 'disputed')::int AS disputed_deals,
          COUNT(*)::int AS total_deals
        FROM deals d
        WHERE d.buyer_agent_id = a.id OR d.seller_agent_id = a.id
      ) ds ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS endorsement_count
        FROM endorsements WHERE endorsed_id = a.id
      ) e ON true
      ORDER BY a.reputation_score DESC, a.created_at ASC
      LIMIT ${limit}
    `;

    const entries = rows.map((row, idx: number) => {
      const completedDeals = Number(row.completed_deals);
      const avgRating = Number(row.avg_rating);
      const { score, breakdown } = computeRaaSScore(
        completedDeals,
        avgRating,
        Number(row.total_deals),
        Number(row.disputed_deals),
        new Date(row.member_since as string).getTime(),
      );
      const trustTier = computeTrustTier(completedDeals, avgRating);
      return {
        rank: idx + 1,
        agentId: row.agent_id,
        name: row.name,
        trustTier: trustTier.tier,
        score,
        breakdown,
        avgRating: Number(Number(avgRating).toFixed(2)),
        reviewCount: Number(row.review_count),
        completedDeals,
        totalVolume: Number(Number(row.total_volume).toFixed(2)),
        endorsementCount: Number(row.endorsement_count),
        memberSince: row.member_since,
      };
    });

    const tierDist = { gold: 0, silver: 0, bronze: 0, new: 0 } as Record<string, number>;
    for (const e of entries) {
      tierDist[e.trustTier] = (tierDist[e.trustTier] ?? 0) + 1;
    }

    const filtered = tierFilter ? entries.filter(e => e.trustTier === tierFilter) : entries;

    return {
      leaderboard: filtered,
      meta: { total: filtered.length, tierDistribution: tierDist },
    };
  });

  app.get("/api/reputation/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };

    const [agent] = await sql`SELECT id, display_name, created_at FROM agents WHERE id = ${agentId}`;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    const [feedbackStats] = await sql`
      SELECT
        COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS avg_rating,
        COUNT(*)::int AS review_count
      FROM feedback
      WHERE to_agent_id = ${agentId}
    `;

    const [dealStats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_deals,
        COALESCE(SUM(negotiated_total) FILTER (WHERE status = 'completed'), 0) AS total_volume,
        COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed_deals,
        COUNT(*)::int AS total_deals
      FROM deals
      WHERE buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}
    `;

    const [endorseStats] = await sql`
      SELECT COUNT(*)::int AS endorsement_count
      FROM endorsements
      WHERE endorsed_id = ${agentId}
    `;

    const completedDeals = Number(dealStats.completed_deals);
    const avgRating = Number(feedbackStats.avg_rating);
    const totalVolume = Number(Number(dealStats.total_volume).toFixed(2));
    const reviewCount = Number(feedbackStats.review_count);
    const disputedDeals = Number(dealStats.disputed_deals);
    const totalDeals = Number(dealStats.total_deals);
    const endorsementCount = Number(endorseStats.endorsement_count);
    const memberSinceMs = new Date(agent.created_at as string).getTime();

    const { score, breakdown } = computeRaaSScore(
      completedDeals, avgRating, totalDeals, disputedDeals, memberSinceMs,
    );
    const trustTier = computeTrustTier(completedDeals, avgRating);
    const badges = computeBadges({
      completedDeals, totalVolume, disputedDeals, totalDeals, reviewCount, memberSinceMs, endorsementCount,
    });

    return {
      agentId,
      displayName: agent.display_name,
      memberSince: agent.created_at,
      completedDeals,
      totalVolume,
      avgRating: Number(avgRating.toFixed(2)),
      reviewCount,
      disputedDeals,
      totalDeals,
      disputeRate: totalDeals > 0 ? Number((disputedDeals / totalDeals).toFixed(4)) : 0,
      endorsementCount,
      score,
      trustTier: {
        tier: trustTier.tier,
        label: trustTier.label,
        color: trustTier.color,
        thresholds: TRUST_TIERS.map(t => ({
          tier: t.tier,
          minDeals: t.minDeals,
          minReputation: t.minReputation,
        })),
      },
      scoreBreakdown: breakdown,
      badges,
    };
  });

  app.get("/api/reputation/:agentId/attestation", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };

    const [agent] = await sql`SELECT id, display_name, created_at FROM agents WHERE id = ${agentId}`;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    const [feedbackStats] = await sql`
      SELECT
        COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS avg_rating
      FROM feedback
      WHERE to_agent_id = ${agentId}
    `;

    const [dealStats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_deals,
        COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed_deals,
        COUNT(*)::int AS total_deals
      FROM deals
      WHERE buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}
    `;

    const completedDeals = Number(dealStats.completed_deals);
    const avgRating = Number(feedbackStats.avg_rating);
    const { score } = computeRaaSScore(
      completedDeals,
      avgRating,
      Number(dealStats.total_deals),
      Number(dealStats.disputed_deals),
      new Date(agent.created_at as string).getTime(),
    );
    const trustTier = computeTrustTier(completedDeals, avgRating);

    const timestamp = new Date().toISOString();
    const signingKey = process.env.PLATFORM_SIGNING_KEY ?? "agentpact-dev-signing-key";

    const payload = {
      agentId,
      score,
      tier: trustTier.tier,
      completedDeals,
      avgRating: Number(avgRating.toFixed(2)),
      timestamp,
      issuer: "agentpact.xyz",
    };

    const signature = createHmac("sha256", signingKey)
      .update(JSON.stringify(payload))
      .digest("hex");

    return {
      ...payload,
      signature,
      verificationInstructions: "HMAC-SHA256 over JSON.stringify(payload without .signature) using PLATFORM_SIGNING_KEY",
    };
  });

  app.post("/api/reputation/:agentId/endorse", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = z.object({
      skillTag: z.string().min(2).max(64),
      message: z.string().max(500).optional(),
    }).parse(request.body);

    const endorserId = (request as unknown as { agentId: string }).agentId;
    if (!endorserId) return reply.code(401).send({ error: "Authentication required" });
    if (endorserId === agentId) return reply.code(400).send({ error: "Cannot endorse yourself" });

    const [target] = await sql`SELECT id FROM agents WHERE id = ${agentId}`;
    if (!target) return reply.code(404).send({ error: "Agent not found" });

    const [sharedDeal] = await sql`
      SELECT id FROM deals
      WHERE status = 'completed'
        AND (
          (buyer_agent_id = ${endorserId} AND seller_agent_id = ${agentId}) OR
          (buyer_agent_id = ${agentId} AND seller_agent_id = ${endorserId})
        )
      LIMIT 1
    `;
    if (!sharedDeal) {
      return reply.code(403).send({ error: "You must have completed at least one deal with this agent to endorse them" });
    }

    const [endorsement] = await sql`
      INSERT INTO endorsements (endorser_id, endorsed_id, skill_tag, message)
      VALUES (${endorserId}, ${agentId}, ${body.skillTag}, ${body.message ?? null})
      ON CONFLICT (endorser_id, endorsed_id, skill_tag) DO UPDATE SET
        message = EXCLUDED.message,
        created_at = NOW()
      RETURNING *
    `;

    return reply.code(201).send({
      endorsement,
      message: "Endorsement recorded successfully",
    });
  });
}
