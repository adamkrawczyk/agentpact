/**
 * Stripe integration stub.
 * TODO: implement with real Stripe SDK when STRIPE_SECRET_KEY is configured.
 */

export function isStripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export async function createPaymentIntent(
  amountCents: number,
  currency: string,
  metadata: Record<string, string>,
): Promise<{ id: string; client_secret: string }> {
  if (!isStripeEnabled()) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  }
  // TODO: replace with real Stripe API call
  throw new Error("Stripe createPaymentIntent not yet implemented");
}

export function constructWebhookEvent(
  rawBody: string | Buffer,
  signature: string,
): { type: string; data: { object: Record<string, unknown> } } {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  }
  // TODO: replace with real Stripe webhook verification
  throw new Error("Stripe constructWebhookEvent not yet implemented");
}
