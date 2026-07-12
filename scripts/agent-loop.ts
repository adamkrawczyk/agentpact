#!/usr/bin/env npx tsx
/**
 * AgentPact Agent Loop
 *
 * A self-contained script that:
 * 1. Registers two agents (buyer + seller) if not already registered
 * 2. Seller posts an offer
 * 3. Buyer posts a matching need
 * 4. Buyer proposes a deal
 * 5. Seller accepts the deal
 * 6. Seller provides fulfillment (triggers instant auto-complete since timeout=0)
 * 7. Deal completes, feedback notification fires
 *
 * Run: npx tsx scripts/agent-loop.ts [--api-url https://api.agentpact.xyz] [--loop]
 *
 * Use --loop to keep running, creating new deals every N seconds.
 */

import { randomUUID } from "node:crypto";

const API_URL = process.argv.includes("--api-url")
  ? process.argv[process.argv.indexOf("--api-url") + 1]
  : process.env.AGENTPACT_API_URL ?? "https://api.agentpact.xyz";

const LOOP_MODE = process.argv.includes("--loop");
const LOOP_INTERVAL_MS = 60_000; // 1 deal per minute in loop mode

// ── State file (persists agent keys across runs) ──────────────────────────────
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = join(import.meta.dirname ?? ".", ".agent-loop-state.json");

type AgentState = {
  buyerAgentId: string;
  buyerApiKey: string;
  buyerWallet: string;
  sellerAgentId: string;
  sellerApiKey: string;
  sellerWallet: string;
  dealsCreated: number;
  lastRunAt: string;
};

function loadState(): AgentState | null {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function saveState(state: AgentState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  body?: unknown,
  apiKey?: string
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey; // AgentPact uses x-api-key, not Bearer

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }

  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── Agent registration (idempotent — re-registers to get fresh API key) ───────
async function registerAgent(agentId: string, walletAddress: string): Promise<string> {
  const res = await api("POST", "/api/auth/register", { agentId, walletAddress }) as Record<string, unknown>;
  const key = res.apiKey as string;
  if (!key) throw new Error(`Registration returned no apiKey: ${JSON.stringify(res)}`);
  return key;
}

async function ensureAgents(state: AgentState | null): Promise<AgentState> {
  if (state) {
    console.log("✅ Using existing agents from state file");
    console.log(`   Buyer:  ${state.buyerAgentId}`);
    console.log(`   Seller: ${state.sellerAgentId}`);
    // Re-register to get fresh API keys (keys may have been rotated)
    state.buyerApiKey = await registerAgent(state.buyerAgentId, state.buyerWallet);
    state.sellerApiKey = await registerAgent(state.sellerAgentId, state.sellerWallet);
    return state;
  }

  console.log("🔑 Registering new agents...");
  const buyerAgentId = randomUUID();
  const sellerAgentId = randomUUID();
  const buyerWallet = "0x" + "1".repeat(40);
  const sellerWallet = "0x" + "2".repeat(40);

  // auth/register auto-creates the agent row via INSERT ON CONFLICT DO NOTHING
  // No need to call POST /api/agents separately (it requires auth anyway)
  const buyerApiKey = await registerAgent(buyerAgentId, buyerWallet);
  const sellerApiKey = await registerAgent(sellerAgentId, sellerWallet);

  // Update agent profile now that we have keys
  await api("POST", "/api/agents", {
    handle: `buyer-${buyerAgentId.slice(0, 8)}`,
    displayName: "Auto Buyer Agent",
    ownerWalletAddress: buyerWallet,
    walletProvider: "metamask",
    autoBuyEnabled: false,
  }, buyerApiKey).catch(() => null);

  await api("POST", "/api/agents", {
    handle: `seller-${sellerAgentId.slice(0, 8)}`,
    displayName: "Auto Seller Agent",
    ownerWalletAddress: sellerWallet,
    walletProvider: "metamask",
    autoBuyEnabled: false,
  }, sellerApiKey).catch(() => null);

  console.log(`   Buyer:  ${buyerAgentId}`);
  console.log(`   Seller: ${sellerAgentId}`);

  return {
    buyerAgentId,
    buyerApiKey,
    buyerWallet,
    sellerAgentId,
    sellerApiKey,
    sellerWallet,
    dealsCreated: 0,
    lastRunAt: new Date().toISOString(),
  };
}

// ── Deal creation services catalogue ─────────────────────────────────────────
const SERVICES = [
  {
    offerTitle: "GPT-4o API Access — $5 Credit",
    offerDescriptionMd: "Get **$5 of OpenAI GPT-4o API credits** delivered within 1 hour as a prepaid API key. Ready to use immediately.",
    offerCategory: "api-access",
    offerTags: ["api-access", "openai", "llm"],
    offerBasePrice: 1,
    needTitle: "Need OpenAI API credits",
    needDescriptionMd: "Looking for **$5 OpenAI API credit** for GPT-4o experiments. Happy to pay 1 USDC.",
    needCategory: "api-access",
    needTags: ["api-access", "openai"],
    milestoneTitle: "Deliver OpenAI API Credits",
    milestoneAmount: 1,
  },
  {
    offerTitle: "Research Report — Web3 DeFi Trends 2026",
    offerDescriptionMd: "A **5-page research report** on DeFi trends in 2026. Delivered as PDF within 24h. Sources cited.",
    offerCategory: "research",
    offerTags: ["research", "defi", "report"],
    offerBasePrice: 2,
    needTitle: "Need DeFi market research",
    needDescriptionMd: "Looking for **up-to-date DeFi/Web3 market analysis** — 3-5 pages, 2026 trends.",
    needCategory: "research",
    needTags: ["research", "defi"],
    milestoneTitle: "Deliver Research Report",
    milestoneAmount: 2,
  },
  {
    offerTitle: "Python Script — CSV to JSON Converter",
    offerDescriptionMd: "A **custom Python script** that converts CSV files to JSON with configurable field mapping. Delivered within 2h.",
    offerCategory: "code",
    offerTags: ["code", "python", "automation"],
    offerBasePrice: 1,
    needTitle: "Need CSV to JSON converter script",
    needDescriptionMd: "Looking for a **Python script** for data format conversion — CSV input, JSON output.",
    needCategory: "code",
    needTags: ["code", "python"],
    milestoneTitle: "Deliver Python Script",
    milestoneAmount: 1,
  },
];

// ── Main deal loop ────────────────────────────────────────────────────────────
async function runOneDeal(state: AgentState): Promise<void> {
  const service = SERVICES[state.dealsCreated % SERVICES.length];
  console.log(`\n🔄 Deal #${state.dealsCreated + 1} — ${service.offerTitle}`);

  // 1. Seller creates offer
  console.log("  📢 Seller posting offer...");
  const offer = await api("POST", "/api/offers", {
    agentId: state.sellerAgentId,
    title: service.offerTitle,
    descriptionMd: service.offerDescriptionMd,
    category: service.offerCategory,
    tags: service.offerTags,
    basePrice: service.offerBasePrice,
    currency: "USDC",
    fulfillmentType: "generic",
    location: { remote: true },
  }, state.sellerApiKey) as Record<string, unknown>;
  console.log(`  ✅ Offer: ${offer.id}`);

  // 2. Buyer creates need
  console.log("  📋 Buyer posting need...");
  const need = await api("POST", "/api/needs", {
    agentId: state.buyerAgentId,
    title: service.needTitle,
    descriptionMd: service.needDescriptionMd,
    category: service.needCategory,
    tags: service.needTags,
    budgetMax: service.offerBasePrice,
    currency: "USDC",
    fulfillmentType: "generic",
    location: { remote: true },
  }, state.buyerApiKey) as Record<string, unknown>;
  console.log(`  ✅ Need: ${need.id}`);

  // 3. Buyer proposes deal (timeout=0 → instant auto-complete on fulfillment)
  console.log("  🤝 Buyer proposing deal...");
  const deal = await api("POST", "/api/deals/propose", {
    buyerAgentId: state.buyerAgentId,
    sellerAgentId: state.sellerAgentId,
    offerId: offer.id,
    needId: need.id,
    negotiatedTotal: service.offerBasePrice,
    maxPriceDeltaPct: 10,
    acceptanceTimeoutDays: 0,
    milestones: [{
      idx: 1,
      title: service.milestoneTitle,
      amount: service.milestoneAmount,
      acceptanceCriteria: ["Delivery confirmed via fulfillment data"],
    }],
  }, state.buyerApiKey) as Record<string, unknown>;
  console.log(`  ✅ Deal proposed: ${deal.id}`);

  // 4. Seller accepts deal
  console.log("  ✅ Seller accepting deal...");
  await api("POST", `/api/deals/${deal.id}/accept`, {
    actorAgentId: state.sellerAgentId,
  }, state.sellerApiKey);
  console.log(`  ✅ Deal accepted`);

  // Small delay to let DB settle
  await new Promise(r => setTimeout(r, 500));

  // 5. Seller provides fulfillment → triggers instant auto-complete (timeout=0)
  console.log("  📦 Seller providing fulfillment...");
  const fulfillment = await api("POST", `/api/deals/${deal.id}/fulfillment`, {
    agentId: state.sellerAgentId,
    fulfillmentData: {
      description: `Delivered: ${service.offerTitle}. Service completed successfully. Thank you for using AgentPact — the agent-to-agent marketplace.`,
      instructions: "Delivery complete. No further action required.",
    },
  }, state.sellerApiKey) as Record<string, unknown>;
  console.log(`  ✅ Fulfillment provided. Auto-completed: ${(fulfillment as Record<string,unknown>).auto_completed ?? false}`);

  // 6. Check final deal status
  await new Promise(r => setTimeout(r, 500));
  const finalDeal = await api("GET", `/api/deals/${deal.id}`, undefined, state.sellerApiKey) as Record<string, unknown>;
  console.log(`  🎉 Deal status: ${finalDeal.status} (${service.offerBasePrice} USDC)`);

  if (finalDeal.status !== "completed") {
    // Deal didn't auto-complete (maybe fulfillment type mismatch) — force it
    console.log("  ⚡ Force-completing via auto-complete endpoint...");
    await fetch(`${API_URL}/api/deals/${deal.id}/fulfillment/auto-complete?force=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  }

  state.dealsCreated++;
  state.lastRunAt = new Date().toISOString();
  saveState(state);
  console.log(`\n📊 Total deals created by this loop: ${state.dealsCreated}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 AgentPact Agent Loop`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Mode: ${LOOP_MODE ? `continuous (every ${LOOP_INTERVAL_MS / 1000}s)` : "single run"}\n`);

  // Health check
  const health = await fetch(`${API_URL}/health`).then(r => r.json()) as Record<string, unknown>;
  if (!health.ok) {
    console.error("❌ API is not healthy:", health);
    process.exit(1);
  }
  console.log("✅ API healthy\n");

  let state = await ensureAgents(loadState());
  saveState(state);

  do {
    try {
      await runOneDeal(state);
    } catch (err) {
      console.error("❌ Deal failed:", err instanceof Error ? err.message : err);
    }

    if (LOOP_MODE) {
      console.log(`\n⏳ Next deal in ${LOOP_INTERVAL_MS / 1000}s... (Ctrl+C to stop)\n`);
      await new Promise(r => setTimeout(r, LOOP_INTERVAL_MS));
    }
  } while (LOOP_MODE);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
