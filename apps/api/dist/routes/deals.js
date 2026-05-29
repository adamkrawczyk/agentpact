import { z } from "zod";
import { proposeDealSchema, counterDealSchema, consultationResponseSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, isZeroPrice, toNumber } from "./utils.js";
async function audit(sql, actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
async function createDealProposal(sql, proposal, opts) {
    const isFreeTier = isZeroPrice(proposal.negotiatedTotal);
    const taskContract = proposal.task_contract ?? null;
    const result = await sql.begin(async (txn) => {
        const [deal] = await txn.unsafe(`
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days, is_free_tier, task_contract
        ) VALUES ($1, $2, $3, $4, $5, $6, 'USDC', $7, $8, $9, $10::jsonb)
        RETURNING *
      `, [
            proposal.buyerAgentId,
            proposal.sellerAgentId,
            proposal.offerId,
            proposal.needId,
            "proposed",
            proposal.negotiatedTotal,
            proposal.maxPriceDeltaPct,
            proposal.acceptanceTimeoutDays,
            isFreeTier,
            taskContract ? JSON.stringify(taskContract) : null,
        ]);
        const milestones = [];
        for (const milestone of proposal.milestones) {
            const dueAt = milestone.dueAt ?? null;
            const [ms] = await txn.unsafe(`
          INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at, status)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6, $7)
          RETURNING *
        `, [
                deal.id,
                milestone.idx,
                milestone.title,
                milestone.amount,
                JSON.stringify(milestone.acceptanceCriteria),
                dueAt,
                "pending",
            ]);
            milestones.push(ms);
        }
        await txn.unsafe(`
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)
      `, [deal.id, opts.negotiationActorAgentId, JSON.stringify(opts.auditPayload ?? proposal)]);
        await txn.unsafe(`INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [opts.auditActorAgentId, opts.auditAction, "deal", String(deal.id), opts.idempotencyKey, JSON.stringify(opts.auditPayload ?? proposal)]);
        return { ...deal, milestones };
    });
    return result;
}
async function enforceDealDelta(sql, dealId, negotiatedTotal) {
    if (isZeroPrice(negotiatedTotal)) {
        return;
    }
    const [deal] = await sql `
    SELECT d.id, o.base_price, d.max_price_delta_pct
    FROM deals d
    JOIN offers o ON d.offer_id = o.id
    WHERE d.id = ${dealId}
  `;
    if (!deal) {
        throw new Error("Deal not found");
    }
    const maxDelta = toNumber(deal.max_price_delta_pct) / 100;
    const base = toNumber(deal.base_price);
    if (base === 0) {
        return;
    }
    const delta = Math.abs(negotiatedTotal - base) / base;
    if (delta > maxDelta) {
        throw new Error("Counter exceeds max negotiation delta");
    }
}
async function getConsultationDealContext(sql, dealId) {
    const [deal] = await sql `
    SELECT
      d.id,
      d.status,
      d.buyer_agent_id,
      d.seller_agent_id,
      d.offer_id,
      d.is_free_tier,
      COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type,
      o.max_respondents,
      o.time_limit_minutes,
      accept_event.created_at AS accepted_at
    FROM deals d
    LEFT JOIN offers o ON o.id = d.offer_id
    LEFT JOIN LATERAL (
      SELECT created_at
      FROM negotiation_events
      WHERE deal_id = d.id AND event_type = 'accept'
      ORDER BY created_at ASC
      LIMIT 1
    ) accept_event ON true
    WHERE d.id = ${dealId}
  `;
    if (!deal)
        return null;
    return {
        id: String(deal.id),
        status: String(deal.status),
        buyer_agent_id: String(deal.buyer_agent_id),
        seller_agent_id: String(deal.seller_agent_id),
        offer_id: deal.offer_id ? String(deal.offer_id) : null,
        fulfillment_type: String(deal.fulfillment_type),
        max_respondents: deal.max_respondents === null ? null : Number(deal.max_respondents),
        time_limit_minutes: deal.time_limit_minutes === null ? null : Number(deal.time_limit_minutes),
        accepted_at: deal.accepted_at ?? null,
        is_free_tier: Boolean(deal.is_free_tier),
    };
}
async function maybeAutoCompleteConsultationDeal(sql, deps, dealId) {
    const deal = await getConsultationDealContext(sql, dealId);
    if (!deal || deal.fulfillment_type !== "consultation") {
        return { completed: false, reason: null };
    }
    if (!["active", "delivered", "funded"].includes(deal.status)) {
        return { completed: deal.status === "completed", reason: null };
    }
    const [responseStats] = await sql `
    SELECT COUNT(*)::int AS response_count
    FROM consultation_responses
    WHERE deal_id = ${dealId}
  `;
    const responseCount = Number(responseStats.response_count ?? 0);
    const startedAt = deal.accepted_at ? new Date(String(deal.accepted_at)) : new Date();
    const deadline = deal.time_limit_minutes
        ? new Date(startedAt.getTime() + deal.time_limit_minutes * 60 * 1000)
        : null;
    const limitReached = deal.max_respondents !== null && responseCount >= deal.max_respondents;
    const timedOut = deadline !== null && Date.now() >= deadline.getTime();
    if (!limitReached && !timedOut) {
        return { completed: false, reason: null };
    }
    await sql.begin(async (txn) => {
        const [locked] = await txn.unsafe(`
        SELECT status
        FROM deals
        WHERE id = $1
        FOR UPDATE
      `, [dealId]);
        if (!locked || !["active", "delivered", "funded"].includes(String(locked.status))) {
            return;
        }
        await txn.unsafe(`
        INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status, updated_at, verified_at)
        VALUES ($1, 'consultation', 'verified', NOW(), NOW())
        ON CONFLICT (deal_id) DO UPDATE SET
          fulfillment_type = EXCLUDED.fulfillment_type,
          status = 'verified',
          verified_at = NOW(),
          updated_at = NOW()
      `, [dealId]);
    });
    const [paymentStats] = await sql `
    SELECT COUNT(*)::int AS funded_intents
    FROM payment_intents pi
    JOIN milestones m ON m.id = pi.milestone_id
    WHERE m.deal_id = ${dealId}
      AND pi.status = 'funded'
  `;
    await deps.completeDealMilestones(dealId, {
        skipPaymentRelease: deal.is_free_tier || Number(paymentStats.funded_intents ?? 0) === 0,
    });
    if (deal.offer_id) {
        await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }
    const respondentRows = await sql `
    SELECT respondent_agent_id
    FROM consultation_responses
    WHERE deal_id = ${dealId}
  `;
    const respondentIds = respondentRows.map((row) => String(row.respondent_agent_id));
    deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id, ...respondentIds], "deal.consultation_completed", {
        dealId,
        reason: limitReached ? "max_respondents" : "time_limit",
        respondentCount: responseCount,
        maxRespondents: deal.max_respondents,
        timeLimitMinutes: deal.time_limit_minutes,
    });
    return {
        completed: true,
        reason: limitReached ? "max_respondents" : "time_limit",
    };
}
export async function registerRoutes(app, sql, deps) {
    app.post("/api/deals/propose", async (request, reply) => {
        const idem = idempotencyKey(request.headers);
        const body = proposeDealSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.buyerAgentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [offerOwner] = await sql `SELECT agent_id FROM offers WHERE id = ${body.offerId}`;
        if (!offerOwner || offerOwner.agent_id !== body.sellerAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const [needOwner] = await sql `SELECT agent_id FROM needs WHERE id = ${body.needId}`;
        if (!needOwner || needOwner.agent_id !== body.buyerAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        if (isZeroPrice(body.negotiatedTotal) && body.milestones.some((milestone) => !isZeroPrice(milestone.amount))) {
            return reply.code(400).send({ error: "Free-tier deals must use zero-value milestones" });
        }
        const result = await createDealProposal(sql, body, {
            idempotencyKey: idem,
            auditAction: "deal.propose",
            auditActorAgentId: body.buyerAgentId,
            negotiationActorAgentId: body.buyerAgentId,
            auditPayload: body,
        });
        deps.notifyAgents(sql, [body.sellerAgentId], "deal.proposed", {
            dealId: result.id,
            buyerAgentId: body.buyerAgentId,
            sellerAgentId: body.sellerAgentId,
            negotiatedTotal: body.negotiatedTotal,
        });
        return reply.code(201).send(result);
    });
    app.post("/api/deals/:id/counter", async (request, reply) => {
        const { id } = request.params;
        const requestBody = request.body && typeof request.body === "object" ? request.body : {};
        const body = counterDealSchema.parse({ ...requestBody, dealId: id });
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.actorAgentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.actorAgentId !== deal.buyer_agent_id && body.actorAgentId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        if (isZeroPrice(body.negotiatedTotal) && body.milestones.some((milestone) => !isZeroPrice(milestone.amount))) {
            return reply.code(400).send({ error: "Free-tier deals must use zero-value milestones" });
        }
        await enforceDealDelta(sql, id, body.negotiatedTotal);
        const isFreeTier = isZeroPrice(body.negotiatedTotal);
        await sql.begin(async (txn) => {
            await txn.unsafe("DELETE FROM milestones WHERE deal_id = $1", [id]);
            for (const milestone of body.milestones) {
                const dueAt = milestone.dueAt ?? null;
                await txn.unsafe(`
            INSERT INTO milestones (deal_id, idx, title, amount, acceptance_criteria, due_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          `, [id, milestone.idx, milestone.title, milestone.amount, JSON.stringify(milestone.acceptanceCriteria), dueAt]);
            }
            await txn.unsafe(`
          UPDATE deals
          SET status = 'countered', negotiated_total = $1, is_free_tier = $2, updated_at = NOW()
          WHERE id = $3
        `, [body.negotiatedTotal, isFreeTier, id]);
            await txn.unsafe(`
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'counter', $3::jsonb)
        `, [id, body.actorAgentId, JSON.stringify(body)]);
        });
        return { ok: true };
    });
    app.post("/api/deals/:id/accept", async (request, reply) => {
        const { id } = request.params;
        const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.actorAgentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `
      SELECT d.buyer_agent_id, d.seller_agent_id, d.status,
             COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type
      FROM deals d
      LEFT JOIN offers o ON o.id = d.offer_id
      WHERE d.id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (!["proposed", "countered"].includes(String(deal.status))) {
            return reply.code(409).send({ error: `Cannot accept deal in status '${deal.status}'` });
        }
        if (body.actorAgentId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        try {
            await sql.begin(async (txn) => {
                const [updated] = await txn.unsafe("UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1 AND status IN ('proposed', 'countered') RETURNING id", [id]);
                if (!updated) {
                    const conflictError = new Error(`Deal ${id} status changed concurrently — accept aborted`);
                    conflictError.name = "DealAcceptConflictError";
                    throw conflictError;
                }
                await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
                await txn.unsafe(`
            INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (deal_id) DO NOTHING
          `, [id, deal.fulfillment_type]);
                await txn.unsafe(`
            INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
            VALUES ($1, $2, 'accept', $3::jsonb)
          `, [id, body.actorAgentId, JSON.stringify(body)]);
            });
        }
        catch (err) {
            app.log.error({ err, dealId: id }, "deal.accept transaction failed — deal status NOT changed");
            if (err instanceof Error && err.name === "DealAcceptConflictError") {
                return reply.code(409).send({ error: "Deal status changed concurrently; retry with the current deal state" });
            }
            return reply.code(500).send({ error: "Failed to accept deal — please retry" });
        }
        deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.accepted", {
            dealId: id,
            acceptedBy: body.actorAgentId,
            fulfillmentType: deal.fulfillment_type,
            sellerActionRequired: "Provide fulfillment details via /api/deals/:id/fulfillment",
        });
        const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
        return { ok: true, ...updatedDeal };
    });
    app.post("/api/deals/:id/cancel", async (request, reply) => {
        const { id } = request.params;
        const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.actorAgentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `SELECT buyer_agent_id, seller_agent_id, status FROM deals WHERE id = ${id}`;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        if (!["proposed", "countered", "accepted", "active", "funded", "delivered", "disputed"].includes(String(deal.status))) {
            return reply.code(400).send({ error: `Deal status ${deal.status} cannot be cancelled` });
        }
        await sql.begin(async (txn) => {
            await txn.unsafe("UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
            await txn.unsafe("UPDATE milestones SET status = 'cancelled' WHERE deal_id = $1", [id]);
            await txn.unsafe(`
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'cancel', $3::jsonb)
        `, [id, body.actorAgentId, JSON.stringify(body)]);
        });
        if (deal) {
            deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.cancelled", {
                dealId: id,
                cancelledBy: body.actorAgentId,
                reason: body.reason,
            });
        }
        return { ok: true };
    });
    app.get("/api/deals", async (request) => {
        const q = request.query;
        const rows = await sql `
      SELECT d.*,
        (SELECT json_agg(m ORDER BY m.idx) FROM milestones m WHERE m.deal_id = d.id) AS milestones
      FROM deals d
      WHERE (${q.buyerAgentId ?? null}::uuid IS NULL OR d.buyer_agent_id = ${q.buyerAgentId ?? null}::uuid)
        AND (${q.sellerAgentId ?? null}::uuid IS NULL OR d.seller_agent_id = ${q.sellerAgentId ?? null}::uuid)
        AND (${q.status ?? null}::text IS NULL OR d.status = ${q.status ?? null}::text)
      ORDER BY d.created_at DESC
      LIMIT 200
    `;
        return rows;
    });
    app.get("/api/deals/:id", async (request, reply) => {
        const { id } = request.params;
        await maybeAutoCompleteConsultationDeal(sql, deps, id);
        const [deal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        const milestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
        const events = await sql `SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
        return { ...deal, milestones, events };
    });
    app.post("/api/deals/:id/consultation-response", async (request, reply) => {
        const { id } = request.params;
        const body = consultationResponseSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const deal = await getConsultationDealContext(sql, id);
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (deal.fulfillment_type !== "consultation") {
            return reply.code(400).send({ error: "Deal is not a consultation deal" });
        }
        if (!["active", "delivered", "funded"].includes(deal.status)) {
            return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept consultation responses` });
        }
        if (body.agentId === deal.buyer_agent_id || body.agentId === deal.seller_agent_id) {
            return reply.code(400).send({ error: "Deal participants cannot submit consultation responses" });
        }
        const autoCompleteBeforeInsert = await maybeAutoCompleteConsultationDeal(sql, deps, id);
        if (autoCompleteBeforeInsert.completed) {
            return reply.code(409).send({ error: `Consultation already completed via ${autoCompleteBeforeInsert.reason}` });
        }
        const [existing] = await sql `
      SELECT id
      FROM consultation_responses
      WHERE deal_id = ${id} AND respondent_agent_id = ${body.agentId}
    `;
        if (existing) {
            return reply.code(409).send({ error: "Agent has already submitted a consultation response" });
        }
        const [response] = await sql `
      INSERT INTO consultation_responses (deal_id, respondent_agent_id, response_md)
      VALUES (${id}, ${body.agentId}, ${body.responseMd})
      RETURNING *
    `;
        const autoCompleteAfterInsert = await maybeAutoCompleteConsultationDeal(sql, deps, id);
        const [updatedDeal] = await sql `SELECT status FROM deals WHERE id = ${id}`;
        return reply.code(201).send({
            ...response,
            deal_status: updatedDeal?.status ?? deal.status,
            auto_completed: autoCompleteAfterInsert.completed,
            completion_reason: autoCompleteAfterInsert.reason,
        });
    });
    app.get("/api/deals/:id/consultation-responses", async (request, reply) => {
        const { id } = request.params;
        const query = z.object({ agentId: z.string().uuid() }).parse(request.query ?? {});
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (query.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const deal = await getConsultationDealContext(sql, id);
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (deal.fulfillment_type !== "consultation") {
            return reply.code(400).send({ error: "Deal is not a consultation deal" });
        }
        const [requesterResponse] = await sql `
      SELECT id
      FROM consultation_responses
      WHERE deal_id = ${id} AND respondent_agent_id = ${query.agentId}
    `;
        const isParticipant = query.agentId === deal.buyer_agent_id || query.agentId === deal.seller_agent_id;
        if (!isParticipant && !requesterResponse) {
            return reply.code(403).send({ error: "Not authorized for this consultation" });
        }
        const autoComplete = await maybeAutoCompleteConsultationDeal(sql, deps, id);
        const [updatedDeal] = await sql `SELECT status FROM deals WHERE id = ${id}`;
        const responses = await sql `
      SELECT *
      FROM consultation_responses
      WHERE deal_id = ${id}
      ORDER BY created_at ASC
    `;
        return {
            deal_id: id,
            deal_status: updatedDeal?.status ?? deal.status,
            max_respondents: deal.max_respondents,
            time_limit_minutes: deal.time_limit_minutes,
            response_count: responses.length,
            auto_completed: autoComplete.completed,
            completion_reason: autoComplete.reason,
            responses,
        };
    });
}
