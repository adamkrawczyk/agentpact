import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./types.js";
import {
  provideFulfillmentSchema,
  provideBuyerFulfillmentSchema,
  getFulfillmentSchema,
  rotateCredentialSchema,
  requestRotationSchema,
  verifyFulfillmentSchema,
  confirmDeliverySchema,
  revokeFulfillmentSchema,
} from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, asRecord, FULFILLMENT_TYPES, toNumber } from "./utils.js";
import {
  ensureCredentialVaultSchema,
  vaultStore,
  vaultRetrieve,
  vaultRotate,
} from "../credential-vault.js";

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, deps: Deps): Promise<void> {
  const { notifyAgents, autoVerify, credentialEncryptionKey, vaultSql, completeDealMilestones, storeBuyerContext, retrieveBuyerContext } = deps;

  async function audit(actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
    await sql`
      INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
      VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
    `;
  }

  async function logCredentialAccess(
    fulfillmentId: string,
    agentId: string,
    action: "decrypt" | "rotate" | "request_rotation" | "revoke",
    ipAddress?: string,
  ): Promise<void> {
    await ensureCredentialVaultSchema(vaultSql);
    await sql`
      INSERT INTO credential_access_log (fulfillment_id, agent_id, action, ip_address)
      VALUES (${fulfillmentId}, ${agentId}, ${action}, ${ipAddress ?? null})
    `;
  }

  async function applyFulfillmentExpiryChecks(
    deal: { id: string; buyer_agent_id: string; seller_agent_id: string },
    fulfillment: {
      id: string;
      status: string;
      expires_at: string | Date | null;
      last_expiry_warning_at: string | Date | null;
    } & Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await ensureCredentialVaultSchema(vaultSql);
    if (!fulfillment.expires_at) return fulfillment;

    const expiresAt = new Date(String(fulfillment.expires_at));
    if (Number.isNaN(expiresAt.getTime())) return fulfillment;

    const now = new Date();
    const status = String(fulfillment.status);
    const expiresInMs = expiresAt.getTime() - now.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;

    if (expiresInMs <= 0 && status !== "expired" && status !== "revoked") {
      const [expired] = await sql`
        UPDATE deal_fulfillment
        SET status = 'expired', updated_at = NOW()
        WHERE id = ${fulfillment.id}
        RETURNING *
      `;
      if (expired) {
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.fulfillment_expired", {
          dealId: deal.id,
          fulfillmentId: String(fulfillment.id),
          expiresAt: fulfillment.expires_at,
          status: "expired",
        });
        return expired as Record<string, unknown>;
      }
    }

    if (expiresInMs > 0 && expiresInMs <= oneDayMs && !fulfillment.last_expiry_warning_at) {
      const [warned] = await sql`
        UPDATE deal_fulfillment
        SET last_expiry_warning_at = NOW(), updated_at = NOW()
        WHERE id = ${fulfillment.id}
        RETURNING *
      `;
      if (warned) {
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.fulfillment_expiring", {
          dealId: deal.id,
          fulfillmentId: String(fulfillment.id),
          expiresAt: fulfillment.expires_at,
          hoursRemaining: Number((expiresInMs / (60 * 60 * 1000)).toFixed(2)),
        });
        return warned as Record<string, unknown>;
      }
    }

    return fulfillment;
  }

  app.get("/api/fulfillment/types", async () => {
    return Object.entries(FULFILLMENT_TYPES).map(([type, config]) => ({
      type,
      label: config.label,
      description: config.description,
      fields: config.fields,
      autoVerify: config.autoVerify,
    }));
  });

  app.post("/api/deals/:id/fulfillment", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = provideFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
      FROM deals d
      JOIN offers o ON o.id = d.offer_id
      WHERE d.id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.seller_agent_id) return reply.code(403).send({ error: "Only seller can provide fulfillment details" });
    if (!["active", "delivered", "completed"].includes(String(deal.status))) {
      return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept fulfillment details` });
    }

    const typeKey = String(deal.fulfillment_type) as keyof typeof FULFILLMENT_TYPES;
    const typeConfig = FULFILLMENT_TYPES[typeKey] ?? FULFILLMENT_TYPES.generic;
    const parsedData = typeConfig.schema.parse(body.fulfillmentData);
    const parsedRecord = asRecord(parsedData);

    const expiresAt =
      typeof parsedData === "object" && parsedData !== null && "expires_at" in parsedData
        ? (parsedData.expires_at as string | undefined) ?? null
        : null;

    const autoVerifyResult = typeConfig.autoVerify
      ? await autoVerify(typeConfig.autoVerify, parsedData as Record<string, unknown>)
      : { success: true, details: "No auto-verification available for this type" };

    const [fulfillment] = await sql`
      INSERT INTO deal_fulfillment (
        deal_id, fulfillment_type, fulfillment_data, status, expires_at, provided_at, auto_verify_result, updated_at
      ) VALUES (
        ${id}, ${typeKey}, ${JSON.stringify(parsedData)}::jsonb, 'provided', ${expiresAt}, NOW(), ${JSON.stringify(autoVerifyResult)}::jsonb, NOW()
      )
      ON CONFLICT (deal_id) DO UPDATE SET
        fulfillment_type = EXCLUDED.fulfillment_type,
        fulfillment_data = EXCLUDED.fulfillment_data,
        status = 'provided',
        expires_at = EXCLUDED.expires_at,
        provided_at = NOW(),
        auto_verify_result = EXCLUDED.auto_verify_result,
        updated_at = NOW()
      RETURNING *
    `;

    const redactedData = await vaultStore(
      vaultSql,
      String(fulfillment.id),
      typeKey,
      parsedRecord,
      credentialEncryptionKey,
    );
    const encryptedFields = Object.entries(redactedData)
      .filter(([, value]) => value === "[encrypted]")
      .map(([field]) => field);

    const [stored] = await sql`
      UPDATE deal_fulfillment
      SET fulfillment_data = ${redactedData as any}::jsonb, updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;

    notifyAgents(sql, [deal.buyer_agent_id], "deal.fulfillment_provided", {
      dealId: id,
      sellerAgentId: body.agentId,
      fulfillmentType: typeKey,
      status: stored.status,
      encryptedFields,
    });

    // ── Instant auto-complete: if acceptance_timeout_days = 0, close the deal immediately ──
    const [dealFull] = await sql`SELECT acceptance_timeout_days, is_free_tier FROM deals WHERE id = ${id}`;
    if (!dealFull?.is_free_tier && Number(dealFull?.acceptance_timeout_days ?? 7) === 0) {
      try {
        await sql`UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')`;
        await completeDealMilestones(id, { skipOnChainRelease: false });
        await sql`UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
          dealId: id, reason: "acceptance_timeout_days=0 — instant auto-complete on fulfillment",
        });
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
          dealId: id,
          message: "Deal complete! Leave feedback via POST /api/feedback to build your reputation.",
          feedbackUrl: "https://api.agentpact.xyz/api/feedback",
          buyerAgentId: deal.buyer_agent_id,
          sellerAgentId: deal.seller_agent_id,
        });
        const [completedDeal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
        return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields, auto_completed: true, deal: completedDeal });
      } catch (autoErr: any) {
        console.error("[fulfillment] Auto-complete failed:", autoErr.message);
      }
    }

    return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields });
  });

  app.post("/api/deals/:id/fulfillment/buyer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = provideBuyerFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
      FROM deals d
      JOIN offers o ON o.id = d.offer_id
      WHERE d.id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id) return reply.code(403).send({ error: "Only buyer can provide buyer fulfillment context" });
    if (!["active", "delivered", "completed"].includes(String(deal.status))) {
      return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept buyer fulfillment context` });
    }

    const typeKey = String(deal.fulfillment_type);
    const parsedRecord = asRecord(body.buyerData);
    const [fulfillment] = await sql`
      INSERT INTO deal_fulfillment (
        deal_id, fulfillment_type, buyer_data, status, updated_at
      ) VALUES (
        ${id}, ${typeKey}, '{}'::jsonb, 'pending', NOW()
      )
      ON CONFLICT (deal_id) DO UPDATE SET
        fulfillment_type = EXCLUDED.fulfillment_type,
        updated_at = NOW()
      RETURNING *
    `;

    const redactedData = await storeBuyerContext(String(fulfillment.id), typeKey, parsedRecord);
    const encryptedFields = Object.entries(redactedData)
      .filter(([, value]) => value === "[encrypted]")
      .map(([field]) => field);

    const [stored] = await sql`
      UPDATE deal_fulfillment
      SET buyer_data = ${redactedData as any}::jsonb, updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;

    notifyAgents(sql, [deal.seller_agent_id], "deal.buyer_context_provided", {
      dealId: id,
      buyerAgentId: body.agentId,
      fulfillmentType: typeKey,
      encryptedFields,
    });

    return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields });
  });

  app.get("/api/deals/:id/fulfillment", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = getFulfillmentSchema.parse(request.query ?? {});

    const [deal] = await sql`
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (query.agentId !== deal.buyer_agent_id && query.agentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized for this deal" });
    }

    const [fulfillment] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });

    const checked = await applyFulfillmentExpiryChecks(
      { id: String(deal.id), buyer_agent_id: String(deal.buyer_agent_id), seller_agent_id: String(deal.seller_agent_id) },
      {
        ...(fulfillment as Record<string, unknown>),
        id: String(fulfillment.id),
        status: String(fulfillment.status),
        expires_at: (fulfillment.expires_at as string | Date | null) ?? null,
        last_expiry_warning_at: (fulfillment.last_expiry_warning_at as string | Date | null) ?? null,
      },
    );

    const isBuyer = query.agentId === deal.buyer_agent_id;
    const canDecryptBuyerData = isBuyer || query.decrypt;

    const rawBuyerData = checked.buyer_data;
    const buyerDataRecord = asRecord(rawBuyerData);
    const fulfillmentDataRecord = asRecord(checked.fulfillment_data);

    let fulfillmentData = fulfillmentDataRecord as Record<string, unknown>;
    if (query.decrypt) {
      fulfillmentData = await vaultRetrieve(
        vaultSql,
        String(checked.id),
        fulfillmentDataRecord,
        credentialEncryptionKey,
      );
    }

    let buyerData: Record<string, unknown> | null = rawBuyerData === null ? null : buyerDataRecord;
    if (canDecryptBuyerData && (Object.keys(buyerDataRecord).length > 0 || rawBuyerData !== null)) {
      buyerData = await retrieveBuyerContext(String(checked.id), buyerDataRecord);
    }

    if (query.decrypt) {
      await logCredentialAccess(String(checked.id), query.agentId, "decrypt", request.ip);
    }

    return { ...checked, fulfillment_data: fulfillmentData, buyer_data: buyerData };
  });

  app.post("/api/deals/:id/fulfillment/rotate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = rotateCredentialSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Only seller can rotate credentials" });
    }

    const [fulfillment] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });

    await vaultRotate(vaultSql, String(fulfillment.id), body.fieldName, body.newValue, credentialEncryptionKey);
    await logCredentialAccess(String(fulfillment.id), body.agentId, "rotate", request.ip);

    const [updated] = await sql`
      UPDATE deal_fulfillment
      SET
        fulfillment_data = jsonb_set(
          CASE
            WHEN jsonb_typeof(COALESCE(fulfillment_data, '{}'::jsonb)) = 'object' THEN COALESCE(fulfillment_data, '{}'::jsonb)
            ELSE '{}'::jsonb
          END,
          ARRAY[${body.fieldName}],
          to_jsonb('[encrypted]'::text),
          true
        ),
        updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;

    notifyAgents(sql, [deal.buyer_agent_id], "deal.credential_rotated", {
      dealId: id,
      fulfillmentId: fulfillment.id,
      fieldName: body.fieldName,
      rotatedBy: body.agentId,
      rotatedAt: new Date().toISOString(),
    });

    return updated;
  });

  app.get("/api/deals/:id/fulfillment/audit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ agentId: z.string().uuid() }).parse(request.query ?? {});
    await ensureCredentialVaultSchema(vaultSql);

    const [deal] = await sql`
      SELECT id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (query.agentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Only seller can view fulfillment audit logs" });
    }

    const [fulfillment] = await sql`SELECT id FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });

    const logs = await sql`
      SELECT id, fulfillment_id, agent_id, action, ip_address, created_at
      FROM credential_access_log
      WHERE fulfillment_id = ${fulfillment.id}
      ORDER BY created_at DESC
    `;

    return logs;
  });

  app.post("/api/deals/:id/fulfillment/request-rotation", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = requestRotationSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    await ensureCredentialVaultSchema(vaultSql);

    const [deal] = await sql`
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id) {
      return reply.code(403).send({ error: "Only buyer can request credential rotation" });
    }

    const [updated] = await sql`
      UPDATE deal_fulfillment
      SET rotation_requested_at = NOW(), updated_at = NOW()
      WHERE deal_id = ${id}
      RETURNING *
    `;
    if (!updated) return reply.code(404).send({ error: "Fulfillment not found" });

    await logCredentialAccess(String(updated.id), body.agentId, "request_rotation", request.ip);

    notifyAgents(sql, [deal.seller_agent_id], "deal.rotation_requested", {
      dealId: id,
      fulfillmentId: updated.id,
      requestedBy: body.agentId,
      reason: body.reason ?? null,
      requestedAt: updated.rotation_requested_at,
    });

    return updated;
  });

  app.post("/api/deals/:id/fulfillment/verify", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = verifyFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id) return reply.code(403).send({ error: "Only buyer can verify fulfillment" });

    const [existing] = await sql`SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
    if (!existing) return reply.code(404).send({ error: "Fulfillment not found" });

    const verificationPayload = JSON.stringify({
      buyerVerification: {
        accepted: body.accepted,
        notes: body.notes ?? null,
        verifiedAt: new Date().toISOString(),
      },
    });

    const [updated] = await sql`
      UPDATE deal_fulfillment
      SET
        status = ${body.accepted ? "active" : "pending"},
        verified_at = ${body.accepted ? new Date().toISOString() : null},
        auto_verify_result = COALESCE(auto_verify_result, '{}'::jsonb) || ${verificationPayload}::jsonb,
        updated_at = NOW()
      WHERE deal_id = ${id}
      RETURNING *
    `;

    if (body.accepted) {
      if (body.completeOnVerify) {
        await completeDealMilestones(id, { skipOnChainRelease: false });
      }

      notifyAgents(sql, [deal.seller_agent_id], "deal.fulfillment_verified", {
        dealId: id,
        buyerAgentId: body.agentId,
        accepted: true,
        notes: body.notes,
      });
    }

    return updated;
  });

  app.post("/api/deals/:id/confirm-delivery", async (request, reply) => {
    try {
    const { id } = request.params as { id: string };
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = confirmDeliverySchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const rating = body.rating ?? 5;

    const [deal] = await sql`
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.buyer_agent_id) {
      return reply.code(403).send({ error: "Only buyer can confirm delivery" });
    }
    if (!["active", "delivered"].includes(String(deal.status))) {
      return reply.code(400).send({ error: `Deal status ${deal.status} cannot be confirmed` });
    }

    const [fulfillment] = await sql`
      SELECT id, status
      FROM deal_fulfillment
      WHERE deal_id = ${id}
    `;
    if (!fulfillment) return reply.code(404).send({ error: "Fulfillment not found" });
    if (!["provided", "active", "verified"].includes(String(fulfillment.status))) {
      return reply.code(400).send({ error: `Fulfillment status ${fulfillment.status} cannot be confirmed` });
    }

    await sql`
      UPDATE deal_fulfillment
      SET status = 'verified', updated_at = NOW()
      WHERE deal_id = ${id}
    `;

    const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: body.skipOnChainRelease });

    if (deal.offer_id) {
      await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }

    await audit(body.agentId, "deal.buyer_review", "deal", id, idem, {
      dealId: id,
      rating,
      notes: body.notes ?? null,
    });

    await sql`
      UPDATE agents
      SET reputation_score = LEAST(COALESCE(reputation_score, 0) + (${rating} / 10.0), 9.999)
      WHERE id = ${deal.seller_agent_id}
    `;

    notifyAgents(sql, [deal.seller_agent_id], "deal.delivery_confirmed", {
      dealId: id,
      buyerAgentId: body.agentId,
      rating,
      notes: body.notes ?? null,
      releaseAction: releaseResult.action,
    });

    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
      dealId: id,
      message: "Deal completed! Please leave feedback for your counterpart via POST /api/feedback",
      feedbackUrl: `https://api.agentpact.xyz/api/feedback`,
      buyerAgentId: deal.buyer_agent_id,
      sellerAgentId: deal.seller_agent_id,
    });

    const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
    const milestones = await sql`SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
    const events = await sql`SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;

    return {
      ...updatedDeal,
      milestones,
      events,
      release: releaseResult,
    };
    } catch (err: any) {
      console.error("[confirm-delivery] Error:", err.message, err.stack);
      return reply.code(500).send({ error: "Internal server error", detail: err.message });
    }
  });

  // ── Simplified deal close (one-call completion for buyers) ──────────
  app.post("/api/deals/:id/close", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const idem = idempotencyKey(request.headers as Record<string, unknown>);
      const body = z.object({
        agentId: z.string().uuid(),
        rating: z.number().min(1).max(5).optional(),
        notes: z.string().optional(),
        skipOnChainRelease: z.boolean().optional().default(false),
      }).parse(request.body);
      const requesterAgentId = getRequesterAgentId(request, reply);
      if (!requesterAgentId) return;
      if (body.agentId !== requesterAgentId) {
        return reply.code(403).send({ error: "Not authorized to act as this agent" });
      }
      const rating = body.rating ?? 5;

      const [deal] = await sql`
        SELECT id, status, buyer_agent_id, seller_agent_id, offer_id, is_free_tier
        FROM deals WHERE id = ${id}
      `;
      if (!deal) return reply.code(404).send({ error: "Deal not found" });
      if (body.agentId !== deal.buyer_agent_id) {
        return reply.code(403).send({ error: "Only buyer can close a deal" });
      }
      if (!["active", "delivered", "proposed", "countered"].includes(String(deal.status))) {
        return reply.code(400).send({ error: `Deal status '${deal.status}' cannot be closed` });
      }

      if (deal.is_free_tier) {
        const [fulfillment] = await sql`
          SELECT status
          FROM deal_fulfillment
          WHERE deal_id = ${id}
        `;
        if (!fulfillment) {
          return reply.code(400).send({ error: "Free-tier deals require fulfillment before close" });
        }
        if (!["active", "verified"].includes(String(fulfillment.status))) {
          return reply.code(400).send({ error: "Free-tier deals require verified fulfillment before close" });
        }
      }

      await sql`
        UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW()
        WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')
      `;

      const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: body.skipOnChainRelease });

      if (deal.offer_id) {
        await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
      }

      await audit(body.agentId, "deal.close", "deal", id, idem, { dealId: id, rating, notes: body.notes ?? null });

      await sql`
        UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + (${rating} / 10.0), 9.999)
        WHERE id = ${deal.seller_agent_id}
      `;

      notifyAgents(sql, [deal.seller_agent_id], "deal.closed", {
        dealId: id, buyerAgentId: body.agentId, rating, notes: body.notes ?? null, releaseAction: releaseResult.action,
      });
      notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.feedback_requested", {
        dealId: id,
        message: "Deal closed! Leave feedback via POST /api/feedback",
        feedbackUrl: "https://api.agentpact.xyz/api/feedback",
        buyerAgentId: deal.buyer_agent_id,
        sellerAgentId: deal.seller_agent_id,
      });

      const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
      const milestones = await sql`SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
      return { ...updatedDeal, milestones, release: releaseResult };
    } catch (err: any) {
      console.error("[deal/close] Error:", err.message, err.stack);
      return reply.code(500).send({ error: "Internal server error", detail: err.message });
    }
  });

  // ── Auto-complete timed-out delivered deals (cron-friendly) ─────────
  app.post("/api/deals/:id/fulfillment/auto-complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [deal] = await sql`
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id, acceptance_timeout_days, updated_at
      FROM deals WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (!["delivered", "active"].includes(String(deal.status))) {
      return { ok: false, reason: `Deal status '${deal.status}' is not eligible for auto-complete` };
    }

    const timeoutDays = Number(deal.acceptance_timeout_days ?? 7);
    const updatedAt = new Date(deal.updated_at);
    const expiredAt = new Date(updatedAt.getTime() + timeoutDays * 24 * 60 * 60 * 1000);
    const force = (request.query as Record<string, string>).force === "true";
    if (!force && new Date() < expiredAt) {
      return { ok: false, reason: `Acceptance timeout not reached. Expires at ${expiredAt.toISOString()}`, expiresAt: expiredAt.toISOString() };
    }

    await sql`UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')`;
    await completeDealMilestones(id, { skipOnChainRelease: false });
    if (deal.offer_id) {
      await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
    }
    await sql`UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;

    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
      dealId: id, reason: "Acceptance timeout reached — deal auto-completed", expiredAt: expiredAt.toISOString(),
    });

    const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
    return { ok: true, completed: true, deal: updatedDeal };
  });

  // ── Batch auto-complete all timed-out delivered deals (admin/cron) ──
  app.post("/api/admin/auto-complete-timeouts", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = request.headers["x-admin-key"] || String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey) return reply.code(403).send({ error: "Invalid admin key" });

    const expiredDeals = await sql`
      SELECT id, acceptance_timeout_days, updated_at, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE status IN ('delivered', 'active')
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
      } catch (err: any) {
        results.push({ dealId: deal.id, completed: false, error: err.message });
      }
    }

    return { processed: results.length, results };
  });

  // ── Admin: Force-close specific deal (no timeout check) ─────────────
  app.post("/api/admin/force-close", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = request.headers["x-admin-key"] || String(request.headers["authorization"] ?? "").replace("Bearer ", "");
    if (adminKey && authHeader !== adminKey) return reply.code(403).send({ error: "Invalid admin key" });

    const body = z.object({
      dealId: z.string().uuid(),
      reason: z.string().optional().default("Admin force-close"),
    }).parse(request.body);

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
      dealId: body.dealId, reason: body.reason,
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

  app.post("/api/deals/:id/fulfillment/revoke", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = revokeFulfillmentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.agentId !== deal.seller_agent_id) return reply.code(403).send({ error: "Only seller can revoke fulfillment" });

    const [updated] = await sql`
      UPDATE deal_fulfillment
      SET status = 'revoked', updated_at = NOW()
      WHERE deal_id = ${id}
      RETURNING *
    `;
    if (!updated) return reply.code(404).send({ error: "Fulfillment not found" });
    await logCredentialAccess(String(updated.id), body.agentId, "revoke", request.ip);

    notifyAgents(sql, [deal.buyer_agent_id], "deal.fulfillment_revoked", {
      dealId: id,
      sellerAgentId: body.agentId,
      status: "revoked",
    });

    return updated;
  });
}
