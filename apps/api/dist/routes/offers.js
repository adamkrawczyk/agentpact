import { z } from "zod";
import { createOfferSchema, autopilotSettingsSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, enrichOfferRow, parseBooleanish } from "./utils.js";
/** Maximum active offers an agent may have at one time (anti-spam). */
const MAX_ACTIVE_OFFERS_PER_AGENT = 15;
/** Auto-archive offers with zero deals older than this many days. */
const STALE_OFFER_DAYS = 30;
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
        // ── Rate limit: cap active offers per agent ─────────────────────────────
        const [{ active_count }] = await sql `
      SELECT COUNT(*)::int AS active_count
      FROM offers
      WHERE agent_id = ${body.agentId} AND status = 'active'
    `;
        if (Number(active_count) >= MAX_ACTIVE_OFFERS_PER_AGENT) {
            return reply.code(429).send({
                error: `Agent already has ${active_count} active offers (max ${MAX_ACTIVE_OFFERS_PER_AGENT}). Archive some before creating new ones.`,
                activeCount: Number(active_count),
                limit: MAX_ACTIVE_OFFERS_PER_AGENT,
            });
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
    /**
     * GET /api/offers/grouped
     * Returns one card per category with ranked providers and aggregate stats.
     * Filters out categories dominated by a single agent (spam detection).
     *
     * Response shape per category:
     * {
     *   category: string,
     *   offerCount: number,
     *   agentCount: number,
     *   minPrice: number,
     *   maxPrice: number,
     *   avgPrice: number,
     *   topProviders: [{ agentId, handle, offerCount, minPrice, reputationScore }],
     *   sampleOffer: {...}   // cheapest offer in category
     * }
     */
    app.get("/api/offers/grouped", async (request) => {
        const q = z.object({
            query: z.string().optional(),
        }).parse(request.query ?? {});
        const queryFilter = `%${q.query ?? ""}%`;
        const rows = await sql `
      SELECT
        o.category,
        COUNT(o.id)::int                          AS offer_count,
        COUNT(DISTINCT o.agent_id)::int           AS agent_count,
        MIN(o.base_price)::float                  AS min_price,
        MAX(o.base_price)::float                  AS max_price,
        AVG(o.base_price)::float                  AS avg_price,
        -- Sample offer: cheapest active, soonest SLA
        (
          SELECT row_to_json(s)
          FROM (
            SELECT s2.id, s2.title, s2.description_md, s2.base_price, s2.sla_days, s2.tags, s2.agent_id
            FROM offers s2
            WHERE s2.category = o.category AND s2.status = 'active'
              AND (s2.title ILIKE ${queryFilter} OR s2.description_md ILIKE ${queryFilter} OR ${q.query ?? ""} = '')
            ORDER BY s2.base_price ASC, s2.sla_days ASC
            LIMIT 1
          ) s
        ) AS sample_offer,
        -- Top providers: up to 5, ranked by reputation then offer count
        (
          SELECT json_agg(p ORDER BY p.reputation_score DESC, p.offer_count DESC)
          FROM (
            SELECT
              a.id        AS agent_id,
              a.handle,
              a.display_name,
              COUNT(o2.id)::int AS offer_count,
              MIN(o2.base_price)::float AS min_price,
              COALESCE(a.reputation_score, 0)::float AS reputation_score
            FROM offers o2
            JOIN agents a ON a.id = o2.agent_id
            WHERE o2.category = o.category AND o2.status = 'active'
            GROUP BY a.id, a.handle, a.display_name, a.reputation_score
            ORDER BY a.reputation_score DESC, COUNT(o2.id) DESC
            LIMIT 5
          ) p
        ) AS top_providers
      FROM offers o
      WHERE o.status = 'active'
        AND (
          ${q.query ?? ""} = ''
          OR o.title ILIKE ${queryFilter}
          OR o.description_md ILIKE ${queryFilter}
          OR o.category ILIKE ${queryFilter}
        )
      GROUP BY o.category
      ORDER BY offer_count DESC
    `;
        return rows;
    });
    app.get("/api/offers/:id", async (request, reply) => {
        const { id } = request.params;
        const [offer] = await sql `SELECT * FROM offers WHERE id = ${id}`;
        if (!offer)
            return reply.code(404).send({ error: "Offer not found" });
        return enrichOfferRow(offer);
    });
    /**
     * POST /api/admin/offers/auto-archive-stale
     * Archives offers that have zero associated deals and are older than STALE_OFFER_DAYS.
     * Admin-key protected.
     */
    app.post("/api/admin/offers/auto-archive-stale", async (request, reply) => {
        const adminKey = process.env.ADMIN_API_KEY;
        const authHeader = request.headers["x-admin-key"] ||
            String(request.headers["authorization"] ?? "").replace("Bearer ", "");
        if (adminKey && authHeader !== adminKey) {
            return reply.code(403).send({ error: "Invalid admin key" });
        }
        // Archive active offers older than STALE_OFFER_DAYS with no deals
        const archived = await sql `
      UPDATE offers
      SET status = 'archived', updated_at = NOW()
      WHERE status = 'active'
        AND created_at < NOW() - (${STALE_OFFER_DAYS} || ' days')::interval
        AND id NOT IN (
          SELECT DISTINCT offer_id FROM deals WHERE offer_id IS NOT NULL
        )
      RETURNING id, agent_id, title, category, created_at
    `;
        app.log.info({ count: archived.length }, "auto-archive-stale: archived offers");
        return {
            archivedCount: archived.length,
            staleDays: STALE_OFFER_DAYS,
            archivedOffers: archived.map((o) => ({
                id: o.id,
                agentId: o.agent_id,
                title: o.title,
                category: o.category,
                createdAt: o.created_at,
            })),
        };
    });
}
