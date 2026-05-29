/**
 * apps/api/src/routes/audit-orders.ts
 * levels_2505: Admin-gated audit order management routes.
 *
 * GET    /api/audit/orders                — list orders (daemon polls)
 * PATCH  /api/audit/orders/:id/claim      — mark in_progress (atomic)
 * POST   /api/audit/orders/:id/report     — deliver report + ledger + email
 * POST   /api/audit/orders/:id/refund     — Stripe refund + status flip
 */
import { z } from "zod";
import Stripe from "stripe";
import { sendEmail, buildAuditEmailBody } from "../services/email.js";
// ── Auth helper ──────────────────────────────────────────────────────────────
function requireAdminKey(headers, reply) {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
        reply.code(503).send({ error: "Admin API not configured" });
        return false;
    }
    const provided = headers["x-admin-api-key"];
    if (provided !== adminKey) {
        reply.code(401).send({ error: "Unauthorized" });
        return false;
    }
    return true;
}
// ── Discord helper (non-fatal) ────────────────────────────────────────────────
function discordPing(message) {
    const url = process.env.DISCORD_WEBHOOK_AGENTPACT_ORDERS ??
        process.env.DISCORD_WEBHOOK_TORI;
    if (!url)
        return;
    fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
    }).catch(() => undefined);
}
// ── Stripe client (lazy) ──────────────────────────────────────────────────────
let _stripe = null;
function getStripe() {
    if (_stripe)
        return _stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key)
        throw new Error("STRIPE_SECRET_KEY not configured");
    _stripe = new Stripe(key, { apiVersion: "2023-10-16" });
    return _stripe;
}
// ── Zod schemas ───────────────────────────────────────────────────────────────
const reportBodySchema = z.object({
    report_md: z.string().min(1).max(200_000),
    severity_counts: z.object({
        high: z.number().int().min(0),
        medium: z.number().int().min(0),
        low: z.number().int().min(0),
        info: z.number().int().min(0),
    }),
    verdict: z.enum(["PASS", "CONDITIONAL", "FAIL"]),
    deliverable_url: z.string().url().optional(),
    failure_reason: z.string().optional(),
});
const refundBodySchema = z.object({
    reason: z.string().optional(),
});
const VALID_STATUSES = ["paid", "in_progress", "completed", "failed", "refunded"];
// ── Route registration ────────────────────────────────────────────────────────
export async function registerAuditOrdersRoutes(app, sql) {
    // ── GET /api/audit/orders ────────────────────────────────────────────────
    app.get("/api/audit/orders", async (request, reply) => {
        if (!requireAdminKey(request.headers, reply))
            return;
        const query = request.query;
        const status = VALID_STATUSES.includes(query.status)
            ? query.status
            : "paid";
        const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? "10", 10) || 10));
        const orders = await sql `
      SELECT id, stripe_session_id, buyer_email, contract_address, contract_chain,
             notes, amount_cents, currency, status, created_at
      FROM audit_orders
      WHERE status = ${status}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
        return reply.code(200).send({ orders });
    });
    // ── PATCH /api/audit/orders/:id/claim ────────────────────────────────────
    app.patch("/api/audit/orders/:id/claim", async (request, reply) => {
        if (!requireAdminKey(request.headers, reply))
            return;
        const { id } = request.params;
        const [existing] = await sql `SELECT id, status FROM audit_orders WHERE id = ${id}`;
        if (!existing) {
            return reply.code(404).send({ error: "Order not found" });
        }
        const [updated] = await sql `
      UPDATE audit_orders
      SET status = 'in_progress', picked_up_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND status = 'paid'
      RETURNING *
    `;
        if (!updated) {
            return reply.code(409).send({ error: "Order already claimed or not in paid state" });
        }
        return reply.code(200).send({ order: updated });
    });
    // ── POST /api/audit/orders/:id/report ────────────────────────────────────
    app.post("/api/audit/orders/:id/report", async (request, reply) => {
        if (!requireAdminKey(request.headers, reply))
            return;
        const { id } = request.params;
        let body;
        try {
            body = reportBodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: "Invalid request body", details: err });
        }
        const { report_md, severity_counts, verdict, failure_reason } = body;
        // Transactional block
        let finalOrder = null;
        let fee_credited_minor = 0;
        try {
            await sql.begin(async (tx) => {
                // SELECT FOR UPDATE
                const orderRows = (await tx.unsafe(`SELECT * FROM audit_orders WHERE id = $1 FOR UPDATE`, [id]));
                const order = orderRows[0];
                if (!order) {
                    throw Object.assign(new Error("Not found"), { statusCode: 404 });
                }
                const currentStatus = order.status;
                if (currentStatus === "completed" || currentStatus === "refunded") {
                    throw Object.assign(new Error(`Order already ${currentStatus}`), { statusCode: 409 });
                }
                // Determine new status
                const newStatus = failure_reason && verdict === "FAIL" ? "failed" : "completed";
                const updatedRows = (await tx.unsafe(`UPDATE audit_orders SET
              status = $1,
              report_md = $2,
              report_severity_counts = $3::jsonb,
              report_verdict = $4,
              failure_reason = $5,
              completed_at = NOW(),
              updated_at = NOW()
            WHERE id = $6
            RETURNING *`, [
                    newStatus,
                    report_md,
                    JSON.stringify(severity_counts),
                    verdict,
                    failure_reason ?? null,
                    id,
                ]));
                finalOrder = updatedRows[0] ?? null;
                // Insert platform fee ledger if completed
                if (newStatus === "completed") {
                    const amountCents = Number(order.amount_cents);
                    const feeCents = Math.floor(amountCents * 0.10);
                    fee_credited_minor = feeCents;
                    await tx.unsafe(`INSERT INTO platform_fee_ledger
                (audit_order_id, amount_minor, currency, fee_pct_at_close, source, stripe_payment_intent_id)
              VALUES ($1, $2, $3, 10.00, 'stripe', $4)
              ON CONFLICT DO NOTHING`, [
                        id,
                        feeCents,
                        order.currency,
                        order.stripe_payment_intent_id,
                    ]);
                }
            });
        }
        catch (err) {
            const e = err;
            if (e.statusCode === 404)
                return reply.code(404).send({ error: "Order not found" });
            if (e.statusCode === 409)
                return reply.code(409).send({ error: e.message });
            request.log.error({ err }, "audit-orders/report: db error");
            return reply.code(500).send({ error: "Database error" });
        }
        if (!finalOrder) {
            return reply.code(500).send({ error: "Unexpected: no order after transaction" });
        }
        // Cast to ensure TS doesn't narrow to never after closure assignment
        const completedOrder = finalOrder;
        // Send email (non-blocking for response, but captured for email_sent_at)
        const contractAddress = completedOrder.contract_address;
        const buyerEmail = completedOrder.buyer_email;
        const emailSubject = `Your AgentPact audit for ${contractAddress.slice(0, 10)}...`;
        const emailBody = buildAuditEmailBody(contractAddress, report_md);
        let emailSentAt = null;
        try {
            const emailResult = await sendEmail({ to: buyerEmail, subject: emailSubject, body: emailBody });
            if (emailResult.ok) {
                emailSentAt = new Date().toISOString();
                await sql `UPDATE audit_orders SET email_sent_at = NOW() WHERE id = ${id}`;
            }
            else {
                request.log.warn({ error: emailResult.error }, "audit-orders/report: email send failed");
            }
        }
        catch (err) {
            request.log.warn({ err }, "audit-orders/report: email error (non-fatal)");
        }
        // Discord ping (non-fatal)
        const amountCents = Number(completedOrder.amount_cents);
        discordPing(`✅ Order ${id} delivered — $${(amountCents / 100).toFixed(2)} → fee $${(amountCents * 0.10 / 100).toFixed(2)} (${verdict})`);
        return reply.code(200).send({
            ok: true,
            order_id: id,
            status: completedOrder.status,
            fee_credited_minor,
            email_sent_at: emailSentAt,
        });
    });
    // ── POST /api/audit/orders/:id/refund ────────────────────────────────────
    app.post("/api/audit/orders/:id/refund", async (request, reply) => {
        if (!requireAdminKey(request.headers, reply))
            return;
        const { id } = request.params;
        let body = {};
        try {
            body = refundBodySchema.parse(request.body ?? {});
        }
        catch {
            body = {};
        }
        const [order] = await sql `SELECT * FROM audit_orders WHERE id = ${id}`;
        if (!order) {
            return reply.code(404).send({ error: "Order not found" });
        }
        // Idempotent — already refunded
        if (order.status === "refunded") {
            return reply.code(200).send({ ok: true, order_id: id, status: "refunded", idempotent: true });
        }
        const paymentIntentId = order.stripe_payment_intent_id;
        let stripeRefundId = null;
        if (paymentIntentId && process.env.STRIPE_SECRET_KEY) {
            try {
                const stripe = getStripe();
                // In test mode, Stripe SDK may reject; let errors bubble as 500
                const refund = await stripe.refunds.create({
                    payment_intent: paymentIntentId,
                    ...(body.reason ? { reason: body.reason } : {}),
                });
                stripeRefundId = refund.id;
            }
            catch (err) {
                request.log.error({ err }, "audit-orders/refund: Stripe refund failed");
                return reply.code(500).send({ error: err instanceof Error ? err.message : "Stripe error" });
            }
        }
        await sql `
      UPDATE audit_orders SET status = 'refunded', updated_at = NOW() WHERE id = ${id}
    `;
        return reply.code(200).send({
            ok: true,
            order_id: id,
            status: "refunded",
            stripe_refund_id: stripeRefundId,
        });
    });
}
