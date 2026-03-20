import { z } from "zod";
import { sql } from "../db.js";
import { completeDealMilestones } from "../shared/deal-helpers.js";
import { notifyAgents } from "../webhooks.js";
import { isOnChainMode, resolveDisputeOnChain, } from "../chain.js";
export default async function adminRoutes(app) {
    function checkAdminKey(request, reply) {
        const adminKey = process.env.ADMIN_API_KEY;
        const authHeader = request.headers["x-admin-key"] ||
            String(request.headers["authorization"] ?? "").replace("Bearer ", "");
        if (adminKey && authHeader !== adminKey) {
            reply.code(403).send({ error: "Invalid admin key" });
            return false;
        }
        return true;
    }
    app.post("/api/admin/auto-complete-timeouts", async (request, reply) => {
        if (!checkAdminKey(request, reply))
            return;
        const expiredDeals = await sql `
      SELECT id, acceptance_timeout_days, updated_at, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE status IN ('delivered', 'active', 'funded')
        AND updated_at < NOW() - (COALESCE(acceptance_timeout_days, 7) || ' days')::interval
    `;
        const results = [];
        for (const deal of expiredDeals) {
            try {
                await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${deal.id} AND status NOT IN ('verified', 'revoked')`;
                await completeDealMilestones(String(deal.id), { skipOnChainRelease: false });
                await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
                notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
                    dealId: String(deal.id),
                    message: "Deal auto-completed! Leave feedback via POST /api/feedback to build your reputation.",
                    feedbackUrl: "https://api.agentpact.xyz/api/feedback",
                });
                results.push({ dealId: deal.id, completed: true });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                results.push({ dealId: deal.id, completed: false, error: message });
            }
        }
        return { processed: results.length, results };
    });
    app.post("/api/admin/force-close", async (request, reply) => {
        if (!checkAdminKey(request, reply))
            return;
        const body = z
            .object({
            dealId: z.string().uuid(),
            reason: z.string().optional().default("Admin force-close"),
        })
            .parse(request.body);
        const [deal] = await sql `
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
      FROM deals WHERE id = ${body.dealId}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (deal.status === "completed")
            return { ok: true, alreadyCompleted: true };
        await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${body.dealId} AND status NOT IN ('verified', 'revoked')`;
        const releaseResult = await completeDealMilestones(body.dealId, { skipOnChainRelease: false });
        if (deal.offer_id) {
            await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
        }
        await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
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
        const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${body.dealId}`;
        return { ok: true, deal: updatedDeal, release: releaseResult };
    });
    app.post("/api/admin/force-release", async (request, reply) => {
        const adminKey = process.env.ADMIN_API_KEY;
        if (!adminKey)
            return reply.code(503).send({ error: "Admin API not configured" });
        const authHeader = request.headers["x-admin-key"] ||
            String(request.headers["authorization"] ?? "").replace("Bearer ", "");
        if (authHeader !== adminKey)
            return reply.code(403).send({ error: "Invalid admin key" });
        const body = z
            .object({
            milestoneId: z.string().uuid(),
            reason: z.string().optional(),
        })
            .parse(request.body);
        const [milestone] = await sql `
      SELECT m.*, d.id AS deal_id, d.status AS deal_status, d.seller_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
        if (!milestone)
            return reply.code(404).send({ error: "Milestone not found" });
        const mode = isOnChainMode() ? "on-chain" : "simulation";
        let txHash = null;
        if (mode === "on-chain") {
            try {
                const result = await resolveDisputeOnChain(body.milestoneId, false);
                txHash = result.txHash;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[admin/force-release] On-chain resolveDispute failed: ${message}`);
            }
        }
        await sql `UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = ${body.milestoneId}`;
        await sql `UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${milestone.deal_id}`;
        await sql `UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ${body.milestoneId} AND status = 'funded'`;
        console.log(`[admin/force-release] Milestone ${body.milestoneId} released. Reason: ${body.reason || "admin action"}. TxHash: ${txHash || "N/A"}`);
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
        if (!checkAdminKey(request, reply))
            return;
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z.object({ isInternal: z.boolean() }).parse(request.body);
        const [agent] = await sql `
      UPDATE agents
      SET is_internal = ${body.isInternal}
      WHERE id = ${id}
      RETURNING id, handle, display_name, is_internal
    `;
        if (!agent)
            return reply.code(404).send({ error: "Agent not found" });
        return { ok: true, agent };
    });
    // ── WIS-107: Bulk-mark agents by wallet prefix / handle pattern ──────────
    app.post("/api/admin/agents/bulk-mark-internal", async (request, reply) => {
        if (!checkAdminKey(request, reply))
            return;
        const body = z.object({
            walletAddresses: z.array(z.string()).optional(),
            handlePatterns: z.array(z.string()).optional(),
            isInternal: z.boolean(),
        }).parse(request.body);
        const results = [];
        if (body.walletAddresses && body.walletAddresses.length > 0) {
            const wallets = body.walletAddresses;
            const rows = await sql `
        UPDATE agents
        SET is_internal = ${body.isInternal}
        WHERE owner_wallet_address = ANY(${wallets}::text[])
        RETURNING id, handle, is_internal
      `;
            results.push(...rows.map(r => ({
                id: String(r.id), handle: String(r.handle), isInternal: Boolean(r.is_internal)
            })));
        }
        if (body.handlePatterns && body.handlePatterns.length > 0) {
            for (const pattern of body.handlePatterns) {
                const rows = await sql `
          UPDATE agents
          SET is_internal = ${body.isInternal}
          WHERE handle ILIKE ${"%" + pattern + "%"}
          RETURNING id, handle, is_internal
        `;
                results.push(...rows.map(r => ({
                    id: String(r.id), handle: String(r.handle), isInternal: Boolean(r.is_internal)
                })));
            }
        }
        return { ok: true, updated: results.length, agents: results };
    });
    // ── WIS-107: Real traction metrics (external agents only) ─────────────────
    app.get("/api/admin/traction", async (request, reply) => {
        if (!checkAdminKey(request, reply))
            return;
        const [overview] = await sql `
      SELECT
        COUNT(*)::int AS total_agents,
        COUNT(*) FILTER (WHERE NOT is_internal)::int AS external_agents,
        COUNT(*) FILTER (WHERE is_internal)::int AS internal_agents
      FROM agents
    `;
        const [offerStats] = await sql `
      SELECT
        COUNT(*)::int AS total_active_offers,
        COUNT(*) FILTER (WHERE a.is_internal = FALSE)::int AS external_active_offers
      FROM offers o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.status = 'active'
    `;
        const [dealStats] = await sql `
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
        const [needStats] = await sql `
      SELECT
        COUNT(*)::int AS total_open_needs,
        COUNT(*) FILTER (WHERE a.is_internal = FALSE)::int AS external_open_needs
      FROM needs n
      JOIN agents a ON a.id = n.agent_id
      WHERE n.status = 'open'
    `;
        const recentExternal = await sql `
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
