import { createHash } from "node:crypto";
import { z } from "zod";
import { submitDeliverySchema, verifyDeliverySchema, disputeSchema } from "./schemas.js";
import { getRequesterAgentId } from "./utils.js";
import { isOnChainMode, resolveDisputeOnChain, } from "../chain.js";
export async function registerRoutes(app, sql, deps, releaseMilestonePayment) {
    const { notifyAgents } = deps;
    app.post("/api/deliveries/submit", async (request, reply) => {
        const body = submitDeliverySchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.submittedBy !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [submissionAuth] = await sql `
      SELECT d.seller_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
        if (!submissionAuth)
            return reply.code(404).send({ error: "Milestone not found" });
        if (submissionAuth.seller_agent_id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const checksum = createHash("sha256").update(JSON.stringify(body.artifacts)).digest("hex");
        const notes = body.notes ?? null;
        const [delivery] = await sql `
      INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, verification_notes)
      VALUES (${body.milestoneId}, ${body.submittedBy}, ${JSON.stringify(body.artifacts)}::jsonb, ${checksum}, ${notes})
      RETURNING *
    `;
        await sql `UPDATE milestones SET status = 'delivered' WHERE id = ${body.milestoneId}`;
        await sql `
      UPDATE deals SET status = 'delivered', updated_at = NOW()
      WHERE id = (SELECT deal_id FROM milestones WHERE id = ${body.milestoneId})
    `;
        return reply.code(201).send(delivery);
    });
    app.post("/api/deliveries/verify", async (request, reply) => {
        const body = verifyDeliverySchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.buyerAgentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [verificationAuth] = await sql `
      SELECT d.buyer_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
        if (!verificationAuth)
            return reply.code(404).send({ error: "Milestone not found" });
        if (verificationAuth.buyer_agent_id !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const verificationNotes = body.verificationNotes ?? null;
        if (!body.accepted) {
            await sql `
        UPDATE deliveries
        SET status = 'rejected', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
        WHERE milestone_id = ${body.milestoneId}
      `;
            await sql `UPDATE milestones SET status = 'in_progress' WHERE id = ${body.milestoneId}`;
            return reply.code(200).send({ accepted: false });
        }
        await sql `
      UPDATE deliveries
      SET status = 'verified', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
      WHERE milestone_id = ${body.milestoneId}
    `;
        const [milestoneInfo] = await sql `
      SELECT d.buyer_agent_id, d.id AS deal_id
      FROM milestones m JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
        await releaseMilestonePayment(body.milestoneId);
        if (milestoneInfo) {
            notifyAgents(sql, [milestoneInfo.buyer_agent_id], "milestone.completed", {
                dealId: milestoneInfo.deal_id,
                milestoneId: body.milestoneId,
                verifiedBy: body.buyerAgentId,
            });
        }
        return { accepted: true, payoutReleased: true };
    });
    app.post("/api/disputes/open", async (request, reply) => {
        const body = disputeSchema.parse(request.body);
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.openedBy !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${body.dealId}`;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Not authorized" });
        }
        const [dispute] = await sql `
      INSERT INTO disputes (deal_id, milestone_id, opened_by, reason, evidence_json, expires_at)
      VALUES (
        ${body.dealId},
        ${body.milestoneId},
        ${body.openedBy},
        ${body.reason},
        ${JSON.stringify(body.evidence)}::jsonb,
        NOW() + INTERVAL '7 days'
      ) RETURNING *
    `;
        await sql `UPDATE milestones SET status = 'disputed' WHERE id = ${body.milestoneId}`;
        await sql `UPDATE deals SET status = 'disputed', updated_at = NOW() WHERE id = ${body.dealId}`;
        return reply.code(201).send(dispute);
    });
    // ── Admin: Force-release stuck on-chain milestones ──────────────────
    app.post("/api/admin/force-release", async (request, reply) => {
        const adminKey = process.env.ADMIN_API_KEY;
        if (!adminKey)
            return reply.code(503).send({ error: "Admin API not configured" });
        const authHeader = request.headers["x-admin-key"] || request.headers["authorization"]?.replace("Bearer ", "");
        if (authHeader !== adminKey)
            return reply.code(403).send({ error: "Invalid admin key" });
        const body = z.object({
            milestoneId: z.string().uuid(),
            reason: z.string().optional(),
        }).parse(request.body);
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
                console.error(`[admin/force-release] On-chain resolveDispute failed: ${err.message}`);
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
    app.post("/api/disputes/resolve-timeouts", async () => {
        const expired = await sql `
      UPDATE disputes
      SET status = 'timed_out', resolved_at = NOW()
      WHERE status = 'open' AND expires_at <= NOW()
      RETURNING *
    `;
        for (const dispute of expired) {
            await releaseMilestonePayment(dispute.milestone_id);
        }
        return { timedOutDisputes: expired.length };
    });
}
