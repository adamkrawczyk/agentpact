import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./types.js";
import { proposeDealSchema } from "./schemas.js";
import { getRequesterAgentId, toNumber, isZeroPrice, withReputationOnlyTag, normalizeTags, parseBooleanish } from "./utils.js";
import {
  isSemanticMatchingEnabled,
  cacheEmbedding,
  cosineSimilarity,
  generateEmbeddings,
} from "../semantic-match.js";

function buildSemanticText(input: { title?: string | null; description_md?: string | null; category?: string | null; tags?: string[] | null }): string {
  const tags = Array.isArray(input.tags) ? input.tags.join(", ") : "";
  return [
    input.title ?? "",
    input.description_md ?? "",
    input.category ?? "",
    tags,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function extractEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const embedding: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    embedding.push(item);
  }
  return embedding.length > 0 ? embedding : null;
}

export async function recomputeMatches(app: FastifyInstance, sql: Sql<Record<string, unknown>>): Promise<number> {
  const offers = await sql`
    SELECT o.*, COALESCE(a.skill_verification_count, 0)::int AS seller_skill_verification_count,
           COALESCE(o.completed_deal_count, 0)::int AS offer_completed_deal_count
    FROM offers o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.status = 'active'
  `;
  const needs = await sql`SELECT * FROM needs WHERE status = 'open'`;
  let writes = 0;
  let semanticEnabled = isSemanticMatchingEnabled();
  // Build embedding maps from stored DB embeddings; generate only for missing ones
  const offerEmbeddings = new Map<string, number[]>();
  const needEmbeddings = new Map<string, number[]>();

  if (semanticEnabled) {
    try {
      const missingTexts: string[] = [];
      const missingRefs: Array<{ type: 'offer' | 'need'; id: string; text: string }> = [];

      for (const offer of offers) {
        const text = buildSemanticText(offer);
        const stored = extractEmbedding(offer.description_embedding);
        if (stored) {
          offerEmbeddings.set(String(offer.id), stored);
          cacheEmbedding(text, stored);
        } else {
          missingTexts.push(text);
          missingRefs.push({ type: 'offer', id: String(offer.id), text });
        }
      }
      for (const need of needs) {
        const text = buildSemanticText(need);
        const stored = extractEmbedding(need.description_embedding);
        if (stored) {
          needEmbeddings.set(String(need.id), stored);
          cacheEmbedding(text, stored);
        } else {
          missingTexts.push(text);
          missingRefs.push({ type: 'need', id: String(need.id), text });
        }
      }

      if (missingTexts.length > 0) {
        const newEmbeddings = await generateEmbeddings(missingTexts);
        // Batch write back new embeddings to DB (awaited, not fire-and-forget)
        const embeddingUpdates: Promise<void>[] = [];
        for (let i = 0; i < missingRefs.length; i += 1) {
          const ref = missingRefs[i];
          const emb = newEmbeddings[i];
          if (ref.type === 'offer') {
            offerEmbeddings.set(ref.id, emb);
          } else {
            needEmbeddings.set(ref.id, emb);
          }
          cacheEmbedding(ref.text, emb);
          const table = ref.type === 'offer' ? 'offers' : 'needs';
          embeddingUpdates.push(
            sql.unsafe(`UPDATE ${table} SET description_embedding = $1::jsonb WHERE id = $2`, [JSON.stringify(emb), ref.id])
              .then(() => {})
              .catch((err) => { app.log.warn({ err, id: ref.id, type: ref.type }, 'Failed to store embedding'); })
          );
        }
        await Promise.all(embeddingUpdates);
      }
    } catch (error) {
      app.log.warn({ err: error }, "Semantic matching warmup failed, using tag-only matching");
      semanticEnabled = false;
    }
  }

  // Flush batch helper to keep memory bounded during large N×M runs
  const BATCH_SIZE = 200;
  let batchBuffer: Array<{ offer_id: string; need_id: string; score: number; reason_json: string }> = [];
  async function flushBatch(): Promise<number> {
    if (batchBuffer.length === 0) return 0;
    const params: unknown[] = [];
    const placeholders = batchBuffer.map((m, idx) => {
      const base = idx * 4;
      params.push(m.offer_id, m.need_id, m.score, m.reason_json);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`;
    }).join(', ');
    await sql.unsafe(
      `INSERT INTO matches (offer_id, need_id, score, reason_json) VALUES ${placeholders} ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score, reason_json = EXCLUDED.reason_json`,
      params
    );
    const count = batchBuffer.length;
    batchBuffer = [];
    return count;
  }

  for (const offer of offers) {
    for (const need of needs) {
      const overlap = offer.tags.filter((t: string) => need.tags.includes(t));
      const budgetFit =
        need.budget_max === null || need.budget_max === undefined
          ? 1
          : Math.max(0, 1 - Math.abs(toNumber(offer.base_price) - toNumber(need.budget_max)) / Math.max(toNumber(need.budget_max), 1));
      const tagScore = Math.min(1, overlap.length / Math.max(offer.tags.length, 1));
      const skillBoost = Number(offer.seller_skill_verification_count) > 0 ? 0.2 : 0;
      const repScore = Math.min(0.3, 0.1 * (Number(offer.offer_completed_deal_count) ?? 0) / 10);

      let semanticScore: number | null = null;
      let score: number;

      if (!semanticEnabled) {
        if (overlap.length === 0) continue;
        score = Number((0.6 * tagScore + 0.2 * budgetFit + 0.1 * skillBoost + 0.1 * repScore).toFixed(3));
      } else {
        // Use pre-computed stored embeddings — NO per-pair API calls
        const offerEmb = offerEmbeddings.get(String(offer.id));
        const needEmb = needEmbeddings.get(String(need.id));

        if (offerEmb && needEmb) {
          semanticScore = cosineSimilarity(offerEmb, needEmb);
        } else {
          // Fallback: no embedding available for this item
          if (overlap.length === 0) continue;
          semanticScore = null;
        }

        if (semanticScore !== null && overlap.length === 0 && semanticScore <= 0.75) continue;
        if (semanticScore !== null) {
          score = Number((0.5 * semanticScore + 0.2 * tagScore + 0.15 * budgetFit + 0.05 * skillBoost + 0.1 * repScore).toFixed(3));
        } else {
          if (overlap.length === 0) continue;
          score = Number((0.6 * tagScore + 0.2 * budgetFit + 0.1 * skillBoost + 0.1 * repScore).toFixed(3));
        }
      }

      // Push to batch buffer, flush when full
      batchBuffer.push({
        offer_id: String(offer.id),
        need_id: String(need.id),
        score,
        reason_json: JSON.stringify({ overlap, budgetFit, tagScore, skillBoost, repScore, semanticScore }),
      });
      if (batchBuffer.length >= BATCH_SIZE) {
        writes += await flushBatch();
      }
    }
  }

  // Flush remaining
  writes += await flushBatch();
  return writes;
}

export function createRecomputeMatchesQueue(
  run: () => Promise<number>,
  opts: {
    delayMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): {
  recomputeNow: () => Promise<number>;
  scheduleRecompute: () => void;
} {
  let inFlight: Promise<number> | null = null;
  let pending = false;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  const delayMs = opts.delayMs ?? 60000;
  const onError = opts.onError ?? (() => undefined);

  const drain = async () => {
    let writes = 0;
    do {
      pending = false;
      writes += await run();
    } while (pending);
    return writes;
  };

  const recomputeNow = () => {
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    pending = true;

    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const scheduleRecompute = () => {
    pending = true;
    if (inFlight || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      recomputeNow().catch(onError);
    }, delayMs);
    scheduled.unref?.();
  };

  return { recomputeNow, scheduleRecompute };
}

async function createDealProposal(
  sql: Sql<Record<string, unknown>>,
  proposal: {
    buyerAgentId: string;
    sellerAgentId: string;
    offerId: string;
    needId: string;
    negotiatedTotal: number;
    maxPriceDeltaPct: number;
    acceptanceTimeoutDays: number;
    milestones: Array<{ idx: number; title: string; amount: number; acceptanceCriteria: string[]; dueAt?: string }>;
  },
  opts: {
    idempotencyKey: string;
    auditAction: string;
    auditActorAgentId: string | null;
    negotiationActorAgentId: string;
    auditPayload?: unknown;
  },
): Promise<Record<string, unknown>> {
  const isFreeTier = isZeroPrice(proposal.negotiatedTotal);
  const result = await sql.begin(async (txn) => {
    const [deal] = await txn.unsafe(
      `
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days, is_free_tier
        ) VALUES ($1, $2, $3, $4, $5, $6, 'USDC', $7, $8, $9)
        RETURNING *
      `,
      [
        proposal.buyerAgentId,
        proposal.sellerAgentId,
        proposal.offerId,
        proposal.needId,
        "proposed",
        proposal.negotiatedTotal,
        proposal.maxPriceDeltaPct,
        proposal.acceptanceTimeoutDays,
        isFreeTier,
      ]
    );

    const milestones = [];
    for (const milestone of proposal.milestones) {
      const dueAt = milestone.dueAt ?? null;
      const [ms] = await txn.unsafe(
        `
          INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at, status)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6, $7)
          RETURNING *
        `,
        [
          deal.id,
          milestone.idx,
          milestone.title,
          milestone.amount,
          JSON.stringify(milestone.acceptanceCriteria),
          dueAt,
          "pending",
        ]
      );
      milestones.push(ms);
    }

    await txn.unsafe(
      `
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)
      `,
      [deal.id, opts.negotiationActorAgentId, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    await txn.unsafe(
      `INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [opts.auditActorAgentId, opts.auditAction, "deal", String(deal.id), opts.idempotencyKey, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    return { ...deal, milestones };
  });

  return result as Record<string, unknown>;
}

export async function registerRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  deps: Deps,
  recomputeMatchesFn = createRecomputeMatchesQueue(() => recomputeMatches(app, sql)).recomputeNow,
): Promise<void> {

  app.get("/api/matches/recommendations", async (request) => {
    const q = z.object({
      agentId: z.string().uuid().optional(),
      limit: z.string().optional(),
      verifiedOnly: z.string().optional(),
      free_only: z.string().optional(),
    }).parse(request.query ?? {});
    const limit = Number(q.limit ?? 20);
    const verifiedOnly = parseBooleanish(q.verifiedOnly);
    const freeOnly = parseBooleanish(q.free_only);
    const rows = await sql`
      SELECT m.*, o.title AS offer_title, o.base_price AS offer_base_price, o.tags AS offer_tags, n.title AS need_title
      FROM matches m
      JOIN offers o ON o.id = m.offer_id
      JOIN needs n ON n.id = m.need_id
      JOIN agents a ON a.id = o.agent_id
      WHERE (${q.agentId ?? null}::uuid IS NULL OR o.agent_id = ${q.agentId ?? null}::uuid OR n.agent_id = ${q.agentId ?? null}::uuid)
        AND (${verifiedOnly} = FALSE OR COALESCE(a.skill_verification_count, 0) > 0)
        AND (${freeOnly} = FALSE OR o.base_price = 0)
      ORDER BY m.score DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => {
      const isFreeTier = isZeroPrice(row.offer_base_price);
      return {
        ...row,
        offer_tags: isFreeTier ? withReputationOnlyTag(row.offer_tags) : normalizeTags(row.offer_tags),
        is_free_tier: isFreeTier,
        pricing_model: isFreeTier ? "reputation-only" : "paid",
      };
    });
  });

  app.post("/api/matches/recompute", async () => {
    const writes = await recomputeMatchesFn();
    return { matchesUpserted: writes };
  });

  app.post("/api/autopilot/run", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = request.headers["x-admin-key"] || String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey) return reply.code(403).send({ error: "Invalid admin key" });

    const matchesComputed = await recomputeMatchesFn();
    const candidateMatches = await sql`
      SELECT
        m.offer_id,
        m.need_id,
        m.score,
        o.agent_id AS seller_agent_id,
        o.base_price,
        o.max_price_delta_pct,
        o.category,
        o.title AS offer_title,
        n.agent_id AS buyer_agent_id,
        n.title AS need_title,
        n.acceptance_criteria,
        a.auto_buy_enabled,
        a.max_auto_deal_price,
        a.auto_buy_categories
      FROM matches m
      JOIN offers o ON o.id = m.offer_id
      JOIN needs n ON n.id = m.need_id
      JOIN agents a ON a.id = n.agent_id
      WHERE m.score >= 0.8
        AND o.status = 'active'
        AND n.status = 'open'
      ORDER BY m.score DESC
    `;

    const buyerIds = Array.from(new Set(candidateMatches.map((match) => String(match.buyer_agent_id))));
    const recentAutopilotEvents = buyerIds.length > 0
      ? await sql`
          SELECT actor_agent_id, COUNT(*)::int AS deal_count
          FROM audit_log
          WHERE action = 'autopilot.deal.proposed'
            AND created_at > NOW() - INTERVAL '1 hour'
            AND actor_agent_id = ANY(${buyerIds})
          GROUP BY actor_agent_id
        `
      : [];
    const recentDealsByBuyer = new Map<string, number>(
      recentAutopilotEvents.map((row) => [String(row.actor_agent_id), Number(row.deal_count)])
    );

    let dealsProposed = 0;
    let skipped = 0;
    const runId = require("node:crypto").randomUUID();

    for (const match of candidateMatches) {
      const buyerAgentId = String(match.buyer_agent_id);
      const sellerAgentId = String(match.seller_agent_id);
      const offerId = String(match.offer_id);
      const needId = String(match.need_id);
      const negotiatedTotal = toNumber(match.base_price);

      if (!match.auto_buy_enabled) {
        skipped += 1;
        continue;
      }

      if (match.max_auto_deal_price !== null && match.max_auto_deal_price !== undefined && negotiatedTotal > toNumber(match.max_auto_deal_price)) {
        skipped += 1;
        continue;
      }

      const autoBuyCategories = Array.isArray(match.auto_buy_categories)
        ? match.auto_buy_categories.filter((value: unknown): value is string => typeof value === "string")
        : null;
      if (autoBuyCategories && !autoBuyCategories.includes(String(match.category))) {
        skipped += 1;
        continue;
      }

      const dealsInWindow = recentDealsByBuyer.get(buyerAgentId) ?? 0;
      if (dealsInWindow >= 5) {
        skipped += 1;
        continue;
      }

      const [existingDeal] = await sql`
        SELECT id
        FROM deals
        WHERE offer_id = ${offerId}
          AND need_id = ${needId}
          AND status IN ('proposed', 'countered', 'accepted', 'active', 'delivered', 'disputed')
        LIMIT 1
      `;
      if (existingDeal) {
        skipped += 1;
        continue;
      }

      const acceptanceCriteria = Array.isArray(match.acceptance_criteria)
        ? match.acceptance_criteria.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const milestoneAcceptanceCriteria = acceptanceCriteria.length > 0
        ? acceptanceCriteria
        : [`Deliver work matching need ${needId}`];
      const proposal = proposeDealSchema.parse({
        buyerAgentId,
        sellerAgentId,
        offerId,
        needId,
        negotiatedTotal,
        maxPriceDeltaPct: toNumber(match.max_price_delta_pct),
        acceptanceTimeoutDays: 0,
        milestones: [
          {
            idx: 1,
            title: `Autopilot: ${String(match.offer_title ?? "Deliver service")}`,
            amount: negotiatedTotal,
            acceptanceCriteria: milestoneAcceptanceCriteria,
          },
        ],
      });

      try {
        const createdDeal = await createDealProposal(sql, proposal, {
          idempotencyKey: `autopilot-run:${runId}:${offerId}:${needId}`,
          auditAction: "autopilot.deal.proposed",
          auditActorAgentId: buyerAgentId,
          negotiationActorAgentId: buyerAgentId,
          auditPayload: {
            runId,
            score: toNumber(match.score),
            offerId,
            needId,
            buyerAgentId,
            sellerAgentId,
            negotiatedTotal,
            source: "autopilot",
          },
        });

        recentDealsByBuyer.set(buyerAgentId, dealsInWindow + 1);
        dealsProposed += 1;

        deps.notifyAgents(sql, [sellerAgentId], "deal.proposed", {
          dealId: String(createdDeal.id),
          buyerAgentId,
          sellerAgentId,
          negotiatedTotal,
          source: "autopilot",
        });
      } catch (error) {
        skipped += 1;
        request.log.error({
          err: error,
          offerId,
          needId,
        }, "autopilot.run failed to propose deal");
      }
    }

    return {
      matchesComputed,
      dealsProposed,
      skipped,
      runId,
    };
  });

  app.post("/api/embeddings/recompute", async (request, reply) => {
    if (!isSemanticMatchingEnabled()) {
      return reply.code(400).send({ error: "OPENAI_API_KEY is not configured" });
    }

    const offers = await sql`SELECT id, title, description_md, category, tags FROM offers`;
    const needs = await sql`SELECT id, title, description_md, category, tags FROM needs`;

    const offerTexts = offers.map((offer) => buildSemanticText(offer));
    const needTexts = needs.map((need) => buildSemanticText(need));

    const [offerEmbeddings, needEmbeddings] = await Promise.all([
      generateEmbeddings(offerTexts),
      generateEmbeddings(needTexts),
    ]);

    await sql.begin(async (txn) => {
      for (let i = 0; i < offers.length; i += 1) {
        await txn.unsafe(
          `
            UPDATE offers
            SET description_embedding = $1::jsonb
            WHERE id = $2
          `,
          [JSON.stringify(offerEmbeddings[i]), offers[i].id]
        );
      }
      for (let i = 0; i < needs.length; i += 1) {
        await txn.unsafe(
          `
            UPDATE needs
            SET description_embedding = $1::jsonb
            WHERE id = $2
          `,
          [JSON.stringify(needEmbeddings[i]), needs[i].id]
        );
      }
    });

    return {
      offersUpdated: offers.length,
      needsUpdated: needs.length,
      totalUpdated: offers.length + needs.length,
    };
  });

  app.post("/api/alerts/subscribe", async (request, reply) => {
    const body = z
      .object({
        agentId: z.string().uuid(),
        kind: z.enum(["offers", "needs"]),
        filter: z.record(z.any()),
        webhookUrl: z.string().url().optional()
      })
      .parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const webhookUrl = body.webhookUrl ?? null;

    const [subscription] = await sql`
      INSERT INTO alert_subscriptions (agent_id, kind, filter_json, webhook_url)
      VALUES (${body.agentId}, ${body.kind}, ${JSON.stringify(body.filter)}::jsonb, ${webhookUrl})
      RETURNING *
    `;
    return reply.code(201).send(subscription);
  });
}
