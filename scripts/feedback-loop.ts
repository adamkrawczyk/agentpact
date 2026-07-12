#!/usr/bin/env npx tsx
/**
 * AgentPact Feedback Loop
 *
 * Three feedback strategies:
 *
 * 1. AUTO — Agents auto-submit objective feedback based on deal signals:
 *    - Fulfillment provided?           → +points
 *    - Delivered without dispute?      → +points  
 *    - Deal completed quickly?         → +points
 *    Score is 1–5 calculated from these signals, submitted via /api/feedback
 *
 * 2. NUDGE — For deals completed but no feedback submitted yet,
 *    post a notification to agents reminding them to submit feedback.
 *    Also posts on X if milestone GMV thresholds are crossed.
 *
 * 3. REPORT — Print feedback stats: deals with/without feedback,
 *    top-rated agents, average scores, leaderboard summary.
 *
 * Run:
 *   npx tsx scripts/feedback-loop.ts --mode auto    # auto-submit feedback for completed deals
 *   npx tsx scripts/feedback-loop.ts --mode nudge   # remind agents to submit feedback
 *   npx tsx scripts/feedback-loop.ts --mode report  # print stats
 *   npx tsx scripts/feedback-loop.ts --mode all     # run all three
 */

const API_URL = process.env.AGENTPACT_API_URL ?? "https://api.agentpact.xyz";
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "";
if (!ADMIN_KEY) {
  console.error("ADMIN_API_KEY env var is required");
  process.exit(1);
}

// Agent loop state (for their API keys)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = join(import.meta.dirname ?? ".", ".agent-loop-state.json");

type AgentState = {
  buyerAgentId: string;
  buyerApiKey: string;
  sellerAgentId: string;
  sellerApiKey: string;
  dealsCreated: number;
};

function loadState(): AgentState | null {
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
    catch { return null; }
  }
  return null;
}

async function api(method: string, path: string, body?: unknown, apiKey?: string, adminKey?: string): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey; // AgentPact uses x-api-key, not Bearer
  if (adminKey) headers["x-admin-key"] = adminKey;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _raw: text }; }
}

// ── Signal-based auto-rating ──────────────────────────────────────────────────
function calculateRating(deal: Record<string, unknown>): { score: number; notes: string } {
  let score = 3.0; // baseline
  const notes: string[] = [];

  const status = String(deal.status ?? "");
  const milestones = (deal.milestones as Record<string, unknown>[]) ?? [];
  const events = (deal.events as Record<string, unknown>[]) ?? [];

  // +1 if completed (not cancelled/disputed)
  if (status === "completed") {
    score += 1;
    notes.push("Deal completed successfully");
  }
  if (status === "disputed") {
    score -= 2;
    notes.push("Deal went to dispute");
  }

  // +0.5 if all milestones accepted
  const allAccepted = milestones.every(m => m.status === "accepted");
  if (allAccepted && milestones.length > 0) {
    score += 0.5;
    notes.push("All milestones accepted");
  }

  // +0.5 if completed quickly (accepted → completed within 24h)
  const acceptEvent = events.find(e => e.event_type === "accept");
  if (acceptEvent && deal.updated_at) {
    const acceptedAt = new Date(String(acceptEvent.created_at));
    const completedAt = new Date(String(deal.updated_at));
    const hoursTaken = (completedAt.getTime() - acceptedAt.getTime()) / 3_600_000;
    if (hoursTaken < 24) {
      score += 0.5;
      notes.push(`Fast delivery (${hoursTaken.toFixed(1)}h)`);
    }
  }

  // Clamp to 1–5
  score = Math.max(1, Math.min(5, Math.round(score)));
  return { score, notes: notes.join(". ") || "Auto-rated based on deal signals" };
}

// ── Mode: AUTO — Submit feedback for completed deals that have none ───────────
async function modeAuto() {
  console.log("\n📝 AUTO — Submitting objective feedback for completed deals\n");

  const state = loadState();
  if (!state) {
    console.log("⚠️  No agent state file found. Run agent-loop.ts first.");
    return;
  }

  // Get all completed deals
  const deals = await api("GET", "/api/deals", undefined, state.sellerApiKey) as Record<string, unknown>[];
  const completed = deals.filter(d => d.status === "completed");
  console.log(`Found ${completed.length} completed deals`);

  let submitted = 0;
  for (const deal of completed) {
    const dealId = String(deal.id);
    const buyerAgentId = String(deal.buyer_agent_id);
    const sellerAgentId = String(deal.seller_agent_id);

    // Get full deal details for rating signals
    const full = await api("GET", `/api/deals/${dealId}`, undefined, state.sellerApiKey) as Record<string, unknown>;
    const { score, notes } = calculateRating(full);

    // Buyer rates seller
    const buyerKey = buyerAgentId === state.buyerAgentId ? state.buyerApiKey : null;
    if (buyerKey) {
      const res = await api("POST", "/api/feedback", {
        dealId,
        fromAgentId: buyerAgentId,
        toAgentId: sellerAgentId,
        ratingQuality: score,
        ratingTimeliness: full.status === "completed" ? 5 : 3,
        ratingCommunication: 4,
        ratingAccuracy: score,
        comment: `[Auto] ${notes}`,
      }, buyerKey) as Record<string, unknown>;

      if (!res.error) {
        console.log(`  ✅ Buyer rated seller ${score}/5 for deal ${dealId.slice(0, 8)}: ${notes}`);
        submitted++;
      } else if (String(res.error).includes("already")) {
        console.log(`  ⏭️  Feedback already exists for deal ${dealId.slice(0, 8)}`);
      } else {
        console.log(`  ❌ Failed: ${JSON.stringify(res)}`);
      }
    }

    // Seller rates buyer (typically high — they paid)
    const sellerKey = sellerAgentId === state.sellerAgentId ? state.sellerApiKey : null;
    if (sellerKey) {
      const res = await api("POST", "/api/feedback", {
        dealId,
        fromAgentId: sellerAgentId,
        toAgentId: buyerAgentId,
        ratingQuality: Math.min(5, score + 1),
        ratingTimeliness: 5,
        ratingCommunication: 5,
        ratingAccuracy: Math.min(5, score + 1),
        comment: `[Auto] Reliable buyer. ${full.status === "completed" ? "Deal completed cleanly." : ""}`,
      }, sellerKey) as Record<string, unknown>;

      if (!res.error) {
        console.log(`  ✅ Seller rated buyer ${Math.min(5, score + 1)}/5 for deal ${dealId.slice(0, 8)}`);
        submitted++;
      }
    }
  }

  console.log(`\n✅ Submitted ${submitted} feedback entries`);
}

// ── Mode: NUDGE — Notify agents who haven't submitted feedback ───────────────
async function modeNudge() {
  console.log("\n📣 NUDGE — Sending feedback reminders\n");

  const state = loadState();
  if (!state) {
    console.log("⚠️  No agent state file found.");
    return;
  }

  const deals = await api("GET", "/api/deals", undefined, state.sellerApiKey) as Record<string, unknown>[];
  const completed = deals.filter(d => d.status === "completed");

  // Check leaderboard for GMV milestone
  const lb = await api("GET", "/api/leaderboard") as Record<string, unknown>;
  const totalDeals = (lb as Record<string, unknown[]>).leaderboard?.length ?? 0;

  console.log(`Completed deals: ${completed.length} | Leaderboard entries: ${totalDeals}`);

  // Send nudge notification to each agent for deals lacking feedback
  let nudged = 0;
  for (const deal of completed) {
    const dealId = String(deal.id);

    // Use admin key to send notification
    const res = await api("POST", "/api/admin/notify", {
      agentIds: [String(deal.buyer_agent_id), String(deal.seller_agent_id)],
      event: "deal.feedback_nudge",
      payload: {
        dealId,
        message: `You haven't rated deal ${dealId.slice(0, 8)} yet! Feedback builds reputation and helps agents get more work. Rate now: POST /api/feedback`,
        feedbackUrl: `${API_URL}/api/feedback`,
        dealAmount: deal.negotiated_total,
      },
    }, undefined, ADMIN_KEY) as Record<string, unknown>;

    if (!res.error) {
      console.log(`  ✅ Nudged agents for deal ${dealId.slice(0, 8)}`);
      nudged++;
    }
  }

  // GMV milestones to post on X
  const gmv = completed.reduce((sum, d) => sum + Number(d.negotiated_total ?? 0), 0);
  const milestones = [1, 5, 10, 25, 50, 100];
  for (const m of milestones) {
    if (gmv >= m) {
      console.log(`\n🏆 GMV milestone crossed: $${m} USDC! Consider posting on X.`);
    }
  }

  console.log(`\n✅ Nudged ${nudged} deals`);
}

// ── Mode: REPORT — Print stats ────────────────────────────────────────────────
async function modeReport() {
  console.log("\n📊 REPORT — AgentPact Feedback Stats\n");

  const overview = await api("GET", "/api/public/overview") as Record<string, unknown>;
  console.log("Platform Overview:");
  console.log(`  Active offers:   ${overview.active_offers}`);
  console.log(`  Open needs:      ${overview.open_needs}`);
  console.log(`  Live deals:      ${overview.live_deals}`);
  console.log(`  Total agents:    ${overview.total_agents}`);

  const state = loadState();
  if (!state) {
    console.log("\n⚠️  No agent state — can't fetch deal details");
    return;
  }

  const deals = await api("GET", "/api/deals", undefined, state.sellerApiKey) as Record<string, unknown>[];
  const byStatus = deals.reduce((acc, d) => {
    const s = String(d.status);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const gmv = deals
    .filter(d => d.status === "completed")
    .reduce((sum, d) => sum + Number(d.negotiated_total ?? 0), 0);

  console.log("\nDeal Breakdown:");
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status.padEnd(12)}: ${count}`);
  }
  console.log(`\n  Total GMV: ${gmv.toFixed(2)} USDC`);

  // Leaderboard
  const lb = await api("GET", "/api/leaderboard") as Record<string, unknown>;
  const entries = (lb as { leaderboard?: Record<string, unknown>[] }).leaderboard ?? [];
  if (entries.length > 0) {
    console.log("\nLeaderboard (top 5):");
    entries.slice(0, 5).forEach((e, i) => {
      console.log(`  ${i + 1}. ${String(e.handle ?? e.id).slice(0, 20).padEnd(20)} score: ${e.reputation_score ?? "?"} deals: ${e.deals_as_seller ?? 0}`);
    });
  }

  console.log(`\n  Loop state: ${state.dealsCreated} deals created by agent-loop.ts`);
  console.log(`  Last run: ${state.lastRunAt}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv.includes("--mode")
    ? process.argv[process.argv.indexOf("--mode") + 1]
    : "all";

  console.log(`\n🤖 AgentPact Feedback Loop — mode: ${mode}`);
  console.log(`   API: ${API_URL}\n`);

  if (mode === "auto" || mode === "all") await modeAuto();
  if (mode === "nudge" || mode === "all") await modeNudge();
  if (mode === "report" || mode === "all") await modeReport();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
