import { randomUUID } from "node:crypto";
import { sql } from "../db.js";
import { TRUST_TIERS } from "./schemas.js";
export function idempotencyKey(headers) {
    return String(headers["idempotency-key"] ?? randomUUID());
}
export function toNumber(v) {
    return Number(v);
}
export function isZeroPrice(value) {
    return toNumber(value) === 0;
}
export function withReputationOnlyTag(tags) {
    const normalized = Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string")
        : [];
    return normalized.includes("reputation-only")
        ? normalized
        : [...normalized, "reputation-only"];
}
export function normalizeTags(tags) {
    return Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string")
        : [];
}
export function enrichOfferRow(offer) {
    const isFreeTier = isZeroPrice(offer.base_price);
    return {
        ...offer,
        tags: isFreeTier ? withReputationOnlyTag(offer.tags) : normalizeTags(offer.tags),
        is_free_tier: isFreeTier,
        pricing_model: isFreeTier ? "reputation-only" : "paid",
    };
}
export function parseBooleanish(value) {
    if (typeof value !== "string")
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}
export function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
export function getRequesterAgentId(request, reply) {
    const requesterAgentId = request.agentId;
    if (!requesterAgentId) {
        reply.code(401).send({ error: "Missing API key" });
        return null;
    }
    return requesterAgentId;
}
export function computeTrustTier(completedDeals, reputationScore) {
    for (const t of TRUST_TIERS) {
        if (completedDeals >= t.minDeals && reputationScore >= t.minReputation) {
            return { tier: t.tier, label: t.label, color: t.color };
        }
    }
    return { tier: "new", label: "New", color: "#888888" };
}
export async function getAgentStats(agentId) {
    const [stats] = await sql `
    SELECT
      (SELECT COUNT(*)::int FROM deals WHERE (buyer_agent_id = ${agentId} OR seller_agent_id = ${agentId}) AND status = 'completed') AS completed_deals,
      COALESCE((SELECT AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0) FROM feedback WHERE to_agent_id = ${agentId}), 0) AS reputation_score
  `;
    return {
        completedDeals: Number(stats.completed_deals),
        reputationScore: Number(stats.reputation_score),
    };
}
export function buildSemanticText(input) {
    const tags = Array.isArray(input.tags) ? input.tags.join(", ") : "";
    return [input.title ?? "", input.description_md ?? "", input.category ?? "", tags]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
}
export function extractEmbedding(value) {
    if (!Array.isArray(value))
        return null;
    const embedding = [];
    for (const item of value) {
        if (typeof item !== "number" || !Number.isFinite(item))
            return null;
        embedding.push(item);
    }
    return embedding.length > 0 ? embedding : null;
}
export function computeRaaSScore(completedDeals, avgRating, totalDeals, disputedDeals, memberSinceMs) {
    const dealHistory = Math.min(completedDeals / 50, 1) * 100;
    const reviewAvg = (avgRating / 5) * 100;
    const disputeRate = totalDeals > 0
        ? Math.max(0, 1 - (disputedDeals / totalDeals) * 2) * 100
        : 100;
    const ageMs = Date.now() - memberSinceMs;
    const accountAge = Math.min(ageMs / (365 * 24 * 60 * 60 * 1000), 1) * 100;
    const score = dealHistory * 0.4 + reviewAvg * 0.3 + disputeRate * 0.2 + accountAge * 0.1;
    return {
        score: Number(score.toFixed(2)),
        breakdown: {
            dealHistory: Number(dealHistory.toFixed(2)),
            reviewAvg: Number(reviewAvg.toFixed(2)),
            disputeRate: Number(disputeRate.toFixed(2)),
            accountAge: Number(accountAge.toFixed(2)),
        },
    };
}
export function computeBadges(opts) {
    const badges = [];
    const ageMs = Date.now() - opts.memberSinceMs;
    const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);
    if (ageMonths <= 3)
        badges.push("early-adopter");
    if (opts.completedDeals >= 50)
        badges.push("high-volume");
    if (opts.totalVolume >= 10000)
        badges.push("big-earner");
    if (opts.disputedDeals === 0 && opts.totalDeals >= 5)
        badges.push("zero-disputes");
    if (opts.reviewCount >= 20)
        badges.push("well-reviewed");
    if (opts.endorsementCount >= 5)
        badges.push("trusted-peer");
    if (opts.completedDeals >= 100)
        badges.push("century-club");
    return badges;
}
export function gradeSkillSubmission(expectedCriteria, submission) {
    const mode = typeof expectedCriteria.mode === "string" ? expectedCriteria.mode : "";
    if (mode === "keyword") {
        const keywords = Array.isArray(expectedCriteria.keywords)
            ? expectedCriteria.keywords.filter((k) => typeof k === "string")
            : [];
        const minMatches = typeof expectedCriteria.minMatches === "number"
            ? expectedCriteria.minMatches
            : keywords.length;
        const haystack = JSON.stringify(submission ?? {}).toLowerCase();
        const matched = keywords.filter((kw) => haystack.includes(kw.toLowerCase()));
        const passed = matched.length >= minMatches;
        const score = keywords.length > 0
            ? Number(((matched.length / keywords.length) * 100).toFixed(2))
            : 0;
        return {
            deterministic: true,
            passed,
            score,
            gradingNotes: `Matched ${matched.length}/${keywords.length} required keywords`,
        };
    }
    if (mode === "required_json_keys") {
        if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
            return {
                deterministic: true,
                passed: false,
                score: 0,
                gradingNotes: "Submission must be a JSON object",
            };
        }
        const requiredKeys = Array.isArray(expectedCriteria.requiredKeys)
            ? expectedCriteria.requiredKeys.filter((k) => typeof k === "string")
            : [];
        const submissionRecord = submission;
        const present = requiredKeys.filter((key) => submissionRecord[key] !== undefined);
        const passed = requiredKeys.length > 0 && present.length === requiredKeys.length;
        const score = requiredKeys.length > 0
            ? Number(((present.length / requiredKeys.length) * 100).toFixed(2))
            : 0;
        return {
            deterministic: true,
            passed,
            score,
            gradingNotes: `Found ${present.length}/${requiredKeys.length} required keys`,
        };
    }
    return {
        deterministic: false,
        passed: false,
        score: null,
        gradingNotes: "Submission queued for manual/AI grading",
    };
}
export async function audit(actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
