/**
 * apps/api/src/routes/verified-seller-webhook.ts
 * Verified Seller SKU: Stripe webhook for the $19 one-time purchase.
 *
 * POST /api/verified/webhook/stripe
 *   - Public (no agent auth); Stripe sig-verified via STRIPE_WEBHOOK_SECRET_VERIFIED
 *   - Handles checkout.session.completed:
 *       1. INSERT verified_seller_orders ON CONFLICT DO NOTHING (idempotent on stripe_session_id)
 *       2. Resolves the paying agent via `client_reference_id` — the Stripe
 *          Payment Link is shared with ?client_reference_id=<agentId-or-handle>
 *          appended by the seller before checkout (see /verified page).
 *       3. Sets agents.verified_at = NOW() for that agent (idempotent — only
 *          set if not already verified, so a re-purchase doesn't reset the date).
 *   - Returns 200 { received: true, order_id, agent_id }
 */

import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type Stripe from "stripe";
import { constructWebhookEvent } from "../stripe.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAgentId(
  sql: Sql<Record<string, unknown>>,
  clientReferenceId: string,
): Promise<string | null> {
  if (!clientReferenceId) return null;
  if (UUID_RE.test(clientReferenceId)) {
    const [byId] = await sql`SELECT id FROM agents WHERE id = ${clientReferenceId}`;
    if (byId) return byId.id as string;
  }
  const [byHandle] = await sql`SELECT id FROM agents WHERE handle = ${clientReferenceId}`;
  return byHandle ? (byHandle.id as string) : null;
}

export async function registerVerifiedSellerWebhookRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
): Promise<void> {
  app.post(
    "/api/verified/webhook/stripe",
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
        const secret = process.env.STRIPE_WEBHOOK_SECRET_VERIFIED;
        event = constructWebhookEvent(rawBody, sig, secret);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid webhook signature";
        request.log.warn({ err }, "verified-webhook: sig verification failed");
        return reply.code(400).send({ error: message });
      }

      // ── 2. Ignore unrelated events ─────────────────────────────────────────
      if (event.type !== "checkout.session.completed") {
        return reply.code(200).send({ received: true, order_id: null, agent_id: null });
      }

      const session = event.data.object as unknown as Record<string, unknown>;

      const stripe_session_id = session.id as string;
      const stripe_payment_intent_id =
        (session.payment_intent as string | null) ?? null;
      const client_reference_id = (session.client_reference_id as string | null) ?? "";

      const customerDetails = session.customer_details as
        | Record<string, unknown>
        | null
        | undefined;
      const buyer_email =
        (customerDetails?.email as string | undefined) ??
        (session.customer_email as string | undefined) ??
        null;

      const amount_cents = (session.amount_total as number | undefined) ?? 0;
      const currency = ((session.currency as string | undefined) ?? "usd").toUpperCase();

      if (!client_reference_id) {
        request.log.error(
          { session_id: stripe_session_id },
          "verified-webhook: no client_reference_id in session",
        );
        return reply.code(500).send({ error: "No client_reference_id in checkout session" });
      }

      const agentId = await resolveAgentId(sql, client_reference_id);

      // ── 3. Insert verified_seller_orders (idempotent) ──────────────────────
      let order_id: string | null = null;
      const initialStatus = agentId ? "applied" : "failed";
      const failureReason = agentId ? null : "agent not found for client_reference_id";
      const appliedAt = agentId ? new Date().toISOString() : null;

      try {
        const [inserted] = await sql`
          INSERT INTO verified_seller_orders
            (stripe_session_id, stripe_payment_intent_id, agent_id,
             client_reference_id, buyer_email, amount_cents, currency,
             status, applied_at, failure_reason)
          VALUES
            (${stripe_session_id}, ${stripe_payment_intent_id}, ${agentId},
             ${client_reference_id}, ${buyer_email}, ${amount_cents}, ${currency},
             ${initialStatus}, ${appliedAt}, ${failureReason})
          ON CONFLICT (stripe_session_id) DO NOTHING
          RETURNING id
        `;

        if (inserted) {
          order_id = inserted.id as string;
        } else {
          const [existing] = await sql`
            SELECT id FROM verified_seller_orders WHERE stripe_session_id = ${stripe_session_id}
          `;
          order_id = existing ? (existing.id as string) : null;
        }
      } catch (err: unknown) {
        request.log.error({ err }, "verified-webhook: db insert failed");
        return reply.code(500).send({ error: "Database error" });
      }

      // ── 4. Apply verification (idempotent — do not overwrite an existing date) ──
      if (agentId) {
        try {
          await sql`
            UPDATE agents
            SET verified_at = COALESCE(verified_at, NOW())
            WHERE id = ${agentId}
          `;
        } catch (err: unknown) {
          request.log.error({ err, agentId }, "verified-webhook: failed to set verified_at");
          return reply.code(500).send({ error: "Database error applying verification" });
        }
      }

      // ── 5. Discord ping (non-fatal) ────────────────────────────────────────
      const discordUrl =
        process.env.DISCORD_WEBHOOK_AGENTPACT_ORDERS ??
        process.env.DISCORD_WEBHOOK_ALERTS;

      if (discordUrl && order_id) {
        const message = agentId
          ? `✅ Verified Seller purchased — agent \`${agentId}\` — $${(amount_cents / 100).toFixed(2)}`
          : `⚠️ Verified Seller checkout completed but agent lookup failed for client_reference_id \`${client_reference_id}\``;
        fetch(discordUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
        }).catch((err: unknown) => {
          request.log.warn({ err }, "verified-webhook: Discord ping failed (non-fatal)");
        });
      }

      return reply.code(200).send({ received: true, order_id, agent_id: agentId });
    },
  );
}
