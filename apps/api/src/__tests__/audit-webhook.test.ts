/**
 * apps/api/src/__tests__/audit-webhook.test.ts
 * levels_2505: Tests for POST /api/audit/webhook/stripe
 *
 * The Stripe SDK + database are mocked. Tests focus on:
 *  - signature validation (missing → 400, invalid → 400)
 *  - unrelated events → 200 no-op
 *  - valid checkout.session.completed → 200 + row inserted
 *  - idempotency (same session_id → single row)
 *  - malformed custom_fields → error path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestApp, cleanDatabase } from "./helpers/testApp.js";

// ── Mock Stripe ─────────────────────────────────────────────────────────────
// We mock the entire stripe module so constructWebhookEvent is controllable.
vi.mock("../stripe.js", async () => {
  return {
    isStripeEnabled: () => true,
    createPaymentIntent: vi.fn(async (amountCents: number, currency: string) => ({
      id: `pi_test_${amountCents}_${currency}`,
      client_secret: `pi_test_${amountCents}_${currency}_secret_test`,
    })),
    constructWebhookEvent: vi.fn(),
  };
});

// Import after mock
import { constructWebhookEvent } from "../stripe.js";
const mockConstructWebhookEvent = vi.mocked(constructWebhookEvent);

// ── Stripe event factories ────────────────────────────────────────────────────

function makeCheckoutCompletedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${Date.now()}`,
        payment_intent: `pi_test_${Date.now()}`,
        customer_details: { email: "buyer@example.com" },
        custom_fields: [
          { key: "contract_address", text: { value: "0xDeadBeef12345678901234567890" } },
          { key: "notes", text: { value: "Please check reentrancy" } },
        ],
        amount_total: 500,
        currency: "usd",
        ...overrides,
      },
    },
  };
}

const ADMIN_KEY = "test-admin-key-audit";
const HEADERS_NO_SIG = { "content-type": "application/json" };
const HEADERS_WITH_SIG = { "content-type": "application/json", "stripe-signature": "t=1,v1=sig" };

describe("POST /api/audit/webhook/stripe", () => {
  beforeEach(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET_AUDIT = "whsec_test_audit";
    await cleanDatabase();
    mockConstructWebhookEvent.mockReset();
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_NO_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: /missing/i });
  });

  it("returns 400 when Stripe sig verification throws (invalid signature)", async () => {
    mockConstructWebhookEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("signatures");
  });

  it("returns 200 no-op for unrelated event type", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_xxx" } },
    } as ReturnType<typeof constructWebhookEvent>);

    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: boolean; order_id: unknown };
    expect(body.received).toBe(true);
    expect(body.order_id).toBeNull();
  });

  it("inserts audit_orders row and returns order_id on valid checkout.session.completed", async () => {
    const sessionId = `cs_test_happy_${Date.now()}`;
    const event = makeCheckoutCompletedEvent({ id: sessionId });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: boolean; order_id: string };
    expect(body.received).toBe(true);
    expect(body.order_id).toBeTruthy();
    expect(typeof body.order_id).toBe("string");

    // Verify DB row
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM audit_orders WHERE stripe_session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("paid");
    expect(rows[0].buyer_email).toBe("buyer@example.com");
    expect(rows[0].amount_cents).toBe(500);
    expect(rows[0].currency).toBe("USD");
  });

  it("is idempotent — same stripe_session_id does not create a duplicate row", async () => {
    const sessionId = `cs_test_idem_${Date.now()}`;
    const event = makeCheckoutCompletedEvent({ id: sessionId });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();

    // First call
    const res1 = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body) as { order_id: string };

    // Second call — same session_id
    const res2 = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body) as { order_id: string };

    // Same order_id returned
    expect(body1.order_id).toBe(body2.order_id);

    // Only one row in DB
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM audit_orders WHERE stripe_session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
  });

  it("returns 500 when no contract_address in custom_fields", async () => {
    const event = makeCheckoutCompletedEvent({ custom_fields: [] });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("contract_address");
  });

  it("uses customer_email fallback when customer_details is missing", async () => {
    const sessionId = `cs_test_email_fallback_${Date.now()}`;
    const event = makeCheckoutCompletedEvent({
      id: sessionId,
      customer_details: null,
      customer_email: "fallback@example.com",
    });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/audit/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);

    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT buyer_email FROM audit_orders WHERE stripe_session_id = ${sessionId}
    `;
    expect(rows[0].buyer_email).toBe("fallback@example.com");
  });
});
