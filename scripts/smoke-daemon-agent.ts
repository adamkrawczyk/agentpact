#!/usr/bin/env tsx
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../apps/daemon/src/config.js";
import { runSelfCheck } from "../apps/daemon/src/self-check.js";
import { createEmptyState } from "../apps/daemon/src/state.js";
import { watchMarket } from "../apps/daemon/src/watcher.js";
import { buildDealProposal, selectAutopilotMatches } from "../apps/daemon/src/autopilot.js";

function readApiUrl(): string {
  const flagIndex = process.argv.indexOf("--api-url");
  const fromFlag = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  return (fromFlag ?? process.env.AGENTPACT_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

const API_URL = readApiUrl();
const SELLER_WALLET = `0x${"3".repeat(40)}`;
const BUYER_WALLET = `0x${"4".repeat(40)}`;

type JsonObject = Record<string, unknown>;

function pass(step: string, details?: string) {
  console.log(`PASS ${step}${details ? ` ${details}` : ""}`);
}

function fail(step: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${step}: ${message}`);
  process.exit(1);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response was not an object: ${JSON.stringify(value)}`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} missing from response`);
  }
  return value;
}

async function api(method: string, path: string, body?: unknown, apiKey?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  console.log(`AgentPact daemon runtime smoke: ${API_URL}`);

  const tempHome = mkdtempSync(join(tmpdir(), "agentpact-daemon-smoke-"));
  try {
    const buyerId = randomUUID();
    const sellerId = randomUUID();

    const buyer = asObject(await api("POST", "/api/auth/register", { agentId: buyerId, walletAddress: BUYER_WALLET }), "buyer register");
    const buyerApiKey = requiredString(buyer.apiKey, "buyer apiKey");
    await api("POST", `/api/agents/${buyerId}/heartbeat`, {}, buyerApiKey);
    pass("daemon smoke buyer registered", buyerId);

    const seller = asObject(await api("POST", "/api/auth/register", { agentId: sellerId, walletAddress: SELLER_WALLET }), "seller register");
    const sellerApiKey = requiredString(seller.apiKey, "seller apiKey");
    pass("daemon smoke seller registered", sellerId);

    const runId = randomUUID().slice(0, 8);
    const offer = asObject(await api("POST", "/api/offers", {
      agentId: sellerId,
      title: `Daemon Smoke Offer ${runId}`,
      descriptionMd: "Daemon smoke offer for dry-run autopilot.",
      category: "daemon-smoke",
      tags: ["daemon", "smoke", "runtime", "autopilot", "verification"],
      basePrice: 1,
      currency: "USDC",
      maxPriceDeltaPct: 10,
      fulfillmentType: "generic",
    }, sellerApiKey), "offer");
    const offerId = requiredString(offer.id, "offer.id");

    const need = asObject(await api("POST", "/api/needs", {
      agentId: buyerId,
      title: `Daemon Smoke Need ${runId}`,
      descriptionMd: "Daemon smoke need for dry-run autopilot.",
      category: "daemon-smoke",
      tags: ["daemon", "smoke", "runtime", "autopilot", "verification"],
      budgetMin: 1,
      budgetMax: 1,
      currency: "USDC",
      acceptanceCriteria: ["Daemon smoke result delivered"],
      fulfillmentType: "generic",
    }, buyerApiKey), "need");
    const needId = requiredString(need.id, "need.id");
    pass("daemon smoke fixtures created", `${offerId}/${needId}`);

    try {
      await api("POST", "/api/matches/recompute", undefined, buyerApiKey);
    } catch {
      // Some deployments restrict recompute; recommendations still exercise the daemon path below.
    }

    const config = loadConfig({
      env: {
        AGENTPACT_API_URL: API_URL,
        AGENTPACT_API_KEY: buyerApiKey,
        AGENTPACT_AGENT_ID: buyerId,
        AGENTPACT_AUTOPILOT: "true",
        AGENTPACT_AUTOPILOT_THRESHOLD: "0",
        AGENTPACT_AUTOPILOT_MAX_PRICE: "5",
        AGENTPACT_AUTOPILOT_ALLOWED_CATEGORIES: "daemon-smoke",
        AGENTPACT_STATE_FILE: join(tempHome, "daemon-state.json"),
      },
      argv: ["--dry-run"],
      homeDir: tempHome,
    });

    const selfCheckResults = await runSelfCheck({ config, log: () => undefined });
    const failures = selfCheckResults.filter((result) => !result.ok);
    if (failures.length > 0) {
      throw new Error(`self-check failed: ${failures.map((result) => `${result.name}=${result.detail}`).join(", ")}`);
    }
    pass("daemon self-check", `${selfCheckResults.length} checks`);

    const watchResult = await watchMarket({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      state: createEmptyState(),
      nowIso: new Date().toISOString(),
    });
    const target = watchResult.matches.find((match) => match.offerId === offerId && match.needId === needId);
    if (!target) throw new Error(`expected recommendation for ${offerId}/${needId}`);
    pass("daemon recommendations", `${watchResult.matches.length} matches`);

    const autopilotMatches = selectAutopilotMatches({
      agentId: config.agentId,
      now: new Date().toISOString(),
      matches: [target],
      autopilot: config.autopilot,
      autopilotDeals: [],
    });
    if (autopilotMatches.length !== 1) throw new Error("expected dry-run autopilot to select the smoke match");
    const proposal = buildDealProposal(config.agentId, autopilotMatches[0]);
    if (proposal.buyerAgentId !== buyerId || proposal.sellerAgentId !== sellerId || proposal.offerId !== offerId || proposal.needId !== needId) {
      throw new Error(`unexpected autopilot proposal ${JSON.stringify(proposal)}`);
    }
    pass("daemon dry-run autopilot", `would propose ${proposal.negotiatedTotal} USDC`);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => fail("daemon runtime smoke", error));
