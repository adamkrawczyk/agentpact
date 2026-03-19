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
      WHERE status IN ('delivered', 'active')
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
}
