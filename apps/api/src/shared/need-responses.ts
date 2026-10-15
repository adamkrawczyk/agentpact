/**
 * Seller-initiated need responses (POST /api/needs/:id/respond).
 *
 * A seller answers an open need with one of its own active offers. The
 * response is stored as ONE concierge_messages row addressed to the need
 * owner (message_type 'match-suggestion', related_need_id + related_offer_id),
 * and the owner is notified with the `need.response` webhook event. No deal is
 * created and no money moves: the need owner proceeds through the normal
 * POST /api/deals/propose → accept flow.
 *
 * The seller identity lives in `metadata.seller_agent_id` (concierge_messages
 * has no sender column); `metadata.source = 'need_response'` separates these
 * rows from the other match-suggestion producers (the concierge relay).
 */
import { z } from "zod";

/** Marker stored in concierge_messages.metadata.source for need responses. */
export const NEED_RESPONSE_SOURCE = "need_response" as const;

/** Webhook event fired to the need owner when a seller responds. */
export const NEED_RESPONSE_EVENT = "need.response" as const;

/** Max characters of the optional seller note, after sanitising. */
export const NEED_RESPONSE_MESSAGE_MAX = 1000;

/**
 * Responses one seller OWNER may send per rolling hour (all needs). The key is
 * the owner wallet (`ap_wallet_key`), so several agents of one wallet share the
 * budget. An agent whose wallet is unknown or a placeholder cannot respond at
 * all (403 owner_wallet_required) — there is no per-agent fallback quota.
 */
export const NEED_RESPONSES_PER_HOUR = 10;

/**
 * Statuses of a concierge row that still count as a "live" response. A row
 * the relay gave up on ('failed') or skipped never reached the owner, so the
 * seller may answer again.
 */
export const LIVE_RESPONSE_STATUSES = ["queued", "sending", "sent"] as const;

/** A `sending` response untouched for this long is presumed orphaned (worker died) and is re-queued. */
export const STALE_SENDING_MINUTES = 10;

export const respondToNeedSchema = z.object({
  offerId: z.string().uuid(),
  message: z.string().max(NEED_RESPONSE_MESSAGE_MAX).optional(),
});

/**
 * Sanitise a free-text seller note before it is stored and shown to another
 * agent: drop control characters (C0 and C1, keeping newline and tab), drop
 * invisible/bidi formatting characters, drop HTML tags,
 * collapse runs of blank lines, trim, and cap the length. Returns null when
 * nothing is left.
 */
export function sanitizeResponseMessage(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let s = raw.normalize("NFC");
  // eslint-disable-next-line no-control-regex
  // C0 (minus \t \n \r) + DEL + C1, zero-width and directional marks (incl. U+061C),
  // bidi embeddings/overrides U+202A-202E, bidi isolates U+2066-2069, BOM.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "");
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/[<>]/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  if (s.length > NEED_RESPONSE_MESSAGE_MAX) s = s.slice(0, NEED_RESPONSE_MESSAGE_MAX).trimEnd();
  return s.length > 0 ? s : null;
}

/** Markdown body of the concierge message the need owner reads. */
export function composeResponseBody(input: {
  needId: string;
  needTitle: string;
  offerId: string;
  offerTitle: string;
  basePrice: string | number | null;
  currency: string | null;
  sellerAgentId: string;
  sellerHandle: string | null;
  message: string | null;
}): string {
  const seller = input.sellerHandle ? `${input.sellerHandle} (${input.sellerAgentId})` : input.sellerAgentId;
  const price = input.basePrice != null ? `${input.basePrice} ${input.currency ?? "USDC"}` : "see offer";
  const lines = [
    `A seller answered your need **${input.needTitle}** (${input.needId}).`,
    "",
    `- Seller: ${seller}`,
    `- Offer: ${input.offerTitle} (${input.offerId})`,
    `- Offer price: ${price}`,
  ];
  if (input.message) {
    lines.push("", "Seller note:", "", ...input.message.split("\n").map((l) => `> ${l}`));
  }
  lines.push(
    "",
    "No deal exists yet and no money has moved. To go ahead, propose a deal:",
    `POST /api/deals/propose with buyerAgentId = your agent id, sellerAgentId = ${input.sellerAgentId}, needId = ${input.needId}, offerId = ${input.offerId} (MCP: agentpact.propose_deal).`,
  );
  return lines.join("\n");
}
