import { z } from "zod";
import { agentIdParamSchema, challengeIdParamSchema, listChallengesQuerySchema, onlineAgentsQuerySchema, startChallengeSchema, submitChallengeSchema, } from "./schemas.js";
import { getRequesterAgentId, getAgentStats, computeTrustTier } from "./utils.js";
function gradeSkillSubmission(expectedCriteria, submission) {
    const mode = typeof expectedCriteria.mode === "string" ? expectedCriteria.mode : "";
    if (mode === "keyword") {
        const keywords = Array.isArray(expectedCriteria.keywords)
            ? expectedCriteria.keywords.filter((k) => typeof k === "string")
            : [];
        const minMatches = typeof expectedCriteria.minMatches === "number" ? expectedCriteria.minMatches : keywords.length;
        const haystack = JSON.stringify(submission ?? {}).toLowerCase();
        const matched = keywords.filter((kw) => haystack.includes(kw.toLowerCase()));
        const passed = matched.length >= minMatches;
        const score = keywords.length > 0 ? Number(((matched.length / keywords.length) * 100).toFixed(2)) : 0;
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
        const score = requiredKeys.length > 0 ? Number(((present.length / requiredKeys.length) * 100).toFixed(2)) : 0;
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
export async function registerRoutes(app, sql, _deps) {
    app.post("/api/agents", async (request, reply) => {
        const body = z
            .object({
            handle: z.string().min(3),
            displayName: z.string().min(2),
            ownerWalletAddress: z.string().min(4),
            walletProvider: z.enum(["metamask", "walletconnect", "coinbase"]),
            autoBuyEnabled: z.boolean().default(false)
        })
            .parse(request.body);
        const [agent] = await sql `
      INSERT INTO agents (handle, display_name, owner_wallet_address, wallet_provider, auto_buy_enabled)
      VALUES (${body.handle}, ${body.displayName}, ${body.ownerWalletAddress}, ${body.walletProvider}, ${body.autoBuyEnabled})
      ON CONFLICT (handle) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        owner_wallet_address = EXCLUDED.owner_wallet_address,
        wallet_provider = EXCLUDED.wallet_provider,
        auto_buy_enabled = EXCLUDED.auto_buy_enabled
      RETURNING *
    `;
        return reply.code(201).send(agent);
    });
    app.get("/api/agents/:id", async (request, reply) => {
        const { id } = request.params;
        const [agent] = await sql `SELECT * FROM agents WHERE id = ${id}`;
        if (!agent)
            return reply.code(404).send({ error: "Agent not found" });
        const [reputation] = await sql `
      SELECT
        COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score,
        COUNT(*)::int AS review_count
      FROM feedback
      WHERE to_agent_id = ${id}
    `;
        const agentStats = await getAgentStats(sql, id);
        const trustTier = computeTrustTier(agentStats.completedDeals, agentStats.reputationScore);
        return {
            ...agent,
            reputation: {
                score: Number(reputation.score ?? 0),
                reviewCount: Number(reputation.review_count ?? 0)
            },
            trustTier
        };
    });
    app.get("/api/agents/:id/reputation", async (request) => {
        const { id } = request.params;
        const [aggregate] = await sql `
      SELECT
        COALESCE(AVG((rating_quality + rating_timeliness + rating_communication + rating_accuracy) / 4.0), 0) AS score,
        COUNT(*)::int AS review_count
      FROM feedback
      WHERE to_agent_id = ${id}
    `;
        return {
            agentId: id,
            score: Number(aggregate.score ?? 0),
            reviewCount: Number(aggregate.review_count ?? 0)
        };
    });
    app.post("/api/agents/:id/heartbeat", async (request, reply) => {
        const { id } = agentIdParamSchema.parse(request.params);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to heartbeat for this agent" });
        }
        const [agent] = await sql `
      UPDATE agents
      SET
        last_seen_at = NOW(),
        presence_status = 'online'
      WHERE id = ${id}
      RETURNING id, last_seen_at
    `;
        if (!agent)
            return reply.code(404).send({ error: "Agent not found" });
        return {
            ok: true,
            last_seen_at: agent.last_seen_at,
        };
    });
    app.get("/api/agents/online", async (request) => {
        const q = onlineAgentsQuerySchema.parse(request.query ?? {});
        await sql `
      UPDATE agents
      SET presence_status = CASE
        WHEN last_seen_at IS NULL THEN 'offline'
        WHEN last_seen_at < NOW() - INTERVAL '15 minutes' THEN 'offline'
        WHEN last_seen_at < NOW() - INTERVAL '5 minutes' THEN 'away'
        ELSE 'online'
      END
      WHERE presence_status IS DISTINCT FROM CASE
        WHEN last_seen_at IS NULL THEN 'offline'
        WHEN last_seen_at < NOW() - INTERVAL '15 minutes' THEN 'offline'
        WHEN last_seen_at < NOW() - INTERVAL '5 minutes' THEN 'away'
        ELSE 'online'
      END
    `;
        const rows = await sql `
      SELECT
        a.id,
        a.display_name AS name,
        a.last_seen_at,
        a.presence_status,
        a.reputation_score
      FROM agents a
      WHERE a.last_seen_at >= NOW() - INTERVAL '15 minutes'
        AND (${q.category ?? null}::text IS NULL OR EXISTS (
          SELECT 1
          FROM offers o
          WHERE o.agent_id = a.id
            AND o.status = 'active'
            AND o.category = ${q.category ?? null}::text
        ))
      ORDER BY a.last_seen_at DESC
    `;
        return rows;
    });
    app.get("/api/agents/:id/presence", async (request, reply) => {
        const { id } = agentIdParamSchema.parse(request.params);
        const [agent] = await sql `
      SELECT
        last_seen_at,
        presence_status,
        (last_seen_at IS NOT NULL AND last_seen_at >= NOW() - INTERVAL '5 minutes') AS online
      FROM agents
      WHERE id = ${id}
    `;
        if (!agent)
            return reply.code(404).send({ error: "Agent not found" });
        return {
            online: Boolean(agent.online),
            last_seen_at: agent.last_seen_at,
            presence_status: agent.presence_status,
        };
    });
    app.get("/api/skills/challenges", async (request) => {
        const q = listChallengesQuerySchema.parse(request.query ?? {});
        const rows = await sql `
      SELECT
        id,
        category,
        title,
        description_md,
        difficulty,
        time_limit_minutes,
        active,
        created_at
      FROM skill_challenges
      WHERE active = TRUE
        AND (${q.category ?? null}::text IS NULL OR category = ${q.category ?? null}::text)
      ORDER BY created_at DESC
    `;
        return rows;
    });
    app.post("/api/skills/challenges/:id/start", async (request, reply) => {
        const { id } = challengeIdParamSchema.parse(request.params);
        const body = startChallengeSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [challenge] = await sql `
      SELECT * FROM skill_challenges
      WHERE id = ${id} AND active = TRUE
    `;
        if (!challenge)
            return reply.code(404).send({ error: "Challenge not found" });
        const [existing] = await sql `
      SELECT *
      FROM skill_verifications
      WHERE challenge_id = ${id}
        AND agent_id = ${body.agentId}
    `;
        if (existing) {
            if (existing.status === "in_progress" && new Date(existing.expires_at).getTime() > Date.now()) {
                return {
                    verificationId: existing.id,
                    challengeId: id,
                    category: challenge.category,
                    title: challenge.title,
                    inputPayload: challenge.input_payload,
                    deadline: existing.expires_at,
                    status: existing.status,
                };
            }
            const retryAt = new Date(existing.started_at);
            retryAt.setHours(retryAt.getHours() + 24);
            if (retryAt.getTime() > Date.now()) {
                return reply.code(429).send({
                    error: "Challenge retry cooldown active",
                    retryAfter: retryAt.toISOString(),
                });
            }
            await sql `DELETE FROM skill_verifications WHERE id = ${existing.id}`;
        }
        const [verification] = await sql `
      INSERT INTO skill_verifications (agent_id, challenge_id, status, expires_at)
      VALUES (
        ${body.agentId},
        ${id},
        'in_progress',
        NOW() + (${challenge.time_limit_minutes}::text || ' minutes')::interval
      )
      RETURNING *
    `;
        return reply.code(201).send({
            verificationId: verification.id,
            challengeId: id,
            category: challenge.category,
            title: challenge.title,
            inputPayload: challenge.input_payload,
            deadline: verification.expires_at,
            status: verification.status,
        });
    });
    app.post("/api/skills/challenges/:id/submit", async (request, reply) => {
        const { id } = challengeIdParamSchema.parse(request.params);
        const body = submitChallengeSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [attempt] = await sql `
      SELECT sv.*, sc.category, sc.expected_criteria
      FROM skill_verifications sv
      JOIN skill_challenges sc ON sc.id = sv.challenge_id
      WHERE sv.challenge_id = ${id}
        AND sv.agent_id = ${body.agentId}
      LIMIT 1
    `;
        if (!attempt)
            return reply.code(404).send({ error: "No challenge attempt found" });
        if (attempt.status !== "in_progress") {
            return reply.code(400).send({ error: `Attempt status is ${attempt.status}, expected in_progress` });
        }
        if (new Date(attempt.expires_at).getTime() <= Date.now()) {
            await sql `
        UPDATE skill_verifications
        SET status = 'expired', submitted_at = NOW()
        WHERE id = ${attempt.id}
      `;
            return reply.code(400).send({ error: "Challenge attempt expired" });
        }
        const criteria = typeof attempt.expected_criteria === "object" && attempt.expected_criteria !== null
            ? attempt.expected_criteria
            : {};
        const grade = gradeSkillSubmission(criteria, body.submission);
        let updatedAttempt;
        if (grade.deterministic) {
            const status = grade.passed ? "passed" : "failed";
            [updatedAttempt] = await sql `
        UPDATE skill_verifications
        SET
          submission = ${JSON.stringify(body.submission)}::jsonb,
          status = ${status},
          score = ${grade.score},
          grading_notes = ${grade.gradingNotes},
          submitted_at = NOW(),
          graded_at = NOW()
        WHERE id = ${attempt.id}
        RETURNING *
      `;
            if (grade.passed) {
                await sql `
          UPDATE agents
          SET
            skills_verified = CASE
              WHEN ${attempt.category} = ANY(skills_verified) THEN skills_verified
              ELSE array_append(skills_verified, ${attempt.category})
            END,
            skill_verification_count = cardinality(
              CASE
                WHEN ${attempt.category} = ANY(skills_verified) THEN skills_verified
                ELSE array_append(skills_verified, ${attempt.category})
              END
            )
          WHERE id = ${body.agentId}
        `;
            }
        }
        else {
            [updatedAttempt] = await sql `
        UPDATE skill_verifications
        SET
          submission = ${JSON.stringify(body.submission)}::jsonb,
          status = 'submitted',
          grading_notes = ${grade.gradingNotes},
          submitted_at = NOW()
        WHERE id = ${attempt.id}
        RETURNING *
      `;
        }
        return {
            verificationId: updatedAttempt?.id,
            challengeId: id,
            status: updatedAttempt?.status,
            passed: updatedAttempt?.status === "passed",
            score: updatedAttempt?.score ?? null,
            gradingNotes: updatedAttempt?.grading_notes ?? null,
        };
    });
    app.get("/api/agents/:id/skills", async (request, reply) => {
        const { id } = challengeIdParamSchema.parse(request.params);
        const [agent] = await sql `
      SELECT id, COALESCE(skills_verified, '{}'::text[]) AS skills_verified, COALESCE(skill_verification_count, 0)::int AS skill_verification_count
      FROM agents
      WHERE id = ${id}
    `;
        if (!agent)
            return reply.code(404).send({ error: "Agent not found" });
        const history = await sql `
      SELECT
        sv.id,
        sv.challenge_id,
        sc.category,
        sc.title,
        sc.difficulty,
        sv.status,
        sv.score,
        sv.grading_notes,
        sv.started_at,
        sv.submitted_at,
        sv.graded_at,
        sv.expires_at
      FROM skill_verifications sv
      JOIN skill_challenges sc ON sc.id = sv.challenge_id
      WHERE sv.agent_id = ${id}
      ORDER BY sv.started_at DESC
    `;
        return {
            agentId: id,
            skillsVerified: agent.skills_verified,
            verificationCount: Number(agent.skill_verification_count),
            history,
        };
    });
}
