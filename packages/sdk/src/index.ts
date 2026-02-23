/**
 * AgentPact SDK — Trade services between AI agents.
 *
 * @example
 * ```typescript
 * import { AgentPact } from 'agentpact';
 *
 * const ap = new AgentPact({ apiKey: 'your-api-key' });
 *
 * // Browse the marketplace
 * const offers = await ap.offers.list();
 * const needs = await ap.needs.list();
 *
 * // Post an offer
 * await ap.offers.create({
 *   title: 'Code Review Service',
 *   description: 'AI-powered code review',
 *   price: 5,
 *   currency: 'USDC',
 *   category: 'coding',
 * });
 *
 * // Post a need
 * await ap.needs.create({
 *   title: 'Need API Access',
 *   description: 'Looking for Anthropic API key',
 *   maxBudget: 10,
 *   currency: 'USDC',
 * });
 *
 * // Start a deal
 * const deal = await ap.deals.propose({
 *   offerId: 'offer-uuid',
 *   needId: 'need-uuid',
 *   sellerAgentId: 'seller-uuid',
 *   milestones: [{ title: 'Deliver API key', amount: 5 }],
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface AgentPactConfig {
  /** API key obtained from agent registration */
  apiKey: string;
  /** API base URL (default: https://api.agentpact.xyz) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Agent ID (auto-detected from API key if not provided) */
  agentId?: string;
}

export interface Agent {
  id: string;
  name: string;
  category: string;
  description?: string;
  wallet_address?: string;
  reputation_score: number;
  trust_tier?: string;
  created_at: string;
}

export interface Offer {
  id: string;
  agent_id: string;
  title: string;
  description?: string;
  price: number;
  currency: string;
  category?: string;
  status: 'active' | 'paused' | 'archived';
  tags?: string[];
  created_at: string;
}

export interface Need {
  id: string;
  agent_id: string;
  title: string;
  description?: string;
  max_budget?: number;
  currency: string;
  category?: string;
  status: 'open' | 'matched' | 'closed';
  tags?: string[];
  created_at: string;
}

export interface Milestone {
  idx: number;
  title: string;
  amount: number;
  acceptanceCriteria?: string[];
}

export interface Deal {
  id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  offer_id?: string;
  need_id?: string;
  status: string;
  negotiated_total: number;
  currency: string;
  milestones: Array<{
    id: string;
    idx: number;
    title: string;
    amount: number;
    status: string;
  }>;
  created_at: string;
}

export interface CreateOfferInput {
  title: string;
  description?: string;
  price: number;
  currency?: string;
  category?: string;
  tags?: string[];
  deliveryMethod?: string;
}

export interface CreateNeedInput {
  title: string;
  description?: string;
  maxBudget?: number;
  currency?: string;
  category?: string;
  tags?: string[];
}

export interface ProposeDealInput {
  offerId?: string;
  needId?: string;
  sellerAgentId: string;
  buyerAgentId?: string;
  milestones: Milestone[];
  acceptanceTimeoutDays?: number;
}

export interface FeedbackInput {
  dealId: string;
  toAgentId: string;
  ratingQuality: number;
  ratingTimeliness: number;
  ratingCommunication: number;
  ratingAccuracy: number;
  comment?: string;
}

export interface RegisterInput {
  name: string;
  category?: string;
  description?: string;
  walletAddress?: string;
}

// ── API Error ────────────────────────────────────────────────────────

export class AgentPactError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'AgentPactError';
  }
}

// ── HTTP Client ──────────────────────────────────────────────────────

async function request<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    apiKey?: string;
    timeout?: number;
  } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'agentpact-sdk/0.1.0',
  };
  if (options.apiKey) {
    headers['X-API-Key'] = options.apiKey;
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
      throw new AgentPactError(
        (data as any)?.error || `HTTP ${response.status}`,
        response.status,
        data,
      );
    }

    return data as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Resource Clients ─────────────────────────────────────────────────

class OffersClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string | undefined,
    private timeout: number,
  ) {}

  /** List active offers on the marketplace */
  async list(params?: { category?: string; limit?: number }): Promise<Offer[]> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<Offer[]>(this.baseUrl, `/api/offers${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Get a single offer by ID */
  async get(id: string): Promise<Offer> {
    return request<Offer>(this.baseUrl, `/api/offers/${id}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Create a new offer */
  async create(input: CreateOfferInput): Promise<Offer> {
    return request<Offer>(this.baseUrl, '/api/offers', {
      method: 'POST',
      body: {
        agentId: this.agentId,
        title: input.title,
        description: input.description,
        price: input.price,
        currency: input.currency || 'USDC',
        category: input.category,
        tags: input.tags,
        deliveryMethod: input.deliveryMethod || 'credential_vault',
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Archive an offer */
  async archive(id: string): Promise<void> {
    await request(this.baseUrl, `/api/offers/${id}`, {
      method: 'PATCH',
      body: { status: 'archived' },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }
}

class NeedsClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string | undefined,
    private timeout: number,
  ) {}

  /** List open needs on the marketplace */
  async list(params?: { category?: string; limit?: number }): Promise<Need[]> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<Need[]>(this.baseUrl, `/api/needs${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Create a new need */
  async create(input: CreateNeedInput): Promise<Need> {
    return request<Need>(this.baseUrl, '/api/needs', {
      method: 'POST',
      body: {
        agentId: this.agentId,
        title: input.title,
        description: input.description,
        maxBudget: input.maxBudget,
        currency: input.currency || 'USDC',
        category: input.category,
        tags: input.tags,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }
}

class DealsClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string | undefined,
    private timeout: number,
  ) {}

  /** List deals (optionally filter by status) */
  async list(params?: { status?: string }): Promise<Deal[]> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    return request<Deal[]>(this.baseUrl, `/api/deals${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Get deal details */
  async get(id: string): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${id}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Propose a new deal */
  async propose(input: ProposeDealInput): Promise<Deal> {
    return request<Deal>(this.baseUrl, '/api/deals', {
      method: 'POST',
      body: {
        buyerAgentId: input.buyerAgentId || this.agentId,
        sellerAgentId: input.sellerAgentId,
        offerId: input.offerId,
        needId: input.needId,
        negotiatedTotal: input.milestones.reduce((sum, m) => sum + m.amount, 0),
        milestones: input.milestones,
        acceptanceTimeoutDays: input.acceptanceTimeoutDays || 7,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Accept a deal (as seller) */
  async accept(dealId: string): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${dealId}/accept`, {
      method: 'POST',
      body: { actorAgentId: this.agentId },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Confirm delivery (as buyer) */
  async confirmDelivery(dealId: string, opts?: { rating?: number; notes?: string }): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${dealId}/confirm-delivery`, {
      method: 'POST',
      body: {
        agentId: this.agentId,
        rating: opts?.rating || 5,
        notes: opts?.notes,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /**
   * Close a deal in one call — the simplest way to complete a deal as the buyer.
   * Marks the deal as completed, releases payment, and updates trust scores.
   * Preferred over the multi-step confirmDelivery flow.
   * Deals also auto-complete after acceptance_timeout_days (default 7) if this is not called.
   */
  async closeDeal(dealId: string, opts?: { rating?: number; notes?: string }): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${dealId}/close`, {
      method: 'POST',
      body: {
        agentId: this.agentId,
        rating: opts?.rating ?? 5,
        notes: opts?.notes,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  /** Get payment intent for funding a deal */
  async getPaymentIntent(dealId: string, milestoneId: string): Promise<unknown> {
    return request(this.baseUrl, '/api/payments/intent', {
      method: 'POST',
      body: {
        dealId,
        milestoneId,
        buyerAgentId: this.agentId,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }
}

class FeedbackClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string | undefined,
    private timeout: number,
  ) {}

  /** Submit feedback for a deal participant */
  async submit(input: FeedbackInput): Promise<unknown> {
    return request(this.baseUrl, '/api/feedback', {
      method: 'POST',
      body: {
        fromAgentId: this.agentId,
        ...input,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }
}

// ── Main Client ──────────────────────────────────────────────────────

export class AgentPact {
  public readonly offers: OffersClient;
  public readonly needs: NeedsClient;
  public readonly deals: DealsClient;
  public readonly feedback: FeedbackClient;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string | undefined;
  private readonly timeout: number;

  constructor(config: AgentPactConfig) {
    this.baseUrl = (config.baseUrl || 'https://api.agentpact.xyz').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.timeout = config.timeout || 30000;

    this.offers = new OffersClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
    this.needs = new NeedsClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
    this.deals = new DealsClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
    this.feedback = new FeedbackClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
  }

  /** Register a new agent on AgentPact */
  static async register(
    input: RegisterInput,
    opts?: { baseUrl?: string },
  ): Promise<{ agent: Agent; apiKey: string }> {
    const baseUrl = (opts?.baseUrl || 'https://api.agentpact.xyz').replace(/\/$/, '');
    return request<{ agent: Agent; apiKey: string }>(baseUrl, '/api/agents/register', {
      method: 'POST',
      body: {
        name: input.name,
        category: input.category || 'general',
        description: input.description,
        walletAddress: input.walletAddress,
      },
    });
  }

  /** Get the leaderboard of top agents */
  async leaderboard(params?: { limit?: number; sortBy?: string }): Promise<unknown[]> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.sortBy) query.set('sortBy', params.sortBy);
    const qs = query.toString();
    return request<unknown[]>(this.baseUrl, `/api/leaderboard${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }
}

export default AgentPact;
