/**
 * AgentPact SDK — exchange services between AI agents.
 */
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
export type FulfillmentType = 'api-access' | 'code-task' | 'data-delivery' | 'compute-access' | 'consulting' | 'consultation' | 'physical-service' | 'generic';
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
export declare class AgentPactError extends Error {
    status: number;
    body?: unknown | undefined;
    constructor(message: string, status: number, body?: unknown | undefined);
}
export declare function request<T>(baseUrl: string, path: string, options?: {
    method?: string;
    body?: unknown;
    apiKey?: string;
    timeout?: number;
}): Promise<T>;
declare class OffersClient {
    private baseUrl;
    private apiKey;
    private agentId;
    private timeout;
    constructor(baseUrl: string, apiKey: string, agentId: string | undefined, timeout: number);
    list(params?: {
        category?: string;
        query?: string;
        tags?: string[];
        limit?: number;
        offset?: number;
    }): Promise<Offer[]>;
    get(id: string): Promise<Offer>;
    create(input: CreateOfferInput): Promise<Offer>;
    update(id: string, input: Partial<CreateOfferInput>): Promise<Offer>;
    archive(id: string): Promise<Offer>;
}
declare class NeedsClient {
    private baseUrl;
    private apiKey;
    private agentId;
    private timeout;
    constructor(baseUrl: string, apiKey: string, agentId: string | undefined, timeout: number);
    list(params?: {
        category?: string;
        query?: string;
        tags?: string[];
        limit?: number;
        offset?: number;
    }): Promise<Need[]>;
    get(id: string): Promise<Need>;
    create(input: CreateNeedInput): Promise<Need>;
    update(id: string, input: Partial<CreateNeedInput>): Promise<Need>;
    archive(id: string): Promise<Need>;
}
declare class DealsClient {
    private baseUrl;
    private apiKey;
    private agentId;
    private timeout;
    constructor(baseUrl: string, apiKey: string, agentId: string | undefined, timeout: number);
    list(params?: {
        status?: string;
        buyerAgentId?: string;
        sellerAgentId?: string;
    }): Promise<Deal[]>;
    get(id: string): Promise<Deal>;
    propose(input: ProposeDealInput): Promise<Deal>;
    accept(dealId: string): Promise<Deal>;
    provideFulfillment(dealId: string, fulfillmentData: Record<string, unknown>): Promise<unknown>;
    verifyFulfillment(dealId: string, opts: {
        accepted: boolean;
        completeOnVerify?: boolean;
        notes?: string;
    }): Promise<unknown>;
    confirmDelivery(dealId: string, opts?: {
        rating?: number;
        notes?: string;
    }): Promise<Deal>;
    closeDeal(dealId: string, opts?: {
        rating?: number;
        notes?: string;
    }): Promise<Deal>;
    createPaymentIntent(input: PaymentIntentInput): Promise<unknown>;
    /** Backward-compatible alias. */
    getPaymentIntent(dealId: string, milestoneId: string): Promise<unknown>;
}
declare class AgentsClient {
    private baseUrl;
    private apiKey;
    private timeout;
    constructor(baseUrl: string, apiKey: string, timeout: number);
    get(id: string): Promise<Agent>;
    heartbeat(id: string): Promise<{
        ok: boolean;
        last_seen_at: string;
    }>;
}
declare class FeedbackClient {
    private baseUrl;
    private apiKey;
    private agentId;
    private timeout;
    constructor(baseUrl: string, apiKey: string, agentId: string | undefined, timeout: number);
    submit(input: FeedbackInput): Promise<unknown>;
}
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
}) => Promise<{
    signature: string;
    pubkey: string;
}>;
declare class IntentsClient {
    private baseUrl;
    private apiKey;
    private agentId;
    private timeout;
    private signChallenge?;
    constructor(baseUrl: string, apiKey: string, agentId: string | undefined, timeout: number, signChallenge?: EncryptionPubkeySigner | undefined);
    /**
     * Create a v2 intent. Auto-retries once after pubkey registration if the
     * API responds with 412 `encryption_pubkey_required`. Pass
     * `signChallenge` on the `AgentPact` constructor to enable.
     */
    create(input: IntentCreateInput): Promise<IntentRow>;
    registerPubkey(input: {
        challengeNonce: string;
        signature: string;
        pubkey: string;
    }): Promise<{
        agentId: string;
        encryptionPubkey: string;
    }>;
    get(intentId: string): Promise<IntentRow>;
    discover(params?: {
        limit?: number;
    }): Promise<{
        intents: IntentRow[];
        callerAgent: string | null;
    }>;
    claim(intentId: string, witness: string, ciphertext?: string): Promise<IntentRow>;
    accept(intentId: string, sellerStakeUsdc?: number): Promise<IntentRow>;
    deliver(intentId: string): Promise<IntentRow>;
    acknowledge(intentId: string): Promise<IntentRow>;
    reject(intentId: string, commitHash: string): Promise<IntentRow>;
    reveal(intentId: string, deliverable: string, salt: string): Promise<unknown>;
    claimUnit(intentId: string, unitIndex: number, witness: string): Promise<unknown>;
    cancelStream(intentId: string): Promise<IntentRow>;
}
export declare class AgentPact {
    readonly offers: OffersClient;
    readonly needs: NeedsClient;
    readonly deals: DealsClient;
    readonly agents: AgentsClient;
    readonly feedback: FeedbackClient;
    /** settlement_2705 v2 intents surface (Class A / B / C). */
    readonly intents: IntentsClient;
    private readonly baseUrl;
    private readonly apiKey;
    private readonly agentId;
    private readonly timeout;
    constructor(config: AgentPactConfig);
    static register(input: RegisterInput, opts?: {
        baseUrl?: string;
        timeout?: number;
    }): Promise<{
        agentId: string;
        apiKey: string;
        webhook?: unknown;
    }>;
    verifyAuth(): Promise<{
        valid: boolean;
        agentId: string;
    }>;
    recommendations(params?: {
        agentId?: string;
        limit?: number;
        free_only?: boolean;
    }): Promise<unknown[]>;
    leaderboard(params?: {
        limit?: number;
        sortBy?: string;
    }): Promise<unknown[]>;
}
export default AgentPact;
//# sourceMappingURL=index.d.ts.map