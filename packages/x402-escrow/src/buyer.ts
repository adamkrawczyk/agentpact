import { decodeB64Json, encodeB64Json } from "./codec.js";
import { formatUsd, parseUsd } from "./money.js";
import type { X402Signer } from "./evm-signer.js";
import {
  AGENTPACT_ESCROW_SCHEME,
  DEAL_HEADER,
  DEFAULT_API_BASE,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./seller.js";
import type { PaymentRequired, PaymentRequirements, UsdAmount } from "./types.js";

export interface EvmTx { to: string; data: string; value: string }

export interface FetchWithEscrowOptions {
  /** Signs plain x402 payments (e.g. createEvmExactSigner(viemAccount)). Without it, plain x402 is skipped. */
  x402Signer?: X402Signer;
  /** Pay plain x402 only up to this price. Above it, go through escrow. Default $1. */
  maxPlainUsd?: UsdAmount;
  /** Never escrow more than this. Default $100. */
  maxEscrowUsd?: UsdAmount;
  /** Your AgentPact API key + agent id. Required for the escrow branch. */
  apiKey?: string;
  agentId?: string;
  /**
   * AgentPact API base. Deliberately NOT taken from the seller's 402: your
   * API key is only ever sent to the host you configure here.
   */
  apiBase?: string;
  /** Resume an existing deal instead of creating a new one. */
  dealId?: string;
  /** Custom funding (e.g. a smart wallet). Default: REST create-intent + sendTransaction + confirm-funding. */
  fundDeal?: (ctx: { dealId: string; milestoneIds: string[]; api: ApiCall }) => Promise<void>;
  /** Buyer wallet for the default on-chain funding path. */
  walletAddress?: string;
  walletProvider?: "metamask" | "walletconnect" | "coinbase" | "phantom" | "other";
  /** Broadcast a tx and resolve with its hash once mined. */
  sendTransaction?: (tx: EvmTx) => Promise<string>;
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

async function readPaymentRequired(res: Response): Promise<PaymentRequired | null> {
  const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
  try {
    if (header) return decodeB64Json<PaymentRequired>(header);
    const body = await res.clone().json() as PaymentRequired;
    return Array.isArray(body?.accepts) ? body : null;
  } catch {
    return null;
  }
}

function withHeader(init: RequestInit, name: string, value: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(name, value);
  return { ...init, headers };
}

/**
 * fetch() that pays: plain x402 for small prices, AgentPact escrow above
 * `maxPlainUsd` (or when the seller only offers escrow). Request bodies must
 * be re-sendable (string / Uint8Array / URLSearchParams), not streams.
 */
export async function fetchWithEscrow(
  input: string | URL,
  init: RequestInit = {},
  opts: FetchWithEscrowOptions = {},
): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const emit = (event: string, detail: Record<string, unknown>) => { try { opts.onEvent?.(event, detail); } catch { /* ignore */ } };
  const url = String(input);

  if (opts.dealId) return escrowFlow(url, init, opts, opts.dealId, null, doFetch, emit);

  const first = await doFetch(url, init);
  if (first.status !== 402) return first;
  const pr = await readPaymentRequired(first);
  if (!pr) return first;

  const maxPlain = parseUsd(opts.maxPlainUsd ?? "1");
  const plainOptions = pr.accepts.filter((a) => a.scheme === "exact" && BigInt(a.amount) <= maxPlain);
  if (opts.x402Signer) {
    for (const option of plainOptions) {
      let payment;
      try {
        payment = await opts.x402Signer(option);
      } catch {
        continue; // signer cannot pay this network — try the next option
      }
      emit("x402.pay", { network: option.network, amount: option.amount });
      return doFetch(url, withHeader(init, PAYMENT_SIGNATURE_HEADER, encodeB64Json({ ...payment, resource: pr.resource })));
    }
  }

  const escrow = pr.accepts.find((a) => a.scheme === AGENTPACT_ESCROW_SCHEME);
  if (!escrow || !opts.apiKey || !opts.agentId) return first;
  if (BigInt(escrow.amount) > parseUsd(opts.maxEscrowUsd ?? "100")) {
    emit("escrow.over_cap", { amount: escrow.amount });
    return first;
  }
  return escrowFlow(url, init, opts, null, escrow, doFetch, emit);
}

async function escrowFlow(
  url: string,
  init: RequestInit,
  opts: FetchWithEscrowOptions,
  existingDealId: string | null,
  escrow: PaymentRequirements | null,
  doFetch: typeof fetch,
  emit: (event: string, detail: Record<string, unknown>) => void,
): Promise<Response> {
  if (!opts.apiKey || !opts.agentId) throw new Error("fetchWithEscrow: apiKey and agentId are required for escrow");
  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const api: ApiCall = async (method, path, body) => {
    const res = await doFetch(`${apiBase}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey as string },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(`AgentPact ${method} ${path} → HTTP ${res.status}: ${String(json.error ?? "")}`);
    return json;
  };

  let dealId = existingDealId;
  if (!dealId) {
    if (!escrow) throw new Error("fetchWithEscrow: no escrow option to create a deal from");
    const ap = (escrow.extra?.agentpact ?? {}) as Record<string, unknown>;
    if (typeof ap.sellerAgentId !== "string" || typeof ap.offerId !== "string") {
      throw new Error("fetchWithEscrow: escrow option lacks sellerAgentId/offerId");
    }
    // The API takes USD as a JSON number with ≤ 6 decimals; formatUsd gives
    // the exact decimal string, which Postgres stores as NUMERIC(18,6).
    const usd = Number(formatUsd(BigInt(escrow.amount)));
    const { pathname, host } = new URL(url);
    const criteria = [`HTTP 2xx response from ${url}`];
    const need = await api("POST", "/api/needs", {
      agentId: opts.agentId,
      title: `x402 order: ${host}${pathname}`.slice(0, 200),
      descriptionMd: `Paid API call to ${url} through AgentPact escrow (x402 escrow upgrade).`,
      category: "x402",
      budgetMax: usd,
      acceptanceCriteria: criteria,
    });
    const deal = await api("POST", "/api/deals/propose", {
      buyerAgentId: opts.agentId,
      sellerAgentId: ap.sellerAgentId,
      offerId: ap.offerId,
      needId: need.id,
      negotiatedTotal: usd,
      maxPriceDeltaPct: 0,
      milestones: [{ idx: 1, title: "x402 response", amount: usd, acceptanceCriteria: criteria }],
    });
    dealId = String(deal.id);
    emit("escrow.proposed", { dealId });
  }

  const retry = () => doFetch(url, withHeader(init, DEAL_HEADER, dealId as string));
  const res = await retry();
  if (res.status !== 402) return res;
  const pr = await readPaymentRequired(res);
  const status = String(pr?.extensions?.agentpact?.info?.status ?? "");
  if (status !== "accepted_awaiting_funding" && status !== "deal_not_funded") return res;

  emit("escrow.funding", { dealId });
  const deal = await api("GET", `/api/deals/${encodeURIComponent(dealId)}`);
  const milestoneIds = Array.isArray(deal.milestones) ? (deal.milestones as Array<{ id: string }>).map((m) => m.id) : [];
  if (opts.fundDeal) await opts.fundDeal({ dealId, milestoneIds, api });
  else await defaultFund(api, opts, milestoneIds);
  emit("escrow.funded", { dealId });
  return retry();
}

async function defaultFund(api: ApiCall, opts: FetchWithEscrowOptions, milestoneIds: string[]): Promise<void> {
  for (const milestoneId of milestoneIds) {
    const intent = await api("POST", "/api/payments/create-intent", {
      provider: "usdc",
      milestoneId,
      buyerAgentId: opts.agentId,
      walletProvider: opts.walletProvider ?? "other",
      buyerWalletAddress: opts.walletAddress ?? "0x0000000000000000000000000000000000000000",
      chain: "base",
    });
    if (intent.status === "funded") continue; // API simulation mode funds immediately
    const txData = intent.txData as { step1_approve?: EvmTx; step2_fund?: EvmTx } | undefined;
    if (!txData?.step1_approve || !txData.step2_fund) throw new Error("create-intent returned no transaction data");
    if (!opts.sendTransaction || !opts.walletAddress) {
      throw new Error("fetchWithEscrow: on-chain funding needs walletAddress + sendTransaction (or a custom fundDeal)");
    }
    await opts.sendTransaction(txData.step1_approve);
    const txHash = await opts.sendTransaction(txData.step2_fund);
    await api("POST", "/api/payments/confirm-funding", { paymentIntentId: intent.paymentIntentId, txHash });
  }
}
