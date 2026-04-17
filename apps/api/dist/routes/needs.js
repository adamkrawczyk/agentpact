import { z } from "zod";
import { createNeedSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey } from "./utils.js";
const DEFAULT_BROWSE_LIMIT = 200;
const MAX_BROWSE_LIMIT = 200;
const MAX_BROWSE_OFFSET = 1000;
function boundedInteger(value, defaultValue, min, max) {
    if (value === undefined || value.trim() === "")
        return defaultValue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return defaultValue;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
}
async function audit(sql, actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
export async function registerRoutes(app, sql, _deps, recomputeMatches) {
    app.post("/api/needs", async (request, reply) => {
        const idem = idempotencyKey(request.headers);
        const body = createNeedSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const budgetMin = body.budgetMin ?? null;
        const budgetMax = body.budgetMax ?? null;
        const deadlineAt = body.deadlineAt ?? null;
        const location = body.location ?? null;
        const [need] = await sql `
      INSERT INTO needs (
        agent_id, title, description_md, category, tags, budget_min, budget_max, currency, acceptance_criteria, deadline_at, fulfillment_type, location
      ) VALUES (
        ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags},
        ${budgetMin}, ${budgetMax}, ${body.currency}, ${JSON.stringify(body.acceptanceCriteria)}::jsonb, ${deadlineAt}, ${body.fulfillmentType}, ${location}::jsonb
      ) RETURNING *
    `;
        await audit(sql, body.agentId, "need.create", "need", need.id, idem, body);
        recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after need.create"));
        return reply.code(201).send(need);
    });
    app.patch("/api/needs/:id", async (request, reply) => {
        const { id } = request.params;
        const body = createNeedSchema.partial().parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        const [existingNeed] = await sql `SELECT agent_id FROM needs WHERE id = ${id}`;
        if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const title = body.title ?? null;
        const descriptionMd = body.descriptionMd ?? null;
        const category = body.category ?? null;
        const tags = body.tags ?? null;
        const budgetMin = body.budgetMin ?? null;
        const budgetMax = body.budgetMax ?? null;
        const acceptanceCriteria = body.acceptanceCriteria ? JSON.stringify(body.acceptanceCriteria) : null;
        const deadlineAt = body.deadlineAt ?? null;
        const fulfillmentType = body.fulfillmentType ?? null;
        const location = body.location ?? null;
        const [need] = await sql `
      UPDATE needs SET
        title = COALESCE(${title}, title),
        description_md = COALESCE(${descriptionMd}, description_md),
        category = COALESCE(${category}, category),
        tags = COALESCE(${tags}, tags),
        budget_min = COALESCE(${budgetMin}, budget_min),
        budget_max = COALESCE(${budgetMax}, budget_max),
        acceptance_criteria = COALESCE(${acceptanceCriteria}::jsonb, acceptance_criteria),
        deadline_at = COALESCE(${deadlineAt}, deadline_at),
        fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
        location = COALESCE(${location}::jsonb, location),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
        recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after need.update"));
        return need;
    });
    app.post("/api/needs/:id/archive", async (request, reply) => {
        const { id } = request.params;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        const [existingNeed] = await sql `SELECT agent_id FROM needs WHERE id = ${id}`;
        if (!existingNeed || existingNeed.agent_id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const [need] = await sql `UPDATE needs SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
        return need;
    });
    app.get("/api/needs", async (request) => {
        const q = z.object({
            query: z.string().optional(),
            tags: z.string().optional(),
            limit: z.string().optional(),
            offset: z.string().optional(),
        }).parse(request.query ?? {});
        const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
        const search = q.query?.trim() ?? "";
        const query = `%${search}%`;
        const limit = boundedInteger(q.limit, DEFAULT_BROWSE_LIMIT, 1, MAX_BROWSE_LIMIT);
        const offset = boundedInteger(q.offset, 0, 0, MAX_BROWSE_OFFSET);
        const rows = search
            ? await sql `
      SELECT * FROM needs
      WHERE status = 'open'
        AND (title ILIKE ${query} OR description_md ILIKE ${query})
        AND (${tags.length} = 0 OR tags && ${tags})
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `
            : await sql `
      SELECT * FROM needs
      WHERE status = 'open'
        AND (${tags.length} = 0 OR tags && ${tags})
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
        return rows;
    });
    app.get("/api/needs/:id", async (request, reply) => {
        const { id } = request.params;
        const [need] = await sql `SELECT * FROM needs WHERE id = ${id}`;
        if (!need)
            return reply.code(404).send({ error: "Need not found" });
        return need;
    });
}
