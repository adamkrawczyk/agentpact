import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./types.js";
import { createOfferSchema, updateOfferSchema, autopilotSettingsSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, enrichOfferRow, parseBooleanish } from "./utils.js";

/** Maximum active offers an agent may have at one time (anti-spam). */
const MAX_ACTIVE_OFFERS_PER_AGENT = 15;

/** Auto-archive offers with zero deals older than this many days. */
const STALE_OFFER_DAYS = 30;

const DEFAULT_BROWSE_LIMIT = 200;
const MAX_BROWSE_LIMIT = 200;
const DEFAULT_GROUPED_LIMIT = 100;
const MAX_GROUPED_LIMIT = 100;
const MAX_BROWSE_OFFSET = 1000;

function boundedInteger(value: string | undefined, defaultValue: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export async function archiveStaleOffersWithoutDeals(sql: Sql<Record<string, unknown>>): Promise<number> {
  const archivedOffers = await sql`
    UPDATE offers o
    SET status = 'archived', updated_at = NOW()
    WHERE o.status = 'active'
      AND o.created_at < NOW() - (${STALE_OFFER_DAYS} * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1
        FROM deals d
        WHERE d.offer_id = o.id
      )
    RETURNING o.id
  `;

  return archivedOffers.length;
}

async function audit(sql: Sql<Record<string, unknown>>, actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

async function auditBestEffort(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  action: string,
  objectType: string,
  objectId: string | null,
  payload: unknown,
): Promise<void> {
  try {
    await audit(sql, null, action, objectType, objectId, `metrics:${action}:${Date.now()}`, payload);
  } catch (err) {
    app.log.warn({ err, action, objectType, objectId }, "metrics audit insert failed");
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, _deps: Deps, recomputeMatches: () => Promise<number>): Promise<void> {
  app.post("/api/autopilot/settings", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = autopilotSettingsSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [agent] = await sql`
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
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    await audit(sql, body.agentId, "autopilot.settings.update", "agent", body.agentId, idem, body);
    return agent;
  });

  app.post("/api/offers", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = createOfferSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const location = body.location ?? null;
    const maxRespondents = body.fulfillmentType === "consultation" ? body.maxRespondents ?? null : null;
    const timeLimitMinutes = body.fulfillmentType === "consultation" ? body.timeLimitMinutes ?? null : null;
    let offer: Record<string, unknown> | undefined;

    try {
      offer = await sql.begin(async (txn) => {
        await txn.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [body.agentId]);

        const [duplicateOffer] = await txn.unsafe(
          `
            SELECT id
            FROM offers
            WHERE agent_id = $1
              AND status = 'active'
              AND lower(btrim(category)) = lower(btrim($2))
              AND lower(btrim(title)) = lower(btrim($3))
            LIMIT 1
          `,
          [body.agentId, body.category, body.title],
        );

        if (duplicateOffer) {
          reply.code(409);
          return { error: "Agent already has an active offer with this category and title" };
        }

        const [activeOfferCountRow] = await txn.unsafe(
          `
            SELECT COUNT(*)::int AS active_offer_count
            FROM offers
            WHERE agent_id = $1
              AND status = 'active'
          `,
          [body.agentId],
        );

        if (Number(activeOfferCountRow.active_offer_count) >= MAX_ACTIVE_OFFERS_PER_AGENT) {
          reply.code(429);
          return { error: `Active offer limit reached (${MAX_ACTIVE_OFFERS_PER_AGENT})` };
        }

        const [createdOffer] = await txn.unsafe(
          `
            INSERT INTO offers (
              agent_id, title, description_md, category, tags, base_price, currency,
              max_price_delta_pct, sla_days, proofs_json, fulfillment_type,
              max_respondents, time_limit_minutes, location
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10::jsonb, $11, $12, $13, $14::jsonb
            )
            RETURNING *
          `,
          [
            body.agentId,
            body.title,
            body.descriptionMd,
            body.category,
            body.tags,
            body.basePrice,
            body.currency,
            body.maxPriceDeltaPct,
            body.slaDays,
            JSON.stringify(body.proofs),
            body.fulfillmentType,
            maxRespondents,
            timeLimitMinutes,
            location ? JSON.stringify(location) : null,
          ],
        );

        return createdOffer as Record<string, unknown>;
      });
    } catch (error: any) {
      if (error?.code === "23505" && error?.constraint_name === "offers_active_agent_category_title_unique") {
        return reply.code(409).send({ error: "Agent already has an active offer with this category and title" });
      }
      throw error;
    }

    if (reply.statusCode >= 400) {
      return reply.send(offer);
    }

    await audit(sql, body.agentId, "offer.create", "offer", String(offer.id), idem, body);
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after offer.create"));
    return reply.code(201).send(offer);
  });

  app.patch("/api/offers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateOfferSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [existingOffer] = await sql`SELECT agent_id FROM offers WHERE id = ${id}`;
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
    const maxRespondents = body.maxRespondents ?? null;
    const timeLimitMinutes = body.timeLimitMinutes ?? null;
    const location = body.location ?? null;
    const [offer] = await sql`
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
        max_respondents = CASE
          WHEN ${body.fulfillmentType ?? null} = 'consultation' OR ${body.maxRespondents !== undefined}
            THEN ${maxRespondents}
          ELSE max_respondents
        END,
        time_limit_minutes = CASE
          WHEN ${body.fulfillmentType ?? null} = 'consultation' OR ${body.timeLimitMinutes !== undefined}
            THEN ${timeLimitMinutes}
          ELSE time_limit_minutes
        END,
        location = COALESCE(${location as any}::jsonb, location),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    recomputeMatches().catch((err) => app.log.error({ err }, "recomputeMatches failed after offer.update"));
    return offer;
  });

  app.post("/api/offers/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [existingOffer] = await sql`SELECT agent_id FROM offers WHERE id = ${id}`;
    if (!existingOffer || existingOffer.agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const [offer] = await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return offer;
  });

  app.get("/api/offers", async (request) => {
    const startedAt = process.hrtime.bigint();
    const q = z.object({
      query: z.string().optional(),
      tags: z.string().optional(),
      minPrice: z.string().optional(),
      maxPrice: z.string().optional(),
      verifiedOnly: z.string().optional(),
      free_only: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }).parse(request.query ?? {});
    const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
    const search = q.query?.trim() ?? "";
    const query = `%${search}%`;
    const min = q.minPrice ? Number(q.minPrice) : 0;
    const max = q.maxPrice ? Number(q.maxPrice) : Number.MAX_SAFE_INTEGER;
    const verifiedOnly = parseBooleanish(q.verifiedOnly);
    const freeOnly = parseBooleanish(q.free_only);
    const limit = boundedInteger(q.limit, DEFAULT_BROWSE_LIMIT, 1, MAX_BROWSE_LIMIT);
    const offset = boundedInteger(q.offset, 0, 0, MAX_BROWSE_OFFSET);

    const rows = search
      ? await sql`
      SELECT o.* FROM offers o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'active'
        AND (o.title ILIKE ${query} OR o.description_md ILIKE ${query})
        AND o.base_price BETWEEN ${min} AND ${max}
        AND (${tags.length} = 0 OR o.tags && ${tags})
        AND (${verifiedOnly} = FALSE OR COALESCE(a.skill_verification_count, 0) > 0)
        AND (${freeOnly} = FALSE OR o.base_price = 0)
      ORDER BY o.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `
      : await sql`
      SELECT o.* FROM offers o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'active'
        AND o.base_price BETWEEN ${min} AND ${max}
        AND (${tags.length} = 0 OR o.tags && ${tags})
        AND (${verifiedOnly} = FALSE OR COALESCE(a.skill_verification_count, 0) > 0)
        AND (${freeOnly} = FALSE OR o.base_price = 0)
      ORDER BY o.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
    const enrichedRows = rows.map((row) => enrichOfferRow(row as Record<string, unknown>));
    await auditBestEffort(app, sql, "browse.latency", "endpoint", null, {
      endpoint: "/api/offers",
      method: "GET",
      durationMs: elapsedMs(startedAt),
      resultCount: enrichedRows.length,
      hasQuery: search.length > 0,
      hasTags: tags.length > 0,
      limit,
      offset,
    });
    return enrichedRows;
  });

  app.get("/api/categories", async () => {
    const startedAt = process.hrtime.bigint();
    const rows = await sql`
      WITH active_offers AS (
        SELECT id, agent_id, category, base_price, currency
        FROM offers
        WHERE status = 'active'
      ),
      provider_stats AS (
        SELECT
          o.category,
          o.agent_id,
          COUNT(d.id)::int AS completed_deals
        FROM active_offers o
        LEFT JOIN deals d
          ON d.offer_id = o.id
         AND d.status = 'completed'
        GROUP BY o.category, o.agent_id
      ),
      top_provider AS (
        SELECT DISTINCT ON (category)
          category,
          agent_id,
          completed_deals
        FROM provider_stats
        ORDER BY category, completed_deals DESC, agent_id
      )
      SELECT
        o.category AS name,
        COUNT(*)::int AS offer_count,
        ARRAY_AGG(DISTINCT o.agent_id) AS agent_ids,
        MIN(o.base_price) AS min_price,
        MAX(o.base_price) AS max_price,
        CASE
          WHEN COUNT(DISTINCT o.currency) = 1 THEN MIN(o.currency)
          ELSE NULL
        END AS currency,
        tp.agent_id AS top_provider_agent_id,
        COALESCE(tp.completed_deals, 0)::int AS top_provider_completed_deals
      FROM active_offers o
      LEFT JOIN top_provider tp
        ON tp.category = o.category
      GROUP BY o.category, tp.agent_id, tp.completed_deals
      ORDER BY COUNT(*) DESC, o.category ASC
    `;

    const categories = rows.map((row) => ({
      name: row.name,
      offerCount: Number(row.offer_count),
      agentIds: Array.isArray(row.agent_ids) ? row.agent_ids : [],
      priceRange: {
        min: row.min_price,
        max: row.max_price,
        currency: row.currency ?? null,
      },
      topProvider: row.top_provider_agent_id
        ? {
            agentId: row.top_provider_agent_id,
            completedDeals: Number(row.top_provider_completed_deals),
          }
        : null,
    }));
    await auditBestEffort(app, sql, "browse.latency", "endpoint", null, {
      endpoint: "/api/categories",
      method: "GET",
      durationMs: elapsedMs(startedAt),
      resultCount: categories.length,
    });
    return categories;
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
    const startedAt = process.hrtime.bigint();
    const q = z.object({
      query: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }).parse(request.query ?? {});

    const search = q.query?.trim() ?? "";
    const queryFilter = `%${search}%`;
    const limit = boundedInteger(q.limit, DEFAULT_GROUPED_LIMIT, 1, MAX_GROUPED_LIMIT);
    const offset = boundedInteger(q.offset, 0, 0, MAX_BROWSE_OFFSET);

    const rows = search
      ? await sql`
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
              AND (
                s2.title ILIKE ${queryFilter}
                OR s2.description_md ILIKE ${queryFilter}
                OR s2.category ILIKE ${queryFilter}
              )
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
          o.title ILIKE ${queryFilter}
          OR o.description_md ILIKE ${queryFilter}
          OR o.category ILIKE ${queryFilter}
        )
      GROUP BY o.category
      ORDER BY offer_count DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `
      : await sql`
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
      GROUP BY o.category
      ORDER BY offer_count DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    await auditBestEffort(app, sql, "browse.latency", "endpoint", null, {
      endpoint: "/api/offers/grouped",
      method: "GET",
      durationMs: elapsedMs(startedAt),
      resultCount: rows.length,
      hasQuery: search.length > 0,
      limit,
      offset,
    });
    return rows;
  });

  app.get("/api/offers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [offer] = await sql`SELECT * FROM offers WHERE id = ${id}`;
    if (!offer) return reply.code(404).send({ error: "Offer not found" });
    await auditBestEffort(app, sql, "offer.view", "offer", id, {
      endpoint: "/api/offers/:id",
      method: "GET",
      offerId: id,
    });
    return enrichOfferRow(offer as Record<string, unknown>);
  });

  /**
   * POST /api/admin/offers/auto-archive-stale
   * Archives offers that have zero associated deals and are older than STALE_OFFER_DAYS.
   * Admin-key protected.
   */
  app.post("/api/admin/offers/auto-archive-stale", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader =
      (request.headers["x-admin-key"] as string | undefined) ||
      String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey) {
      return reply.code(403).send({ error: "Invalid admin key" });
    }

    // Archive active offers older than STALE_OFFER_DAYS with no deals
    const archived = await sql`
      WITH archived AS (
        UPDATE offers
        SET status = 'archived', updated_at = NOW()
        WHERE id IN (
          SELECT o.id
          FROM offers o
          WHERE o.status = 'active'
            AND o.created_at < NOW() - (${STALE_OFFER_DAYS} * INTERVAL '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM deals d WHERE d.offer_id = o.id
            )
        )
        RETURNING id, agent_id, title, category, created_at
      )
      SELECT * FROM archived
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
