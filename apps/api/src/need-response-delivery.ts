/**
 * Outbox delivery for seller need responses (POST /api/needs/:id/respond).
 *
 * The response row is committed as `queued` (= pending) together with its
 * audit entry. It only becomes `sent` once a webhook of the need owner has
 * actually accepted it; a failed delivery goes back to `queued` and the
 * concierge relay retries it. Nothing is ever marked sent ahead of delivery.
 *
 * One delivery path, one decision:
 *  - the request handler and the relay both CLAIM a row atomically
 *    (`queued -> sending`), so a response is never delivered by both;
 *  - per webhook, the event is chosen from ONE snapshot of that owner's
 *    subscriptions: `need.response` if it subscribes to it, else
 *    `concierge.message`. A webhook registered or changed mid-flight can
 *    therefore never receive both events for one response;
 *  - a webhook that already accepted this response (notification_log, status
 *    `sent`, same responseId) is not called again on a retry.
 */
import type { Sql } from "postgres";
import { NEED_RESPONSE_EVENT, NEED_RESPONSE_SOURCE } from "./shared/need-responses.js";
import { deliverWebhook } from "./webhooks.js";

type Db = Sql<Record<string, unknown>>;
type Warn = (obj: Record<string, unknown>, msg: string) => void;

const CONCIERGE_EVENT = "concierge.message";

export interface NeedResponseRow {
  id: string;
  agent_id: string;
  message_type: string;
  subject: string;
  body_md: string;
  related_offer_id: string | null;
  related_need_id: string | null;
  related_deal_id: string | null;
  metadata: Record<string, unknown> | null;
}

export type NeedResponseOutcome =
  | { kind: "sent" }
  | { kind: "no_webhook" }
  | { kind: "failed"; error: string };

export function isNeedResponse(row: { message_type?: unknown; metadata?: unknown }): boolean {
  const meta = row.metadata as Record<string, unknown> | null | undefined;
  return row.message_type === "match-suggestion" && meta?.source === NEED_RESPONSE_SOURCE;
}

function eventPayload(event: string, row: NeedResponseRow): object {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  if (event === CONCIERGE_EVENT) {
    return {
      conciergeMessageId: row.id,
      responseId: row.id,
      messageType: row.message_type,
      subject: row.subject,
      body: row.body_md,
      relatedOfferId: row.related_offer_id,
      relatedNeedId: row.related_need_id,
      relatedDealId: row.related_deal_id,
      metadata: row.metadata,
    };
  }
  return {
    responseId: row.id,
    needId: row.related_need_id,
    needTitle: m.need_title ?? null,
    offerId: row.related_offer_id,
    offerTitle: m.offer_title ?? null,
    offerPrice: m.offer_price ?? null,
    currency: m.currency ?? null,
    sellerAgentId: m.seller_agent_id ?? null,
    message: m.message ?? null,
  };
}

/**
 * Deliver an already-claimed response to the owner's webhooks. Never touches
 * the row's status; the caller settles it from the outcome.
 */
export async function deliverNeedResponse(db: Db, row: NeedResponseRow): Promise<NeedResponseOutcome> {
  try {
    const hooks = await db`
      SELECT id, url, secret, events FROM agent_webhooks
      WHERE agent_id = ${row.agent_id} AND active = TRUE
        AND (${NEED_RESPONSE_EVENT} = ANY(events) OR ${CONCIERGE_EVENT} = ANY(events))
    `;
    if (hooks.length === 0) return { kind: "no_webhook" };

    const done = await db`
      SELECT DISTINCT webhook_id FROM notification_log
      WHERE webhook_id = ANY(${hooks.map((h) => h.id as string)}::uuid[])
        AND status = 'sent'
        -- payload_json holds the signed envelope, stored either as a jsonb object or as a jsonb string of JSON
        AND (CASE WHEN jsonb_typeof(payload_json) = 'string' THEN (payload_json #>> '{}')::jsonb ELSE payload_json END)
              -> 'payload' ->> 'responseId' = ${row.id}
    `;
    const delivered = new Set(done.map((d) => d.webhook_id as string));
    const todo = hooks.filter((h) => !delivered.has(h.id as string));

    const results = await Promise.all(
      todo.map((h) => {
        const event = (h.events as string[]).includes(NEED_RESPONSE_EVENT) ? NEED_RESPONSE_EVENT : CONCIERGE_EVENT;
        return deliverWebhook(
          db,
          { id: h.id as string, url: h.url as string, secret: h.secret as string },
          row.agent_id,
          event,
          eventPayload(event, row),
        ).catch(() => false);
      }),
    );
    if (results.some((ok) => !ok)) return { kind: "failed", error: "webhook delivery failed" };
    return { kind: "sent" };
  } catch (err: unknown) {
    return { kind: "failed", error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Request-path delivery: claim the freshly committed response (only if the
 * owner has a webhook that could take it — otherwise it stays queued for the
 * relay / inbox), deliver, then settle. Never throws; a failure leaves the
 * row queued for the relay to retry.
 */
export async function attemptNeedResponseDelivery(db: Db, responseId: string, warn: Warn = () => {}): Promise<void> {
  let row: NeedResponseRow | undefined;
  try {
    [row] = (await db`
      UPDATE concierge_messages cm
      SET status = 'sending', updated_at = NOW()
      WHERE cm.id = ${responseId}
        AND cm.status = 'queued'
        AND EXISTS (
          SELECT 1 FROM agent_webhooks w
          WHERE w.agent_id = cm.agent_id AND w.active = TRUE
            AND (${NEED_RESPONSE_EVENT} = ANY(w.events) OR ${CONCIERGE_EVENT} = ANY(w.events))
        )
      RETURNING cm.id, cm.agent_id, cm.message_type, cm.subject, cm.body_md,
                cm.related_offer_id, cm.related_need_id, cm.related_deal_id, cm.metadata
    `) as unknown as NeedResponseRow[];
  } catch (err: unknown) {
    warn({ err, responseId }, "need response claim failed; left queued for the relay");
    return;
  }
  if (!row) return; // not deliverable now, or the relay already owns it

  const outcome = await deliverNeedResponse(db, row);
  try {
    if (outcome.kind === "sent") {
      await db`
        UPDATE concierge_messages
        SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE id = ${row.id}
      `;
    } else if (outcome.kind === "no_webhook") {
      await db`UPDATE concierge_messages SET status = 'queued', updated_at = NOW() WHERE id = ${row.id}`;
    } else {
      await db`
        UPDATE concierge_messages
        SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = ${outcome.error},
            updated_at = NOW()
        WHERE id = ${row.id}
      `;
    }
  } catch (err: unknown) {
    // Row stays 'sending'; the relay's stale-sending recovery re-queues it.
    warn({ err, responseId, outcome: outcome.kind }, "need response settle failed; stale-sending recovery will requeue");
  }
}
