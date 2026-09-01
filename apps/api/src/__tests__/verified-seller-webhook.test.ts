/**
 * apps/api/src/__tests__/verified-seller-webhook.test.ts
 * Tests for POST /api/verified/webhook/stripe
 *
 *  - missing/invalid signature -> 400
 *  - unrelated event -> 200 no-op
 *  - valid checkout.session.completed with client_reference_id=agentId -> sets
 *    agents.verified_at, inserts verified_seller_orders row (status=applied)
 *  - client_reference_id can be a handle, not just a UUID
 *  - idempotency: re-purchase does not reset verified_at
 *  - missing client_reference_id -> 500
 *  - unknown agent -> order recorded with status=failed, no crash
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, cleanDatabase, generateTestAgent, getAuthHeadersForAgent } from "./helpers/testApp.js";

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

import { constructWebhookEvent } from "../stripe.js";
const mockConstructWebhookEvent = vi.mocked(constructWebhookEvent);

function makeCheckoutCompletedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        payment_intent: `pi_test_${Date.now()}`,
        customer_details: { email: "buyer@example.com" },
        client_reference_id: "",
        amount_total: 1900,
        currency: "usd",
        ...overrides,
      },
    },
  };
}

const HEADERS_NO_SIG = { "content-type": "application/json" };
const HEADERS_WITH_SIG = { "content-type": "application/json", "stripe-signature": "t=1,v1=sig" };

async function createAgent() {
  const { app } = await createTestApp();
  const testAgent = generateTestAgent();
  const agentId = randomUUID();
  const headers = await getAuthHeadersForAgent(agentId, { walletAddress: testAgent.ownerWalletAddress });
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers,
    payload: {
      handle: testAgent.handle,
      displayName: testAgent.displayName,
      ownerWalletAddress: testAgent.ownerWalletAddress,
      walletProvider: testAgent.walletProvider,
    },
  });
  expect(res.statusCode).toBe(200);
  return { agentId, handle: testAgent.handle };
}

describe("POST /api/verified/webhook/stripe", () => {
  beforeEach(async () => {
    process.env.STRIPE_SECRET_KEY = "«redacted:sk_test_…»";
    process.env.STRIPE_WEBHOOK_SECRET_VERIFIED = "whsec_test_verified";
    await cleanDatabase();
    mockConstructWebhookEvent.mockReset();
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_NO_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when signature verification throws", async () => {
    mockConstructWebhookEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 no-op for unrelated event type", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_xxx" } },
    } as ReturnType<typeof constructWebhookEvent>);

    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: boolean; order_id: unknown };
    expect(body.received).toBe(true);
    expect(body.order_id).toBeNull();
  });

  it("sets agents.verified_at and records an applied order when client_reference_id is a valid agent UUID", async () => {
    const { agentId } = await createAgent();
    const event = makeCheckoutCompletedEvent({ client_reference_id: agentId });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: boolean; order_id: string; agent_id: string };
    expect(body.received).toBe(true);
    expect(body.agent_id).toBe(agentId);

    const [agentRow] = await sql`SELECT verified_at FROM agents WHERE id = ${agentId}`;
    expect(agentRow.verified_at).not.toBeNull();

    const orderRows = await sql`SELECT * FROM verified_seller_orders WHERE agent_id = ${agentId}`;
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0].status).toBe("applied");
    expect(orderRows[0].amount_cents).toBe(1900);
  });

  it("resolves client_reference_id by handle when it is not a UUID", async () => {
    const { agentId, handle } = await createAgent();
    const event = makeCheckoutCompletedEvent({ client_reference_id: handle });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    const [agentRow] = await sql`SELECT verified_at FROM agents WHERE id = ${agentId}`;
    expect(agentRow.verified_at).not.toBeNull();
  });

  it("is idempotent — does not reset verified_at on repeat purchase, no duplicate order row for same session", async () => {
    const { agentId } = await createAgent();
    const sessionId = `cs_test_idem_${Date.now()}`;
    const event = makeCheckoutCompletedEvent({ id: sessionId, client_reference_id: agentId });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();
    const res1 = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res1.statusCode).toBe(200);

    const [firstAgentRow] = await sql`SELECT verified_at FROM agents WHERE id = ${agentId}`;
    const firstVerifiedAt = firstAgentRow.verified_at;

    const res2 = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res2.statusCode).toBe(200);

    const [secondAgentRow] = await sql`SELECT verified_at FROM agents WHERE id = ${agentId}`;
    expect(new Date(secondAgentRow.verified_at as string).getTime()).toBe(
      new Date(firstVerifiedAt as string).getTime(),
    );

    const orderRows = await sql`SELECT * FROM verified_seller_orders WHERE stripe_session_id = ${sessionId}`;
    expect(orderRows).toHaveLength(1);
  });

  it("returns 500 when client_reference_id is missing", async () => {
    const event = makeCheckoutCompletedEvent({ client_reference_id: "" });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(500);
  });

  it("records a failed order (no crash) when client_reference_id resolves to no agent", async () => {
    const event = makeCheckoutCompletedEvent({ client_reference_id: "nonexistent-handle-xyz" });
    mockConstructWebhookEvent.mockReturnValue(event as ReturnType<typeof constructWebhookEvent>);

    const { app, sql } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/verified/webhook/stripe",
      headers: HEADERS_WITH_SIG,
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { agent_id: string | null };
    expect(body.agent_id).toBeNull();

    const orderRows = await sql`SELECT status FROM verified_seller_orders WHERE client_reference_id = ${"nonexistent-handle-xyz"}`;
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0].status).toBe("failed");
  });
});
