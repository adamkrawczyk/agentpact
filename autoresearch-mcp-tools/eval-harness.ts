/**
 * Autoresearch Eval Harness for AgentPact MCP Tools
 * 
 * Tests whether an LLM agent can complete marketplace tasks
 * using only the MCP tool descriptions. Scores binary pass/fail.
 * 
 * Usage: npx tsx eval-harness.ts [--runs 5] [--tools-file ../apps/mcp/src/index.ts]
 */

import OpenAI from "openai";
import { randomUUID } from "crypto";

const API_BASE = "https://api.agentpact_xyz";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const MODEL = process.env.EVAL_MODEL ?? "gpt-4o-mini";
const RUNS = parseInt(process.env.RUNS ?? "5");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Test Scenarios ───────────────────────────────────────────────────

interface Scenario {
  name: string;
  prompt: string;
  evals: EvalCheck[];
}

interface EvalCheck {
  name: string;
  check: (trace: ToolCall[]) => boolean;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

const scenarios: Scenario[] = [
  {
    name: "Find and hire a code review service",
    prompt: `You are an AI agent that needs a code review service. Use the AgentPact marketplace to find one and hire it. Your agent ID is {AGENT_ID} and your API key is {API_KEY}. Search for available code review offers, pick the best one, and propose a deal.`,
    evals: [
      {
        name: "Called search_offers",
        check: (trace) => trace.some(t => t.tool === "agentpact_search_offers"),
      },
      {
        name: "Proposed a deal",
        check: (trace) => trace.some(t => t.tool === "agentpact_propose_deal" && !t.error),
      },
      {
        name: "No errors in flow",
        check: (trace) => trace.filter(t => t.error).length === 0,
      },
      {
        name: "Completed in under 8 tool calls",
        check: (trace) => trace.length <= 8,
      },
      {
        name: "Correct tool order (search before deal)",
        check: (trace) => {
          const searchIdx = trace.findIndex(t => t.tool === "agentpact_search_offers");
          const dealIdx = trace.findIndex(t => t.tool === "agentpact_propose_deal");
          return searchIdx >= 0 && dealIdx > searchIdx;
        },
      },
    ],
  },
  {
    name: "Register and list a service",
    prompt: `You are a new AI agent joining the AgentPact marketplace. Your agent ID is {AGENT_ID}. Register on the platform, create your agent profile, and list a "Data Analysis" service for $0.50. Make the offer description clear and professional.`,
    evals: [
      {
        name: "Called register",
        check: (trace) => trace.some(t => t.tool === "agentpact_register" && !t.error),
      },
      {
        name: "Created agent profile",
        check: (trace) => trace.some(t => t.tool === "agentpact_create_agent" && !t.error),
      },
      {
        name: "Created an offer",
        check: (trace) => trace.some(t => t.tool === "agentpact_create_offer" && !t.error),
      },
      {
        name: "Correct sequence (register → profile → offer)",
        check: (trace) => {
          const reg = trace.findIndex(t => t.tool === "agentpact_register");
          const prof = trace.findIndex(t => t.tool === "agentpact_create_agent");
          const offer = trace.findIndex(t => t.tool === "agentpact_create_offer");
          return reg >= 0 && prof > reg && offer > prof;
        },
      },
      {
        name: "No errors in flow",
        check: (trace) => trace.filter(t => t.error).length === 0,
      },
    ],
  },
  {
    name: "Post a need and check matches",
    prompt: `You are an AI agent looking for help with web scraping. Your agent ID is {AGENT_ID} and your API key is {API_KEY}. Post a need describing what you're looking for, then check if there are any matching offers available.`,
    evals: [
      {
        name: "Created a need",
        check: (trace) => trace.some(t => t.tool === "agentpact_create_need" && !t.error),
      },
      {
        name: "Checked matches or searched offers",
        check: (trace) => trace.some(t =>
          (t.tool === "agentpact_get_match_recommendations" || t.tool === "agentpact_search_offers") && !t.error
        ),
      },
      {
        name: "No errors in flow",
        check: (trace) => trace.filter(t => t.error).length === 0,
      },
      {
        name: "Need description is specific (>20 chars)",
        check: (trace) => {
          const need = trace.find(t => t.tool === "agentpact_create_need");
          const desc = (need?.args as any)?.descriptionMd ?? (need?.args as any)?.description ?? "";
          return desc.length > 20;
        },
      },
      {
        name: "Completed in under 6 tool calls",
        check: (trace) => trace.length <= 6,
      },
    ],
  },
  {
    name: "Check reputation before dealing",
    prompt: `You are an AI agent considering buying a service from agent ID "b8169514-d2f6-48f6-a796-bbb2a345ce42". Your agent ID is {AGENT_ID} and API key is {API_KEY}. Check their reputation and profile before deciding. Search for their offers. Report your findings.`,
    evals: [
      {
        name: "Retrieved agent profile",
        check: (trace) => trace.some(t => t.tool === "agentpact_get_agent" && !t.error),
      },
      {
        name: "Searched or viewed offers",
        check: (trace) => trace.some(t =>
          (t.tool === "agentpact_search_offers" || t.tool === "agentpact_get_agent") && !t.error
        ),
      },
      {
        name: "No errors",
        check: (trace) => trace.filter(t => t.error).length === 0,
      },
      {
        name: "Completed in under 5 tool calls",
        check: (trace) => trace.length <= 5,
      },
      {
        name: "Did NOT blindly propose a deal",
        check: (trace) => !trace.some(t => t.tool === "agentpact_propose_deal"),
      },
    ],
  },
  {
    name: "End-to-end: find service, deal, deliver",
    prompt: `You have two agents. Agent A (buyer, ID={AGENT_ID}, key={API_KEY}) needs a deployment service. Agent B (seller, ID={AGENT_ID_B}, key={API_KEY_B}) provides it. As Agent B, create an offer for "Node.js Deployment" at $0.30. Then as Agent A, find it, propose a deal, and accept. Use the correct API keys for each agent.`,
    evals: [
      {
        name: "Created offer as seller",
        check: (trace) => trace.some(t => t.tool === "agentpact_create_offer" && !t.error),
      },
      {
        name: "Proposed deal as buyer",
        check: (trace) => trace.some(t => t.tool === "agentpact_propose_deal" && !t.error),
      },
      {
        name: "Accepted deal",
        check: (trace) => trace.some(t => t.tool === "agentpact_accept_deal" && !t.error),
      },
      {
        name: "Used different API keys for buyer/seller",
        check: (trace) => {
          const keys = new Set(trace.map(t => (t.args as any)?.apiKey).filter(Boolean));
          return keys.size >= 2;
        },
      },
      {
        name: "No errors in flow",
        check: (trace) => trace.filter(t => t.error).length === 0,
      },
    ],
  },
];

// ── MCP Tool Execution (hits real API) ───────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; error?: string }> {
  const apiKey = (args.apiKey as string) || "";
  
  const toolRoutes: Record<string, { method: string; path: string; bodyTransform?: (a: any) => any }> = {
    "agentpact_register": { method: "POST", path: "/api/auth/register", bodyTransform: (a) => ({ agentId: a.agentId, walletAddress: a.walletAddress }) },
    "agentpact_create_agent": { method: "POST", path: "/api/agents", bodyTransform: (a) => ({ handle: a.handle, displayName: a.displayName, ownerWalletAddress: a.ownerWalletAddress, walletProvider: a.walletProvider }) },
    "agentpact_get_agent": { method: "GET", path: `/api/agents/${args.id}` },
    "agentpact_create_offer": { method: "POST", path: "/api/offers" },
    "agentpact_search_offers": { method: "GET", path: `/api/offers?${new URLSearchParams(Object.entries(args).filter(([k]) => k !== 'apiKey').map(([k,v]) => [k, String(v)])).toString()}` },
    "agentpact_create_need": { method: "POST", path: "/api/needs" },
    "agentpact_search_needs": { method: "GET", path: `/api/needs?${new URLSearchParams(Object.entries(args).filter(([k]) => k !== 'apiKey').map(([k,v]) => [k, String(v)])).toString()}` },
    "agentpact_propose_deal": { method: "POST", path: "/api/deals" },
    "agentpact_accept_deal": { method: "PATCH", path: `/api/deals/${args.dealId}/accept` },
    "agentpact_cancel_deal": { method: "PATCH", path: `/api/deals/${args.dealId}/cancel` },
    "agentpact_get_match_recommendations": { method: "GET", path: `/api/matches?agentId=${args.agentId}` },
  };
  
  const route = toolRoutes[name];
  if (!route) return { result: null, error: `Unknown tool: ${name}` };
  
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    
    const body = route.method !== "GET" ? (route.bodyTransform ? route.bodyTransform(args) : args) : undefined;
    const resp = await fetch(`${API_BASE}${route.path}`, {
      method: route.method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { result: data, error: `${resp.status}: ${JSON.stringify(data)}` };
    return { result: data };
  } catch (err: any) {
    return { result: null, error: err.message };
  }
}

// ── Run a single scenario ────────────────────────────────────────────

async function runScenario(scenario: Scenario, toolDescriptions: string): Promise<{ passed: boolean[]; trace: ToolCall[] }> {
  const agentIdA = randomUUID();
  const agentIdB = randomUUID();
  
  // Pre-register agents to get API keys
  const regA = await executeTool("agentpact_register", { agentId: agentIdA });
  const apiKeyA = (regA.result as any)?.apiKey ?? "";
  const regB = await executeTool("agentpact_register", { agentId: agentIdB });
  const apiKeyB = (regB.result as any)?.apiKey ?? "";
  
  const prompt = scenario.prompt
    .replace("{AGENT_ID}", agentIdA)
    .replace("{API_KEY}", apiKeyA)
    .replace("{AGENT_ID_B}", agentIdB)
    .replace("{API_KEY_B}", apiKeyB);
  
  const trace: ToolCall[] = [];
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: `You are an AI agent interacting with the AgentPact marketplace via MCP tools.\n\nAvailable tools and their descriptions:\n${toolDescriptions}\n\nCall tools by responding with function_call. Always include apiKey in authenticated calls.` },
    { role: "user", content: prompt },
  ];
  
  // Run the agent loop (max 12 turns)
  for (let turn = 0; turn < 12; turn++) {
    const tools: OpenAI.Chat.ChatCompletionTool[] = [
      "agentpact_register", "agentpact_create_agent", "agentpact_get_agent",
      "agentpact_create_offer", "agentpact_search_offers", "agentpact_create_need",
      "agentpact_search_needs", "agentpact_propose_deal", "agentpact_accept_deal",
      "agentpact_cancel_deal", "agentpact_get_match_recommendations",
    ].map(name => ({
      type: "function" as const,
      function: {
        name,
        parameters: { type: "object" as const, properties: {}, additionalProperties: true },
      },
    }));
    
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });
    
    const msg = response.choices[0].message;
    messages.push(msg);
    
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;
    
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const { result, error } = await executeTool(tc.function.name, args);
      trace.push({ tool: tc.function.name, args, result, error });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(error ? { error } : result),
      });
    }
  }
  
  const passed = scenario.evals.map(e => e.check(trace));
  return { passed, trace };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`AgentPact MCP Tools Autoresearch Eval`);
  console.log(`Model: ${MODEL} | Runs per scenario: ${RUNS}`);
  console.log(`Scenarios: ${scenarios.length} | Evals: ${scenarios.reduce((s, sc) => s + sc.evals.length, 0)}`);
  console.log("─".repeat(60));
  
  // Read tool descriptions from MCP source (the thing we're optimizing)
  const toolsFile = process.env.TOOLS_FILE ?? "../apps/mcp/src/index.ts";
  const fs = await import("fs");
  const toolsSource = fs.readFileSync(toolsFile, "utf-8");
  
  // Extract tool descriptions
  const toolDescriptions = toolsSource
    .split(/\{\s*name:\s*"agentpact\./)
    .slice(1)
    .map(block => {
      const nameMatch = block.match(/^([^"]+)"/);
      const descMatch = block.match(/description:\s*"([^"]+)"/);
      return nameMatch && descMatch ? `- agentpact_${nameMatch[1]}: ${descMatch[1]}` : null;
    })
    .filter(Boolean)
    .join("\n");
  
  let totalPass = 0;
  let totalEvals = 0;
  
  for (const scenario of scenarios) {
    console.log(`\n▶ ${scenario.name}`);
    
    for (let run = 0; run < RUNS; run++) {
      try {
        const { passed, trace } = await runScenario(scenario, toolDescriptions);
        const passCount = passed.filter(Boolean).length;
        totalPass += passCount;
        totalEvals += passed.length;
        
        const status = passed.every(Boolean) ? "✅" : "❌";
        console.log(`  Run ${run + 1}: ${status} ${passCount}/${passed.length} | ${trace.length} tool calls`);
        
        if (!passed.every(Boolean)) {
          scenario.evals.forEach((e, i) => {
            if (!passed[i]) console.log(`    ✗ ${e.name}`);
          });
        }
      } catch (err: any) {
        console.log(`  Run ${run + 1}: 💥 ERROR: ${err.message}`);
        totalEvals += scenario.evals.length;
      }
    }
  }
  
  console.log("\n" + "─".repeat(60));
  console.log(`TOTAL: ${totalPass}/${totalEvals} (${((totalPass / totalEvals) * 100).toFixed(1)}%)`);
  
  // Write results
  const results = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    runs: RUNS,
    totalPass,
    totalEvals,
    passRate: ((totalPass / totalEvals) * 100).toFixed(1),
  };
  fs.writeFileSync("results.json", JSON.stringify(results, null, 2));
  console.log("Results written to results.json");
}

main().catch(console.error);
