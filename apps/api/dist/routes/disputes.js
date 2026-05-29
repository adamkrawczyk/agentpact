import { createHash } from "node:crypto";
import { submitDeliverySchema, verifyDeliverySchema, disputeSchema } from "./schemas.js";
import { getRequesterAgentId } from "./utils.js";
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
        // ── Task-contract auto-verification (data-delivery-v1) ────────────
        // If the deal has a task_contract with a verifier, run it against the
        // deliverable's download_url from the artifact manifest.
        const [dealRow] = await sql `
      SELECT d.task_contract
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
        const taskContract = dealRow?.task_contract;
        let autoVerifyResult = null;
        if (taskContract && typeof taskContract.verifier === "string") {
            // Extract download_url from the first artifact's url field
            const firstArtifact = Array.isArray(body.artifacts) && body.artifacts.length > 0
                ? body.artifacts[0]
                : {};
            // Merge spec from contract + download_url from deliverable for the verifier
            const verifierData = {
                download_url: firstArtifact.url ?? "",
                ...firstArtifact,
                spec: taskContract.spec ?? {},
            };
            try {
                autoVerifyResult = await deps.autoVerify(taskContract.verifier, verifierData);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                autoVerifyResult = { success: false, details: `Verifier error: ${msg}` };
            }
            if (autoVerifyResult.success) {
                await sql `
          UPDATE deliveries
          SET status = 'auto-verified',
              auto_verify_result = ${JSON.stringify({ ...autoVerifyResult, verifier: taskContract.verifier })}::jsonb,
              verified_at = NOW(),
              verification_notes = COALESCE(${notes}, '') || ' [auto-verified: ' || ${autoVerifyResult.details} || ']'
          WHERE id = ${delivery.id}
        `;
            }
            else {
                await sql `
          UPDATE deliveries
          SET auto_verify_result = ${JSON.stringify({ ...autoVerifyResult, verifier: taskContract.verifier })}::jsonb,
              verification_notes = COALESCE(${notes}, '') || ' [auto-verify FAILED: ' || ${autoVerifyResult.details} || ']'
          WHERE id = ${delivery.id}
        `;
            }
        }
        await sql `UPDATE milestones SET status = 'delivered' WHERE id = ${body.milestoneId}`;
        await sql `
      UPDATE deals SET status = 'delivered', updated_at = NOW()
      WHERE id = (SELECT deal_id FROM milestones WHERE id = ${body.milestoneId})
    `;
        // Re-fetch delivery with updated status/result
        const [updatedDelivery] = await sql `SELECT * FROM deliveries WHERE id = ${delivery.id}`;
        return reply.code(201).send({ ...updatedDelivery, auto_verify_result: autoVerifyResult });
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
    // NOTE: admin force-release route lives in routes/admin.ts
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
