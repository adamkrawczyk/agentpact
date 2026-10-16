// Client for Circle's Iris attestation service (CCTP v2).
//
//   GET /v2/messages/{sourceDomainId}?transactionHash=0x…
//     https://developers.circle.com/api-reference/cctp/all/get-messages-v2
//   GET /v2/burn/USDC/fees/{sourceDomainId}/{destDomainId}
//     https://developers.circle.com/api-reference/cctp/all/get-burn-usdc-fees
//
// Hosts, endpoints, rate limit: https://developers.circle.com/cctp/references/technical-guide
// Iris allows 40 requests/second; exceeding it returns HTTP 429 and blocks the
// caller for 5 minutes.
// A long lockout is NOT slept through inside a tick — it is thrown as
// IrisRateLimitedError so the caller reschedules the row instead of wedging
// the sweeper.

import type { Hex } from "viem";

export type IrisMessageStatus = "complete" | "pending_confirmations" | (string & {});

export interface IrisMessage {
  /** Full CCTP v2 message bytes, or null while Iris has not produced it. */
  message: Hex | null;
  /** Attestation bytes, or null while pending ("PENDING" is normalised to null). */
  attestation: Hex | null;
  /** CCTP v2 nonce (bytes32), assigned by Iris at attestation time. */
  eventNonce: Hex | null;
  status: IrisMessageStatus;
  cctpVersion: number | null;
  /** null | insufficient_fee | amount_above_max | insufficient_allowance_available */
  delayReason: string | null;
  /**
   * Forwarding Service state. Circle documents only "PENDING"; any other value
   * is passed through verbatim and NOT interpreted — forwardTxHash is the only
   * completion signal we trust.
   */
  forwardState: string | null;
  /** Destination mint tx submitted by Circle's Forwarding Service. */
  forwardTxHash: string | null;
}

export type IrisMessagesResult = { kind: "found"; messages: IrisMessage[] } | { kind: "not_found" };

export interface IrisFeeTier {
  /** 1000 = Fast Transfer (confirmed), 2000 = Standard Transfer (finalized). */
  finalityThreshold: number;
  /**
   * Minimum fee in basis points, as an exact decimal string ("1", "1.3").
   * Kept as text so no float ever enters fee math — see fees.ts bpsFee().
   */
  minimumFeeBps: string;
}

/** Forwarding Service fee quote, USDC base units (NOT bps). */
export interface IrisForwardFee {
  low: bigint;
  med: bigint;
  high: bigint;
}

export interface IrisBurnFees {
  tiers: IrisFeeTier[];
  /** Present only when requested with forward=true. */
  forwardFee: IrisForwardFee | null;
}

export interface BurnFeeQuery {
  /** Ask for the Forwarding Service fee (forward=true). */
  forward?: boolean;
  /** Include Solana ATA creation in the forwarding fee (includeRecipientSetup=true). */
  includeRecipientSetup?: boolean;
}

export interface IrisClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt on transient failures (network, timeout, 5xx, short 429). */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Cap on a single backoff sleep AND the longest Retry-After we will sleep through. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** [0,1) jitter source; injectable for deterministic tests. */
  random?: () => number;
}

export class IrisError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "IrisError";
  }
}

export class IrisRateLimitedError extends IrisError {
  constructor(readonly retryAfterMs: number) {
    super(`Iris rate limit (HTTP 429), retry after ${retryAfterMs} ms`, 429);
    this.name = "IrisRateLimitedError";
  }
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
// Iris's documented 429 lockout; used when the header is absent.
const DEFAULT_RATE_LIMIT_MS = 5 * 60_000;

function parseRetryAfter(h: string | null, nowMs: number): number {
  if (!h) return DEFAULT_RATE_LIMIT_MS;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : DEFAULT_RATE_LIMIT_MS;
}

function baseUnits(v: unknown): bigint {
  const t = typeof v === "number" ? String(v) : v;
  if (typeof t !== "string" || !/^\d+$/.test(t)) throw new IrisError(`unexpected Iris response: forwardFee ${String(v)}`, 200);
  return BigInt(t);
}

function hexOrNull(v: unknown): Hex | null {
  return typeof v === "string" && HEX_RE.test(v) && v.length > 2 ? (v as Hex) : null;
}

export class IrisClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: IrisClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  async getMessages(sourceDomain: number, transactionHash: Hex): Promise<IrisMessagesResult> {
    if (!TX_RE.test(transactionHash)) throw new Error(`invalid transaction hash: ${transactionHash}`);
    const res = await this.request(`/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`, true);
    if (res === null) return { kind: "not_found" };
    const raw = (res as { messages?: unknown }).messages;
    if (!Array.isArray(raw)) throw new IrisError("unexpected Iris response: no messages array", 200);
    const messages = raw.map((m): IrisMessage => {
      const o = m as Record<string, unknown>;
      if (typeof o.status !== "string") throw new IrisError("unexpected Iris response: message.status", 200);
      return {
        message: hexOrNull(o.message),
        attestation: hexOrNull(o.attestation),
        eventNonce: hexOrNull(o.eventNonce),
        status: o.status,
        cctpVersion: typeof o.cctpVersion === "number" ? o.cctpVersion : null,
        delayReason: typeof o.delayReason === "string" ? o.delayReason : null,
        forwardState: typeof o.forwardState === "string" ? o.forwardState : null,
        forwardTxHash: typeof o.forwardTxHash === "string" && o.forwardTxHash.length > 0 ? o.forwardTxHash : null,
      };
    });
    return { kind: "found", messages };
  }

  /**
   * GET /v2/burn/USDC/fees/{src}/{dst}[?forward=true[&includeRecipientSetup=true]]
   * https://developers.circle.com/cctp/howtos/get-transfer-fee
   * The live API names the middle forwarding tier `med` (the OpenAPI spec says
   * `medium`); both are accepted.
   */
  async getBurnFees(sourceDomain: number, destinationDomain: number, q: BurnFeeQuery = {}): Promise<IrisBurnFees> {
    const qs = new URLSearchParams();
    if (q.forward) qs.set("forward", "true");
    if (q.forward && q.includeRecipientSetup) qs.set("includeRecipientSetup", "true");
    const query = qs.toString();
    const suffix = query ? `?${query}` : "";
    const res = await this.request(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}${suffix}`, false);
    if (!Array.isArray(res)) throw new IrisError("unexpected Iris response: fees is not an array", 200);
    let forwardFee: IrisForwardFee | null = null;
    const tiers = res.map((t) => {
      const o = t as Record<string, unknown>;
      const fee = o.minimumFee;
      if (typeof o.finalityThreshold !== "number" || (typeof fee !== "number" && typeof fee !== "string")) {
        throw new IrisError("unexpected Iris response: fee tier", 200);
      }
      const bps = String(fee);
      if (!/^\d+(\.\d+)?$/.test(bps)) throw new IrisError(`unexpected Iris response: minimumFee ${bps}`, 200);
      if (o.forwardFee && typeof o.forwardFee === "object") {
        const f = o.forwardFee as Record<string, unknown>;
        const med = f.med ?? f.medium;
        forwardFee = { low: baseUnits(f.low), med: baseUnits(med), high: baseUnits(f.high) };
      }
      return { finalityThreshold: o.finalityThreshold, minimumFeeBps: bps };
    });
    if (q.forward && !forwardFee) throw new IrisError("unexpected Iris response: forward=true but no forwardFee", 200);
    return { tiers, forwardFee };
  }

  /** GET with timeout + retry. Returns parsed JSON, or null for a tolerated 404. */
  private async request(path: string, notFoundIsNull: boolean): Promise<unknown> {
    let lastError: IrisError | null = null;
    let slept = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0 && !slept) await this.sleep(this.backoff(attempt - 1));
      slept = false;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          headers: { accept: "application/json" },
          signal: ctrl.signal,
        });
      } catch (err) {
        lastError = new IrisError(`Iris request failed: ${err instanceof Error ? err.message : String(err)}`, null);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new IrisError("unexpected Iris response: body is not JSON", res.status);
        }
      }
      if (res.status === 404 && notFoundIsNull) return null;
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get("retry-after"), Date.now());
        if (wait > this.maxDelayMs || attempt === this.maxRetries) throw new IrisRateLimitedError(wait);
        // The Retry-After sleep replaces the next attempt's backoff; it still
        // consumes an attempt, so a server that keeps answering 429 cannot
        // hold us in an unbounded loop.
        await this.sleep(wait);
        slept = true;
        lastError = new IrisRateLimitedError(wait);
        continue;
      }
      const text = await res.text().catch(() => "");
      lastError = new IrisError(`Iris HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      if (res.status < 500) throw lastError;
    }
    throw lastError ?? new IrisError("Iris request failed", null);
  }

  /** Exponential backoff with equal jitter: d/2 + rand·d/2, d = min(max, base·2^n). */
  private backoff(n: number): number {
    const d = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** n);
    return Math.round(d / 2 + this.random() * (d / 2));
  }
}
