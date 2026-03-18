#!/usr/bin/env npx tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const API_URL = process.env.AGENTPACT_API_URL ?? "https://api.agentpact.xyz";
const AGENT_ID = process.env.AGENTPACT_AGENT_ID;
const API_KEY = process.env.AGENTPACT_API_KEY;
const HEARTBEAT_INTERVAL_MS = Number(process.env.DAEMON_HEARTBEAT_INTERVAL_MS ?? "60000");
const WATCH_INTERVAL_MS = Number(process.env.DAEMON_WATCH_INTERVAL_MS ?? "300000");
const MAX_PRICE = Number(process.env.DAEMON_MAX_PRICE ?? "10");
const MIN_SCORE = Number(process.env.DAEMON_MIN_SCORE ?? "0.7");
const AUTOPILOT_ENABLED = parseBoolean(process.env.DAEMON_AUTOPILOT);
const WEBHOOK_URL = process.env.DAEMON_WEBHOOK_URL;
const DRY_RUN = process.argv.includes("--dry-run");

const STATE_FILE = join(import.meta.dirname ?? ".", ".daemon-state.json");
const MAX_SEEN_MATCHES = 5000;

type DaemonState = {
  lastCheckAt: string | null;
  seenMatches: string[];
};

type Recommendation = {
  offer_id: string;
  need_id: string;
  score: number;
  offer_title?: string;
  need_title?: string;
};

type OfferRecord = {
  id: string;
  agent_id: string;
  title?: string;
  category?: string;
  base_price?: number;
  max_price_delta_pct?: number;
  status?: string;
};

type NeedRecord = {
  id: string;
  agent_id: string;
  title?: string;
  acceptance_criteria?: unknown;
  status?: string;
};

type HydratedMatch = {
  recommendation: Recommendation;
  offer: OfferRecord;
  need: NeedRecord;
};

type MatchPolicy = {
  maxPrice: number;
  categories: string[] | null;
  minScore: number;
};

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseCategories(value: string | undefined): string[] | null {
  if (!value || !value.trim()) return null;
  const categories = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return categories.length > 0 ? categories : null;
}

const CATEGORY_FILTER = parseCategories(process.env.DAEMON_CATEGORIES);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function buildSeenMatchKey(offerId: string, needId: string): string {
  return `${offerId}:${needId}`;
}

function loadState(): DaemonState {
  if (existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<DaemonState>;
      return {
        lastCheckAt: typeof parsed.lastCheckAt === "string" ? parsed.lastCheckAt : null,
        seenMatches: Array.isArray(parsed.seenMatches)
          ? parsed.seenMatches.filter((item): item is string => typeof item === "string")
          : [],
      };
    } catch {
      return { lastCheckAt: null, seenMatches: [] };
    }
  }

  return { lastCheckAt: null, seenMatches: [] };
}

function saveState(state: DaemonState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function mergeSeenMatches(
  state: DaemonState,
  matches: Array<{ offerId: string; needId: string }>,
  lastCheckAt: string
): DaemonState {
  const seen = new Set(state.seenMatches);
  for (const match of matches) {
    seen.add(buildSeenMatchKey(match.offerId, match.needId));
  }

  return {
    lastCheckAt,
    seenMatches: Array.from(seen).slice(-MAX_SEEN_MATCHES),
  };
}

export function shouldNotifyForMatch(match: { score: number; offer: { basePrice?: number; category?: string } }, policy: MatchPolicy): boolean {
  const basePrice = Number(match.offer.basePrice ?? 0);
  const category = String(match.offer.category ?? "").toLowerCase();

  if (Number.isNaN(basePrice) || basePrice > policy.maxPrice) return false;
  if (match.score < policy.minScore) return false;
  if (policy.categories && !policy.categories.includes(category)) return false;
  return true;
}

async function api(method: string, path: string, body?: unknown, apiKey?: string): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

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
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function postWebhook(match: HydratedMatch, action: "notify" | "auto-propose", detail?: Record<string, unknown>) {
  if (!WEBHOOK_URL) return;

  const payload = {
    event: `daemon.match.${action}`,
    agentId: AGENT_ID,
    score: match.recommendation.score,
    offerId: match.offer.id,
    needId: match.need.id,
    offerTitle: match.offer.title ?? match.recommendation.offer_title ?? null,
    needTitle: match.need.title ?? match.recommendation.need_title ?? null,
    sellerAgentId: match.offer.agent_id,
    buyerAgentId: match.need.agent_id,
    basePrice: Number(match.offer.base_price ?? 0),
    category: match.offer.category ?? null,
    detail: detail ?? null,
    detectedAt: new Date().toISOString(),
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook POST -> ${res.status}: ${text}`);
  }
}

async function hydrateMatch(recommendation: Recommendation): Promise<HydratedMatch> {
  const [offer, need] = await Promise.all([
    api("GET", `/api/offers/${recommendation.offer_id}`, undefined, API_KEY) as Promise<OfferRecord>,
    api("GET", `/api/needs/${recommendation.need_id}`, undefined, API_KEY) as Promise<NeedRecord>,
  ]);

  return {
    recommendation,
    offer,
    need,
  };
}

function buildMilestoneCriteria(need: NeedRecord): string[] {
  if (Array.isArray(need.acceptance_criteria)) {
    const criteria = need.acceptance_criteria.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (criteria.length > 0) return criteria;
  }

  return [`Deliver work matching need ${need.id}`];
}

async function sendHeartbeat() {
  const agentId = requireEnv("AGENTPACT_AGENT_ID", AGENT_ID);
  const apiKey = requireEnv("AGENTPACT_API_KEY", API_KEY);
  const result = await api("POST", `/api/agents/${agentId}/heartbeat`, undefined, apiKey) as Record<string, unknown>;
  console.log(`[heartbeat] ok last_seen_at=${String(result.last_seen_at ?? "unknown")}`);
}

async function autoPropose(match: HydratedMatch) {
  const buyerAgentId = requireEnv("AGENTPACT_AGENT_ID", AGENT_ID);
  const apiKey = requireEnv("AGENTPACT_API_KEY", API_KEY);
  const negotiatedTotal = Number(match.offer.base_price ?? 0);

  if (match.need.agent_id !== buyerAgentId) {
    console.log(`[autopilot] skip ${match.offer.id}/${match.need.id} need does not belong to configured buyer`);
    return;
  }

  if (match.offer.agent_id === buyerAgentId) {
    console.log(`[autopilot] skip ${match.offer.id}/${match.need.id} offer belongs to configured agent`);
    return;
  }

  const deal = await api("POST", "/api/deals/propose", {
    buyerAgentId,
    sellerAgentId: match.offer.agent_id,
    offerId: match.offer.id,
    needId: match.need.id,
    negotiatedTotal,
    maxPriceDeltaPct: Number(match.offer.max_price_delta_pct ?? 15),
    acceptanceTimeoutDays: 0,
    milestones: [
      {
        idx: 1,
        title: `Daemon: ${match.offer.title ?? "Deliver service"}`,
        amount: negotiatedTotal,
        acceptanceCriteria: buildMilestoneCriteria(match.need),
      },
    ],
  }, apiKey) as Record<string, unknown>;

  console.log(`[autopilot] proposed deal ${String(deal.id)} for ${match.offer.id}/${match.need.id}`);

  try {
    await postWebhook(match, "auto-propose", {
      dealId: String(deal.id),
      dryRun: DRY_RUN,
    });
  } catch (error) {
    console.error("[webhook] auto-propose failed:", error instanceof Error ? error.message : error);
  }
}

async function pollRecommendations(state: DaemonState): Promise<DaemonState> {
  const agentId = requireEnv("AGENTPACT_AGENT_ID", AGENT_ID);
  const apiKey = requireEnv("AGENTPACT_API_KEY", API_KEY);
  const policy: MatchPolicy = {
    maxPrice: MAX_PRICE,
    categories: CATEGORY_FILTER,
    minScore: MIN_SCORE,
  };

  const rows = await api(
    "GET",
    `/api/matches/recommendations?agentId=${encodeURIComponent(agentId)}&limit=50`,
    undefined,
    apiKey
  ) as Recommendation[];

  const seen = new Set(state.seenMatches);
  const unseen = rows.filter((row) => !seen.has(buildSeenMatchKey(row.offer_id, row.need_id)));

  console.log(`[watch] fetched=${rows.length} unseen=${unseen.length} last_check=${state.lastCheckAt ?? "never"}`);

  for (const recommendation of unseen) {
    try {
      const match = await hydrateMatch(recommendation);

      if (match.offer.status && match.offer.status !== "active") {
        console.log(`[watch] skip ${match.offer.id}/${match.need.id} offer status=${match.offer.status}`);
        continue;
      }

      if (match.need.status && match.need.status !== "open") {
        console.log(`[watch] skip ${match.offer.id}/${match.need.id} need status=${match.need.status}`);
        continue;
      }

      const candidate = {
        score: Number(recommendation.score ?? 0),
        offer: {
          basePrice: Number(match.offer.base_price ?? 0),
          category: match.offer.category,
        },
      };

      if (!shouldNotifyForMatch(candidate, policy)) {
        console.log(
          `[watch] filtered ${match.offer.id}/${match.need.id} score=${candidate.score.toFixed(3)} price=${candidate.offer.basePrice} category=${String(match.offer.category ?? "unknown")}`
        );
        continue;
      }

      console.log(
        `[match] score=${candidate.score.toFixed(3)} price=${candidate.offer.basePrice} category=${String(match.offer.category ?? "unknown")} offer="${String(match.offer.title ?? recommendation.offer_title ?? match.offer.id)}"`
      );

      if (WEBHOOK_URL) {
        try {
          await postWebhook(match, "notify", { dryRun: DRY_RUN });
        } catch (error) {
          console.error("[webhook] notify failed:", error instanceof Error ? error.message : error);
        }
      }

      if (AUTOPILOT_ENABLED && !DRY_RUN && candidate.score > policy.minScore) {
        try {
          await autoPropose(match);
        } catch (error) {
          console.error("[autopilot] failed:", error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error("[watch] failed to process match:", error instanceof Error ? error.message : error);
    }
  }

  const nextState = mergeSeenMatches(
    state,
    rows.map((row) => ({ offerId: row.offer_id, needId: row.need_id })),
    new Date().toISOString()
  );
  saveState(nextState);
  return nextState;
}

function printBanner(state: DaemonState) {
  const categoriesLabel = CATEGORY_FILTER?.join(", ") ?? "all";
  console.log("\nAgentPact Daemon");
  console.log(`  API: ${API_URL}`);
  console.log(`  Agent: ${AGENT_ID ?? "missing"}`);
  console.log(`  Heartbeat: ${HEARTBEAT_INTERVAL_MS}ms`);
  console.log(`  Watch: ${WATCH_INTERVAL_MS}ms`);
  console.log(`  Max price: ${MAX_PRICE}`);
  console.log(`  Categories: ${categoriesLabel}`);
  console.log(`  Min score: ${MIN_SCORE}`);
  console.log(`  Autopilot: ${AUTOPILOT_ENABLED ? "enabled" : "disabled"}`);
  console.log(`  Dry run: ${DRY_RUN ? "enabled" : "disabled"}`);
  console.log(`  Webhook: ${WEBHOOK_URL ?? "off"}`);
  console.log(`  State file: ${STATE_FILE}`);
  console.log(`  Last check: ${state.lastCheckAt ?? "never"} | Seen matches: ${state.seenMatches.length}\n`);
}

async function main() {
  requireEnv("AGENTPACT_AGENT_ID", AGENT_ID);
  requireEnv("AGENTPACT_API_KEY", API_KEY);

  let state = loadState();
  printBanner(state);
  saveState(state);

  let shuttingDown = false;
  let heartbeatInFlight = false;
  let watchInFlight = false;

  const runHeartbeat = async () => {
    if (shuttingDown || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await sendHeartbeat();
    } catch (error) {
      console.error("[heartbeat] failed:", error instanceof Error ? error.message : error);
    } finally {
      heartbeatInFlight = false;
    }
  };

  const runWatch = async () => {
    if (shuttingDown || watchInFlight) return;
    watchInFlight = true;
    try {
      state = await pollRecommendations(state);
    } catch (error) {
      console.error("[watch] failed:", error instanceof Error ? error.message : error);
    } finally {
      watchInFlight = false;
    }
  };

  await runHeartbeat();
  await runWatch();

  const heartbeatTimer = setInterval(() => {
    void runHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);

  const watchTimer = setInterval(() => {
    void runWatch();
  }, WATCH_INTERVAL_MS);

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    clearInterval(watchTimer);
    console.log(`\n[shutdown] received ${signal}, exiting cleanly`);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  main().catch((error) => {
    console.error("Fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
