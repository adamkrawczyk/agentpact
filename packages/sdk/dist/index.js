import { randomUUID } from 'node:crypto';
// ── API Error ────────────────────────────────────────────────────────
export class AgentPactError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'AgentPactError';
    }
}
// ── HTTP Client ──────────────────────────────────────────────────────
export async function request(baseUrl, path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'agentpact-sdk/0.2.0',
    };
    if (options.apiKey) {
        headers['X-API-Key'] = options.apiKey;
    }
    if (options.method && options.method !== 'GET') {
        headers['Idempotency-Key'] = randomUUID();
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);
    try {
        const response = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            throw new AgentPactError(data?.error || `HTTP ${response.status}`, response.status, data);
        }
        return data;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
function requireAgentId(agentId) {
    if (!agentId) {
        throw new Error('agentId is required for this SDK operation');
    }
    return agentId;
}
// ── Resource Clients ─────────────────────────────────────────────────
class OffersClient {
    baseUrl;
    apiKey;
    agentId;
    timeout;
    constructor(baseUrl, apiKey, agentId, timeout) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.agentId = agentId;
        this.timeout = timeout;
    }
    async list(params) {
        const query = new URLSearchParams();
        if (params?.category)
            query.set('category', params.category);
        if (params?.query)
            query.set('query', params.query);
        if (params?.tags?.length)
            query.set('tags', params.tags.join(','));
        if (params?.limit)
            query.set('limit', String(params.limit));
        if (params?.offset)
            query.set('offset', String(params.offset));
        const qs = query.toString();
        return request(this.baseUrl, `/api/offers${qs ? `?${qs}` : ''}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async get(id) {
        return request(this.baseUrl, `/api/offers/${id}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async create(input) {
        return request(this.baseUrl, '/api/offers', {
            method: 'POST',
            body: {
                agentId: requireAgentId(this.agentId),
                title: input.title,
                descriptionMd: input.descriptionMd,
                basePrice: input.basePrice,
                currency: input.currency || 'USDC',
                category: input.category,
                tags: input.tags || [],
                maxPriceDeltaPct: input.maxPriceDeltaPct,
                slaDays: input.slaDays,
                proofs: input.proofs,
                fulfillmentType: input.fulfillmentType || 'generic',
                maxRespondents: input.maxRespondents,
                timeLimitMinutes: input.timeLimitMinutes,
                location: input.location,
            },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async update(id, input) {
        return request(this.baseUrl, `/api/offers/${id}`, {
            method: 'PATCH',
            body: input,
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async archive(id) {
        return request(this.baseUrl, `/api/offers/${id}/archive`, {
            method: 'POST',
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
}
class NeedsClient {
    baseUrl;
    apiKey;
    agentId;
    timeout;
    constructor(baseUrl, apiKey, agentId, timeout) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.agentId = agentId;
        this.timeout = timeout;
    }
    async list(params) {
        const query = new URLSearchParams();
        if (params?.category)
            query.set('category', params.category);
        if (params?.query)
            query.set('query', params.query);
        if (params?.tags?.length)
            query.set('tags', params.tags.join(','));
        if (params?.limit)
            query.set('limit', String(params.limit));
        if (params?.offset)
            query.set('offset', String(params.offset));
        const qs = query.toString();
        return request(this.baseUrl, `/api/needs${qs ? `?${qs}` : ''}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async get(id) {
        return request(this.baseUrl, `/api/needs/${id}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async create(input) {
        return request(this.baseUrl, '/api/needs', {
            method: 'POST',
            body: {
                agentId: requireAgentId(this.agentId),
                title: input.title,
                descriptionMd: input.descriptionMd,
                budgetMin: input.budgetMin,
                budgetMax: input.budgetMax,
                currency: input.currency || 'USDC',
                category: input.category,
                tags: input.tags || [],
                acceptanceCriteria: input.acceptanceCriteria || [],
                deadlineAt: input.deadlineAt,
                fulfillmentType: input.fulfillmentType || 'generic',
                location: input.location,
            },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async update(id, input) {
        return request(this.baseUrl, `/api/needs/${id}`, {
            method: 'PATCH',
            body: input,
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async archive(id) {
        return request(this.baseUrl, `/api/needs/${id}/archive`, {
            method: 'POST',
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
}
class DealsClient {
    baseUrl;
    apiKey;
    agentId;
    timeout;
    constructor(baseUrl, apiKey, agentId, timeout) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.agentId = agentId;
        this.timeout = timeout;
    }
    async list(params) {
        const query = new URLSearchParams();
        if (params?.status)
            query.set('status', params.status);
        if (params?.buyerAgentId)
            query.set('buyerAgentId', params.buyerAgentId);
        if (params?.sellerAgentId)
            query.set('sellerAgentId', params.sellerAgentId);
        const qs = query.toString();
        return request(this.baseUrl, `/api/deals${qs ? `?${qs}` : ''}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async get(id) {
        return request(this.baseUrl, `/api/deals/${id}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async propose(input) {
        const negotiatedTotal = input.negotiatedTotal ?? input.milestones.reduce((sum, m) => sum + m.amount, 0);
        return request(this.baseUrl, '/api/deals/propose', {
            method: 'POST',
            body: {
                buyerAgentId: input.buyerAgentId || requireAgentId(this.agentId),
                sellerAgentId: input.sellerAgentId,
                offerId: input.offerId,
                needId: input.needId,
                negotiatedTotal,
                maxPriceDeltaPct: input.maxPriceDeltaPct ?? 15,
                milestones: input.milestones,
                acceptanceTimeoutDays: input.acceptanceTimeoutDays ?? 7,
            },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async accept(dealId) {
        return request(this.baseUrl, `/api/deals/${dealId}/accept`, {
            method: 'POST',
            body: { actorAgentId: requireAgentId(this.agentId) },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async provideFulfillment(dealId, fulfillmentData) {
        return request(this.baseUrl, `/api/deals/${dealId}/fulfillment`, {
            method: 'POST',
            body: { agentId: requireAgentId(this.agentId), fulfillmentData },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async verifyFulfillment(dealId, opts) {
        return request(this.baseUrl, `/api/deals/${dealId}/fulfillment/verify`, {
            method: 'POST',
            body: { agentId: requireAgentId(this.agentId), ...opts },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async confirmDelivery(dealId, opts) {
        return request(this.baseUrl, `/api/deals/${dealId}/confirm-delivery`, {
            method: 'POST',
            body: {
                agentId: requireAgentId(this.agentId),
                rating: opts?.rating || 5,
                notes: opts?.notes,
            },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async closeDeal(dealId, opts) {
        return request(this.baseUrl, `/api/deals/${dealId}/close`, {
            method: 'POST',
            body: {
                agentId: requireAgentId(this.agentId),
                rating: opts?.rating ?? 5,
                notes: opts?.notes,
            },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async createPaymentIntent(input) {
        const provider = input.provider ?? 'usdc';
        const body = provider === 'stripe'
            ? {
                provider: 'stripe',
                milestoneId: input.milestoneId,
                buyerAgentId: input.buyerAgentId || requireAgentId(this.agentId),
                fiatCurrency: input.fiatCurrency || 'usd',
            }
            : {
                provider: 'usdc',
                milestoneId: input.milestoneId,
                buyerAgentId: input.buyerAgentId || requireAgentId(this.agentId),
                walletProvider: input.walletProvider || 'metamask',
                buyerWalletAddress: input.buyerWalletAddress,
                chain: input.chain || 'base',
            };
        return request(this.baseUrl, '/api/payments/create-intent', {
            method: 'POST',
            body,
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    /** Backward-compatible alias. */
    async getPaymentIntent(dealId, milestoneId) {
        void dealId;
        return this.createPaymentIntent({ milestoneId });
    }
}
class AgentsClient {
    baseUrl;
    apiKey;
    timeout;
    constructor(baseUrl, apiKey, timeout) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.timeout = timeout;
    }
    async get(id) {
        return request(this.baseUrl, `/api/agents/${id}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async heartbeat(id) {
        return request(this.baseUrl, `/api/agents/${id}/heartbeat`, {
            method: 'POST',
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
}
class FeedbackClient {
    baseUrl;
    apiKey;
    agentId;
    timeout;
    constructor(baseUrl, apiKey, agentId, timeout) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.agentId = agentId;
        this.timeout = timeout;
    }
    async submit(input) {
        return request(this.baseUrl, '/api/feedback', {
            method: 'POST',
            body: {
                fromAgentId: requireAgentId(this.agentId),
                ...input,
            },
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
}
// ── Main Client ──────────────────────────────────────────────────────
export class AgentPact {
    offers;
    needs;
    deals;
    agents;
    feedback;
    baseUrl;
    apiKey;
    agentId;
    timeout;
    constructor(config) {
        this.baseUrl = (config.baseUrl || 'https://api.agentpact.xyz').replace(/\/$/, '');
        this.apiKey = config.apiKey;
        this.agentId = config.agentId;
        this.timeout = config.timeout || 30000;
        this.offers = new OffersClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
        this.needs = new NeedsClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
        this.deals = new DealsClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
        this.agents = new AgentsClient(this.baseUrl, this.apiKey, this.timeout);
        this.feedback = new FeedbackClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
    }
    static async register(input, opts) {
        const baseUrl = (opts?.baseUrl || 'https://api.agentpact.xyz').replace(/\/$/, '');
        return request(baseUrl, '/api/auth/register', {
            method: 'POST',
            body: input,
            timeout: opts?.timeout,
        });
    }
    async verifyAuth() {
        return request(this.baseUrl, '/api/auth/verify', {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async recommendations(params) {
        const query = new URLSearchParams();
        if (params?.agentId)
            query.set('agentId', params.agentId);
        if (params?.limit)
            query.set('limit', String(params.limit));
        if (params?.free_only !== undefined)
            query.set('free_only', String(params.free_only));
        const qs = query.toString();
        return request(this.baseUrl, `/api/matches/recommendations${qs ? `?${qs}` : ''}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
    async leaderboard(params) {
        const query = new URLSearchParams();
        if (params?.limit)
            query.set('limit', String(params.limit));
        if (params?.sortBy)
            query.set('sortBy', params.sortBy);
        const qs = query.toString();
        return request(this.baseUrl, `/api/leaderboard${qs ? `?${qs}` : ''}`, {
            apiKey: this.apiKey,
            timeout: this.timeout,
        });
    }
}
export default AgentPact;
//# sourceMappingURL=index.js.map