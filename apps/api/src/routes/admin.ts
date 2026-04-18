import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";
import { completeDealMilestones } from "../shared/deal-helpers.js";
import { notifyAgents } from "../webhooks.js";
import { PLATFORM_FEE_PCT } from "./utils.js";
import {
  isOnChainMode,
  resolveDisputeOnChain,
} from "../chain.js";

export default async function adminRoutes(app: FastifyInstance) {
  function checkAdminKey(
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  ): boolean {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader =
      (request.headers["x-admin-key"] as string | undefined) ||
      String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey) {
      reply.code(403).send({ error: "Invalid admin key" });
      return false;
    }
    return true;
  }

  function requireAdminKey(
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  ): boolean {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
      reply.code(503).send({ error: "Admin API not configured" });
      return false;
    }
    const authHeader =
      (request.headers["x-admin-key"] as string | undefined) ||
      String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (authHeader !== adminKey) {
      reply.code(403).send({ error: "Invalid admin key" });
      return false;
    }
    return true;
  }

  function conversion(from: string, to: string, fromCount: number, toCount: number) {
    return {
      from,
      to,
      fromCount,
      toCount,
      rate: fromCount > 0 ? Number((toCount / fromCount).toFixed(4)) : null,
    };
  }

  async function getMetrics() {
    const browseByEndpoint = await sql`
      SELECT
        COALESCE(payload_json->>'endpoint', 'unknown') AS endpoint,
        COUNT(*)::int AS count,
        ROUND(AVG((payload_json->>'durationMs')::numeric), 2)::float AS avg_ms,
        MIN((payload_json->>'durationMs')::numeric)::float AS min_ms,
        MAX((payload_json->>'durationMs')::numeric)::float AS max_ms,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2)::float AS p50_ms,
        ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2)::float AS p95_ms
      FROM audit_log
      WHERE action = 'browse.latency'
        AND payload_json ? 'durationMs'
      GROUP BY 1
      ORDER BY count DESC, endpoint ASC
    `;

    const [browseOverall] = await sql`
      SELECT
        COUNT(*)::int AS count,
        COALESCE(ROUND(AVG((payload_json->>'durationMs')::numeric), 2), 0)::float AS avg_ms,
        COALESCE(MIN((payload_json->>'durationMs')::numeric), 0)::float AS min_ms,
        COALESCE(MAX((payload_json->>'durationMs')::numeric), 0)::float AS max_ms,
        COALESCE(ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2), 0)::float AS p50_ms,
        COALESCE(ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (payload_json->>'durationMs')::numeric))::numeric, 2), 0)::float AS p95_ms
      FROM audit_log
      WHERE action = 'browse.latency'
        AND payload_json ? 'durationMs'
    `;

    const [offerViewStats] = await sql`
      SELECT COUNT(*)::int AS total
      FROM audit_log
      WHERE action = 'offer.view'
    `;

    const topViewedOffers = await sql`
      SELECT
        al.object_id AS offer_id,
        COALESCE(o.title, '') AS title,
        COUNT(*)::int AS views
      FROM audit_log al
      LEFT JOIN offers o ON o.id = al.object_id
      WHERE al.action = 'offer.view'
      GROUP BY al.object_id, o.title
      ORDER BY views DESC, offer_id ASC
      LIMIT 20
    `;

    const [funnelStats] = await sql`
      SELECT
        COUNT(*)::int AS deal_proposals_created,
        COUNT(*) FILTER (WHERE status IN ('accepted', 'active', 'funded', 'delivered', 'completed'))::int AS proposals_accepted,
        COUNT(*) FILTER (
          WHERE status IN ('funded', 'delivered', 'completed')
             OR EXISTS (
               SELECT 1
               FROM milestones m
               JOIN payment_intents pi ON pi.milestone_id = m.id
               WHERE m.deal_id = deals.id
                 AND pi.status IN ('funded', 'released')
             )
        )::int AS deals_funded,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS deals_completed,
        COALESCE(SUM(negotiated_total) FILTER (WHERE status = 'completed'), 0)::float AS gmv
      FROM deals
    `;

    const [auditedFeeStats] = await sql`
      SELECT COALESCE(SUM((payload_json->>'feeAmount')::numeric), 0)::float AS platform_fee_revenue
      FROM audit_log
      WHERE action = 'payment.release'
        AND payload_json ? 'feeAmount'
    `;

    const dealProposalsCreated = Number(funnelStats.deal_proposals_created ?? 0);
    const proposalsAccepted = Number(funnelStats.proposals_accepted ?? 0);
    const dealsFunded = Number(funnelStats.deals_funded ?? 0);
    const dealsCompleted = Number(funnelStats.deals_completed ?? 0);
    const gmv = Number(funnelStats.gmv ?? 0);
    const calculatedPlatformFeeRevenue = Number(((gmv * PLATFORM_FEE_PCT) / 100).toFixed(6));
    const auditedPlatformFeeRevenue = Number(auditedFeeStats.platform_fee_revenue ?? 0);

    return {
      generatedAt: new Date().toISOString(),
      browseLatency: {
        overall: {
          count: Number(browseOverall?.count ?? 0),
          avgMs: Number(browseOverall?.avg_ms ?? 0),
          minMs: Number(browseOverall?.min_ms ?? 0),
          maxMs: Number(browseOverall?.max_ms ?? 0),
          p50Ms: Number(browseOverall?.p50_ms ?? 0),
          p95Ms: Number(browseOverall?.p95_ms ?? 0),
        },
        byEndpoint: browseByEndpoint.map((row) => ({
          endpoint: String(row.endpoint),
          count: Number(row.count),
          avgMs: Number(row.avg_ms ?? 0),
          minMs: Number(row.min_ms ?? 0),
          maxMs: Number(row.max_ms ?? 0),
          p50Ms: Number(row.p50_ms ?? 0),
          p95Ms: Number(row.p95_ms ?? 0),
        })),
      },
      offerPageViews: {
        total: Number(offerViewStats.total ?? 0),
        topOffers: topViewedOffers.map((row) => ({
          offerId: row.offer_id ? String(row.offer_id) : null,
          title: String(row.title ?? ""),
          views: Number(row.views),
        })),
      },
      funnel: {
        dealProposalsCreated,
        proposalsAccepted,
        dealsFunded,
        dealsCompleted,
        conversions: [
          conversion("offerPageViews", "dealProposalsCreated", Number(offerViewStats.total ?? 0), dealProposalsCreated),
          conversion("dealProposalsCreated", "proposalsAccepted", dealProposalsCreated, proposalsAccepted),
          conversion("proposalsAccepted", "dealsFunded", proposalsAccepted, dealsFunded),
          conversion("dealsFunded", "dealsCompleted", dealsFunded, dealsCompleted),
        ],
      },
      revenue: {
        gmv,
        platformFeePct: PLATFORM_FEE_PCT,
        platformFeeRevenue: calculatedPlatformFeeRevenue,
        auditedPlatformFeeRevenue,
      },
    };
  }

  function renderMetricsHtml(metrics: Awaited<ReturnType<typeof getMetrics>>): string {
    const cards = [
      ["Offer views", metrics.offerPageViews.total],
      ["Proposals", metrics.funnel.dealProposalsCreated],
      ["Accepted", metrics.funnel.proposalsAccepted],
      ["Funded", metrics.funnel.dealsFunded],
      ["Completed", metrics.funnel.dealsCompleted],
      ["GMV", `${metrics.revenue.gmv.toFixed(2)} USDC`],
      ["Fee revenue", `${metrics.revenue.platformFeeRevenue.toFixed(2)} USDC`],
      ["Browse p95", `${metrics.browseLatency.overall.p95Ms.toFixed(2)} ms`],
    ];
    const rows = metrics.browseLatency.byEndpoint
      .map((row) => `<tr><td>${row.endpoint}</td><td>${row.count}</td><td>${row.avgMs}</td><td>${row.p50Ms}</td><td>${row.p95Ms}</td></tr>`)
      .join("");
    const conversions = metrics.funnel.conversions
      .map((item) => `<tr><td>${item.from} to ${item.to}</td><td>${item.fromCount}</td><td>${item.toCount}</td><td>${item.rate === null ? "n/a" : `${(item.rate * 100).toFixed(1)}%`}</td></tr>`)
      .join("");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AgentPact Metrics</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #111; background: #f7f7f7; }
    main { max-width: 1080px; margin: 0 auto; }
    h1, h2 { margin: 0 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 24px 0; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
    .label { color: #555; font-size: 13px; }
    .value { font-size: 24px; font-weight: 700; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ddd; margin-bottom: 24px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e5e5; }
  </style>
</head>
<body>
  <main>
    <h1>AgentPact Metrics</h1>
    <p>Generated ${metrics.generatedAt}</p>
    <section class="grid">${cards.map(([label, value]) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("")}</section>
    <h2>Browse Latency</h2>
    <table><thead><tr><th>Endpoint</th><th>Count</th><th>Avg ms</th><th>P50 ms</th><th>P95 ms</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Conversions</h2>
    <table><thead><tr><th>Step</th><th>From</th><th>To</th><th>Rate</th></tr></thead><tbody>${conversions}</tbody></table>
  </main>
</body>
</html>`;
  }

  app.get("/api/admin/metrics", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;
    return getMetrics();
  });

  app.get("/api/admin/metrics.html", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;
    const metrics = await getMetrics();
    return reply.type("text/html").send(renderMetricsHtml(metrics));
  });

  app.post("/api/admin/auto-complete-timeouts", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const expiredDeals = await sql`
      SELECT id, acceptance_timeout_days, updated_at, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE status IN ('delivered', 'active', 'funded')
        AND updated_at < NOW() - (COALESCE(acceptance_timeout_days, 7) || ' days')::interval
    `;

    const results = [];
    for (const deal of expiredDeals) {
      try {
        await sql`UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${deal.id} AND status NOT IN ('verified', 'revoked')`;
        await completeDealMilestones(String(deal.id), { skipOnChainRelease: false });
        await sql`UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
          dealId: String(deal.id),
          message: "Deal auto-completed! Leave feedback via POST /api/feedback to build your reputation.",
          feedbackUrl: "https://api.agentpact.xyz/api/feedback",
        });
        results.push({ dealId: deal.id, completed: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ dealId: deal.id, completed: false, error: message });
      }
    }

    return { processed: results.length, results };
  });

  app.post("/api/admin/force-close", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const body = z
      .object({
        dealId: z.string().uuid(),
        reason: z.string().optional().default("Admin force-close"),
      })
      .parse(request.body);

    const [deal] = await sql`
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
      FROM deals WHERE id = ${body.dealId}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (deal.status === "completed") return { ok: true, alreadyCompleted: true };

    await sql`UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${body.dealId} AND status NOT IN ('verified', 'revoked')`;
    const releaseResult = await completeDealMilestones(body.dealId, { skipOnChainRelease: false });

    if (deal.offer_id) {
      await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }
    await sql`UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;

    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
      dealId: body.dealId,
      reason: body.reason,
    });
    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
      dealId: body.dealId,
      message: "Deal closed! Leave feedback via POST /api/feedback to build your reputation.",
      feedbackUrl: "https://api.agentpact.xyz/api/feedback",
      buyerAgentId: deal.buyer_agent_id,
      sellerAgentId: deal.seller_agent_id,
    });

    const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${body.dealId}`;
    return { ok: true, deal: updatedDeal, release: releaseResult };
  });

  app.post("/api/admin/force-release", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) return reply.code(503).send({ error: "Admin API not configured" });

    const authHeader =
      (request.headers["x-admin-key"] as string | undefined) ||
      String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (authHeader !== adminKey) return reply.code(403).send({ error: "Invalid admin key" });

    const body = z
      .object({
        milestoneId: z.string().uuid(),
        reason: z.string().optional(),
      })
      .parse(request.body);

    const [milestone] = await sql`
      SELECT m.*, d.id AS deal_id, d.status AS deal_status, d.seller_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    if (!milestone) return reply.code(404).send({ error: "Milestone not found" });

    const mode = isOnChainMode() ? "on-chain" : "simulation";
    let txHash: string | null = null;

    if (mode === "on-chain") {
      try {
        const result = await resolveDisputeOnChain(body.milestoneId, false);
        txHash = result.txHash;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[admin/force-release] On-chain resolveDispute failed: ${message}`);
      }
    }

    await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = ${body.milestoneId}`;
    await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${milestone.deal_id}`;
    await sql`UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ${body.milestoneId} AND status = 'funded'`;

    console.log(
      `[admin/force-release] Milestone ${body.milestoneId} released. Reason: ${body.reason || "admin action"}. TxHash: ${txHash || "N/A"}`
    );

    return {
      ok: true,
      milestoneId: body.milestoneId,
      dealId: milestone.deal_id,
      mode,
      txHash,
      reason: body.reason || "admin force-release",
    };
  });

  // ── WIS-107: Mark agent as internal (WiseChef-owned) ──────────────────────
  app.patch("/api/admin/agents/:id/mark-internal", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ isInternal: z.boolean() }).parse(request.body);

    const [agent] = await sql`
      UPDATE agents
      SET is_internal = ${body.isInternal}
      WHERE id = ${id}
      RETURNING id, handle, display_name, is_internal
    `;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    return { ok: true, agent };
  });

  // ── WIS-107: Bulk-mark agents by wallet prefix / handle pattern ──────────
  app.post("/api/admin/agents/bulk-mark-internal", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const body = z.object({
      walletAddresses: z.array(z.string()).optional(),
      handlePatterns: z.array(z.string()).optional(),
      isInternal: z.boolean(),
    }).parse(request.body);

    const results: Array<{ id: string; handle: string; isInternal: boolean }> = [];

    if (body.walletAddresses && body.walletAddresses.length > 0) {
      const wallets = body.walletAddresses;
      const rows = await sql`
        UPDATE agents
        SET is_internal = ${body.isInternal}
        WHERE owner_wallet_address = ANY(${wallets}::text[])
        RETURNING id, handle, is_internal
      `;
      results.push(...(rows as unknown as Array<{ id: string; handle: string; is_internal: boolean }>).map(r => ({
        id: String(r.id), handle: String(r.handle), isInternal: Boolean(r.is_internal)
      })));
    }

    if (body.handlePatterns && body.handlePatterns.length > 0) {
      for (const pattern of body.handlePatterns) {
        const rows = await sql`
          UPDATE agents
          SET is_internal = ${body.isInternal}
          WHERE handle ILIKE ${"%" + pattern + "%"}
          RETURNING id, handle, is_internal
        `;
        results.push(...(rows as unknown as Array<{ id: string; handle: string; is_internal: boolean }>).map(r => ({
          id: String(r.id), handle: String(r.handle), isInternal: Boolean(r.is_internal)
        })));
      }
    }

    return { ok: true, updated: results.length, agents: results };
  });

  // ── WIS-107: Real traction metrics (external agents only) ─────────────────
  app.get("/api/admin/traction", async (request, reply) => {
    if (!checkAdminKey(request, reply)) return;

    const [overview] = await sql`
      SELECT
        COUNT(*)::int AS total_agents,
        COUNT(*) FILTER (WHERE NOT is_internal)::int AS external_agents,
        COUNT(*) FILTER (WHERE is_internal)::int AS internal_agents
      FROM agents
    `;

    const [offerStats] = await sql`
      SELECT
        COUNT(*)::int AS total_active_offers,
        COUNT(*) FILTER (WHERE a.is_internal = FALSE)::int AS external_active_offers
      FROM offers o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'active'
    `;

    const [dealStats] = await sql`
      SELECT
        COUNT(*)::int AS total_deals,
        COUNT(*) FILTER (
          WHERE a_buyer.is_internal = FALSE OR a_seller.is_internal = FALSE
        )::int AS deals_with_external_party,
        COUNT(*) FILTER (
          WHERE a_buyer.is_internal = FALSE AND a_seller.is_internal = FALSE
        )::int AS fully_external_deals
      FROM deals d
      JOIN agents a_buyer ON a_buyer.id = d.buyer_agent_id
      JOIN agents a_seller ON a_seller.id = d.seller_agent_id
    `;

    const [needStats] = await sql`
      SELECT
        COUNT(*)::int AS total_open_needs,
        COUNT(*) FILTER (WHERE a.is_internal = FALSE)::int AS external_open_needs
      FROM needs n
      JOIN agents a ON a.id = n.agent_id
      WHERE n.status = 'open'
    `;

    const recentExternal = await sql`
      SELECT id, handle, display_name, created_at, reputation_score, is_internal
      FROM agents
      WHERE is_internal = FALSE
      ORDER BY created_at DESC
      LIMIT 10
    `;

    return {
      agents: {
        total: overview.total_agents,
        external: overview.external_agents,
        internal: overview.internal_agents,
        externalPct: overview.total_agents > 0
          ? Number(((overview.external_agents / overview.total_agents) * 100).toFixed(1))
          : 0,
      },
      offers: {
        totalActive: offerStats.total_active_offers,
        externalActive: offerStats.external_active_offers,
      },
      deals: {
        total: dealStats.total_deals,
        withExternalParty: dealStats.deals_with_external_party,
        fullyExternal: dealStats.fully_external_deals,
      },
      needs: {
        totalOpen: needStats.total_open_needs,
        externalOpen: needStats.external_open_needs,
      },
      recentExternalAgents: recentExternal,
    };
  });
}
