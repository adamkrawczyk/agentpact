#!/usr/bin/env node
/**
 * seller-notice.ts — moneypath_0920 §3 M1 "the ask": one-shot Verified-Seller
 * notice to the top-20 sellers.
 *
 * Usage:
 *   npx tsx scripts/seller-notice.ts            # DRY RUN (default): prints the
 *                                               # 20 recipients + the payload,
 *                                               # writes nothing, sends nothing
 *   npx tsx scripts/seller-notice.ts --send     # enqueue the webhook event for
 *                                               # each recipient and log it to
 *                                               # seller_notices (migration 051)
 *   npx tsx scripts/seller-notice.ts --json     # dry-run output as JSON
 *   npx tsx scripts/seller-notice.ts --limit 5  # override the top-N (default 20)
 *   npx tsx scripts/seller-notice.ts --days 30  # override the window (default 90)
 *
 * Selection: sellers ranked by COMPLETED, NON-SELF deals
 * (buyer_agent_id != seller_agent_id) in the last N days. Self-deals are the
 * fleet dogfooding itself and are not a signal that a stranger would value the
 * badge.
 *
 * Transport: the existing agent webhook path (apps/api/src/webhooks.ts
 * notifyAgents) — event 'seller.verified_offer'. A seller only receives it if
 * it registered a webhook subscribed to that event; notifyAgents is
 * fire-and-forget and logs every attempt to notification_log. Decision
 * 2026-09-22: webhook, NOT concierge_messages.
 *
 * Idempotency: seller_notices has a UNIQUE (campaign_id, agent_id) index.
 * Re-running --send skips any agent already logged for this campaign.
 *
 * The message is claim-grounded: every sentence maps to a documented fact in
 * docs/agentpact-skill/SKILL.md "Verified Seller ($19 one-time)".
 */

import postgres from "postgres";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CAMPAIGN_ID = "moneypath-0920-seller-notice-1";
export const EVENT_TYPE = "seller.verified_offer";
export const CHANNEL = "webhook";
export const DEFAULT_LIMIT = 20;
export const DEFAULT_WINDOW_DAYS = 90;

export type SellerRow = {
  agent_id: string;
  handle: string;
  display_name: string | null;
  verified_at: string | Date | null;
  completed_deals: number;
  last_completed_at: string | Date | null;
  has_webhook: boolean;
};

export type NoticePayload = {
  campaign_id: string;
  subject: string;
  message: string;
  verified_seller_url: string;
  skill_url: string;
  price_usd: number;
  benefits: string[];
  check_status: string;
};

/**
 * Fixed, claim-grounded message. Sources (docs/agentpact-skill/SKILL.md
 * §"Verified Seller ($19 one-time)"): $19 one-time Stripe purchase, no expiry;
 * badge on offers + agent page; verified offers sorted first in offer
 * search/discovery (GET /api/offers, search_offers); applied automatically via
 * Stripe webhook that sets agents.verified_at; status check is public.
 */
export function buildNoticePayload(seller: Pick<SellerRow, "agent_id" | "handle" | "completed_deals">): NoticePayload {
  return {
    campaign_id: CAMPAIGN_ID,
    subject: "You are one of AgentPact's most active sellers — Verified Seller badge available",
    message:
      `Hi ${seller.handle}. You completed ${seller.completed_deals} deal(s) with other agents on AgentPact in the last ${DEFAULT_WINDOW_DAYS} days, ` +
      `which puts you in the top ${DEFAULT_LIMIT} sellers. ` +
      `Verified Seller is a $19 one-time purchase (no expiry) that adds a verified badge to your offers and agent page, ` +
      `and ranks your offers first in offer search and discovery (GET /api/offers and agentpact.search_offers order verified sellers ahead of non-verified, then by recency). ` +
      `Verification is applied automatically via Stripe within seconds of payment. ` +
      `Buy at https://agentpact.xyz/verified — paste your agent ID (${seller.agent_id}) or handle. ` +
      `Full integration guide: https://agentpact.xyz/skill`,
    verified_seller_url: "https://agentpact.xyz/verified",
    skill_url: "https://agentpact.xyz/skill",
    price_usd: 19,
    benefits: [
      "Verified badge on your offers and agent page",
      "Offers ranked first in offer search/discovery (GET /api/offers, agentpact.search_offers)",
      "One-time $19 purchase, no expiry, applied automatically via Stripe",
    ],
    check_status: `GET https://api.agentpact.xyz/api/agents/${seller.agent_id}/verification`,
  };
}

export const TOP_SELLERS_SQL = `
  SELECT
    a.id                              AS agent_id,
    a.handle,
    a.display_name,
    a.verified_at,
    COUNT(d.id)::int                  AS completed_deals,
    MAX(d.updated_at)                 AS last_completed_at,
    EXISTS (
      SELECT 1 FROM agent_webhooks w
      WHERE w.agent_id = a.id AND w.active = TRUE AND $3 = ANY(w.events)
    )                                 AS has_webhook
  FROM deals d
  JOIN agents a ON a.id = d.seller_agent_id
  WHERE d.status = 'completed'
    AND d.buyer_agent_id <> d.seller_agent_id
    AND d.updated_at >= NOW() - ($1::int * INTERVAL '1 day')
  GROUP BY a.id, a.handle, a.display_name, a.verified_at
  ORDER BY completed_deals DESC, last_completed_at DESC, a.id
  LIMIT $2
`;

export async function selectTopSellers(
  sql: ReturnType<typeof postgres>,
  opts: { limit?: number; windowDays?: number } = {},
): Promise<SellerRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const rows = await sql.unsafe(TOP_SELLERS_SQL, [windowDays, limit, EVENT_TYPE]);
  return rows.map((r: Record<string, unknown>) => ({
    agent_id: String(r.agent_id),
    handle: String(r.handle),
    display_name: (r.display_name as string | null) ?? null,
    verified_at: (r.verified_at as string | Date | null) ?? null,
    completed_deals: Number(r.completed_deals),
    last_completed_at: (r.last_completed_at as string | Date | null) ?? null,
    has_webhook: Boolean(r.has_webhook),
  }));
}

/**
 * Enqueue the notice for every seller not already logged for this campaign.
 * Returns the agent ids that were newly logged+sent and those skipped.
 * `notify` is injected so tests can assert the call without any network.
 */
export async function sendNotices(
  sql: ReturnType<typeof postgres>,
  sellers: SellerRow[],
  notify: (db: ReturnType<typeof postgres>, agentIds: string[], eventType: string, payload: object) => void,
): Promise<{ sent: string[]; skipped: string[] }> {
  const sent: string[] = [];
  const skipped: string[] = [];
  for (const seller of sellers) {
    const payload = buildNoticePayload(seller);
    const inserted = await sql`
      INSERT INTO seller_notices (agent_id, campaign_id, channel, event_type, payload_json)
      VALUES (${seller.agent_id}, ${CAMPAIGN_ID}, ${CHANNEL}, ${EVENT_TYPE}, ${sql.json(payload as never)})
      ON CONFLICT (campaign_id, agent_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      skipped.push(seller.agent_id);
      continue;
    }
    notify(sql, [seller.agent_id], EVENT_TYPE, payload);
    sent.push(seller.agent_id);
  }
  return { sent, skipped };
}

function parseArgs(argv: string[]): { send: boolean; json: boolean; limit: number; windowDays: number } {
  let send = false, json = false, limit = DEFAULT_LIMIT, windowDays = DEFAULT_WINDOW_DAYS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") send = true;
    else if (a === "--json") json = true;
    else if (a === "--limit") limit = Number(argv[++i]);
    else if (a === "--days") windowDays = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write("usage: seller-notice.ts [--send] [--json] [--limit N] [--days N]\n");
      process.exit(0);
    }
  }
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
  if (!Number.isInteger(windowDays) || windowDays <= 0) throw new Error("--days must be a positive integer");
  return { send, json, limit, windowDays };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("DATABASE_URL is required");
  const sql = postgres(connection, { max: 1, idle_timeout: 5, connect_timeout: 10 });

  try {
    const sellers = await selectTopSellers(sql, { limit: args.limit, windowDays: args.windowDays });
    const already = new Set(
      (await sql`SELECT agent_id FROM seller_notices WHERE campaign_id = ${CAMPAIGN_ID}`).map((r) => String(r.agent_id)),
    );

    if (!args.send) {
      const preview = sellers.map((s) => ({
        agent_id: s.agent_id,
        handle: s.handle,
        completed_deals: s.completed_deals,
        verified: s.verified_at != null,
        has_webhook: s.has_webhook,
        already_notified: already.has(s.agent_id),
      }));
      if (args.json) {
        process.stdout.write(JSON.stringify({ mode: "dry-run", campaign_id: CAMPAIGN_ID, event: EVENT_TYPE, recipients: preview, sample_payload: sellers[0] ? buildNoticePayload(sellers[0]) : null }, null, 2) + "\n");
      } else {
        process.stdout.write(`DRY RUN — campaign ${CAMPAIGN_ID}, event ${EVENT_TYPE}, top ${args.limit} sellers by completed non-self deals in ${args.windowDays}d\n`);
        process.stdout.write(`${"#".padStart(3)}  ${"agent_id".padEnd(36)}  ${"handle".padEnd(32)}  deals  verified  webhook  notified\n`);
        preview.forEach((p, i) => {
          process.stdout.write(`${String(i + 1).padStart(3)}  ${p.agent_id}  ${p.handle.slice(0, 32).padEnd(32)}  ${String(p.completed_deals).padStart(5)}  ${String(p.verified).padEnd(8)}  ${String(p.has_webhook).padEnd(7)}  ${p.already_notified}\n`);
        });
        process.stdout.write(`\n${preview.length} recipient(s). Nothing sent, nothing written. Re-run with --send to enqueue.\n`);
        if (sellers[0]) {
          process.stdout.write(`\nSample payload (for ${sellers[0].handle}):\n${JSON.stringify(buildNoticePayload(sellers[0]), null, 2)}\n`);
        }
      }
      return;
    }

    const { notifyAgents } = await import("../apps/api/src/webhooks.js");
    const result = await sendNotices(sql, sellers, notifyAgents);
    process.stdout.write(`SENT ${result.sent.length} · SKIPPED (already notified) ${result.skipped.length} · campaign ${CAMPAIGN_ID}\n`);
    for (const id of result.sent) process.stdout.write(`  sent    ${id}\n`);
    for (const id of result.skipped) process.stdout.write(`  skipped ${id}\n`);
    // notifyAgents is fire-and-forget on setImmediate; give deliveries a moment
    // to reach notification_log before we close the pool.
    await new Promise((r) => setTimeout(r, 8_000));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isDirectRun = (() => {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const argv1 = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return self === argv1 || (process.env.pm_exec_path ? realpathSync(process.env.pm_exec_path) === self : false);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[seller-notice] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
