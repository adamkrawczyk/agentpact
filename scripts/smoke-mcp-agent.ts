#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";

function readApiUrl(): string {
  const flagIndex = process.argv.indexOf("--api-url");
  const fromFlag = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  return (fromFlag ?? process.env.AGENTPACT_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

const API_URL = readApiUrl();
const DEFAULT_BUYER_WALLET = `0x${"1".repeat(40)}`;
const DEFAULT_SELLER_WALLET = `0x${"2".repeat(40)}`;

type JsonObject = Record<string, unknown>;
type ToolCall = {
  tool: string;
  args: JsonObject;
};

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
    throw new Error(`${label} result was not an object: ${JSON.stringify(value)}`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} missing from result`);
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

async function callTool(call: ToolCall): Promise<unknown> {
  switch (call.tool) {
    case "agentpact.register":
      return api("POST", "/api/auth/register", call.args);
    case "agentpact.create_offer": {
      const { apiKey, ...body } = call.args;
      return api("POST", "/api/offers", body, String(apiKey));
    }
    case "agentpact.create_need": {
      const { apiKey, ...body } = call.args;
      return api("POST", "/api/needs", body, String(apiKey));
    }
    case "agentpact.propose_deal": {
      const { apiKey, ...body } = call.args;
      return api("POST", "/api/deals/propose", body, String(apiKey));
    }
    case "agentpact.accept_deal": {
      const { apiKey, dealId, ...body } = call.args;
      return api("POST", `/api/deals/${String(dealId)}/accept`, body, String(apiKey));
    }
    case "agentpact.create_payment_intent": {
      const { apiKey, ...body } = call.args;
      return api("POST", "/api/payments/create-intent", body, String(apiKey));
    }
    case "agentpact.provide_fulfillment": {
      const { apiKey, dealId, ...body } = call.args;
      return api("POST", `/api/deals/${String(dealId)}/fulfillment`, body, String(apiKey));
    }
    case "agentpact.close_deal": {
      const { apiKey, dealId, ...body } = call.args;
      return api("POST", `/api/deals/${String(dealId)}/close`, body, String(apiKey));
    }
    default:
      throw new Error(`Unsupported smoke MCP tool ${call.tool}`);
  }
}

async function main() {
  console.log(`AgentPact MCP runtime smoke: ${API_URL}`);

  const buyerId = randomUUID();
  const sellerId = randomUUID();

  const buyer = asObject(await callTool({
    tool: "agentpact.register",
    args: { agentId: buyerId, walletAddress: DEFAULT_BUYER_WALLET },
  }), "buyer register");
  const buyerApiKey = requiredString(buyer.apiKey, "buyer apiKey");
  pass("mcp register buyer", buyerId);

  const seller = asObject(await callTool({
    tool: "agentpact.register",
    args: { agentId: sellerId, walletAddress: DEFAULT_SELLER_WALLET },
  }), "seller register");
  const sellerApiKey = requiredString(seller.apiKey, "seller apiKey");
  pass("mcp register seller", sellerId);

  const runId = randomUUID().slice(0, 8);
  const offer = asObject(await callTool({
    tool: "agentpact.create_offer",
    args: {
      apiKey: sellerApiKey,
      agentId: sellerId,
      title: `MCP Smoke Offer ${runId}`,
      descriptionMd: "MCP smoke offer for runtime parity checks.",
      category: "runtime-smoke",
      tags: ["mcp", "smoke"],
      basePrice: 1,
      currency: "USDC",
      maxPriceDeltaPct: 10,
      fulfillmentType: "generic",
    },
  }), "offer");
  const offerId = requiredString(offer.id, "offer.id");
  pass("mcp create offer", offerId);

  const need = asObject(await callTool({
    tool: "agentpact.create_need",
    args: {
      apiKey: buyerApiKey,
      agentId: buyerId,
      title: `MCP Smoke Need ${runId}`,
      descriptionMd: "MCP smoke need for runtime parity checks.",
      category: "runtime-smoke",
      tags: ["mcp", "smoke"],
      budgetMin: 1,
      budgetMax: 1,
      currency: "USDC",
      acceptanceCriteria: ["Smoke result delivered"],
      fulfillmentType: "generic",
    },
  }), "need");
  const needId = requiredString(need.id, "need.id");
  pass("mcp create need", needId);

  const deal = asObject(await callTool({
    tool: "agentpact.propose_deal",
    args: {
      apiKey: buyerApiKey,
      buyerAgentId: buyerId,
      sellerAgentId: sellerId,
      offerId,
      needId,
      negotiatedTotal: 1,
      maxPriceDeltaPct: 10,
      acceptanceTimeoutDays: 7,
      milestones: [{ idx: 1, title: "Deliver MCP smoke", amount: 1, acceptanceCriteria: ["Smoke result delivered"] }],
    },
  }), "deal");
  const dealId = requiredString(deal.id, "deal.id");
  pass("mcp propose deal", dealId);

  const accepted = asObject(await callTool({
    tool: "agentpact.accept_deal",
    args: { apiKey: sellerApiKey, dealId, actorAgentId: sellerId },
  }), "accepted deal");
  if (accepted.status !== "active") throw new Error(`Expected active deal, got ${String(accepted.status)}`);
  pass("mcp accept deal", dealId);

  const fetchedDeal = asObject(await api("GET", `/api/deals/${dealId}`, undefined, buyerApiKey), "fetched deal");
  const milestones = fetchedDeal.milestones;
  if (!Array.isArray(milestones) || milestones.length === 0) throw new Error("Accepted deal has no milestones");
  const milestoneId = requiredString((milestones[0] as JsonObject).id, "milestone.id");

  await callTool({
    tool: "agentpact.create_payment_intent",
    args: {
      apiKey: buyerApiKey,
      provider: "usdc",
      milestoneId,
      buyerAgentId: buyerId,
      walletProvider: "metamask",
      buyerWalletAddress: DEFAULT_BUYER_WALLET,
      chain: "base",
    },
  });
  pass("mcp fund deal", milestoneId);

  await callTool({
    tool: "agentpact.provide_fulfillment",
    args: {
      apiKey: sellerApiKey,
      dealId,
      agentId: sellerId,
      fulfillmentData: { description: "MCP runtime smoke fulfilled." },
    },
  });
  pass("mcp provide fulfillment", dealId);

  const closed = asObject(await callTool({
    tool: "agentpact.close_deal",
    args: { apiKey: buyerApiKey, dealId, agentId: buyerId, rating: 5, notes: "MCP smoke close." },
  }), "closed deal");
  if (closed.status !== "completed") throw new Error(`Expected completed deal, got ${String(closed.status)}`);
  pass("mcp close deal", dealId);
}

main().catch((error) => fail("mcp runtime smoke", error));
