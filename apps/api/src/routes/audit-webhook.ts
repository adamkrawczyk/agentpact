/**
 * apps/api/src/routes/audit-webhook.ts
 * levels_2505: Stripe webhook for audit order flow.
 *
 * POST /api/audit/webhook/stripe
 *   - Public (no agent auth); Stripe sig-verified via STRIPE_WEBHOOK_SECRET_AUDIT
 *   - Handles checkout.session.completed → INSERT audit_orders ON CONFLICT DO NOTHING
 *   - Posts Discord ping on insert
 *   - Returns 200 { received: true, order_id }
 */

import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type Stripe from "stripe";
import { constructWebhookEvent } from "../stripe.js";

export async function registerAuditWebhookRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
): Promise<void> {
  app.post(
    "/api/audit/webhook/stripe",
    { config: { rawBody: true } },
    async (request, reply) => {
      // ── 1. Verify signature ────────────────────────────────────────────────
      const sig = request.headers["stripe-signature"] as string | undefined;
      if (!sig) {
        return reply.code(400).send({ error: "Missing stripe-signature header" });
      }

      const rawBody =
        (request as unknown as { rawBody?: Buffer | string }).rawBody ??
        JSON.stringify(request.body);

      let event: Stripe.Event;
      try {
        const secret = process.env.STRIPE_WEBHOOK_SECRET_AUDIT;
        event = constructWebhookEvent(rawBody, sig, secret);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid webhook signature";
        request.log.warn({ err }, "audit-webhook: sig verification failed");
        return reply.code(400).send({ error: message });
      }

      // ── 2. Ignore unrelated events ─────────────────────────────────────────
      if (event.type !== "checkout.session.completed") {
        return reply.code(200).send({ received: true, order_id: null });
      }

      // ── 3. Extract fields from session ────────────────────────────────────
      const session = event.data.object as unknown as Record<string, unknown>;

      const stripe_session_id = session.id as string;
      const stripe_payment_intent_id =
        (session.payment_intent as string | null) ?? null;

      // buyer email: customer_details.email or customer_email
      const customerDetails = session.customer_details as
        | Record<string, unknown>
        | null
        | undefined;
      const buyer_email =
        (customerDetails?.email as string | undefined) ??
        (session.customer_email as string | undefined) ??
        "";

      if (!buyer_email) {
        request.log.error({ session_id: stripe_session_id }, "audit-webhook: no buyer email");
        return reply.code(500).send({ error: "No buyer email in session" });
      }

      // custom_fields: [{key, text: {value}}]
      const customFields = Array.isArray(session.custom_fields)
        ? (session.custom_fields as Array<Record<string, unknown>>)
        : [];

      const findCustomField = (key: string): string | null => {
        const field = customFields.find(
          (f) => (f.key as string | undefined) === key,
        );
        if (!field) return null;
        // Stripe custom_fields text type: { key, label, text: { value } }
        const text = field.text as Record<string, unknown> | undefined;
        return (text?.value as string | undefined) ?? null;
      };

      const contract_address = findCustomField("contract_address") ?? "";
      const notes = findCustomField("notes") ?? null;

      if (!contract_address) {
        request.log.error({ session_id: stripe_session_id }, "audit-webhook: no contract_address");
        return reply.code(500).send({ error: "No contract_address in custom_fields" });
      }

      const amount_cents = (session.amount_total as number | undefined) ?? 0;
      const currency = ((session.currency as string | undefined) ?? "usd").toUpperCase();

      // ── 4. Insert audit_orders (idempotent) ───────────────────────────────
      let order_id: string | null = null;

      try {
        const [inserted] = await sql`
          INSERT INTO audit_orders
            (stripe_session_id, stripe_payment_intent_id, buyer_email,
             contract_address, notes, amount_cents, currency)
          VALUES
            (${stripe_session_id}, ${stripe_payment_intent_id}, ${buyer_email},
             ${contract_address}, ${notes}, ${amount_cents}, ${currency})
          ON CONFLICT (stripe_session_id) DO NOTHING
          RETURNING id
        `;

        if (inserted) {
          order_id = inserted.id as string;
        } else {
          // Row already existed — fetch the existing id
          const [existing] = await sql`
            SELECT id FROM audit_orders WHERE stripe_session_id = ${stripe_session_id}
          `;
          order_id = existing ? (existing.id as string) : null;
        }
      } catch (err: unknown) {
        request.log.error({ err }, "audit-webhook: db insert failed");
        return reply.code(500).send({ error: "Database error" });
      }

      // ── 5. Discord ping (non-fatal) ────────────────────────────────────────
      const discordUrl =
        process.env.DISCORD_WEBHOOK_AGENTPACT_ORDERS ??
        process.env.DISCORD_WEBHOOK_ALERTS;

      if (discordUrl && order_id) {
        const message = `🆕 New audit order **${order_id}** — \`${contract_address.slice(0, 10)}...\` · $${(amount_cents / 100).toFixed(2)} from ${buyer_email}`;
        fetch(discordUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
        }).catch((err: unknown) => {
          request.log.warn({ err }, "audit-webhook: Discord ping failed (non-fatal)");
        });
      }

      return reply.code(200).send({ received: true, order_id });
    },
  );
}
