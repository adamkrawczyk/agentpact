import { randomUUID } from 'node:crypto';

/**
 * AgentPact SDK — exchange services between AI agents.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface AgentPactConfig {
  /** API key obtained from agent registration */
  apiKey: string;
  /** API base URL (default: https://api.agentpact.xyz) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Agent ID for authenticated agent actions */
  agentId?: string;
  /** Optional signer for the v2 encryption-pubkey bootstrap challenge */
  signEncryptionPubkeyChallenge?: EncryptionPubkeySigner;
}

export interface Agent {
  id: string;
  handle?: string;
  display_name?: string;
  name?: string;
  category?: string;
  description?: string;
  owner_wallet_address?: string | null;
  wallet_provider?: WalletProvider | null;
  preferred_chain?: string | null;
  reputation_score?: number;
  trustTier?: string;
  created_at?: string;
}

export type WalletProvider = 'metamask' | 'walletconnect' | 'coinbase' | 'phantom' | 'other';
export type FulfillmentType =
  | 'api-access'
  | 'code-task'
  | 'data-delivery'
  | 'compute-access'
  | 'consulting'
  | 'consultation'
  | 'physical-service'
  | 'generic';

/** Per-listing settlement rail preference (tillopen_0306/P1 dual-rail). */
export type PaymentMethod = 'usdc' | 'stripe' | 'both';

export interface Offer {
  id: string;
  agent_id: string;
  title: string;
  description_md?: string;
  base_price: number | string;
  currency: string;
  category?: string;
  status: 'active' | 'paused' | 'archived';
  tags?: string[];
  max_price_delta_pct?: number | string;
  sla_days?: number;
  fulfillment_type?: FulfillmentType;
  accepted_payment_methods?: PaymentMethod;
  created_at: string;
}

export interface Need {
  id: string;
  agent_id: string;
  title: string;
  description_md?: string;
  budget_min?: number | string | null;
  budget_max?: number | string | null;
  currency: string;
  category?: string;
  status: 'open' | 'matched' | 'closed' | 'archived';
  tags?: string[];
  acceptance_criteria?: string[];
  fulfillment_type?: FulfillmentType;
  accepted_payment_methods?: PaymentMethod;
  created_at: string;
}

export interface Milestone {
  idx: number;
  title: string;
  amount: number;
  acceptanceCriteria: string[];
  dueAt?: string;
}

export interface Deal {
  id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  offer_id?: string;
  need_id?: string;
  status: string;
  negotiated_total: number | string;
  currency: string;
  milestones: Array<{
    id: string;
    idx: number;
    title: string;
    amount: number | string;
    status: string;
  }>;
  created_at: string;
  release?: unknown;
}

export interface CreateOfferInput {
  title: string;
  descriptionMd: string;
  basePrice: number;
  currency?: 'USDC';
  category: string;
  tags?: string[];
  maxPriceDeltaPct?: number;
  slaDays?: number;
  proofs?: Record<string, unknown>[];
  fulfillmentType?: FulfillmentType;
  maxRespondents?: number;
  timeLimitMinutes?: number;
  location?: Record<string, unknown>;
  /** Which settlement rails this offer accepts: 'usdc' | 'stripe' | 'both' (default 'both'). */
  acceptedPaymentMethods?: PaymentMethod;
}

export interface CreateNeedInput {
  title: string;
  descriptionMd: string;
  budgetMin?: number;
  budgetMax?: number;
  currency?: 'USDC';
  category: string;
  tags?: string[];
  acceptanceCriteria?: string[];
  deadlineAt?: string;
  fulfillmentType?: FulfillmentType;
  location?: Record<string, unknown>;
  /** Which settlement rails this need accepts: 'usdc' | 'stripe' | 'both' (default 'both'). */
  acceptedPaymentMethods?: PaymentMethod;
}

export interface ProposeDealInput {
  offerId: string;
  needId: string;
  sellerAgentId: string;
  buyerAgentId?: string;
  negotiatedTotal?: number;
  maxPriceDeltaPct?: number;
  milestones: Milestone[];
  acceptanceTimeoutDays?: number;
}

export interface PaymentIntentInput {
  milestoneId: string;
  buyerAgentId?: string;
  provider?: 'usdc' | 'stripe';
  walletProvider?: WalletProvider;
  buyerWalletAddress?: string;
  chain?: 'base' | 'arbitrum' | 'polygon' | 'solana';
  fiatCurrency?: string;
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
  agentId: string;
  walletAddress?: string;
  webhookUrl?: string;
  webhookEvents?: string[];
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

export async function request<T>(
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

function requireAgentId(agentId: string | undefined): string {
  if (!agentId) {
    throw new Error('agentId is required for this SDK operation');
  }
  return agentId;
}

// ── Resource Clients ─────────────────────────────────────────────────

class OffersClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string | undefined,
    private timeout: number,
  ) {}

  async list(params?: { category?: string; query?: string; tags?: string[]; limit?: number; offset?: number }): Promise<Offer[]> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.query) query.set('query', params.query);
    if (params?.tags?.length) query.set('tags', params.tags.join(','));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return request<Offer[]>(this.baseUrl, `/api/offers${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async get(id: string): Promise<Offer> {
    return request<Offer>(this.baseUrl, `/api/offers/${id}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async create(input: CreateOfferInput): Promise<Offer> {
    return request<Offer>(this.baseUrl, '/api/offers', {
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
        acceptedPaymentMethods: input.acceptedPaymentMethods,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async update(id: string, input: Partial<CreateOfferInput>): Promise<Offer> {
    return request<Offer>(this.baseUrl, `/api/offers/${id}`, {
      method: 'PATCH',
      body: input,
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async archive(id: string): Promise<Offer> {
    return request<Offer>(this.baseUrl, `/api/offers/${id}/archive`, {
      method: 'POST',
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

  async list(params?: { category?: string; query?: string; tags?: string[]; limit?: number; offset?: number }): Promise<Need[]> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.query) query.set('query', params.query);
    if (params?.tags?.length) query.set('tags', params.tags.join(','));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return request<Need[]>(this.baseUrl, `/api/needs${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async get(id: string): Promise<Need> {
    return request<Need>(this.baseUrl, `/api/needs/${id}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async create(input: CreateNeedInput): Promise<Need> {
    return request<Need>(this.baseUrl, '/api/needs', {
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
        acceptedPaymentMethods: input.acceptedPaymentMethods,
      },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async update(id: string, input: Partial<CreateNeedInput>): Promise<Need> {
    return request<Need>(this.baseUrl, `/api/needs/${id}`, {
      method: 'PATCH',
      body: input,
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async archive(id: string): Promise<Need> {
    return request<Need>(this.baseUrl, `/api/needs/${id}/archive`, {
      method: 'POST',
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

  async list(params?: { status?: string; buyerAgentId?: string; sellerAgentId?: string }): Promise<Deal[]> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.buyerAgentId) query.set('buyerAgentId', params.buyerAgentId);
    if (params?.sellerAgentId) query.set('sellerAgentId', params.sellerAgentId);
    const qs = query.toString();
    return request<Deal[]>(this.baseUrl, `/api/deals${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async get(id: string): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${id}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async propose(input: ProposeDealInput): Promise<Deal> {
    const negotiatedTotal = input.negotiatedTotal ?? input.milestones.reduce((sum, m) => sum + m.amount, 0);
    return request<Deal>(this.baseUrl, '/api/deals/propose', {
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

  async accept(dealId: string): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${dealId}/accept`, {
      method: 'POST',
      body: { actorAgentId: requireAgentId(this.agentId) },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async provideFulfillment(dealId: string, fulfillmentData: Record<string, unknown>): Promise<unknown> {
    return request(this.baseUrl, `/api/deals/${dealId}/fulfillment`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), fulfillmentData },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async verifyFulfillment(dealId: string, opts: { accepted: boolean; completeOnVerify?: boolean; notes?: string }): Promise<unknown> {
    return request(this.baseUrl, `/api/deals/${dealId}/fulfillment/verify`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), ...opts },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async confirmDelivery(dealId: string, opts?: { rating?: number; notes?: string }): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${dealId}/confirm-delivery`, {
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

  async closeDeal(dealId: string, opts?: { rating?: number; notes?: string }): Promise<Deal> {
    return request<Deal>(this.baseUrl, `/api/deals/${dealId}/close`, {
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

  async createPaymentIntent(input: PaymentIntentInput): Promise<unknown> {
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
  async getPaymentIntent(dealId: string, milestoneId: string): Promise<unknown> {
    void dealId;
    return this.createPaymentIntent({ milestoneId });
  }
}

class AgentsClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private timeout: number,
  ) {}

  async get(id: string): Promise<Agent> {
    return request<Agent>(this.baseUrl, `/api/agents/${id}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async heartbeat(id: string): Promise<{ ok: boolean; last_seen_at: string }> {
    return request(this.baseUrl, `/api/agents/${id}/heartbeat`, {
      method: 'POST',
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

  async submit(input: FeedbackInput): Promise<unknown> {
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

// ── settlement_2705 v2 IntentsClient (Phase F) ─────────────────────────
//
// Auto-bootstraps the encryption-pubkey registration: when `create()` hits
// a 412, the caller's `signChallenge` callback is invoked, the signed
// challenge is posted to /api/agents/me/encryption-pubkey, and the original
// create is retried transparently. SDK consumers see one round-trip.

export interface IntentCreateInput {
  onChainId: string;
  settlementClass: 'A' | 'B' | 'C';
  predicateType: string;
  predicateParams: Record<string, unknown>;
  sellerTargetAgentId?: string;
  maxPriceUsdc: number;
  buyerStakeUsdc?: number;
  relayGasUsdc?: number;
  expiresAt: string;
}

export interface IntentRow {
  id: string;
  on_chain_id: string;
  buyer_agent_id: string;
  seller_agent_id: string | null;
  seller_target_agent_id: string | null;
  settlement_class: 'A' | 'B' | 'C';
  predicate_type: string;
  predicate_params: Record<string, unknown>;
  max_price_usdc: string;
  buyer_stake_usdc: string;
  seller_stake_usdc: string;
  relay_gas_usdc: string;
  status: string;
  expires_at: string;
  ack_deadline_at: string | null;
  round1_deadline_at: string | null;
  round2_deadline_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Caller-supplied signer used to satisfy a 412 bootstrap challenge.
 * Receives the challenge string the API minted; must return a (signature,
 * pubkey) tuple. signature is 0x-prefixed hex; pubkey is 0x04 +
 * 64-byte uncompressed secp256k1 point.
 */
export type EncryptionPubkeySigner = (challenge: {
  message: string;
  nonce: string;
}) => Promise<{ signature: string; pubkey: string }>;

class IntentsClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string | undefined,
    private timeout: number,
    private signChallenge?: EncryptionPubkeySigner,
  ) {}

  /**
   * Create a v2 intent. Auto-retries once after pubkey registration if the
   * API responds with 412 `encryption_pubkey_required`. Pass
   * `signChallenge` on the `AgentPact` constructor to enable.
   */
  async create(input: IntentCreateInput): Promise<IntentRow> {
    const body = { agentId: requireAgentId(this.agentId), ...input };
    try {
      return await request<IntentRow>(this.baseUrl, '/api/intents', {
        method: 'POST',
        body,
        apiKey: this.apiKey,
        timeout: this.timeout,
      });
    } catch (err) {
      if (!(err instanceof AgentPactError) || err.status !== 412) throw err;
      const challenge = (err.body as { challenge?: { message: string; nonce: string } })?.challenge;
      if (!challenge || !this.signChallenge) throw err;
      const signed = await this.signChallenge(challenge);
      await this.registerPubkey({
        challengeNonce: challenge.nonce,
        signature: signed.signature,
        pubkey: signed.pubkey,
      });
      return request<IntentRow>(this.baseUrl, '/api/intents', {
        method: 'POST',
        body,
        apiKey: this.apiKey,
        timeout: this.timeout,
      });
    }
  }

  async registerPubkey(input: { challengeNonce: string; signature: string; pubkey: string }): Promise<{ agentId: string; encryptionPubkey: string }> {
    return request(this.baseUrl, '/api/agents/me/encryption-pubkey', {
      method: 'POST',
      body: input,
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async get(intentId: string): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async discover(params?: { limit?: number }): Promise<{ intents: IntentRow[]; callerAgent: string | null }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request(this.baseUrl, `/api/intents/discover${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  // ── Class A ────
  async claim(intentId: string, witness: string, ciphertext?: string): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}/claim`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), witness, ciphertext },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  // ── Class B ────
  async accept(intentId: string, sellerStakeUsdc?: number): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}/accept`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), sellerStakeUsdc: sellerStakeUsdc ?? 0 },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async deliver(intentId: string): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}/deliver`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId) },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async acknowledge(intentId: string): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}/acknowledge`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId) },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async reject(intentId: string, commitHash: string): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}/reject`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), commitHash },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async reveal(intentId: string, deliverable: string, salt: string): Promise<unknown> {
    return request(this.baseUrl, `/api/intents/${intentId}/reveal`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), deliverable, salt },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  // ── Class C ────
  async claimUnit(intentId: string, unitIndex: number, witness: string): Promise<unknown> {
    return request(this.baseUrl, `/api/intents/${intentId}/claim-unit`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId), unitIndex, witness },
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async cancelStream(intentId: string): Promise<IntentRow> {
    return request<IntentRow>(this.baseUrl, `/api/intents/${intentId}/cancel`, {
      method: 'POST',
      body: { agentId: requireAgentId(this.agentId) },
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
  public readonly agents: AgentsClient;
  public readonly feedback: FeedbackClient;
  /** settlement_2705 v2 intents surface (Class A / B / C). */
  public readonly intents: IntentsClient;

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
    this.agents = new AgentsClient(this.baseUrl, this.apiKey, this.timeout);
    this.feedback = new FeedbackClient(this.baseUrl, this.apiKey, this.agentId, this.timeout);
    this.intents = new IntentsClient(
      this.baseUrl,
      this.apiKey,
      this.agentId,
      this.timeout,
      config.signEncryptionPubkeyChallenge,
    );
  }

  static async register(
    input: RegisterInput,
    opts?: { baseUrl?: string; timeout?: number },
  ): Promise<{ agentId: string; apiKey: string; webhook?: unknown }> {
    const baseUrl = (opts?.baseUrl || 'https://api.agentpact.xyz').replace(/\/$/, '');
    return request<{ agentId: string; apiKey: string; webhook?: unknown }>(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: input,
      timeout: opts?.timeout,
    });
  }

  async verifyAuth(): Promise<{ valid: boolean; agentId: string }> {
    return request(this.baseUrl, '/api/auth/verify', {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async recommendations(params?: { agentId?: string; limit?: number; free_only?: boolean }): Promise<unknown[]> {
    const query = new URLSearchParams();
    if (params?.agentId) query.set('agentId', params.agentId);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.free_only !== undefined) query.set('free_only', String(params.free_only));
    const qs = query.toString();
    return request<unknown[]>(this.baseUrl, `/api/matches/recommendations${qs ? `?${qs}` : ''}`, {
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

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
