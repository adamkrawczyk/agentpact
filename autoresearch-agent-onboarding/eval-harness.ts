/**
 * Autoresearch Eval Harness for AgentPact Agent Onboarding
 * 
 * Tests whether a WiseChef-style bot correctly checks AgentPact
 * before building from scratch. The "skill" being optimized is
 * the onboarding prompt/instructions we give to agents.
 * 
 * Usage: npx tsx eval-harness.ts [--runs 5]
 */

import OpenAI from "openai";
import { randomUUID } from "crypto";

const API_BASE = "https://api.agentpact.xyz";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const MODEL = process.env.EVAL_MODEL ?? "gpt-4o-mini";
const RUNS = parseInt(process.env.RUNS ?? "5");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Scenarios: Tasks a WiseChef bot might receive ────────────────────

interface Scenario {
  name: string;
  task: string;
  evals: { name: string; check: (actions: string[], response: string) => boolean }[];
}

const scenarios: Scenario[] = [
  {
    name: "Bot needs code review",
    task: "I need a code review for my Node.js project. Can you handle it?",
    evals: [
      {
        name: "Checked AgentPact first",
        check: (actions) => actions.some(a => a.includes("search_offers") || a.includes("agentpact")),
      },
      {
        name: "Mentioned available services",
        check: (_, response) => response.toLowerCase().includes("found") || response.toLowerCase().includes("available") || response.toLowerCase().includes("offer"),
      },
      {
        name: "Did NOT immediately say 'I can do it myself'",
        check: (_, response) => !response.toLowerCase().startsWith("i can") && !response.toLowerCase().startsWith("sure, i'll"),
      },
      {
        name: "Proposed using marketplace before DIY",
        check: (actions, response) => {
          const searchIdx = actions.findIndex(a => a.includes("agentpact"));
          return searchIdx >= 0 && searchIdx < 2; // Checked within first 2 actions
        },
      },
    ],
  },
  {
    name: "Bot needs deployment help",
    task: "Deploy this service to production. Here's the repo: https://github.com/example/myapp",
    evals: [
      {
        name: "Checked AgentPact for deployment services",
        check: (actions) => actions.some(a => a.includes("search") && (a.includes("deploy") || a.includes("agentpact"))),
      },
      {
        name: "Found relevant offers",
        check: (_, response) => response.toLowerCase().includes("deployment") || response.toLowerCase().includes("service"),
      },
      {
        name: "Gave user a choice (marketplace vs DIY)",
        check: (_, response) => {
          const lower = response.toLowerCase();
          return (lower.includes("found") || lower.includes("available")) && (lower.includes("alternatively") || lower.includes("or") || lower.includes("option"));
        },
      },
    ],
  },
  {
    name: "Bot needs data analysis",
    task: "Analyze this CSV dataset and produce a summary report with charts.",
    evals: [
      {
        name: "Searched marketplace first",
        check: (actions) => actions.some(a => a.includes("agentpact") || a.includes("search")),
      },
      {
        name: "Relevant category searched",
        check: (actions) => actions.some(a => a.includes("data") || a.includes("analysis") || a.includes("analytics")),
      },
      {
        name: "Response mentions marketplace results",
        check: (_, response) => response.toLowerCase().includes("agentpact") || response.toLowerCase().includes("marketplace"),
      },
    ],
  },
];

// ── Simple tool simulation ───────────────────────────────────────────

async function simulateToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "agentpact_search_offers" || name === "search_agentpact" || name.includes("search")) {
    // Actually hit the API
    try {
      const query = (args.query || args.category || args.search || "") as string;
      const resp = await fetch(`${API_BASE}/api/offers?category=${encodeURIComponent(query)}&limit=5`);
      const data = await resp.json();
      return JSON.stringify(data);
    } catch {
      return JSON.stringify({ offers: [], message: "No results" });
    }
  }
  return JSON.stringify({ result: "Tool executed" });
}

// ── Run a scenario ───────────────────────────────────────────────────

async function runScenario(scenario: Scenario, onboardingPrompt: string): Promise<{ passed: boolean[]; response: string; actions: string[] }> {
  const actions: string[] = [];
  
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "search_agentpact",
        description: "Search the AgentPact marketplace for available services from other AI agents",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            category: { type: "string", description: "Category filter" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "execute_task",
        description: "Execute a task yourself directly without outsourcing",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string" },
          },
        },
      },
    },
  ];
  
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: onboardingPrompt },
    { role: "user", content: scenario.task },
  ];
  
  let finalResponse = "";
  
  for (let turn = 0; turn < 6; turn++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });
    
    const msg = response.choices[0].message;
    messages.push(msg);
    
    if (msg.content) finalResponse += msg.content + " ";
    
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;
    
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      actions.push(`${tc.function.name}(${JSON.stringify(args)})`);
      const result = await simulateToolCall(tc.function.name, args);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  
  const passed = scenario.evals.map(e => e.check(actions, finalResponse));
  return { passed, response: finalResponse, actions };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // The prompt we're optimizing — this is the "skill" for autoresearch
  const fs = await import("fs");
  const onboardingFile = process.env.ONBOARDING_FILE ?? "onboarding-prompt.md";
  const onboardingPrompt = fs.readFileSync(onboardingFile, "utf-8");
  
  console.log(`AgentPact Agent Onboarding Autoresearch Eval`);
  console.log(`Model: ${MODEL} | Runs per scenario: ${RUNS}`);
  console.log(`Scenarios: ${scenarios.length}`);
  console.log("─".repeat(60));
  
  let totalPass = 0;
  let totalEvals = 0;
  
  for (const scenario of scenarios) {
    console.log(`\n▶ ${scenario.name}`);
    
    for (let run = 0; run < RUNS; run++) {
      try {
        const { passed, actions } = await runScenario(scenario, onboardingPrompt);
        const passCount = passed.filter(Boolean).length;
        totalPass += passCount;
        totalEvals += passed.length;
        
        const status = passed.every(Boolean) ? "✅" : "❌";
        console.log(`  Run ${run + 1}: ${status} ${passCount}/${passed.length} | ${actions.length} actions`);
        
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
  
  const results = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    runs: RUNS,
    totalPass,
    totalEvals,
    passRate: ((totalPass / totalEvals) * 100).toFixed(1),
  };
  fs.writeFileSync("results.json", JSON.stringify(results, null, 2));
}

main().catch(console.error);
