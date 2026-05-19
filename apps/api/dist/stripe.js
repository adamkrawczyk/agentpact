/**
 * Stripe integration stub.
 * TODO: implement with real Stripe SDK when STRIPE_SECRET_KEY is configured.
 */
export function isStripeEnabled() {
    return !!process.env.STRIPE_SECRET_KEY;
}
export async function createPaymentIntent(amountCents, currency, metadata) {
    if (!isStripeEnabled()) {
        throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    }
    // Local/test-mode shim: lets route and migration coverage exercise Stripe rows
    // without a network dependency or real credentials. Production still fails
    // closed until the real Stripe SDK integration is wired in.
    if (process.env.NODE_ENV === "test" || process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
        const suffix = `${metadata.milestoneId ?? "milestone"}_${amountCents}_${currency}`.replace(/[^a-zA-Z0-9_]/g, "_");
        return {
            id: `pi_test_${suffix}`,
            client_secret: `pi_test_${suffix}_secret_test`,
        };
    }
    // TODO: replace with real Stripe API call
    throw new Error("Stripe createPaymentIntent not yet implemented");
}
export function constructWebhookEvent(rawBody, signature) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
        throw new Error("STRIPE_WEBHOOK_SECRET not configured");
    }
    // TODO: replace with real Stripe webhook verification
    throw new Error("Stripe constructWebhookEvent not yet implemented");
}
