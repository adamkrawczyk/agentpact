import { z } from "zod";
import { createOfferSchema, autopilotSettingsSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, enrichOfferRow, parseBooleanish } from "./utils.js";
async function audit(sql, actorId, action, objectType, objectId, idem, payload) {
    await sql `
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}
export async function registerRoutes(app, sql, _deps, recomputeMatches) {
    app.post("/api/autopilot/settings", async (request, reply) => {
        const idem = idempotencyKey(request.headers);
        const body = autopilotSettingsSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [agent] = await sql `
      UPDATE agents
      SET
        auto_buy_enabled = COALESCE(${body.autoBuyEnabled ?? null}, auto_buy_enabled),
        max_auto_deal_price = CASE
          WHEN ${body.maxAutoDealPrice !== undefined} THEN ${body.maxAutoDealPrice ?? null}
          ELSE max_auto_deal_price
        END,
        auto_buy_categories = CASE
          WHEN ${body.autoBuyCategories !== undefined} THEN ${body.autoBuyCategories ?? null}::text[]
          ELSE auto_buy_categories
        END
      WHERE id = ${body.agentId}
      RETURNING id, auto_buy_enabled, max_auto_deal_price, auto_buy_categories
    `;
        if (!agent)
            return reply.code(404).send({ error: "Agent not found" });
        await audit(sql, body.agentId, "autopilot.settings.update", "agent", body.agentId, idem, body);
        return agent;
    });
    app.post("/api/offers", async (request, reply) => {
        const idem = idempotencyKey(request.headers);
        const body = createOfferSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const location = body.location ?? null;
        const [offer] = await sql `
      INSERT INTO offers (
        agent_id, title, description_md, category, tags, base_price, currency, max_price_delta_pct, sla_days, proofs_json, fulfillment_type, location
      ) VALUES (
        ${body.agentId}, ${body.title}, ${body.descriptionMd}, ${body.category}, ${body.tags}, ${body.basePrice},
        ${body.currency}, ${body.maxPriceDeltaPct}, ${body.slaDays}, ${JSON.stringify(body.proofs)}::jsonb, ${body.fulfillmentType}, ${location}::jsonb
      )
      RETURNING *
    `;
        await audit(sql, body.agentId, "offer.create", "offer", offer.id, idem, body);
        recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after offer.create"));
        return reply.code(201).send(offer);
    });
    app.patch("/api/offers/:id", async (request, reply) => {
        const { id } = request.params;
        const body = createOfferSchema.partial().parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        const [existingOffer] = await sql `SELECT agent_id FROM offers WHERE id = ${id}`;
        if (!existingOffer || existingOffer.agent_id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const title = body.title ?? null;
        const descriptionMd = body.descriptionMd ?? null;
        const category = body.category ?? null;
        const tags = body.tags ?? null;
        const basePrice = body.basePrice ?? null;
        const maxPriceDeltaPct = body.maxPriceDeltaPct ?? null;
        const slaDays = body.slaDays ?? null;
        const proofsJson = body.proofs ? JSON.stringify(body.proofs) : null;
        const fulfillmentType = body.fulfillmentType ?? null;
        const location = body.location ?? null;
        const [offer] = await sql `
      UPDATE offers SET
        title = COALESCE(${title}, title),
        description_md = COALESCE(${descriptionMd}, description_md),
        category = COALESCE(${category}, category),
        tags = COALESCE(${tags}, tags),
        base_price = COALESCE(${basePrice}, base_price),
        max_price_delta_pct = COALESCE(${maxPriceDeltaPct}, max_price_delta_pct),
        sla_days = COALESCE(${slaDays}, sla_days),
        proofs_json = COALESCE(${proofsJson}::jsonb, proofs_json),
        fulfillment_type = COALESCE(${fulfillmentType}, fulfillment_type),
        location = COALESCE(${location}::jsonb, location),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
        recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after offer.update"));
        return offer;
    });
    app.post("/api/offers/:id/archive", async (request, reply) => {
        const { id } = request.params;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        const [existingOffer] = await sql `SELECT agent_id FROM offers WHERE id = ${id}`;
        if (!existingOffer || existingOffer.agent_id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const [offer] = await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
        return offer;
    });
    app.get("/api/offers", async (request) => {
        const q = z.object({
            query: z.string().optional(),
            tags: z.string().optional(),
            minPrice: z.string().optional(),
            maxPrice: z.string().optional(),
            verifiedOnly: z.string().optional(),
            free_only: z.string().optional(),
        }).parse(request.query ?? {});
        const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
        const query = `%${q.query ?? ""}%`;
        const min = q.minPrice ? Number(q.minPrice) : 0;
        const max = q.maxPrice ? Number(q.maxPrice) : Number.MAX_SAFE_INTEGER;
        const verifiedOnly = parseBooleanish(q.verifiedOnly);
        const freeOnly = parseBooleanish(q.free_only);
        const rows = await sql `
      SELECT o.* FROM offers o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'active'
        AND (o.title ILIKE ${query} OR o.description_md ILIKE ${query})
        AND o.base_price BETWEEN ${min} AND ${max}
        AND (${tags.length} = 0 OR o.tags && ${tags})
        AND (${verifiedOnly} = FALSE OR COALESCE(a.skill_verification_count, 0) > 0)
        AND (${freeOnly} = FALSE OR o.base_price = 0)
      ORDER BY o.created_at DESC
      LIMIT 200
    `;
        return rows.map((row) => enrichOfferRow(row));
    });
    app.get("/api/offers/:id", async (request, reply) => {
        const { id } = request.params;
        const [offer] = await sql `SELECT * FROM offers WHERE id = ${id}`;
        if (!offer)
            return reply.code(404).send({ error: "Offer not found" });
        return enrichOfferRow(offer);
    });
}
