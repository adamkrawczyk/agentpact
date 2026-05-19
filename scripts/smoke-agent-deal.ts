#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readApiUrl(): string {
  const flagIndex = process.argv.indexOf("--api-url");
  const fromFlag = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  return (fromFlag ?? process.env.AGENTPACT_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

const API_URL = readApiUrl();
const STATE_FILE = process.env.AGENTPACT_SMOKE_STATE_FILE ?? join(process.cwd(), "scripts", ".smoke-agent-deal-state.json");

type AgentFixture = {
  agentId: string;
  apiKey: string;
  walletAddress: string;
};

type SmokeState = {
  buyer?: AgentFixture;
  seller?: AgentFixture;
};

type JsonObject = Record<string, unknown>;

function pass(step: string, details?: string) {
  console.log(`PASS ${step}${details ? ` ${details}` : ""}`);
}

function fail(step: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${step}: ${message}`);
  process.exit(1);
}

function loadState(): SmokeState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SmokeState;
  } catch {
    return {};
  }
}

function saveState(state: SmokeState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`${method} ${path} network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function registerOrReuse(existing: AgentFixture | undefined, role: "buyer" | "seller"): Promise<AgentFixture> {
  const agentId = existing?.agentId ?? randomUUID();
  const walletAddress = existing?.walletAddress ?? (role === "buyer" ? `0x${"1".repeat(40)}` : `0x${"2".repeat(40)}`);

  const register = async () => {
    const body = asObject(await api("POST", "/api/auth/register", { agentId, walletAddress }), `${role} register`);
    return requiredString(body.apiKey, `${role} apiKey`);
  };

  try {
    return { agentId, walletAddress, apiKey: await register() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!existing?.apiKey || !message.includes("409")) {
      throw err;
    }
    await api("GET", "/api/auth/verify", undefined, existing.apiKey);
    return existing;
  }
}

async function optionalRecompute(apiKey: string) {
  try {
    const body = await api("POST", "/api/matches/recompute", undefined, apiKey);
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { skipped: true, reason: message };
  }
}

async function findMatch(offerId: string, needId: string, buyerId: string, sellerId: string): Promise<JsonObject | null> {
  const queries = [
    `/api/matches/recommendations?agentId=${encodeURIComponent(buyerId)}&limit=50`,
    `/api/matches/recommendations?agentId=${encodeURIComponent(sellerId)}&limit=50`,
    "/api/matches/recommendations?limit=50",
  ];
  for (const path of queries) {
    const rows = await api("GET", path);
    if (Array.isArray(rows)) {
      const match = rows.find((row) => {
        const item = row as JsonObject;
        return item.offer_id === offerId && item.need_id === needId;
      });
      if (match) return match as JsonObject;
    }
  }
  return null;
}

async function main() {
  console.log(`AgentPact deal smoke: ${API_URL}`);
  const state = loadState();

  try {
    await api("GET", "/health");
  } catch (err) {
    fail("api reachable", err);
  }

  let buyer: AgentFixture;
  try {
    buyer = await registerOrReuse(state.buyer, "buyer");
    state.buyer = buyer;
    saveState(state);
    pass("register buyer", buyer.agentId);
  } catch (err) {
    fail("register buyer", err);
  }

  let seller: AgentFixture;
  try {
    seller = await registerOrReuse(state.seller, "seller");
    state.seller = seller;
    saveState(state);
    pass("register seller", seller.agentId);
  } catch (err) {
    fail("register seller", err);
  }

  const runId = randomUUID().slice(0, 8);
  let offerId = "";
  try {
    const offer = asObject(await api("POST", "/api/offers", {
      agentId: seller.agentId,
      title: `Lead Research Offer ${runId}`,
      descriptionMd: "Lead research service: identify qualified B2B leads and provide concise fit notes.",
      category: "lead-research",
      tags: ["lead-research", "sales", "research", "b2b", "qualified-leads"],
      basePrice: 1,
      currency: "USDC",
      maxPriceDeltaPct: 10,
      slaDays: 1,
      fulfillmentType: "generic",
      location: { remote: true },
    }, seller.apiKey), "offer");
    offerId = requiredString(offer.id, "offer.id");
    pass("seller creates offer", offerId);
  } catch (err) {
    fail("seller creates offer", err);
  }

  let needId = "";
  try {
    const need = asObject(await api("POST", "/api/needs", {
      agentId: buyer.agentId,
      title: `Need Lead Research ${runId}`,
      descriptionMd: "Need a small list of qualified B2B leads with source links and short fit notes.",
      category: "lead-research",
      tags: ["lead-research", "sales", "research", "b2b", "qualified-leads"],
      budgetMin: 1,
      budgetMax: 1,
      currency: "USDC",
      acceptanceCriteria: ["At least five leads", "Include source URLs", "Include fit notes"],
      fulfillmentType: "generic",
      location: { remote: true },
    }, buyer.apiKey), "need");
    needId = requiredString(need.id, "need.id");
    pass("buyer creates need", needId);
  } catch (err) {
    fail("buyer creates need", err);
  }

  try {
    await optionalRecompute(buyer.apiKey);
    const match = await findMatch(offerId, needId, buyer.agentId, seller.agentId);
    if (!match) throw new Error(`No match found for offer ${offerId} and need ${needId}`);
    pass("match generated", `score=${match.score ?? "unknown"}`);
  } catch (err) {
    fail("match generated", err);
  }

  let dealId = "";
  try {
    const deal = asObject(await api("POST", "/api/deals/propose", {
      buyerAgentId: buyer.agentId,
      sellerAgentId: seller.agentId,
      offerId,
      needId,
      negotiatedTotal: 1,
      maxPriceDeltaPct: 10,
      acceptanceTimeoutDays: 7,
      milestones: [{
        idx: 1,
        title: "Deliver lead research",
        amount: 1,
        acceptanceCriteria: ["At least five leads", "Include source URLs", "Include fit notes"],
      }],
    }, buyer.apiKey), "deal");
    dealId = requiredString(deal.id, "deal.id");
    pass("deal proposed", dealId);
  } catch (err) {
    fail("deal proposed", err);
  }

  let milestoneId = "";
  try {
    await api("POST", `/api/deals/${dealId}/accept`, { actorAgentId: seller.agentId }, seller.apiKey);
    const deal = asObject(await api("GET", `/api/deals/${dealId}`, undefined, buyer.apiKey), "accepted deal");
    if (deal.status !== "active") throw new Error(`Expected active deal, got ${String(deal.status)}`);
    const milestones = deal.milestones;
    if (!Array.isArray(milestones) || milestones.length === 0) throw new Error("Accepted deal has no milestones");
    milestoneId = requiredString((milestones[0] as JsonObject).id, "milestone.id");
    pass("deal accepted", dealId);
  } catch (err) {
    fail("deal accepted", err);
  }

  try {
    const payment = asObject(await api("POST", "/api/payments/create-intent", {
      provider: "usdc",
      milestoneId,
      buyerAgentId: buyer.agentId,
      walletProvider: "metamask",
      buyerWalletAddress: buyer.walletAddress,
      chain: "base",
    }, buyer.apiKey), "payment");
    pass("payment simulated/funded", String(payment.status ?? payment.mode ?? "ok"));
  } catch (err) {
    fail("payment simulated/funded", err);
  }

  try {
    await api("POST", `/api/deals/${dealId}/fulfillment`, {
      agentId: seller.agentId,
      fulfillmentData: {
        description: "Delivered lead research with five qualified leads, source URLs, and concise fit notes.",
        artifact_urls: ["https://example.com/agentpact-lead-research-smoke"],
        instructions: "Review the artifact URL and confirm delivery.",
      },
    }, seller.apiKey);
    pass("fulfillment submitted", dealId);
  } catch (err) {
    fail("fulfillment submitted", err);
  }

  try {
    const closed = asObject(await api("POST", `/api/deals/${dealId}/close`, {
      agentId: buyer.agentId,
      rating: 5,
      notes: "Smoke test close accepted.",
    }, buyer.apiKey), "closed deal");
    if (closed.status !== "completed") throw new Error(`Expected completed close response, got ${String(closed.status)}`);
    pass("buyer closes deal", dealId);
  } catch (err) {
    fail("buyer closes deal", err);
  }

  try {
    const fetched = asObject(await api("GET", `/api/deals/${dealId}`, undefined, buyer.apiKey), "final deal");
    if (fetched.status !== "completed" && fetched.status !== "closed") {
      throw new Error(`Expected completed/closed, got ${String(fetched.status)}`);
    }
    const milestones = fetched.milestones;
    if (!Array.isArray(milestones) || !milestones.every((m) => ["accepted", "completed"].includes(String((m as JsonObject).status)))) {
      throw new Error(`Unexpected milestone statuses: ${JSON.stringify(milestones)}`);
    }
    pass("receipt generated", `deal=${dealId} status=${String(fetched.status)}`);
  } catch (err) {
    fail("receipt generated", err);
  }
}

main().catch((err) => fail("unexpected smoke failure", err));
