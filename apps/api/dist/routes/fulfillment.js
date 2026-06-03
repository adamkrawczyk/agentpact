import { z } from "zod";
import { provideFulfillmentSchema, provideBuyerFulfillmentSchema, getFulfillmentSchema, rotateCredentialSchema, requestRotationSchema, verifyFulfillmentSchema, confirmDeliverySchema, revokeFulfillmentSchema, } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, asRecord, FULFILLMENT_TYPES } from "./utils.js";
import { ensureCredentialVaultSchema, vaultStore, vaultRetrieve, vaultRotate, } from "../credential-vault.js";
export async function registerRoutes(app, sql, deps) {
    const { notifyAgents, autoVerify, credentialEncryptionKey, vaultSql, completeDealMilestones, storeBuyerContext, retrieveBuyerContext } = deps;
    async function audit(actorId, action, objectType, objectId, idem, payload) {
        await sql `
      INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
      VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
    `;
    }
    async function logCredentialAccess(fulfillmentId, agentId, action, ipAddress) {
        await ensureCredentialVaultSchema(vaultSql);
        await sql `
      INSERT INTO credential_access_log (fulfillment_id, agent_id, action, ip_address)
      VALUES (${fulfillmentId}, ${agentId}, ${action}, ${ipAddress ?? null})
    `;
    }
    function sendValidationError(reply, error, message = "Validation error") {
        return reply.code(400).send({ error: message, details: error.issues });
    }
    function parseOrReply(reply, schema, value, message = "Validation error") {
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            sendValidationError(reply, parsed.error, message);
            return null;
        }
        return parsed.data;
    }
    async function applyFulfillmentExpiryChecks(deal, fulfillment) {
        await ensureCredentialVaultSchema(vaultSql);
        if (!fulfillment.expires_at)
            return fulfillment;
        const expiresAt = new Date(String(fulfillment.expires_at));
        if (Number.isNaN(expiresAt.getTime()))
            return fulfillment;
        const now = new Date();
        const status = String(fulfillment.status);
        const expiresInMs = expiresAt.getTime() - now.getTime();
        const oneDayMs = 24 * 60 * 60 * 1000;
        if (expiresInMs <= 0 && status !== "expired" && status !== "revoked") {
            const [expired] = await sql `
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
                return expired;
            }
        }
        if (expiresInMs > 0 && expiresInMs <= oneDayMs && !fulfillment.last_expiry_warning_at) {
            const [warned] = await sql `
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
                return warned;
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
        const { id } = request.params;
        const body = parseOrReply(reply, provideFulfillmentSchema, request.body);
        if (!body)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `
      SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
      FROM deals d
      JOIN offers o ON o.id = d.offer_id
      WHERE d.id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.seller_agent_id)
            return reply.code(403).send({ error: "Only seller can provide fulfillment details" });
        if (!["active", "funded", "delivered", "completed"].includes(String(deal.status))) {
            return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept fulfillment details` });
        }
        const typeKey = String(deal.fulfillment_type);
        const typeConfig = FULFILLMENT_TYPES[typeKey] ?? FULFILLMENT_TYPES.generic;
        const parsedData = parseOrReply(reply, typeConfig.schema, body.fulfillmentData, "Invalid fulfillment data");
        if (!parsedData)
            return;
        const parsedRecord = asRecord(parsedData);
        const expiresAt = typeof parsedData === "object" && parsedData !== null && "expires_at" in parsedData
            ? parsedData.expires_at ?? null
            : null;
        const autoVerifyResult = typeConfig.autoVerify
            ? await autoVerify(typeConfig.autoVerify, parsedData)
            : { success: true, details: "No auto-verification available for this type" };
        const [fulfillment] = await sql `
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
        const redactedData = await vaultStore(vaultSql, String(fulfillment.id), typeKey, parsedRecord, credentialEncryptionKey);
        const encryptedFields = Object.entries(redactedData)
            .filter(([, value]) => value === "[encrypted]")
            .map(([field]) => field);
        const [stored] = await sql `
      UPDATE deal_fulfillment
      SET fulfillment_data = ${redactedData}::jsonb, updated_at = NOW()
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
        const [dealFull] = await sql `SELECT acceptance_timeout_days, is_free_tier FROM deals WHERE id = ${id}`;
        if (!dealFull?.is_free_tier && Number(dealFull?.acceptance_timeout_days ?? 7) === 0) {
            try {
                await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')`;
                const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: false });
                // tillopen_0306/P1 — only celebrate (reputation bump, "Deal complete!"
                // notifications, auto_completed:true) when the deal ACTUALLY settled. If
                // the guard held it at 'delivered' (settlement_pending — fee-bearing deal
                // with no real-money funded intent), do NOT reward the seller or claim
                // completion; surface the pending state so the buyer funds it.
                if (releaseResult.action === "settlement_pending") {
                    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.settlement_pending", {
                        dealId: id,
                        reason: "Fulfillment delivered, but no funded payment was found. Fund the deal to release escrow and complete it.",
                    });
                    const [pendingDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
                    return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields, auto_completed: false, settlement_pending: true, deal: pendingDeal, release: releaseResult });
                }
                await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
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
                const [completedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
                return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields, auto_completed: true, deal: completedDeal, release: releaseResult });
            }
            catch (autoErr) {
                console.error("[fulfillment] Auto-complete failed:", autoErr.message);
            }
        }
        return reply.code(200).send({ ...stored, encrypted_fields: encryptedFields });
    });
    app.post("/api/deals/:id/fulfillment/buyer", async (request, reply) => {
        const { id } = request.params;
        const body = parseOrReply(reply, provideBuyerFulfillmentSchema, request.body);
        if (!body)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `
      SELECT d.id, d.status, d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
      FROM deals d
      JOIN offers o ON o.id = d.offer_id
      WHERE d.id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.buyer_agent_id)
            return reply.code(403).send({ error: "Only buyer can provide buyer fulfillment context" });
        if (!["active", "funded", "delivered", "completed"].includes(String(deal.status))) {
            return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept buyer fulfillment context` });
        }
        const typeKey = String(deal.fulfillment_type);
        const parsedRecord = asRecord(body.buyerData);
        const [fulfillment] = await sql `
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
        const [stored] = await sql `
      UPDATE deal_fulfillment
      SET buyer_data = ${redactedData}::jsonb, updated_at = NOW()
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
    app.get("/api/deals/:id/fulfillment", { preHandler: app.authenticate }, async (request, reply) => {
        const { id } = request.params;
        const query = parseOrReply(reply, getFulfillmentSchema, request.query ?? {});
        if (!query)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        const actorId = requesterAgentId;
        const [deal] = await sql `
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (actorId !== deal.buyer_agent_id && actorId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Not authorized for this deal" });
        }
        const [fulfillment] = await sql `SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
        if (!fulfillment)
            return reply.code(404).send({ error: "Fulfillment not found" });
        const checked = await applyFulfillmentExpiryChecks({ id: String(deal.id), buyer_agent_id: String(deal.buyer_agent_id), seller_agent_id: String(deal.seller_agent_id) }, {
            ...fulfillment,
            id: String(fulfillment.id),
            status: String(fulfillment.status),
            expires_at: fulfillment.expires_at ?? null,
            last_expiry_warning_at: fulfillment.last_expiry_warning_at ?? null,
        });
        const isBuyer = actorId === deal.buyer_agent_id;
        const canDecryptBuyerData = isBuyer || query.decrypt;
        const rawBuyerData = checked.buyer_data;
        const buyerDataRecord = asRecord(rawBuyerData);
        const fulfillmentDataRecord = asRecord(checked.fulfillment_data);
        let fulfillmentData = fulfillmentDataRecord;
        if (query.decrypt) {
            fulfillmentData = await vaultRetrieve(vaultSql, String(checked.id), fulfillmentDataRecord, credentialEncryptionKey);
        }
        let buyerData = rawBuyerData === null ? null : buyerDataRecord;
        if (canDecryptBuyerData && (Object.keys(buyerDataRecord).length > 0 || rawBuyerData !== null)) {
            buyerData = await retrieveBuyerContext(String(checked.id), buyerDataRecord);
        }
        if (query.decrypt) {
            await logCredentialAccess(String(checked.id), actorId, "decrypt", request.ip);
        }
        return { ...checked, fulfillment_data: fulfillmentData, buyer_data: buyerData };
    });
    app.post("/api/deals/:id/fulfillment/rotate", async (request, reply) => {
        const { id } = request.params;
        const body = parseOrReply(reply, rotateCredentialSchema, request.body);
        if (!body)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Only seller can rotate credentials" });
        }
        const [fulfillment] = await sql `SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
        if (!fulfillment)
            return reply.code(404).send({ error: "Fulfillment not found" });
        await vaultRotate(vaultSql, String(fulfillment.id), body.fieldName, body.newValue, credentialEncryptionKey);
        await logCredentialAccess(String(fulfillment.id), body.agentId, "rotate", request.ip);
        const [updated] = await sql `
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
        const { id } = request.params;
        const query = parseOrReply(reply, z.object({ agentId: z.string().uuid() }), request.query ?? {});
        if (!query)
            return;
        await ensureCredentialVaultSchema(vaultSql);
        const [deal] = await sql `
      SELECT id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (query.agentId !== deal.seller_agent_id) {
            return reply.code(403).send({ error: "Only seller can view fulfillment audit logs" });
        }
        const [fulfillment] = await sql `SELECT id FROM deal_fulfillment WHERE deal_id = ${id}`;
        if (!fulfillment)
            return reply.code(404).send({ error: "Fulfillment not found" });
        const logs = await sql `
      SELECT id, fulfillment_id, agent_id, action, ip_address, created_at
      FROM credential_access_log
      WHERE fulfillment_id = ${fulfillment.id}
      ORDER BY created_at DESC
    `;
        return logs;
    });
    app.post("/api/deals/:id/fulfillment/request-rotation", async (request, reply) => {
        const { id } = request.params;
        const body = parseOrReply(reply, requestRotationSchema, request.body);
        if (!body)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        await ensureCredentialVaultSchema(vaultSql);
        const [deal] = await sql `
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.buyer_agent_id) {
            return reply.code(403).send({ error: "Only buyer can request credential rotation" });
        }
        const [updated] = await sql `
      UPDATE deal_fulfillment
      SET rotation_requested_at = NOW(), updated_at = NOW()
      WHERE deal_id = ${id}
      RETURNING *
    `;
        if (!updated)
            return reply.code(404).send({ error: "Fulfillment not found" });
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
        const { id } = request.params;
        const body = parseOrReply(reply, verifyFulfillmentSchema, request.body);
        if (!body)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.buyer_agent_id)
            return reply.code(403).send({ error: "Only buyer can verify fulfillment" });
        const [existing] = await sql `SELECT * FROM deal_fulfillment WHERE deal_id = ${id}`;
        if (!existing)
            return reply.code(404).send({ error: "Fulfillment not found" });
        const verificationPayload = JSON.stringify({
            buyerVerification: {
                accepted: body.accepted,
                notes: body.notes ?? null,
                verifiedAt: new Date().toISOString(),
            },
        });
        const [updated] = await sql `
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
        const body = parseOrReply(reply, confirmDeliverySchema, request.body);
        if (!body)
            return;
        try {
            const { id } = request.params;
            const idem = idempotencyKey(request.headers);
            const requesterAgentId = getRequesterAgentId(request, reply);
            if (!requesterAgentId)
                return;
            if (body.agentId !== requesterAgentId) {
                return reply.code(403).send({ error: "Not authorized to act as this agent" });
            }
            const rating = body.rating ?? 5;
            const [deal] = await sql `
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id
      FROM deals
      WHERE id = ${id}
    `;
            if (!deal)
                return reply.code(404).send({ error: "Deal not found" });
            if (body.agentId !== deal.buyer_agent_id) {
                return reply.code(403).send({ error: "Only buyer can confirm delivery" });
            }
            if (!["active", "funded", "delivered"].includes(String(deal.status))) {
                return reply.code(400).send({ error: `Deal status ${deal.status} cannot be confirmed` });
            }
            const [fulfillment] = await sql `
      SELECT id, status
      FROM deal_fulfillment
      WHERE deal_id = ${id}
    `;
            if (!fulfillment)
                return reply.code(404).send({ error: "Fulfillment not found" });
            if (!["provided", "active", "verified"].includes(String(fulfillment.status))) {
                return reply.code(400).send({ error: `Fulfillment status ${fulfillment.status} cannot be confirmed` });
            }
            await sql `
      UPDATE deal_fulfillment
      SET status = 'verified', updated_at = NOW()
      WHERE deal_id = ${id}
    `;
            const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: false });
            // tillopen_0306/P1 — if the deal was held (no real-money funding), do not
            // archive the offer, reward the seller, or claim completion. Surface pending.
            if (releaseResult.action === "settlement_pending") {
                notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.settlement_pending", {
                    dealId: id, reason: "Delivery confirmed, but the deal has unfunded milestones — fund them to release escrow and complete.",
                });
                const [pendingDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
                const pendingMilestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
                const pendingEvents = await sql `SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
                return reply.code(200).send({ ...pendingDeal, settlement_pending: true, milestones: pendingMilestones, events: pendingEvents, release: releaseResult });
            }
            if (deal.offer_id) {
                await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
            }
            await audit(body.agentId, "deal.buyer_review", "deal", id, idem, {
                dealId: id,
                rating,
                notes: body.notes ?? null,
            });
            await sql `
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
            const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
            const milestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
            const events = await sql `SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
            return {
                ...updatedDeal,
                milestones,
                events,
                release: releaseResult,
            };
        }
        catch (err) {
            request.log.error(err, "confirm-delivery failed");
            return reply.code(500).send({ error: "Internal server error" });
        }
    });
    // ── Simplified deal close (one-call completion for buyers) ──────────
    app.post("/api/deals/:id/close", async (request, reply) => {
        const body = parseOrReply(reply, 
        // ── §3.3 (Tori, 2026-05-21): public close endpoint MUST NOT accept
        // skipOnChainRelease. Only admin/maintenance routes may bypass the
        // on-chain release; buyer-facing close always goes through the full
        // release path. Body field removed from schema so payloads with it
        // are rejected by zod.passthrough — silent acceptance with hardcoded
        // false was a latent foot-gun.
        z.object({
            agentId: z.string().uuid(),
            rating: z.number().min(1).max(5).optional(),
            notes: z.string().optional(),
        }), request.body);
        if (!body)
            return;
        try {
            const { id } = request.params;
            const idem = idempotencyKey(request.headers);
            const requesterAgentId = getRequesterAgentId(request, reply);
            if (!requesterAgentId)
                return;
            if (body.agentId !== requesterAgentId) {
                return reply.code(403).send({ error: "Not authorized to act as this agent" });
            }
            const rating = body.rating ?? 5;
            const [deal] = await sql `
        SELECT id, status, buyer_agent_id, seller_agent_id, offer_id, is_free_tier
        FROM deals WHERE id = ${id}
      `;
            if (!deal)
                return reply.code(404).send({ error: "Deal not found" });
            if (body.agentId !== deal.buyer_agent_id) {
                return reply.code(403).send({ error: "Only buyer can close a deal" });
            }
            if (!["active", "funded", "delivered", "proposed", "countered"].includes(String(deal.status))) {
                return reply.code(400).send({ error: `Deal status '${deal.status}' cannot be closed` });
            }
            if (deal.is_free_tier) {
                const [fulfillment] = await sql `
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
            await sql `
        UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW()
        WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')
      `;
            const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: false });
            // tillopen_0306/P1 — held deal (unfunded milestones): do not archive,
            // reward, or claim "closed". Surface pending so the buyer funds first.
            if (releaseResult.action === "settlement_pending") {
                notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.settlement_pending", {
                    dealId: id, reason: "Close requested, but the deal has unfunded milestones — fund them to release escrow and complete.",
                });
                const [pendingDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
                const pendingMilestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
                return { ...pendingDeal, settlement_pending: true, milestones: pendingMilestones, release: releaseResult };
            }
            if (deal.offer_id) {
                await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
            }
            await audit(body.agentId, "deal.close", "deal", id, idem, { dealId: id, rating, notes: body.notes ?? null });
            await sql `
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
            const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
            const milestones = await sql `SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
            return { ...updatedDeal, milestones, release: releaseResult };
        }
        catch (err) {
            request.log.error(err, "deal close failed");
            return reply.code(500).send({ error: "Internal server error" });
        }
    });
    // ── Auto-complete timed-out delivered deals (cron-friendly) ─────────
    app.post("/api/deals/:id/fulfillment/auto-complete", async (request, reply) => {
        const { id } = request.params;
        const [deal] = await sql `
      SELECT id, status, buyer_agent_id, seller_agent_id, offer_id, acceptance_timeout_days, updated_at
      FROM deals WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (!["delivered", "active", "funded"].includes(String(deal.status))) {
            return { ok: false, reason: `Deal status '${deal.status}' is not eligible for auto-complete` };
        }
        const timeoutDays = Number(deal.acceptance_timeout_days ?? 7);
        const updatedAt = new Date(deal.updated_at);
        const expiredAt = new Date(updatedAt.getTime() + timeoutDays * 24 * 60 * 60 * 1000);
        const force = request.query.force === "true";
        if (!force && new Date() < expiredAt) {
            return { ok: false, reason: `Acceptance timeout not reached. Expires at ${expiredAt.toISOString()}`, expiresAt: expiredAt.toISOString() };
        }
        await sql `UPDATE deal_fulfillment SET status = 'verified', updated_at = NOW() WHERE deal_id = ${id} AND status NOT IN ('verified', 'revoked')`;
        const releaseResult = await completeDealMilestones(id, { skipOnChainRelease: false });
        // tillopen_0306/P1 — do not archive the offer, reward the seller, or claim
        // completion when the deal was held at 'delivered' (settlement_pending).
        if (releaseResult.action === "settlement_pending") {
            notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.settlement_pending", {
                dealId: id, reason: "Acceptance timeout reached but no funded payment was found — deal cannot complete until funded.",
            });
            const [pendingDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
            return { ok: true, completed: false, settlement_pending: true, deal: pendingDeal, release: releaseResult };
        }
        if (deal.offer_id) {
            await sql `UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
        }
        await sql `UPDATE agents SET reputation_score = LEAST(COALESCE(reputation_score, 0) + 0.5, 9.999) WHERE id = ${deal.seller_agent_id}`;
        notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.auto_completed", {
            dealId: id, reason: "Acceptance timeout reached — deal auto-completed", expiredAt: expiredAt.toISOString(),
        });
        const [updatedDeal] = await sql `SELECT * FROM deals WHERE id = ${id}`;
        return { ok: true, completed: true, deal: updatedDeal, release: releaseResult };
    });
    // NOTE: admin routes (auto-complete-timeouts, force-close) live in routes/admin.ts
    app.post("/api/deals/:id/fulfillment/revoke", async (request, reply) => {
        const { id } = request.params;
        const body = parseOrReply(reply, revokeFulfillmentSchema, request.body);
        if (!body)
            return;
        const requesterAgentId = getRequesterAgentId(request, reply);
        if (!requesterAgentId)
            return;
        if (body.agentId !== requesterAgentId) {
            return reply.code(403).send({ error: "Not authorized to act as this agent" });
        }
        const [deal] = await sql `
      SELECT id, buyer_agent_id, seller_agent_id
      FROM deals
      WHERE id = ${id}
    `;
        if (!deal)
            return reply.code(404).send({ error: "Deal not found" });
        if (body.agentId !== deal.seller_agent_id)
            return reply.code(403).send({ error: "Only seller can revoke fulfillment" });
        const [updated] = await sql `
      UPDATE deal_fulfillment
      SET status = 'revoked', updated_at = NOW()
      WHERE deal_id = ${id}
      RETURNING *
    `;
        if (!updated)
            return reply.code(404).send({ error: "Fulfillment not found" });
        await logCredentialAccess(String(updated.id), body.agentId, "revoke", request.ip);
        notifyAgents(sql, [deal.buyer_agent_id], "deal.fulfillment_revoked", {
            dealId: id,
            sellerAgentId: body.agentId,
            status: "revoked",
        });
        return updated;
    });
}
