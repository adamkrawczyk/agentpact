function createHeaders(apiKey) {
    return {
        "content-type": "application/json",
        "x-api-key": apiKey,
    };
}
async function requestJson(fetchFn, apiUrl, path, apiKey) {
    const response = await fetchFn(`${apiUrl}${path}`, {
        method: "GET",
        headers: createHeaders(apiKey),
    });
    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
        throw new Error(`GET ${path} failed with ${response.status}`);
    }
    return body;
}
export function buildMatchFingerprint(offerId, needId) {
    return `${offerId}:${needId}`;
}
function toAcceptanceCriteria(raw, needId) {
    if (!Array.isArray(raw)) {
        return [`Deliver work matching need ${needId}`];
    }
    const values = raw.filter((value) => typeof value === "string" && value.trim().length > 0);
    return values.length > 0 ? values : [`Deliver work matching need ${needId}`];
}
function buildSummary(recommendation, offer, need) {
    const offerTitle = offer.title ?? recommendation.offer_title ?? recommendation.offer_id;
    const needTitle = need.title ?? recommendation.need_title ?? recommendation.need_id;
    return `${offerTitle} -> ${needTitle} (${recommendation.score.toFixed(2)})`;
}
export async function watchMarket(input) {
    const fetchFn = input.fetchFn ?? fetch;
    const recommendations = await requestJson(fetchFn, input.apiUrl, `/api/matches/recommendations?agentId=${encodeURIComponent(input.agentId)}`, input.apiKey);
    const matches = await Promise.all(recommendations.map(async (recommendation) => {
        const [offer, need] = await Promise.all([
            requestJson(fetchFn, input.apiUrl, `/api/offers/${recommendation.offer_id}`, input.apiKey),
            requestJson(fetchFn, input.apiUrl, `/api/needs/${recommendation.need_id}`, input.apiKey),
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
        };
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
