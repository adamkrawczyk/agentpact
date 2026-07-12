/**
 * apps/api/src/__tests__/audit-orders.test.ts
 * audit-order rollout: Tests for audit order admin routes.
 *
 * Covers:
 *  - GET /api/audit/orders (auth, filtering, limit)
 *  - PATCH /api/audit/orders/:id/claim (paid→in_progress, conflict, missing)
 *  - POST /api/audit/orders/:id/report (happy path, idempotent, FAIL verdict, email_sent_at)
 *  - POST /api/audit/orders/:id/refund (auth, happy path, idempotent)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestApp, cleanDatabase } from "./helpers/testApp.js";

// ── Mock Stripe & Email ────────────────────────────────────────────────────────

vi.mock("../stripe.js", async () => ({
  isStripeEnabled: () => true,
  createPaymentIntent: vi.fn(async (a: number, c: string) => ({
    id: `pi_test_${a}_${c}`,
    client_secret: `pi_test_${a}_${c}_secret`,
  })),
  constructWebhookEvent: vi.fn(),
}));

vi.mock("../services/email.js", async () => ({
  sendEmail: vi.fn(async () => ({ ok: true, provider: "gws", message_id: "msg_test_123" })),
  buildAuditEmailBody: vi.fn((addr: string, md: string) => `body for ${addr}: ${md}`),
}));

// Mock Stripe class for refund
vi.mock("stripe", async () => {
  const MockStripe = vi.fn().mockImplementation(function() {
    return {
      refunds: {
        create: vi.fn(async () => ({ id: "re_test_mock", status: "succeeded" })),
      },
    };
  });
  return { default: MockStripe };
});

import { sendEmail } from "../services/email.js";
const mockSendEmail = vi.mocked(sendEmail);

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_KEY = "test-admin-key-99";
const ADMIN_HEADERS = { "x-admin-api-key": ADMIN_KEY };
const WRONG_HEADERS = { "x-admin-api-key": "wrong-key" };

async function insertAuditOrder(
  sql: import("postgres").Sql<Record<string, unknown>>,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO audit_orders
      (stripe_session_id, stripe_payment_intent_id, buyer_email, contract_address,
       amount_cents, currency, status)
    VALUES
      (${`cs_test_${Date.now()}_${Math.random()}`}, 'pi_test_001', 'test@example.com',
       '0xContractAddress1234567890', 500, 'USD',
       ${(overrides.status as string) ?? 'paid'})
    RETURNING id
  `;
  return row.id;
}

// ── GET /api/audit/orders ─────────────────────────────────────────────────────

describe("GET /api/audit/orders", () => {
  beforeEach(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    await cleanDatabase();
  });

  it("returns 401 when x-admin-api-key is missing or wrong", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/audit/orders", headers: WRONG_HEADERS });
    expect(res.statusCode).toBe(401);
  });

  it("returns orders with status=paid by default", async () => {
    const { app, sql } = await createTestApp();
    await insertAuditOrder(sql, { status: "paid" });
    await insertAuditOrder(sql, { status: "paid" });
    await insertAuditOrder(sql, { status: "completed" }); // should not be in default response

    const res = await app.inject({ method: "GET", url: "/api/audit/orders", headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { orders: unknown[] };
    expect(body.orders.length).toBe(2);
  });

  it("respects limit query param", async () => {
    const { app, sql } = await createTestApp();
    for (let i = 0; i < 5; i++) {
      await insertAuditOrder(sql, { status: "paid" });
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/audit/orders?limit=2",
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { orders: unknown[] };
    expect(body.orders.length).toBe(2);
  });
});

// ── PATCH /api/audit/orders/:id/claim ─────────────────────────────────────────

describe("PATCH /api/audit/orders/:id/claim", () => {
  beforeEach(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    await cleanDatabase();
  });

  it("transitions paid→in_progress and returns 200", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/audit/orders/${orderId}/claim`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { order: { status: string } };
    expect(body.order.status).toBe("in_progress");

    const [row] = await sql<Array<{ status: string }>>`SELECT status FROM audit_orders WHERE id = ${orderId}`;
    expect(row.status).toBe("in_progress");
  });

  it("returns 409 when order is already in_progress (conflict)", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "in_progress" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/audit/orders/${orderId}/claim`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for unknown order id", async () => {
    const { app } = await createTestApp();
    const fakeId = "00000000-0000-0000-0000-000000000001";

    const res = await app.inject({
      method: "PATCH",
      url: `/api/audit/orders/${fakeId}/claim`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /api/audit/orders/:id/report ─────────────────────────────────────────

const REPORT_BODY = {
  report_md: "# Audit Report\n\nNo critical issues found.",
  severity_counts: { high: 0, medium: 0, low: 1, info: 2 },
  verdict: "PASS",
};

describe("POST /api/audit/orders/:id/report", () => {
  beforeEach(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    await cleanDatabase();
    mockSendEmail.mockResolvedValue({ ok: true, provider: "gws", message_id: "msg_001" });
  });

  it("returns 401 for wrong admin key", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    const res = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/report`,
      headers: WRONG_HEADERS,
      payload: REPORT_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("happy path: marks completed, inserts fee ledger row, sends email, returns ok", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    const res = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/report`,
      headers: ADMIN_HEADERS,
      payload: REPORT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean; status: string; fee_credited_minor: number; email_sent_at: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("completed");
    expect(body.fee_credited_minor).toBe(50); // 10% of 500

    // Fee ledger row
    const [fee] = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM platform_fee_ledger WHERE audit_order_id = ${orderId}
    `;
    expect(fee).toBeTruthy();
    expect(Number(fee.amount_minor)).toBe(50);
    expect(fee.source).toBe("stripe");

    // Email sent_at updated
    const [order] = await sql<Array<{ email_sent_at: unknown; status: string }>>`
      SELECT email_sent_at, status FROM audit_orders WHERE id = ${orderId}
    `;
    expect(order.status).toBe("completed");
    expect(order.email_sent_at).toBeTruthy();
  });

  it("idempotent on conflict — second call with same order returns 409 (already completed)", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    // First call succeeds
    await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/report`,
      headers: ADMIN_HEADERS,
      payload: REPORT_BODY,
    });

    // Second call conflicts
    const res2 = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/report`,
      headers: ADMIN_HEADERS,
      payload: REPORT_BODY,
    });
    expect(res2.statusCode).toBe(409);
  });

  it("sets status=failed when verdict=FAIL and failure_reason provided", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    const res = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/report`,
      headers: ADMIN_HEADERS,
      payload: {
        ...REPORT_BODY,
        verdict: "FAIL",
        failure_reason: "Contract not verified on BaseScan",
        report_md: "Audit could not be completed.",
        severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe("failed");

    const [row] = await sql<Array<{ status: string; failure_reason: string }>>`
      SELECT status, failure_reason FROM audit_orders WHERE id = ${orderId}
    `;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("Contract not verified on BaseScan");
  });

  it("updates email_sent_at on successful email send", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });
    mockSendEmail.mockResolvedValueOnce({ ok: true, provider: "gws", message_id: "msg_xyz" });

    await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/report`,
      headers: ADMIN_HEADERS,
      payload: REPORT_BODY,
    });

    const [row] = await sql<Array<{ email_sent_at: unknown }>>`
      SELECT email_sent_at FROM audit_orders WHERE id = ${orderId}
    `;
    expect(row.email_sent_at).toBeTruthy();
  });
});

// ── POST /api/audit/orders/:id/refund ─────────────────────────────────────────

describe("POST /api/audit/orders/:id/refund", () => {
  beforeEach(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    await cleanDatabase();
  });

  it("returns 401 for wrong admin key", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    const res = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/refund`,
      headers: WRONG_HEADERS,
      payload: { reason: "duplicate" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("happy path: flips status to refunded and returns ok", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "paid" });

    const res = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/refund`,
      headers: ADMIN_HEADERS,
      payload: { reason: "test_refund" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("refunded");

    const [row] = await sql<Array<{ status: string }>>`SELECT status FROM audit_orders WHERE id = ${orderId}`;
    expect(row.status).toBe("refunded");
  });

  it("idempotent: already-refunded order returns 200 without error", async () => {
    const { app, sql } = await createTestApp();
    const orderId = await insertAuditOrder(sql, { status: "refunded" });

    const res = await app.inject({
      method: "POST",
      url: `/api/audit/orders/${orderId}/refund`,
      headers: ADMIN_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; idempotent: boolean };
    expect(body.status).toBe("refunded");
    expect(body.idempotent).toBe(true);
  });
});
