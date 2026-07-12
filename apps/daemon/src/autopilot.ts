import type { RuntimeConfig } from "./config.js";
import type { AutopilotDealRecord } from "./state.js";
import { pruneAutopilotDeals } from "./state.js";
import type { MarketMatch } from "./watcher.js";

export type DealProposal = {
  buyerAgentId: string;
  sellerAgentId: string;
  offerId: string;
  needId: string;
  negotiatedTotal: number;
  maxPriceDeltaPct: number;
  acceptanceTimeoutDays: number;
  milestones: Array<{
    idx: number;
    title: string;
    amount: number;
    acceptanceCriteria: string[];
  }>;
};

export function selectAutopilotMatches(input: {
  agentId: string;
  now: string;
  matches: MarketMatch[];
  autopilot: RuntimeConfig["autopilot"];
  autopilotDeals: AutopilotDealRecord[];
}): MarketMatch[] {
  if (!input.autopilot.enabled) return [];

  const recentDeals = pruneAutopilotDeals(input.autopilotDeals, input.now);
  if (recentDeals.length >= input.autopilot.rateLimitPerHour) return [];

  const priorFingerprints = new Set(recentDeals.map((record) => record.matchFingerprint));

  return input.matches
    .filter((match) => match.needAgentId === input.agentId)
    .filter((match) => match.offerAgentId !== input.agentId)
    .filter((match) => match.score >= input.autopilot.threshold)
    .filter((match) => match.price <= input.autopilot.maxPrice)
    .filter((match) => !priorFingerprints.has(match.fingerprint))
    .filter((match) => {
      if (!input.autopilot.allowedCategories || input.autopilot.allowedCategories.length === 0) return true;
      return !!match.category && input.autopilot.allowedCategories.includes(match.category.toLowerCase());
    })
    .slice(0, Math.max(0, input.autopilot.rateLimitPerHour - recentDeals.length));
}

export function buildDealProposal(agentId: string, match: MarketMatch): DealProposal {
  return {
    buyerAgentId: agentId,
    sellerAgentId: match.offerAgentId,
    offerId: match.offerId,
    needId: match.needId,
    negotiatedTotal: match.price,
    maxPriceDeltaPct: match.maxPriceDeltaPct,
    acceptanceTimeoutDays: 0,
    milestones: [
      {
        idx: 1,
        title: `Daemon: ${match.offerTitle}`,
        amount: match.price,
        acceptanceCriteria: match.acceptanceCriteria,
      },
    ],
  };
}

export async function proposeDeal(input: {
  apiUrl: string;
  apiKey: string;
  proposal: DealProposal;
  fetchFn?: typeof fetch;
}): Promise<{ id: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const response = await fetchFn(`${input.apiUrl}/api/deals/propose`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify(input.proposal),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) as { id: string } : { id: "" };
  if (!response.ok) {
    throw new Error(`POST /api/deals/propose failed with ${response.status}`);
  }
  return body;
}
