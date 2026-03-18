import type { DaemonState } from "./state.js";

export type RecommendationRecord = {
  offer_id: string;
  need_id: string;
  score: number;
  offer_title?: string | null;
  need_title?: string | null;
};

type OfferRecord = {
  id: string;
  agent_id: string;
  title?: string | null;
  category?: string | null;
  base_price?: number | null;
  max_price_delta_pct?: number | null;
};

type NeedRecord = {
  id: string;
  agent_id: string;
  title?: string | null;
  acceptance_criteria?: unknown;
};

export type MarketMatch = {
  fingerprint: string;
  summary: string;
  score: number;
  offerId: string;
  needId: string;
  offerTitle: string;
  needTitle: string;
  offerAgentId: string;
  needAgentId: string;
  category?: string;
  price: number;
  maxPriceDeltaPct: number;
  acceptanceCriteria: string[];
};

export type WatchResult = {
  matches: MarketMatch[];
  newMatches: MarketMatch[];
  nextState: DaemonState;
};

type FetchLike = typeof fetch;

function createHeaders(apiKey: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
}

async function requestJson<T>(fetchFn: FetchLike, apiUrl: string, path: string, apiKey: string): Promise<T> {
  const response = await fetchFn(`${apiUrl}${path}`, {
    method: "GET",
    headers: createHeaders(apiKey),
  });

  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) as T : null;
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return body as T;
}

export function buildMatchFingerprint(offerId: string, needId: string): string {
  return `${offerId}:${needId}`;
}

function toAcceptanceCriteria(raw: unknown, needId: string): string[] {
  if (!Array.isArray(raw)) {
    return [`Deliver work matching need ${needId}`];
  }

  const values = raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return values.length > 0 ? values : [`Deliver work matching need ${needId}`];
}

function buildSummary(recommendation: RecommendationRecord, offer: OfferRecord, need: NeedRecord): string {
  const offerTitle = offer.title ?? recommendation.offer_title ?? recommendation.offer_id;
  const needTitle = need.title ?? recommendation.need_title ?? recommendation.need_id;
  return `${offerTitle} -> ${needTitle} (${recommendation.score.toFixed(2)})`;
}

export async function watchMarket(input: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  state: DaemonState;
  nowIso: string;
  fetchFn?: FetchLike;
}): Promise<WatchResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const recommendations = await requestJson<RecommendationRecord[]>(
    fetchFn,
    input.apiUrl,
    `/api/matches/recommendations?agentId=${encodeURIComponent(input.agentId)}`,
    input.apiKey,
  );

  const matches = await Promise.all(recommendations.map(async (recommendation) => {
    const [offer, need] = await Promise.all([
      requestJson<OfferRecord>(fetchFn, input.apiUrl, `/api/offers/${recommendation.offer_id}`, input.apiKey),
      requestJson<NeedRecord>(fetchFn, input.apiUrl, `/api/needs/${recommendation.need_id}`, input.apiKey),
    ]);

    return {
      fingerprint: buildMatchFingerprint(recommendation.offer_id, recommendation.need_id),
      summary: buildSummary(recommendation, offer, need),
      score: recommendation.score,
      offerId: recommendation.offer_id,
      needId: recommendation.need_id,
      offerTitle: offer.title ?? recommendation.offer_title ?? recommendation.offer_id,
      needTitle: need.title ?? recommendation.need_title ?? recommendation.need_id,
      offerAgentId: offer.agent_id,
      needAgentId: need.agent_id,
      category: offer.category ?? undefined,
      price: Number(offer.base_price ?? 0),
      maxPriceDeltaPct: Number(offer.max_price_delta_pct ?? 0),
      acceptanceCriteria: toAcceptanceCriteria(need.acceptance_criteria, need.id),
    } satisfies MarketMatch;
  }));

  const newMatches = matches.filter((match) => !input.state.seenMatchFingerprints.includes(match.fingerprint));

  return {
    matches,
    newMatches,
    nextState: {
      seenMatchFingerprints: Array.from(new Set([
        ...input.state.seenMatchFingerprints,
        ...matches.map((match) => match.fingerprint),
      ])).slice(-5000),
      autopilotDeals: input.state.autopilotDeals,
      lastWatchAt: input.nowIso,
    },
  };
}
