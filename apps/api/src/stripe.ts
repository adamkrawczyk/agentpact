/**
 * Stripe integration — real SDK implementation.
 * audit-order rollout: replaced stub with live Stripe SDK calls.
 *
 * Public API surface (unchanged):
 *   isStripeEnabled()
 *   createPaymentIntent(amountCents, currency, metadata)
 *   cancelPaymentIntent(stripePaymentIntentId)
 *   constructWebhookEvent(rawBody, signature, secret?)
 */

import Stripe from "stripe";

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  _stripe = new Stripe(key, { apiVersion: "2023-10-16" });
  return _stripe;
}

export function isStripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/** Test/sandbox shim: synthetic `pi_test_*` PIs that never reach Stripe. One predicate for create AND cancel. */
function isStripeTestShim(): boolean {
  return process.env.NODE_ENV === "test" || !!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_");
}

/**
 * Create a Stripe PaymentIntent.
 * In test-mode (NODE_ENV=test or sk_test_ key) returns a synthetic stub so
 * route + migration coverage can run without a real network call.
 */
export async function createPaymentIntent(
  amountCents: number,
  currency: string,
  metadata: Record<string, string>,
): Promise<{ id: string; client_secret: string }> {
  if (!isStripeEnabled()) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  }

  // Local/test-mode shim: lets route and migration coverage exercise Stripe rows
  // without a network dependency or real credentials.
  if (isStripeTestShim()) {
    const suffix = `${metadata.milestoneId ?? "milestone"}_${amountCents}_${currency}`.replace(
      /[^a-zA-Z0-9_]/g,
      "_",
    );
    return {
      id: `pi_test_${suffix}`,
      client_secret: `pi_test_${suffix}_secret_test`,
    };
  }

  const stripe = getStripe();
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: currency.toLowerCase(),
    metadata,
  });

  if (!intent.client_secret) {
    throw new Error("Stripe did not return a client_secret");
  }

  return { id: intent.id, client_secret: intent.client_secret };
}

/**
 * Cancel a deal-funding Stripe PaymentIntent at the provider (cancel-refund-guard
 * spec §3.2 step 6). Used by deal cancel BEFORE any DB write, so a client
 * secret already in the buyer's hands can no longer capture money.
 *
 *  - "cancelled":        the PI is cancelled (now, or it already was)
 *  - "already_captured": money moved (`succeeded`) or is moving (`processing`);
 *                        the caller must refuse the cancel and change nothing
 *  - throws:             any other failure — the caller fails closed (502)
 */
export async function cancelPaymentIntent(
  stripePaymentIntentId: string,
): Promise<{ outcome: "cancelled" | "already_captured"; status: string }> {
  if (!isStripeEnabled()) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  }

  // Twin of the createPaymentIntent shim: synthetic `pi_test_*` ids never
  // reached Stripe, so there is nothing at the provider to cancel.
  if (stripePaymentIntentId.startsWith("pi_test_") && isStripeTestShim()) {
    return { outcome: "cancelled", status: "canceled" };
  }

  const stripe = getStripe();
  try {
    const intent = await stripe.paymentIntents.cancel(stripePaymentIntentId);
    return { outcome: "cancelled", status: intent.status };
  } catch (err: unknown) {
    // Stripe refuses to cancel a PI that is not in a cancellable state. Read
    // the authoritative status instead of guessing from the error text.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "payment_intent_unexpected_state") throw err;
    const current = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    if (current.status === "canceled") return { outcome: "cancelled", status: current.status };
    if (current.status === "succeeded" || current.status === "processing") {
      return { outcome: "already_captured", status: current.status };
    }
    throw err;
  }
}

/**
 * Verify and parse a Stripe webhook event.
 *
 * @param rawBody   Raw request body (Buffer or string).
 * @param signature Value of the `stripe-signature` header.
 * @param secret    Webhook signing secret to use. Defaults to
 *                  `STRIPE_WEBHOOK_SECRET`. Pass `STRIPE_WEBHOOK_SECRET_AUDIT`
 *                  or `STRIPE_WEBHOOK_SECRET_VERIFIED` (or the env var value)
 *                  for the audit / verified-seller webhook endpoints.
 */
export function constructWebhookEvent(
  rawBody: string | Buffer,
  signature: string,
  secret?: string,
): Stripe.Event {
  const signingSecret =
    secret ?? process.env.STRIPE_WEBHOOK_SECRET;

  if (!signingSecret) {
    throw new Error("Stripe webhook secret not configured");
  }

  // In unit tests Stripe SDK is typically mocked; this path is exercised by
  // integration / manual tests.
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, signingSecret);
}
