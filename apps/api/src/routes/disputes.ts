import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./types.js";
import { submitDeliverySchema, verifyDeliverySchema, disputeSchema } from "./schemas.js";
import { getRequesterAgentId } from "./utils.js";
import {
  isOnChainMode,
  resolveDisputeOnChain,
} from "../chain.js";

export async function registerRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  deps: Deps,
  releaseMilestonePayment: (milestoneId: string) => Promise<void>,
): Promise<void> {
  const { notifyAgents } = deps;

  app.post("/api/deliveries/submit", async (request, reply) => {
    const body = submitDeliverySchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.submittedBy !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [submissionAuth] = await sql`
      SELECT d.seller_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    if (!submissionAuth) return reply.code(404).send({ error: "Milestone not found" });
    if (submissionAuth.seller_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const checksum = createHash("sha256").update(JSON.stringify(body.artifacts)).digest("hex");
    const notes = body.notes ?? null;

    // ── Revision tracking (delivery-revisions primitive) ──────────────
    // Each submission for a milestone gets a monotonically increasing
    // revision number. If the deal caps attempts (max_revisions), reject
    // submissions beyond the cap with 409 + structured error.
    const [revisionInfo] = await sql`
      SELECT
        (SELECT COUNT(*) FROM deliveries WHERE milestone_id = ${body.milestoneId}) AS prior_count,
        d.max_revisions
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    const revision = Number(revisionInfo?.prior_count ?? 0) + 1;
    const maxRevisions = revisionInfo?.max_revisions == null ? null : Number(revisionInfo.max_revisions);
    if (maxRevisions !== null && revision > maxRevisions) {
      return reply.code(409).send({
        error: "Max revisions exceeded",
        code: "MAX_REVISIONS_EXCEEDED",
        maxRevisions,
        attempted: revision,
      });
    }

    const [delivery] = await sql`
      INSERT INTO deliveries (milestone_id, submitted_by, artifact_manifest, checksum, verification_notes, revision)
      VALUES (${body.milestoneId}, ${body.submittedBy}, ${JSON.stringify(body.artifacts)}::jsonb, ${checksum}, ${notes}, ${revision})
      RETURNING *
    `;

    // ── Task-contract auto-verification (data-delivery-v1) ────────────
    // If the deal has a task_contract with a verifier, run it against the
    // deliverable's download_url from the artifact manifest.
    const [dealRow] = await sql`
      SELECT d.task_contract
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    const taskContract = dealRow?.task_contract as Record<string, unknown> | null;
    let autoVerifyResult: { success: boolean; details: string } | null = null;

    if (taskContract && typeof taskContract.verifier === "string") {
      // Extract download_url from the first artifact's url field
      const firstArtifact = Array.isArray(body.artifacts) && body.artifacts.length > 0
        ? body.artifacts[0] as Record<string, unknown>
        : {};
      // Merge spec from contract + download_url from deliverable for the verifier
      const verifierData = {
        download_url: firstArtifact.url ?? "",
        ...firstArtifact,
        spec: taskContract.spec ?? {},
      };
      try {
        autoVerifyResult = await deps.autoVerify(taskContract.verifier, verifierData);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        autoVerifyResult = { success: false, details: `Verifier error: ${msg}` };
      }

      if (autoVerifyResult.success) {
        await sql`
          UPDATE deliveries
          SET status = 'auto-verified',
              auto_verify_result = ${JSON.stringify({ ...autoVerifyResult, verifier: taskContract.verifier })}::jsonb,
              verified_at = NOW(),
              verification_notes = COALESCE(${notes}, '') || ' [auto-verified: ' || ${autoVerifyResult.details} || ']'
          WHERE id = ${delivery.id}
        `;
      } else {
        await sql`
          UPDATE deliveries
          SET auto_verify_result = ${JSON.stringify({ ...autoVerifyResult, verifier: taskContract.verifier })}::jsonb,
              verification_notes = COALESCE(${notes}, '') || ' [auto-verify FAILED: ' || ${autoVerifyResult.details} || ']'
          WHERE id = ${delivery.id}
        `;
      }
    }

    await sql`UPDATE milestones SET status = 'delivered' WHERE id = ${body.milestoneId}`;
    await sql`
      UPDATE deals SET status = 'delivered', updated_at = NOW()
      WHERE id = (SELECT deal_id FROM milestones WHERE id = ${body.milestoneId})
    `;

    // Re-fetch delivery with updated status/result
    const [updatedDelivery] = await sql`SELECT * FROM deliveries WHERE id = ${delivery.id}`;
    return reply.code(201).send({ ...updatedDelivery, auto_verify_result: autoVerifyResult });
  });

  app.post("/api/deliveries/verify", async (request, reply) => {
    const body = verifyDeliverySchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.buyerAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [verificationAuth] = await sql`
      SELECT d.buyer_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    if (!verificationAuth) return reply.code(404).send({ error: "Milestone not found" });
    if (verificationAuth.buyer_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const verificationNotes = body.verificationNotes ?? null;

    if (!body.accepted) {
      await sql`
        UPDATE deliveries
        SET status = 'rejected', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
        WHERE milestone_id = ${body.milestoneId}
      `;
      await sql`UPDATE milestones SET status = 'in_progress' WHERE id = ${body.milestoneId}`;
      return reply.code(200).send({ accepted: false });
    }

    await sql`
      UPDATE deliveries
      SET status = 'verified', verified_at = NOW(), verification_notes = COALESCE(${verificationNotes}, verification_notes)
      WHERE milestone_id = ${body.milestoneId}
    `;

    const [milestoneInfo] = await sql`
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
    if (!requesterAgentId) return;
    if (body.openedBy !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [deal] = await sql`SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${body.dealId}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const [dispute] = await sql`
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

    await sql`UPDATE milestones SET status = 'disputed' WHERE id = ${body.milestoneId}`;
    await sql`UPDATE deals SET status = 'disputed', updated_at = NOW() WHERE id = ${body.dealId}`;
    return reply.code(201).send(dispute);
  });

  // NOTE: admin force-release route lives in routes/admin.ts

  // Operator/cron surface, not an agent surface — sweeps ALL expired disputes
  // globally and triggers settlement (fund release) for parties unrelated to
  // the caller. Gated with the SAME ADMIN_API_KEY mechanism as the admin
  // sweeper (routes/admin.ts `/api/admin/auto-complete-timeouts`), copied
  // verbatim rather than inventing a new auth mechanism. Kept in this file
  // (not moved to routes/admin.ts) to keep the fix minimal blast-radius — the
  // path is unchanged, so no public-API break, no SDK regen, no lint-routes
  // path-ownership violation (AGENTS.md ownership is about route files not
  // duplicating a path across files, not about the admin/non-admin prefix).
  app.post("/api/disputes/resolve-timeouts", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
      return reply.code(503).send({ error: "Admin API not configured" });
    }
    const authHeader =
      (request.headers["x-admin-key"] as string | undefined) ||
      String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (authHeader !== adminKey) {
      return reply.code(403).send({ error: "Invalid admin key" });
    }

    const expired = await sql`
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
