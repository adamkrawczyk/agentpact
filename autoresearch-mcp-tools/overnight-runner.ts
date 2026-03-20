/**
 * Autoresearch Mutation Loop for AgentPact MCP Tools
 * 
 * Karpathy method: run evals → analyze failures → mutate ONE thing → 
 * re-eval → keep if better, discard if not → repeat
 * 
 * Overnight runner targeting 80-90% from 21.6% baseline.
 */

import OpenAI from "openai";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync } from "fs";

const API_BASE = "https://api.agentpact.xyz";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const EVAL_MODEL = process.env.EVAL_MODEL ?? "gpt-4o-mini";
const MUTATOR_MODEL = process.env.MUTATOR_MODEL ?? "gpt-4o";
const RUNS_PER_SCENARIO = 3; // 3 runs to save cost, enough signal
const MAX_EXPERIMENTS = 40;
const TARGET_PASS_RATE = 90;
const MCP_SOURCE = "../apps/mcp/src/index.ts";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Types ────────────────────────────────────────────────────────────

interface ToolCall { tool: string; args: Record<string, unknown>; result: unknown; error?: string }
interface EvalCheck { name: string; check: (trace: ToolCall[]) => boolean }
interface Scenario { name: string; prompt: string; evals: EvalCheck[] }
interface ExperimentResult {
  id: number; score: number; maxScore: number; passRate: number;
  status: "baseline" | "keep" | "discard"; description: string;
  failingEvals: string[];
}

// ── Scenarios (same as before, tuned) ────────────────────────────────

const scenarios: Scenario[] = [
  {
    name: "Find and hire a code review service",
    prompt: `You are an AI agent that needs a code review service. Use the AgentPact marketplace tools to find one and hire it. Your agent ID is {AGENT_ID} and your API key is {API_KEY}. Search for available offers, pick the best one, and propose a deal.`,
    evals: [
      { name: "Called search_offers", check: (t) => t.some(c => c.tool === "agentpact_search_offers") },
      { name: "Proposed a deal", check: (t) => t.some(c => c.tool === "agentpact_propose_deal" && !c.error) },
      { name: "No errors in critical path", check: (t) => { const critical = t.filter(c => ["agentpact_search_offers","agentpact_propose_deal"].includes(c.tool)); return critical.length > 0 && critical.every(c => !c.error); }},
      { name: "Under 8 tool calls", check: (t) => t.length <= 8 },
      { name: "Search before deal", check: (t) => { const s = t.findIndex(c => c.tool === "agentpact_search_offers"); const d = t.findIndex(c => c.tool === "agentpact_propose_deal"); return s >= 0 && d > s; }},
    ],
  },
  {
    name: "Register and list a service",
    prompt: `You are a new AI agent joining the AgentPact marketplace. Register on the platform using agent ID {AGENT_ID}, create your profile, and list a "Data Analysis" service for $0.50.`,
    evals: [
      { name: "Called register", check: (t) => t.some(c => c.tool === "agentpact_register" && !c.error) },
      { name: "Created profile", check: (t) => t.some(c => c.tool === "agentpact_create_agent" && !c.error) },
      { name: "Created offer", check: (t) => t.some(c => c.tool === "agentpact_create_offer" && !c.error) },
      { name: "Correct order", check: (t) => { const r = t.findIndex(c => c.tool === "agentpact_register"); const p = t.findIndex(c => c.tool === "agentpact_create_agent"); const o = t.findIndex(c => c.tool === "agentpact_create_offer"); return r >= 0 && p > r && o > p; }},
      { name: "No errors", check: (t) => t.filter(c => c.error).length === 0 },
    ],
  },
  {
    name: "Post a need and check matches",
    prompt: `You are an AI agent looking for web scraping help. Your agent ID is {AGENT_ID} and API key is {API_KEY}. Post a need describing what you're looking for, then check for matching offers.`,
    evals: [
      { name: "Created need", check: (t) => t.some(c => c.tool === "agentpact_create_need" && !c.error) },
      { name: "Checked matches", check: (t) => t.some(c => (c.tool === "agentpact_get_match_recommendations" || c.tool === "agentpact_search_offers") && !c.error) },
      { name: "No errors", check: (t) => t.filter(c => c.error).length === 0 },
      { name: "Under 6 calls", check: (t) => t.length <= 6 },
    ],
  },
  {
    name: "Check reputation before dealing",
    prompt: `Check agent "b8169514-d2f6-48f6-a796-bbb2a345ce42" reputation and profile before dealing with them. Your agent ID is {AGENT_ID}, API key is {API_KEY}. Look up their profile and search their offers.`,
    evals: [
      { name: "Got agent profile", check: (t) => t.some(c => c.tool === "agentpact_get_agent" && !c.error) },
      { name: "No errors", check: (t) => t.filter(c => c.error).length === 0 },
      { name: "Under 5 calls", check: (t) => t.length <= 5 },
      { name: "Didn't blindly deal", check: (t) => !t.some(c => c.tool === "agentpact_propose_deal") },
    ],
  },
];

// ── Tool execution (hits real API) ───────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; error?: string }> {
  const apiKey = (args.apiKey as string) || "";
  const routes: Record<string, { method: string; path: () => string; body?: (a: any) => any }> = {
    "agentpact_register": { method: "POST", path: () => "/api/auth/register", body: (a: any) => ({ agentId: a.agentId, walletAddress: a.walletAddress || `0xtest${randomUUID().replace(/-/g,"").slice(0,32)}` }) },
    "agentpact_create_agent": { method: "POST", path: () => "/api/agents", body: (a: any) => ({ handle: a.handle || `agent-${randomUUID().slice(0,8)}`, displayName: a.displayName || "Test Agent", ownerWalletAddress: a.ownerWalletAddress || `0xtest${randomUUID().replace(/-/g,"").slice(0,32)}`, walletProvider: a.walletProvider || "metamask" }) },
    "agentpact_get_agent": { method: "GET", path: () => `/api/agents/${args.id || args.agentId}` },
    "agentpact_create_offer": { method: "POST", path: () => "/api/offers", body: (a: any) => ({ agentId: a.agentId, title: a.title || "Service", descriptionMd: a.descriptionMd || a.description || "Service description", category: a.category || "general", tags: a.tags || ["service"], basePrice: String(a.basePrice || a.price || "0.50"), pricingModel: a.pricingModel || "paid", fulfillmentType: a.fulfillmentType || "data-delivery", slaDays: a.slaDays || 1 }) },
    "agentpact_search_offers": { method: "GET", path: () => { const p = new URLSearchParams(); if (args.category) p.set("category", String(args.category)); if (args.query) p.set("q", String(args.query)); return `/api/offers?${p.toString()}`; } },
    "agentpact_create_need": { method: "POST", path: () => "/api/needs", body: (a: any) => ({ agentId: a.agentId, title: a.title || "Need", descriptionMd: a.descriptionMd || a.description || "Need description", category: a.category || "general", tags: a.tags || ["needed"], maxBudget: String(a.maxBudget || a.budget || "1.00") }) },
    "agentpact_search_needs": { method: "GET", path: () => `/api/needs?limit=5` },
    "agentpact_propose_deal": { method: "POST", path: () => "/api/deals", body: (a: any) => ({ buyerAgentId: a.buyerAgentId || a.agentId, offerId: a.offerId, price: String(a.price || "0.50"), message: a.message || "I'd like to proceed" }) },
    "agentpact_accept_deal": { method: "PATCH", path: () => `/api/deals/${args.dealId}/accept` },
    "agentpact_cancel_deal": { method: "PATCH", path: () => `/api/deals/${args.dealId}/cancel` },
    "agentpact_get_match_recommendations": { method: "GET", path: () => `/api/matches?agentId=${args.agentId}` },
  };
  const route = routes[name];
  if (!route) return { result: null, error: `Unknown tool: ${name}` };
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    const body = route.method !== "GET" && route.body ? route.body(args) : undefined;
    const resp = await fetch(`${API_BASE}${route.path()}`, { method: route.method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { result: data, error: `${resp.status}: ${JSON.stringify(data).slice(0,200)}` };
    return { result: data };
  } catch (err: any) { return { result: null, error: err.message }; }
}

// ── Extract tool descriptions from MCP source ────────────────────────

function extractToolDescriptions(source: string): string {
  const blocks: string[] = [];
  const regex = /name:\s*"(agentpact\.[^"]+)"[\s\S]*?description:\s*\n?\s*"([^"]+(?:"[^"]*"[^"]*)*?)"/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    blocks.push(`- ${match[1].replace(/\./g, "_")}: ${match[2]}`);
  }
  if (blocks.length === 0) {
    // Fallback: simpler extraction
    const parts = source.split(/\{\s*name:\s*"/);
    for (const part of parts.slice(1)) {
      const nameEnd = part.indexOf('"');
      const name = part.slice(0, nameEnd);
      const descMatch = part.match(/description:\s*\n?\s*"([^"]+)"/);
      if (name.startsWith("agentpact.") && descMatch) {
        blocks.push(`- ${name.replace(/\./g, "_")}: ${descMatch[1]}`);
      }
    }
  }
  return blocks.join("\n");
}

// ── Run one full eval cycle ──────────────────────────────────────────

async function runFullEval(toolDescriptions: string): Promise<{ score: number; maxScore: number; failingEvals: string[] }> {
  let totalPass = 0;
  let totalEvals = 0;
  const failing: string[] = [];

  for (const scenario of scenarios) {
    for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
      const agentId = randomUUID();
      const reg = await executeTool("agentpact_register", { agentId });
      const apiKey = (reg.result as any)?.apiKey ?? "";

      const prompt = scenario.prompt.replace("{AGENT_ID}", agentId).replace("{API_KEY}", apiKey);
      const trace: ToolCall[] = [];
      
      const toolDefs: OpenAI.Chat.ChatCompletionTool[] = [
        "agentpact_register", "agentpact_create_agent", "agentpact_get_agent",
        "agentpact_create_offer", "agentpact_search_offers", "agentpact_create_need",
        "agentpact_search_needs", "agentpact_propose_deal", "agentpact_accept_deal",
        "agentpact_cancel_deal", "agentpact_get_match_recommendations",
      ].map(n => ({ type: "function" as const, function: { name: n, parameters: { type: "object" as const, properties: {}, additionalProperties: true } } }));

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: `You are an AI agent interacting with the AgentPact marketplace.\n\nAvailable tools:\n${toolDescriptions}\n\nIMPORTANT: Always include apiKey in authenticated calls. The agent was pre-registered, use the provided API key.` },
        { role: "user", content: prompt },
      ];

      for (let turn = 0; turn < 10; turn++) {
        try {
          const response = await openai.chat.completions.create({ model: EVAL_MODEL, messages, tools: toolDefs, tool_choice: "auto" });
          const msg = response.choices[0].message;
          messages.push(msg);
          if (!msg.tool_calls || msg.tool_calls.length === 0) break;
          for (const tc of msg.tool_calls) {
            const args = JSON.parse(tc.function.arguments);
            if (!args.apiKey && apiKey) args.apiKey = apiKey;
            if (!args.agentId) args.agentId = agentId;
            const { result, error } = await executeTool(tc.function.name, args);
            trace.push({ tool: tc.function.name, args, result, error });
            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(error ? { error } : result).slice(0, 2000) });
          }
        } catch (err: any) {
          trace.push({ tool: "system_error", args: {}, result: null, error: err.message });
          break;
        }
      }

      for (const e of scenario.evals) {
        totalEvals++;
        if (e.check(trace)) { totalPass++; }
        else { failing.push(`${scenario.name}: ${e.name}`); }
      }
    }
  }

  return { score: totalPass, maxScore: totalEvals, failingEvals: failing };
}

// ── Mutator: analyze failures and suggest ONE change ─────────────────

async function suggestMutation(currentDescriptions: string, failingEvals: string[], changelog: string): Promise<{ change: string; newDescriptions: string }> {
  const failCounts: Record<string, number> = {};
  for (const f of failingEvals) {
    failCounts[f] = (failCounts[f] || 0) + 1;
  }
  const topFailures = Object.entries(failCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v}x)`).join("\n");

  // Vary approach to avoid getting stuck
  const approaches = [
    "Focus on the MOST failing eval. Add specific argument names and types to the tool description.",
    "Focus on TOOL SEQUENCING. Make it crystal clear which tools must be called before others.",
    "Focus on EXAMPLES. Add a brief example JSON for the most-failing tool's arguments.",
    "Focus on ERROR PREVENTION. Add warnings about common mistakes in tool descriptions.",
    "Try a COMPLETELY DIFFERENT approach to the descriptions — restructure, reword, add context.",
    "Focus on making the SIMPLEST possible description. Remove clutter, keep only what's essential.",
    "Focus on DEAL CREATION. The propose_deal tool needs clearer docs about required args (buyerAgentId, offerId, price).",
    "Add a WORKFLOW SUMMARY at the top: 'Step 1: register → Step 2: create_agent → Step 3: create_offer/search_offers'",
  ];
  const approach = approaches[Math.floor(Math.random() * approaches.length)];

  const resp = await openai.chat.completions.create({
    model: MUTATOR_MODEL,
    messages: [
      { role: "system", content: `You optimize MCP tool descriptions for AI agent usability. You make ONE targeted change per iteration.

The tools are for the AgentPact marketplace — agents use them to register, create profiles, list services, search for services, propose deals, etc.

APPROACH FOR THIS ITERATION: ${approach}

RULES:
- Change only tool descriptions, NOT the tool functionality  
- Make descriptions clearer about required arguments and their formats
- Add examples of correct argument values where helpful
- Clarify the sequence of operations (register → create profile → then use other tools)
- The propose_deal tool requires: buyerAgentId, offerId (from search results), price (string like "0.50")
- The create_offer tool requires: agentId, title, descriptionMd, category, tags (array), basePrice (string), pricingModel, fulfillmentType, slaDays
- The create_agent tool requires: handle, displayName, ownerWalletAddress
- Output the FULL updated tool descriptions list (all tools, not just changed ones)
- Keep descriptions concise but unambiguous
- DO NOT repeat changes that were already tried and discarded` },
      { role: "user", content: `Current tool descriptions:\n\n${currentDescriptions}\n\nTop failing evals:\n${topFailures}\n\nPrevious mutations tried:\n${changelog.slice(-2000) || "None yet"}\n\nSuggest ONE change. Reply with:\nCHANGE: <what you changed and why>\nDESCRIPTIONS:\n<full updated tool descriptions list>` },
    ],
    temperature: 0.6 + Math.random() * 0.4, // 0.6–1.0
  });

  const text = resp.choices[0].message.content || "";
  const changeMatch = text.match(/CHANGE:\s*(.+?)(?:\n|DESCRIPTIONS:)/s);
  const descMatch = text.match(/DESCRIPTIONS:\s*\n([\s\S]+)/);
  
  return {
    change: changeMatch?.[1]?.trim() || "Unknown change",
    newDescriptions: descMatch?.[1]?.trim() || currentDescriptions,
  };
}

// ── Main loop ────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("AUTORESEARCH: AgentPact MCP Tool Descriptions");
  console.log(`Eval model: ${EVAL_MODEL} | Mutator: ${MUTATOR_MODEL}`);
  console.log(`Runs/scenario: ${RUNS_PER_SCENARIO} | Max experiments: ${MAX_EXPERIMENTS}`);
  console.log(`Target: ${TARGET_PASS_RATE}%`);
  console.log("═".repeat(60));

  // Backup original
  const mcpSource = readFileSync(MCP_SOURCE, "utf-8");
  if (!existsSync("SKILL.md.baseline")) {
    writeFileSync("SKILL.md.baseline", mcpSource);
  }

  let currentDescriptions = extractToolDescriptions(mcpSource);
  console.log(`\nExtracted ${currentDescriptions.split("\n").length} tool descriptions\n`);

  // Resume from previous run if exists
  let results: ExperimentResult[] = [];
  let changelog = "";
  let bestScore = 0;
  let bestDescriptions = currentDescriptions;
  let consecutiveHigh = 0;
  let startExp = 1;

  if (existsSync("results.json")) {
    try {
      const prev = JSON.parse(readFileSync("results.json", "utf-8"));
      if (prev.experiments?.length > 0) {
        results = prev.experiments;
        startExp = results.length; // resume from next experiment
        bestScore = Math.max(...results.map((r: ExperimentResult) => r.score));
        if (existsSync("best-descriptions.md")) {
          bestDescriptions = readFileSync("best-descriptions.md", "utf-8");
          currentDescriptions = bestDescriptions;
        }
        if (existsSync("changelog.md")) {
          changelog = readFileSync("changelog.md", "utf-8");
        }
        console.log(`\n⏩ Resuming from experiment ${startExp} (best so far: ${(bestScore/results[0].maxScore*100).toFixed(1)}%)\n`);
      }
    } catch {}
  }

  if (results.length === 0) {
    // TSV header
    writeFileSync("results.tsv", "experiment\tscore\tmax_score\tpass_rate\tstatus\tdescription\n");
    
    // Baseline
    console.log("▶ Running baseline...");
    const baseline = await runFullEval(currentDescriptions);
    const baselineRate = (baseline.score / baseline.maxScore * 100);
    bestScore = baseline.score;
    
    const baseResult: ExperimentResult = {
      id: 0, score: baseline.score, maxScore: baseline.maxScore,
      passRate: baselineRate, status: "baseline",
      description: "original tool descriptions", failingEvals: baseline.failingEvals,
    };
    results.push(baseResult);
    appendFileSync("results.tsv", `0\t${baseline.score}\t${baseline.maxScore}\t${baselineRate.toFixed(1)}%\tbaseline\toriginal tool descriptions\n`);
    writeFileSync("results.json", JSON.stringify({ experiments: results, status: "running", bestScore: baselineRate }, null, 2));
    
    console.log(`Baseline: ${baseline.score}/${baseline.maxScore} (${baselineRate.toFixed(1)}%)\n`);
  }

  // Mutation loop
  for (let exp = startExp; exp <= MAX_EXPERIMENTS; exp++) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Experiment ${exp}/${MAX_EXPERIMENTS}`);
    
    // Get latest failing evals
    const latestFailing = results[results.length - 1]?.failingEvals || [];
    
    // Analyze and mutate
    console.log("Analyzing failures and generating mutation...");
    let change: string, newDescriptions: string;
    try {
      const mutation = await suggestMutation(currentDescriptions, latestFailing, changelog);
      change = mutation.change;
      newDescriptions = mutation.newDescriptions;
    } catch (err: any) {
      console.log(`Mutator error: ${err.message} — retrying in 30s`);
      await new Promise(r => setTimeout(r, 30000));
      try {
        const mutation = await suggestMutation(currentDescriptions, latestFailing, changelog);
        change = mutation.change;
        newDescriptions = mutation.newDescriptions;
      } catch (err2: any) {
        console.log(`Mutator retry failed: ${err2.message} — skipping`);
        continue;
      }
    }
    console.log(`Change: ${change}`);
    
    // Eval the mutation
    console.log("Running evals...");
    let evalResult: { score: number; maxScore: number; failingEvals: string[] };
    try {
      evalResult = await runFullEval(newDescriptions);
    } catch (err: any) {
      console.log(`Eval error: ${err.message} — skipping experiment`);
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }
    const passRate = (evalResult.score / evalResult.maxScore * 100);
    
    const improved = evalResult.score > bestScore;
    const status = improved ? "keep" : "discard";
    
    console.log(`Score: ${evalResult.score}/${evalResult.maxScore} (${passRate.toFixed(1)}%) → ${status.toUpperCase()}`);
    
    if (improved) {
      bestScore = evalResult.score;
      bestDescriptions = newDescriptions;
      currentDescriptions = newDescriptions;
      // Save improved descriptions
      writeFileSync("best-descriptions.md", newDescriptions);
    }
    
    const expResult: ExperimentResult = {
      id: exp, score: evalResult.score, maxScore: evalResult.maxScore,
      passRate, status, description: change, failingEvals: evalResult.failingEvals,
    };
    results.push(expResult);
    
    // Log
    appendFileSync("results.tsv", `${exp}\t${evalResult.score}\t${evalResult.maxScore}\t${passRate.toFixed(1)}%\t${status}\t${change}\n`);
    changelog += `\n## Experiment ${exp} — ${status}\nScore: ${evalResult.score}/${evalResult.maxScore} (${passRate.toFixed(1)}%)\nChange: ${change}\n`;
    appendFileSync("changelog.md", `\n## Experiment ${exp} — ${status}\n\n**Score:** ${evalResult.score}/${evalResult.maxScore} (${passRate.toFixed(1)}%)\n**Change:** ${change}\n**Top failures:** ${evalResult.failingEvals.slice(0, 3).join("; ")}\n`);
    
    writeFileSync("results.json", JSON.stringify({ 
      experiments: results, status: "running", 
      bestScore: (bestScore / evalResult.maxScore * 100).toFixed(1),
      currentExperiment: exp,
    }, null, 2));
    
    // Check stopping conditions
    if (passRate >= TARGET_PASS_RATE) {
      consecutiveHigh++;
      if (consecutiveHigh >= 3) {
        console.log(`\n🎯 Hit ${TARGET_PASS_RATE}%+ for 3 consecutive experiments. Stopping.`);
        break;
      }
    } else {
      consecutiveHigh = 0;
    }
    
    // Cool down to avoid rate limits
    await new Promise(r => setTimeout(r, 5000));
  }
  
  // Final summary
  const finalRate = (bestScore / results[0].maxScore * 100);
  const kept = results.filter(r => r.status === "keep").length;
  const discarded = results.filter(r => r.status === "discard").length;
  
  console.log("\n" + "═".repeat(60));
  console.log("AUTORESEARCH COMPLETE");
  console.log(`Baseline: ${results[0].passRate.toFixed(1)}% → Final: ${finalRate.toFixed(1)}%`);
  console.log(`Experiments: ${results.length - 1} | Kept: ${kept} | Discarded: ${discarded}`);
  console.log(`Best descriptions saved to: best-descriptions.md`);
  console.log("═".repeat(60));
  
  writeFileSync("results.json", JSON.stringify({ 
    experiments: results, status: "complete", 
    baseline: results[0].passRate,
    bestScore: finalRate,
    kept, discarded,
    totalExperiments: results.length - 1,
  }, null, 2));
  
  writeFileSync("best-descriptions.md", bestDescriptions);
  
  // Signal completion
  const { execSync } = await import("child_process");
  try {
    execSync(`openclaw system event --text "Autoresearch complete: MCP tools ${results[0].passRate.toFixed(0)}% → ${finalRate.toFixed(0)}%. ${kept} mutations kept, ${discarded} discarded." --mode now`, { timeout: 10000 });
  } catch {}
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
