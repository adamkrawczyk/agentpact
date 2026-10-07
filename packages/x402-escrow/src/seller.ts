import { decodeB64Json, encodeB64Json, headerValue, randomHex, sha256Hex, toBytes } from "./codec.js";
import { formatUsd, parseUsd } from "./money.js";
import { EVM_USDC, SOLANA_USDC, type EvmNetworkName, type SolanaNetworkName } from "./networks.js";
import type {
  CompleteResult,
  CoreRequest,
  Decision,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  ResponseBody,
  SettleResponse,
  UsdAmount,
  VerifyResponse,
} from "./types.js";

/** x402 `scheme` id of the escrow option listed next to the standard `exact` option. */
export const AGENTPACT_ESCROW_SCHEME = "agentpact-escrow";
/** Header the buyer sets on the retry once its AgentPact deal is funded. */
export const DEAL_HEADER = "X-AGENTPACT-DEAL";
/** Secret only the deal's buyer can mint (POST /api/deals/:id/x402-token); binds the retry to the buyer. */
export const DEAL_TOKEN_HEADER = "X-AGENTPACT-DEAL-TOKEN";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
export const DEFAULT_API_BASE = "https://api.agentpact.xyz";

export interface X402EscrowConfig {
  /** Your AgentPact agent id (the seller on every escrow deal). */
  sellerAgentId: string;
  /** Your AgentPact API key. Only ever sent to `apiBase`. */
  apiKey: string;
  /** The AgentPact offer buyers propose escrow deals against (create one with POST /api/offers). */
  offerId: string;
  /** Calls priced ABOVE this also get the escrow option. */
  thresholdUsd: UsdAmount;
  /** Price per call, or a function of the request (e.g. batch size). */
  price: UsdAmount | ((req: CoreRequest) => UsdAmount);
  /** Your Base address for plain x402 payments. */
  payTo: string;
  /** Default "base". "base-sepolia" for testing. */
  network?: EvmNetworkName;
  /** Optional: also accept plain x402 on Solana. */
  solana?: { payTo: string; feePayer: string; network?: SolanaNetworkName };
  /** Requests for which escrow is offered regardless of price (e.g. batch jobs). */
  isBatch?: (req: CoreRequest) => boolean;
  /** x402 facilitator. Default https://x402.org/facilitator (testnet); use a mainnet facilitator for Base. */
  facilitatorUrl?: string;
  /** Extra headers for facilitator calls (e.g. a CDP facilitator JWT). */
  facilitatorHeaders?: (op: "verify" | "settle") => Record<string, string> | Promise<Record<string, string>>;
  /** Default https://api.agentpact.xyz */
  apiBase?: string;
  description?: string;
  mimeType?: string;
  /** Default 60. */
  maxTimeoutSeconds?: number;
  /** Per-request timeout for facilitator + AgentPact calls. Default 15 000 ms. */
  timeoutMs?: number;
  /** Non-fatal problems (e.g. a delivery that could not be submitted). */
  onError?: (err: unknown, ctx: { stage: string; dealId?: string }) => void;
  fetch?: typeof fetch;
}

export interface X402Escrow {
  handle(req: CoreRequest): Promise<Decision>;
  /** Price in USDC base units for a request (useful for logging/UI). */
  priceOf(req: CoreRequest): bigint;
  readonly config: Readonly<X402EscrowConfig>;
}

interface ConsumeOk { consumed: true; replay: boolean; dealId: string; milestoneIds: string[] }

const sameAddress = (a: string, b: string) =>
  a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Does a buyer's `accepted` requirement match one we actually offered? */
function matches(offered: PaymentRequirements, accepted: PaymentRequirements | undefined): boolean {
  if (!accepted || typeof accepted !== "object") return false;
  return offered.scheme === accepted.scheme
    && offered.network === accepted.network
    && offered.amount === String(accepted.amount)
    && typeof accepted.asset === "string" && sameAddress(offered.asset, accepted.asset)
    && typeof accepted.payTo === "string" && sameAddress(offered.payTo, accepted.payTo);
}

export function x402Escrow(config: X402EscrowConfig): X402Escrow {
  for (const k of ["sellerAgentId", "apiKey", "offerId", "payTo"] as const) {
    if (typeof config[k] !== "string" || config[k].length === 0) throw new Error(`x402Escrow: ${k} is required`);
  }
  const threshold = parseUsd(config.thresholdUsd);
  if (typeof config.price !== "function") parseUsd(config.price); // fail fast on a bad static price
  const network = EVM_USDC[config.network ?? "base"];
  if (!network) throw new Error(`x402Escrow: unsupported network ${config.network}`);
  const solana = config.solana ? { ...SOLANA_USDC[config.solana.network ?? "solana"], ...config.solana } : null;
  const facilitatorUrl = (config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL).replace(/\/$/, "");
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const doFetch = config.fetch ?? fetch;
  const report = (err: unknown, ctx: { stage: string; dealId?: string }) => {
    try { config.onError?.(err, ctx); } catch { /* never let a logger break a response */ }
  };

  const priceOf = (req: CoreRequest): bigint =>
    parseUsd(typeof config.price === "function" ? config.price(req) : config.price);

  function exactOptions(amount: bigint): PaymentRequirements[] {
    const opts: PaymentRequirements[] = [{
      scheme: "exact",
      network: network.caip2,
      amount: amount.toString(),
      asset: network.asset,
      payTo: config.payTo,
      maxTimeoutSeconds,
      extra: { name: network.name, version: network.version },
    }];
    if (solana) {
      opts.push({
        scheme: "exact",
        network: solana.caip2,
        amount: amount.toString(),
        asset: solana.asset,
        payTo: solana.payTo,
        maxTimeoutSeconds,
        extra: { feePayer: solana.feePayer },
      });
    }
    return opts;
  }

  function escrowOption(amount: bigint): PaymentRequirements {
    const usd = formatUsd(amount);
    return {
      scheme: AGENTPACT_ESCROW_SCHEME,
      network: network.caip2,
      amount: amount.toString(),
      asset: network.asset,
      payTo: config.payTo,
      maxTimeoutSeconds,
      extra: {
        agentpact: {
          sellerAgentId: config.sellerAgentId,
          offerId: config.offerId,
          priceUsd: usd,
          apiBase,
          retryHeader: DEAL_HEADER,
          retryTokenHeader: DEAL_TOKEN_HEADER,
          docs: "https://agentpact.xyz/skill",
          createDeal: {
            rest: [
              { call: "POST /api/needs", body: { agentId: "<your agent id>", title: "x402 order", descriptionMd: "<what you need>", category: "x402", budgetMax: Number(usd) } },
              {
                call: "POST /api/deals/propose",
                body: {
                  buyerAgentId: "<your agent id>", sellerAgentId: config.sellerAgentId, offerId: config.offerId, needId: "<need id>",
                  negotiatedTotal: Number(usd), maxPriceDeltaPct: 0,
                  milestones: [{ idx: 1, title: "x402 response", amount: Number(usd), acceptanceCriteria: ["HTTP 2xx response from the resource"] }],
                },
              },
              { call: "POST /api/deals/<dealId>/x402-token", note: `buyer-only; send the token as ${DEAL_TOKEN_HEADER} on every retry (deal ids are public, the token proves you are the buyer)` },
              { call: `retry this request with ${DEAL_HEADER}: <dealId> and ${DEAL_TOKEN_HEADER}: <token>`, note: "the seller accepts the deal automatically" },
              { call: "POST /api/payments/create-intent", note: "fund the milestone (USDC escrow on Base), then POST /api/payments/confirm-funding" },
              { call: `retry this request with ${DEAL_HEADER} + ${DEAL_TOKEN_HEADER}`, note: "served once; the seller submits the delivery and the receipt flow completes" },
            ],
            mcp: [
              "agentpact.create_need",
              `agentpact.propose_deal { sellerAgentId: "${config.sellerAgentId}", offerId: "${config.offerId}", negotiatedTotal: ${usd} }`,
              "POST /api/deals/<dealId>/x402-token (REST; buyer-only)",
              "agentpact.create_payment_intent → agentpact.confirm_funding",
            ],
            sdk: "fetchWithEscrow(url, init, { apiKey, agentId, maxPlainUsd }) from @agentpact/x402-escrow does all of this",
          },
        },
      },
    };
  }

  function paymentRequired(
    req: CoreRequest,
    accepts: PaymentRequirements[],
    error: string,
    status = 402,
    agentpact?: Record<string, unknown>,
  ): Decision {
    const resource: ResourceInfo = { url: req.url };
    if (config.description) resource.description = config.description;
    if (config.mimeType) resource.mimeType = config.mimeType;
    const body: PaymentRequired = { x402Version: 2, error, resource, accepts };
    if (agentpact) body.extensions = { agentpact: { info: agentpact, schema: { type: "object" } } };
    return {
      action: "respond",
      status,
      headers: { [PAYMENT_REQUIRED_HEADER]: encodeB64Json(body), "Content-Type": "application/json" },
      body,
    };
  }

  async function post(url: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const apiHeaders = { "x-api-key": config.apiKey };

  // ── plain x402 ─────────────────────────────────────────────────────────────

  async function plainPath(req: CoreRequest, header: string, accepts: PaymentRequirements[], exact: PaymentRequirements[]): Promise<Decision> {
    let payment: PaymentPayload;
    try {
      payment = decodeB64Json<PaymentPayload>(header);
    } catch {
      return { action: "respond", status: 400, headers: { "Content-Type": "application/json" }, body: { error: "invalid_payload" } };
    }
    if (!payment || typeof payment !== "object") {
      return { action: "respond", status: 400, headers: { "Content-Type": "application/json" }, body: { error: "invalid_payload" } };
    }
    if (payment.x402Version !== 2) {
      return { action: "respond", status: 400, headers: { "Content-Type": "application/json" }, body: { error: "invalid_x402_version" } };
    }
    const requirements = exact.find((o) => matches(o, payment.accepted));
    if (!requirements) return paymentRequired(req, accepts, "payment payload does not match any accepted requirement");

    const facilitatorBody = { x402Version: 2, paymentPayload: payment, paymentRequirements: requirements };
    let verify: VerifyResponse;
    try {
      const res = await post(`${facilitatorUrl}/verify`, facilitatorBody, await (config.facilitatorHeaders?.("verify") ?? {}));
      if (!res.ok) throw new Error(`facilitator /verify HTTP ${res.status}`);
      verify = await res.json() as VerifyResponse;
    } catch (err) {
      report(err, { stage: "verify" });
      return { action: "respond", status: 500, headers: { "Content-Type": "application/json" }, body: { error: "facilitator_unavailable" } };
    }
    if (verify.isValid !== true) return paymentRequired(req, accepts, verify.invalidReason ?? "invalid_payment");

    return {
      action: "serve",
      mode: "x402",
      async complete(_body: ResponseBody, status: number): Promise<CompleteResult> {
        // Never charge for a failed response (≥ 400), as the x402 reference
        // middleware does. A 3xx is a served response and is paid for.
        if (status >= 400) return { ok: true, headers: {} };
        let settle: SettleResponse;
        try {
          const res = await post(`${facilitatorUrl}/settle`, facilitatorBody, await (config.facilitatorHeaders?.("settle") ?? {}));
          settle = await res.json() as SettleResponse;
          if (!res.ok && settle.success !== false) throw new Error(`facilitator /settle HTTP ${res.status}`);
        } catch (err) {
          report(err, { stage: "settle" });
          settle = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: requirements.network };
        }
        const headers = { [PAYMENT_RESPONSE_HEADER]: encodeB64Json(settle) };
        if (settle.success !== true) {
          const pr = paymentRequired(req, accepts, settle.errorReason ?? "settlement_failed");
          return { ok: false, status: 402, headers: { ...headers, ...(pr.action === "respond" ? pr.headers : {}) }, body: pr.action === "respond" ? pr.body : {} };
        }
        return { ok: true, headers };
      },
    };
  }

  // ── escrow ─────────────────────────────────────────────────────────────────

  async function consume(dealId: string, buyerToken: string | undefined, price: bigint, resource: string, consumeKey: string): Promise<Response> {
    const url = `${apiBase}/api/deals/${encodeURIComponent(dealId)}/consume`;
    const body = { priceBaseUnits: price.toString(), consumeKey, buyerToken, offerId: config.offerId, resource };
    try {
      return await post(url, body, apiHeaders);
    } catch (err) {
      // One retry with the SAME key: the API treats it as an idempotent replay
      // if the first attempt landed and only the response was lost.
      report(err, { stage: "consume", dealId });
      return post(url, body, apiHeaders);
    }
  }

  async function escrowPath(req: CoreRequest, dealId: string, price: bigint, accepts: PaymentRequirements[]): Promise<Decision> {
    const consumeKey = randomHex(16);
    const buyerToken = headerValue(req.headers, DEAL_TOKEN_HEADER);
    let res: Response;
    let payload: Record<string, unknown>;
    try {
      res = await consume(dealId, buyerToken, price, req.url, consumeKey);
      payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    } catch (err) {
      report(err, { stage: "consume", dealId });
      return { action: "respond", status: 500, headers: { "Content-Type": "application/json" }, body: { error: "agentpact_unavailable" } };
    }
    if (res.status === 401) {
      report(new Error("AgentPact rejected the seller API key"), { stage: "consume", dealId });
      return { action: "respond", status: 500, headers: { "Content-Type": "application/json" }, body: { error: "agentpact_auth_failed" } };
    }
    if (res.ok && payload.consumed === true) {
      const ok = payload as unknown as ConsumeOk;
      return {
        action: "serve",
        mode: "escrow",
        dealId,
        async complete(body: ResponseBody, status: number): Promise<CompleteResult> {
          const headers = { [DEAL_HEADER]: dealId };
          if (status >= 400) {
            // The handler failed: hand the deal back so the buyer can retry.
            // (A 3xx is a served response: it consumes the deal.)
            try {
              const r = await post(`${apiBase}/api/deals/${encodeURIComponent(dealId)}/consume/release`, { consumeKey }, apiHeaders);
              if (!r.ok) throw new Error(`consume/release HTTP ${r.status}`);
            } catch (err) {
              report(err, { stage: "release", dealId });
            }
            return { ok: true, headers };
          }
          const bytes = toBytes(body);
          const sha = await sha256Hex(bytes);
          for (const milestoneId of ok.milestoneIds ?? []) {
            try {
              const r = await post(`${apiBase}/api/deliveries/submit`, {
                milestoneId,
                submittedBy: config.sellerAgentId,
                artifacts: [{ type: "x402-response", url: req.url, hash: `sha256:${sha}` }],
                notes: `x402 escrow delivery: ${bytes.byteLength} bytes, sha256 ${sha}`,
              }, apiHeaders);
              if (!r.ok) throw new Error(`deliveries/submit HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
            } catch (err) {
              // The buyer paid and the response exists: serve it. The delivery
              // can be resubmitted (agentpact.submit_delivery) — report loudly.
              report(err, { stage: "delivery", dealId });
            }
          }
          return { ok: true, headers: { ...headers, "X-AGENTPACT-ARTIFACT-SHA256": sha } };
        },
      };
    }

    const code = typeof payload.code === "string" ? payload.code : `HTTP_${res.status}`;
    if (code === "DEAL_NOT_ACCEPTED") {
      // Zero-human seller: the middleware accepts deals proposed against our
      // offer. The API re-checks seller + status; funding still has to happen.
      try {
        const acc = await post(`${apiBase}/api/deals/${encodeURIComponent(dealId)}/accept`, { actorAgentId: config.sellerAgentId }, apiHeaders);
        if (acc.ok) {
          return paymentRequired(req, accepts, "agentpact_deal_accepted_awaiting_funding", 402, {
            dealId, status: "accepted_awaiting_funding",
            next: `fund the deal (POST /api/payments/create-intent), then retry with ${DEAL_HEADER}: ${dealId}`,
          });
        }
        report(new Error(`accept HTTP ${acc.status}`), { stage: "accept", dealId });
      } catch (err) {
        report(err, { stage: "accept", dealId });
      }
      return paymentRequired(req, accepts, "agentpact_deal_not_accepted", 402, { dealId, status: "not_accepted" });
    }
    return paymentRequired(req, accepts, `agentpact_${code.toLowerCase()}`, 402, {
      dealId,
      status: code.toLowerCase(),
      detail: typeof payload.error === "string" ? payload.error : undefined,
    });
  }

  async function handle(req: CoreRequest): Promise<Decision> {
    const price = priceOf(req);
    const escrowOffered = price > threshold || (config.isBatch?.(req) ?? false);
    const exact = exactOptions(price);
    const accepts = escrowOffered ? [...exact, escrowOption(price)] : exact;

    const dealId = headerValue(req.headers, DEAL_HEADER);
    if (dealId) return escrowPath(req, dealId, price, accepts);

    const signature = headerValue(req.headers, PAYMENT_SIGNATURE_HEADER);
    if (signature) return plainPath(req, signature, accepts, exact);

    return paymentRequired(req, accepts, `${PAYMENT_SIGNATURE_HEADER} header is required`);
  }

  return { handle, priceOf, config };
}
