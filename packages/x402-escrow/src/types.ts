// x402 v2 wire types — https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
// (§5 Types) and the HTTP transport (specs/transports-v2/http.md).

/** One acceptable way to pay (x402 v2 §5.1.2). Amounts are atomic units as decimal strings. */
export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2 network id, e.g. "eip155:8453" (Base) or "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface ExtensionValue {
  info: Record<string, unknown>;
  schema: Record<string, unknown>;
}

/** Body of a 402 and the base64 content of the PAYMENT-REQUIRED header. */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, ExtensionValue>;
}

/** Base64 content of the PAYMENT-SIGNATURE header. */
export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Base64 content of the PAYMENT-RESPONSE header. */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
}

/** A USD price: "$0.02", "0.02", 0.02, or exact USDC base units. */
export type UsdAmount = string | number | { amountBaseUnits: string | bigint };

/** Framework-neutral view of an incoming request. Header names are lower-case. */
export interface CoreRequest {
  method: string;
  /** Absolute URL of the protected resource as the client requested it. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export type ResponseBody = string | Uint8Array | ArrayBuffer | null | undefined;

export type CompleteResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; status: number; headers: Record<string, string>; body: unknown };

/** What the middleware wants the framework to do with a request. */
export type Decision =
  | {
      action: "respond";
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }
  | {
      action: "serve";
      mode: "x402" | "escrow";
      /** Present on the escrow branch. */
      dealId?: string;
      /**
       * Call once the handler produced its response, BEFORE flushing it.
       * x402: settles the payment (body withheld if settlement fails).
       * escrow: submits the delivery (artifact sha256) so the receipt flow completes,
       * or releases the consumption if the handler failed.
       */
      complete(body: ResponseBody, status: number): Promise<CompleteResult>;
    };
