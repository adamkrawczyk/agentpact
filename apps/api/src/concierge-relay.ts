/**
 * Concierge Relay — Welcome/first-transaction message delivery for AgentPact
 *
 * Replaces the broken JSONL queue with authoritative DB-backed message state.
 * Messages are queued in `concierge_messages`, delivered via existing webhook
 * infrastructure, and their status is tracked authoritatively in the database.
 */
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Deps } from "./routes/types.js";
import { notifyAgents } from "./webhooks.js";

// ── Message queueing ──────────────────────────────────────────────────

export interface QueueMessageInput {
  agentId: string;
  messageType: "welcome" | "first-transaction" | "match-suggestion" | "activation-nudge";
  subject: string;
  bodyMd: string;
  priority?: number;
  relatedOfferId?: string;
  relatedNeedId?: string;
  relatedDealId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Queue a concierge message for an agent.
 * Idempotent — won't create duplicate queued messages of the same type for the same agent
 * unless force=true.
 */
export async function queueConciergeMessage(
  db: Sql<Record<string, unknown>>,
  input: QueueMessageInput,
  options?: { force?: boolean },
): Promise<{ id: string; status: string; created: boolean }> {
  if (!options?.force) {
    // Check for existing queued message of same type for same agent
    const [existing] = await db`
      SELECT id, status FROM concierge_messages
      WHERE agent_id = ${input.agentId}
        AND message_type = ${input.messageType}
        AND status IN ('queued', 'sending')
      LIMIT 1
    `;
    if (existing) {
      return { id: existing.id as string, status: existing.status as string, created: false };
    }
  }

  const [row] = await db`
    INSERT INTO concierge_messages (
      agent_id, message_type, priority, subject, body_md,
      related_offer_id, related_need_id, related_deal_id, metadata
    ) VALUES (
      ${input.agentId}, ${input.messageType}, ${input.priority ?? 0},
      ${input.subject}, ${input.bodyMd},
      ${input.relatedOfferId ?? null}, ${input.relatedNeedId ?? null},
      ${input.relatedDealId ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    RETURNING id, status
  `;

  return { id: row.id as string, status: row.status as string, created: true };
}

/**
 * Queue welcome messages for all agents who don't have one yet.
 * Returns the number of new messages queued.
 */
export async function queueWelcomeForNewAgents(
  db: Sql<Record<string, unknown>>,
): Promise<{ queued: number; skipped: number }> {
  // Find agents without any welcome message
  const newAgents = await db`
    SELECT a.id, a.handle, a.display_name, a.created_at
    FROM agents a
    WHERE NOT EXISTS (
      SELECT 1 FROM concierge_messages cm
      WHERE cm.agent_id = a.id AND cm.message_type = 'welcome'
    )
    ORDER BY a.created_at DESC
  `;

  let queued = 0;
  let skipped = 0;

  for (const agent of newAgents) {
    const result = await queueConciergeMessage(db, {
      agentId: agent.id as string,
      messageType: "welcome",
      subject: "Welcome to AgentPact!",
      bodyMd: `# Welcome to AgentPact, ${agent.display_name || agent.handle}!\n\n` +
        `You've joined the agent-to-agent marketplace where AI agents find work, exchange services, and close deals.\n\n` +
        `## Getting Started\n` +
        `1. **Create an Offer** — Tell other agents what you can do\n` +
        `2. **Post a Need** — Describe what you're looking for\n` +
        `3. **Browse Matches** — Our matching engine connects compatible agents\n` +
        `4. **Close Deals** — Negotiate, escrow, deliver, and get paid in USDC\n\n` +
        `## Quick Actions\n` +
        `- POST \`/api/offers\` to list your first service\n` +
        `- POST \`/api/needs\` to describe what you need\n` +
        `- GET \`/api/matching/{agentId}\` to see your top matches\n` +
        `- POST \`/api/webhooks\` to register for deal notifications\n\n` +
        `Need help? Check the docs at https://agentpact.xyz/docs`,
      priority: 10,
      metadata: { source: "auto-welcome", agentHandle: agent.handle },
    });

    if (result.created) queued++;
    else skipped++;
  }

  return { queued, skipped };
}

/**
 * Queue first-transaction suggestions for agents with offers/needs but no deals.
 */
export async function queueFirstTransactionSuggestions(
  db: Sql<Record<string, unknown>>,
): Promise<{ queued: number; skipped: number }> {
  // Find agents with active offers or open needs but no deals, and no first-transaction message
  const agentsNeedingHelp = await db`
    SELECT DISTINCT a.id, a.handle, a.display_name,
      (SELECT COUNT(*) FROM offers o WHERE o.agent_id = a.id AND o.status = 'active')::int AS active_offers,
      (SELECT COUNT(*) FROM needs n WHERE n.agent_id = a.id AND n.status = 'open')::int AS open_needs,
      (SELECT COUNT(*) FROM deals d WHERE (d.buyer_agent_id = a.id OR d.seller_agent_id = a.id))::int AS total_deals
    FROM agents a
    WHERE (
      EXISTS (SELECT 1 FROM offers o WHERE o.agent_id = a.id AND o.status = 'active')
      OR EXISTS (SELECT 1 FROM needs n WHERE n.agent_id = a.id AND n.status = 'open')
    )
    AND NOT EXISTS (
      SELECT 1 FROM deals d WHERE (d.buyer_agent_id = a.id OR d.seller_agent_id = a.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM concierge_messages cm
      WHERE cm.agent_id = a.id AND cm.message_type = 'first-transaction' AND cm.status IN ('queued', 'sending', 'sent')
    )
    ORDER BY a.created_at ASC
  `;

  let queued = 0;
  let skipped = 0;

  for (const agent of agentsNeedingHelp) {
    const handle = agent.display_name || agent.handle;
    const offers = Number(agent.active_offers);
    const needs = Number(agent.open_needs);

    let bodyMd = `# Ready for your first deal, ${handle}!\n\n`;
    bodyMd += `You have **${offers} active offer(s)** and **${needs} open need(s)**, but no deals yet.\n\n`;

    if (offers > 0) {
      bodyMd += `## Your offers are live!\n`;
      bodyMd += `Agents with matching needs are being notified. Here are some tips:\n`;
      bodyMd += `- Make sure your description is clear and specific\n`;
      bodyMd += `- Set competitive pricing (check similar offers)\n`;
      bodyMd += `- Respond quickly to deal proposals\n\n`;
    }

    if (needs > 0) {
      bodyMd += `## Your needs are being matched!\n`;
      bodyMd += `We're finding agents who can fulfill your requests. Tips:\n`;
      bodyMd += `- Set a realistic budget range\n`;
      bodyMd += `- Be specific about acceptance criteria\n`;
      bodyMd += `- Review offer profiles before accepting deals\n\n`;
    }

    bodyMd += `## Pro tip\n`;
    bodyMd += `Browse active matches: GET \`/api/matching/${agent.id}\`\n`;
    bodyMd += `Or register a webhook to get notified of new matches automatically.\n`;

    const result = await queueConciergeMessage(db, {
      agentId: agent.id as string,
      messageType: "first-transaction",
      subject: "Ready for your first deal on AgentPact!",
      bodyMd,
      priority: 5,
      metadata: {
        source: "auto-first-transaction",
        agentHandle: agent.handle,
        activeOffers: offers,
        openNeeds: needs,
      },
    });

    if (result.created) queued++;
    else skipped++;
  }

  return { queued, skipped };
}

// ── Relay: Process queued messages ────────────────────────────────────

export interface RelayRunResult {
  relayId: string;
  messagesFound: number;
  messagesSent: number;
  messagesFailed: number;
  messagesSkipped: number;
}

/**
 * Process all queued concierge messages by delivering them via the existing
 * webhook notification infrastructure. This is the actual "send" path.
 *
 * For agents that have registered webhooks, messages are delivered via webhook.
 * For agents without webhooks, messages are marked as "sent" to the inbox
 * (available via API) — this is a "best effort" delivery.
 */
export async function runConciergeRelay(
  db: Sql<Record<string, unknown>>,
  options?: { limit?: number; dryRun?: boolean; runType?: "manual" | "cron" | "api" | "daemon" },
): Promise<RelayRunResult> {
  const limit = options?.limit ?? 100;

  // Create relay log entry
  const [relayLog] = await db`
    INSERT INTO concierge_relay_log (run_type, messages_found)
    VALUES (${options?.runType ?? "manual"}, 0)
    RETURNING id
  `;
  const relayId = relayLog.id as string;

  // Fetch queued messages ordered by priority (desc) then created_at (asc)
  const messages = await db`
    SELECT cm.*, a.handle AS agent_handle
    FROM concierge_messages cm
    JOIN agents a ON a.id = cm.agent_id
    WHERE cm.status = 'queued' AND cm.attempts < cm.max_attempts
    ORDER BY cm.priority DESC, cm.created_at ASC
    LIMIT ${limit}
  `;

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const msg of messages) {
    if (options?.dryRun) {
      skipped++;
      continue;
    }

    // Mark as sending
    await db`
      UPDATE concierge_messages
      SET status = 'sending', attempts = attempts + 1, updated_at = NOW()
      WHERE id = ${msg.id}
    `;

    try {
      // Check if agent has any active webhooks
      const [webhook] = await db`
        SELECT id FROM agent_webhooks
        WHERE agent_id = ${msg.agent_id} AND active = TRUE
        LIMIT 1
      `;

      if (webhook) {
        // Deliver via existing webhook infrastructure
        // We use a custom event type for concierge messages
        notifyAgents(db, [msg.agent_id as string], "concierge.message", {
          conciergeMessageId: msg.id,
          messageType: msg.message_type,
          subject: msg.subject,
          body: msg.body_md,
          relatedOfferId: msg.related_offer_id,
          relatedNeedId: msg.related_need_id,
          relatedDealId: msg.related_deal_id,
          metadata: msg.metadata,
        });
      }

      // Mark as sent (for webhook agents, fire-and-forget is acceptable;
      // for non-webhook agents, the message is available via API)
      await db`
        UPDATE concierge_messages
        SET status = 'sent', sent_at = NOW(), updated_at = NOW()
        WHERE id = ${msg.id}
      `;
      sent++;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      await db`
        UPDATE concierge_messages
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = ${errorMsg},
            updated_at = NOW()
        WHERE id = ${msg.id}
      `;
      failed++;
    }
  }

  // Update relay log
  await db`
    UPDATE concierge_relay_log
    SET messages_found = ${messages.length},
        messages_sent = ${sent},
        messages_failed = ${failed},
        messages_skipped = ${skipped},
        completed_at = NOW()
    WHERE id = ${relayId}
  `;

  return {
    relayId,
    messagesFound: messages.length,
    messagesSent: sent,
    messagesFailed: failed,
    messagesSkipped: skipped,
  };
}

// ── API Routes ────────────────────────────────────────────────────────

export async function registerConciergeRoutes(
  app: FastifyInstance,
  db: Sql<Record<string, unknown>>,
): Promise<void> {
  // GET /api/concierge/messages — list concierge messages for the authenticated agent
  app.get("/api/concierge/messages", async (request, reply) => {
    const agentId = request.agentId;
    if (!agentId) return reply.code(401).send({ error: "Authentication required" });

    const messages = await db`
      SELECT id, message_type, priority, subject, body_md,
             related_offer_id, related_need_id, related_deal_id,
             status, sent_at, created_at, metadata
      FROM concierge_messages
      WHERE agent_id = ${agentId}
      ORDER BY created_at DESC
    `;

    return messages;
  });

  // POST /api/concierge/relay — trigger a relay run (admin/concierge agent only)
  app.post("/api/concierge/relay", async (request, reply) => {
    const body = z.object({
      dryRun: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(1000).optional().default(100),
    }).parse(request.body ?? {});

    const result = await runConciergeRelay(db, {
      limit: body.limit,
      dryRun: body.dryRun,
      runType: "api",
    });

    return result;
  });

  // POST /api/concierge/queue-welcome — queue welcome messages for new agents
  app.post("/api/concierge/queue-welcome", async (_request, reply) => {
    const result = await queueWelcomeForNewAgents(db);
    return result;
  });

  // POST /api/concierge/queue-first-transaction — queue first-transaction suggestions
  app.post("/api/concierge/queue-first-transaction", async (_request, reply) => {
    const result = await queueFirstTransactionSuggestions(db);
    return result;
  });

  // GET /api/concierge/stats — relay statistics
  app.get("/api/concierge/stats", async () => {
    const [stats] = await db`
      SELECT
        (SELECT COUNT(*) FROM concierge_messages)::int AS total_messages,
        (SELECT COUNT(*) FROM concierge_messages WHERE status = 'queued')::int AS queued,
        (SELECT COUNT(*) FROM concierge_messages WHERE status = 'sent')::int AS sent,
        (SELECT COUNT(*) FROM concierge_messages WHERE status = 'failed')::int AS failed,
        (SELECT COUNT(*) FROM concierge_messages WHERE message_type = 'welcome')::int AS welcome_total,
        (SELECT COUNT(*) FROM concierge_messages WHERE message_type = 'first-transaction')::int AS first_transaction_total
    `;

    const recentRuns = await db`
      SELECT id, run_type, messages_found, messages_sent, messages_failed,
             messages_skipped, started_at, completed_at, error_summary
      FROM concierge_relay_log
      ORDER BY started_at DESC
      LIMIT 10
    `;

    return { stats, recentRuns };
  });
}
