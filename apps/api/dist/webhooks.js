import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
// ── Schemas ──────────────────────────────────────────────────────────
const VALID_EVENTS = [
    "deal.proposed",
    "deal.accepted",
    "deal.cancelled",
    "deal.fulfillment_provided",
    "deal.buyer_context_provided",
    "deal.fulfillment_verified",
    "deal.fulfillment_revoked",
    "deal.credential_rotated",
    "deal.rotation_requested",
    "deal.fulfillment_expiring",
    "deal.fulfillment_expired",
    "deal.feedback_requested",
    "payment.funded",
    "payment.released",
    "milestone.completed",
    "feedback.received",
    "concierge.message",
    "webhook.test",
];
const createWebhookSchema = z.object({
    url: z.string().url(),
    events: z.array(z.enum(VALID_EVENTS)).min(1),
    secret: z.string().min(16).optional(),
});
// ── HMAC signing ─────────────────────────────────────────────────────
function signPayload(payload, secret) {
    return createHmac("sha256", secret).update(payload).digest("hex");
}
// ── Retry with exponential backoff ───────────────────────────────────
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s
async function deliverWebhook(db, webhook, agentId, eventType, payload) {
    const body = JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        payload,
    });
    const signature = signPayload(body, webhook.secret);
    // Create log entry
    const [logEntry] = await db `
    INSERT INTO notification_log (agent_id, webhook_id, event_type, payload_json, status, attempts)
    VALUES (${agentId}, ${webhook.id}, ${eventType}, ${body}::jsonb, 'pending', 0)
    RETURNING id
  `;
    const logId = logEntry.id;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(webhook.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-AgentPact-Signature": signature,
                    "X-AgentPact-Event": eventType,
                },
                body,
                signal: AbortSignal.timeout(10_000), // 10s timeout
            });
            if (response.ok || (response.status >= 200 && response.status < 300)) {
                await db `
          UPDATE notification_log
          SET status = 'sent', attempts = ${attempt}
          WHERE id = ${logId}
        `;
                return;
            }
            const errorText = `HTTP ${response.status}: ${response.statusText}`;
            await db `
        UPDATE notification_log
        SET attempts = ${attempt}, last_error = ${errorText}
        WHERE id = ${logId}
      `;
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            await db `
        UPDATE notification_log
        SET attempts = ${attempt}, last_error = ${errorMsg}
        WHERE id = ${logId}
      `;
        }
        // Wait before retry (exponential backoff), but not after last attempt
        if (attempt < MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        }
    }
    // All retries exhausted
    await db `
    UPDATE notification_log
    SET status = 'failed'
    WHERE id = ${logId}
  `;
}
// ── Core dispatch function ───────────────────────────────────────────
/**
 * Fire-and-forget notification to all matching webhooks for the given agents.
 * Does NOT block the caller — uses setImmediate to run asynchronously.
 */
export function notifyAgents(db, agentIds, eventType, payload) {
    if (agentIds.length === 0)
        return;
    // Fire-and-forget
    setImmediate(async () => {
        try {
            // Find all active webhooks for these agents that subscribe to this event
            const webhooks = await db `
        SELECT id, agent_id, url, secret
        FROM agent_webhooks
        WHERE agent_id = ANY(${agentIds}::uuid[])
          AND active = TRUE
          AND ${eventType} = ANY(events)
      `;
            const deliveries = webhooks.map((wh) => deliverWebhook(db, { id: wh.id, url: wh.url, secret: wh.secret }, wh.agent_id, eventType, payload).catch(() => {
                /* swallow — already logged in notification_log */
            }));
            await Promise.allSettled(deliveries);
        }
        catch {
            // Best effort — don't crash the process
        }
    });
}
// ── Route registration ───────────────────────────────────────────────
export function registerWebhookRoutes(app, db) {
    // POST /api/webhooks — register a new webhook
    app.post("/api/webhooks", async (request, reply) => {
        const agentId = request.agentId;
        if (!agentId)
            return reply.code(401).send({ error: "Authentication required" });
        const body = createWebhookSchema.parse(request.body);
        const secret = body.secret ?? randomBytes(32).toString("hex");
        const [webhook] = await db `
      INSERT INTO agent_webhooks (agent_id, url, secret, events)
      VALUES (${agentId}, ${body.url}, ${secret}, ${body.events})
      RETURNING id, agent_id, url, events, active, created_at, updated_at
    `;
        return reply.code(201).send({ ...webhook, secret });
    });
    // GET /api/webhooks — list my webhooks
    app.get("/api/webhooks", async (request, reply) => {
        const agentId = request.agentId;
        if (!agentId)
            return reply.code(401).send({ error: "Authentication required" });
        const webhooks = await db `
      SELECT id, agent_id, url, events, active, created_at, updated_at
      FROM agent_webhooks
      WHERE agent_id = ${agentId}
      ORDER BY created_at DESC
    `;
        return webhooks;
    });
    // DELETE /api/webhooks/:id — remove a webhook
    app.delete("/api/webhooks/:id", async (request, reply) => {
        const agentId = request.agentId;
        if (!agentId)
            return reply.code(401).send({ error: "Authentication required" });
        const { id } = request.params;
        const [deleted] = await db `
      DELETE FROM agent_webhooks
      WHERE id = ${id} AND agent_id = ${agentId}
      RETURNING id
    `;
        if (!deleted)
            return reply.code(404).send({ error: "Webhook not found" });
        return { ok: true, deleted: id };
    });
    // POST /api/webhooks/:id/test — send a test ping
    app.post("/api/webhooks/:id/test", async (request, reply) => {
        const agentId = request.agentId;
        if (!agentId)
            return reply.code(401).send({ error: "Authentication required" });
        const { id } = request.params;
        const [webhook] = await db `
      SELECT id, url, secret
      FROM agent_webhooks
      WHERE id = ${id} AND agent_id = ${agentId}
    `;
        if (!webhook)
            return reply.code(404).send({ error: "Webhook not found" });
        // Deliver synchronously so we can report the result
        const body = JSON.stringify({
            event: "webhook.test",
            timestamp: new Date().toISOString(),
            payload: { message: "Test ping from AgentPact" },
        });
        const signature = signPayload(body, webhook.secret);
        try {
            const response = await fetch(webhook.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-AgentPact-Signature": signature,
                    "X-AgentPact-Event": "webhook.test",
                },
                body,
                signal: AbortSignal.timeout(10_000),
            });
            // Log it
            await db `
        INSERT INTO notification_log (agent_id, webhook_id, event_type, payload_json, status, attempts)
        VALUES (${agentId}, ${id}, 'webhook.test', ${body}::jsonb, ${response.ok ? "sent" : "failed"}, 1)
      `;
            return {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
            };
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            await db `
        INSERT INTO notification_log (agent_id, webhook_id, event_type, payload_json, status, attempts, last_error)
        VALUES (${agentId}, ${id}, 'webhook.test', ${body}::jsonb, 'failed', 1, ${errorMsg})
      `;
            return reply.code(502).send({ ok: false, error: errorMsg });
        }
    });
}
