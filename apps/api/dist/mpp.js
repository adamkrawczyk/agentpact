import { randomUUID } from "node:crypto";
import { Receipt } from "mppx";
import { Mppx, stripe, tempo } from "mppx/server";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY ?? randomUUID();
let cachedMppx;
function toMinorUnits(amount, decimals) {
    return Math.round(amount * 10 ** decimals).toString();
}
function isSupportedDealCurrency(currency) {
    const normalized = currency.trim().toUpperCase();
    return normalized === "USDC" || normalized === "USD";
}
function getConfiguredMethods() {
    const methods = [];
    if (process.env.STRIPE_SECRET_KEY) {
        methods.push(stripe.charge({
            secretKey: process.env.STRIPE_SECRET_KEY,
            networkId: "internal",
            paymentMethodTypes: ["card", "link"],
        }));
    }
    if (process.env.TEMPO_RECIPIENT_ADDRESS) {
        methods.push(tempo.charge({
            currency: PATH_USD,
            recipient: process.env.TEMPO_RECIPIENT_ADDRESS,
        }));
    }
    return methods;
}
function getMppx() {
    if (cachedMppx !== undefined)
        return cachedMppx;
    const methods = getConfiguredMethods();
    cachedMppx = methods.length
        ? Mppx.create({
            methods,
            secretKey: MPP_SECRET_KEY,
        })
        : null;
    return cachedMppx;
}
export function getAvailableDealPaymentMethods(options) {
    const methods = [];
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
export function getMppConfigurationError() {
    if (!process.env.STRIPE_SECRET_KEY && !process.env.TEMPO_RECIPIENT_ADDRESS) {
        return "MPP payment methods are not configured";
    }
    return null;
}
export async function chargeDeal(amount, currency, request) {
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
    const entries = [];
    if (process.env.STRIPE_SECRET_KEY) {
        entries.push([
            mppx.stripe.charge,
            {
                amount: toMinorUnits(amount, 2),
                currency: "usd",
                decimals: 2,
                description: "AgentPact deal funding",
            },
        ]);
    }
    if (process.env.TEMPO_RECIPIENT_ADDRESS) {
        entries.push([
            mppx.tempo.charge,
            {
                amount: toMinorUnits(amount, 6),
                decimals: 6,
                description: "AgentPact deal funding",
            },
        ]);
    }
    const result = await mppx.compose(...entries)(request);
    if (result.status === 402) {
        return result;
    }
    const response = result.withReceipt(new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
    }));
    return {
        status: 200,
        receipt: Receipt.fromResponse(response),
        response,
    };
}
