import { randomUUID } from "node:crypto";
import { Receipt } from "mppx";
import { Mppx, stripe, tempo } from "mppx/server";

const PATH_USD = "0x20c0000000000000000000000000000000000000" as `0x${string}`;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY ?? randomUUID();

export type DealPaymentMethod = "mpp-fiat" | "mpp-crypto" | "legacy-usdc";
export type DealPaymentMethodEntry = { type: DealPaymentMethod };

type DealChargeResult =
  | {
      status: 402;
      challenge: Response;
    }
  | {
      status: 200;
      receipt: Receipt.Receipt;
      response: Response;
    };

let cachedMppx: any | null | undefined;

function toMinorUnits(amount: number, decimals: number): string {
  return Math.round(amount * 10 ** decimals).toString();
}

function isSupportedDealCurrency(currency: string): boolean {
  const normalized = currency.trim().toUpperCase();
  return normalized === "USDC" || normalized === "USD";
}

function getConfiguredMethods() {
  const methods: any[] = [];

  if (process.env.STRIPE_SECRET_KEY) {
    methods.push(
      stripe.charge({
        secretKey: process.env.STRIPE_SECRET_KEY,
        networkId: "internal",
        paymentMethodTypes: ["card", "link"],
      }),
    );
  }

  if (process.env.TEMPO_RECIPIENT_ADDRESS) {
    methods.push(
      tempo.charge({
        currency: PATH_USD,
        recipient: process.env.TEMPO_RECIPIENT_ADDRESS as `0x${string}`,
      }),
    );
  }

  return methods;
}

function getMppx() {
  if (cachedMppx !== undefined) return cachedMppx;

  const methods = getConfiguredMethods();
  cachedMppx = methods.length
    ? Mppx.create({
        methods,
        secretKey: MPP_SECRET_KEY,
      })
    : null;

  return cachedMppx;
}

export function getAvailableDealPaymentMethods(options?: { includeLegacyUsdc?: boolean }): DealPaymentMethodEntry[] {
  const methods: DealPaymentMethodEntry[] = [];

  if (process.env.STRIPE_SECRET_KEY) {
    methods.push({ type: "mpp-fiat" });
  }

  if (process.env.TEMPO_RECIPIENT_ADDRESS) {
    methods.push({ type: "mpp-crypto" });
  }

  if (options?.includeLegacyUsdc) {
    methods.push({ type: "legacy-usdc" });
  }

  return methods;
}

export function getMppConfigurationError(): string | null {
  if (!process.env.STRIPE_SECRET_KEY && !process.env.TEMPO_RECIPIENT_ADDRESS) {
    return "MPP payment methods are not configured";
  }
  return null;
}

export async function chargeDeal(amount: number, currency: string, request: Request): Promise<DealChargeResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Deal amount must be greater than zero");
  }

  if (!isSupportedDealCurrency(currency)) {
    throw new Error(`Unsupported deal currency for MPP payment: ${currency}`);
  }

  const mppx = getMppx();
  if (!mppx) {
    throw new Error(getMppConfigurationError() ?? "MPP is not configured");
  }

  const entries: any[] = [];

  if (process.env.STRIPE_SECRET_KEY) {
    entries.push([
      mppx.stripe.charge,
      {
        amount: toMinorUnits(amount, 2),
        currency: "usd",
        decimals: 2,
        description: "AgentPact deal funding",
      },
    ] as const);
  }

  if (process.env.TEMPO_RECIPIENT_ADDRESS) {
    entries.push([
      mppx.tempo.charge,
      {
        amount: toMinorUnits(amount, 6),
        decimals: 6,
        description: "AgentPact deal funding",
      },
    ] as const);
  }

  const result = await mppx.compose(...entries)(request);
  if (result.status === 402) {
    return result;
  }

  const response = result.withReceipt(
    new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );

  return {
    status: 200,
    receipt: Receipt.fromResponse(response),
    response,
  };
}
