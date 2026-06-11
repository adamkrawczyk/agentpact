import test from "node:test";
import assert from "node:assert/strict";

import { createApiClient, ApiError, OrderAlreadyClaimed } from "./api-client.js";

function makeOrder(id = "order-1") {
  return {
    id,
    stripe_session_id: "cs_test_abc",
    buyer_email: "buyer@example.com",
    contract_address: "0xABC123",
    contract_chain: "base",
    amount_cents: 500,
    currency: "USD",
    status: "paid",
    created_at: new Date().toISOString(),
  };
}

test("api-client: builds correct URL and header for listPaidOrders", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};

  const mockFetch = async (url: string, opts?: RequestInit) => {
    capturedUrl = url as string;
    capturedHeaders = (opts?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ orders: [makeOrder()] }), { status: 200 });
  };

  const client = createApiClient({
    apiUrl: "https://api.test",
    adminApiKey: "test-key",
    fetchFn: mockFetch as typeof fetch,
  });

  const orders = await client.listPaidOrders(5);
  assert.equal(capturedUrl, "https://api.test/api/audit/orders?status=paid&limit=5");
  assert.equal(capturedHeaders["x-admin-api-key"], "test-key");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, "order-1");
});

test("api-client: non-2xx throws ApiError with status", async () => {
  const mockFetch = async () =>
    new Response("Unauthorized", { status: 401 });

  const client = createApiClient({
    apiUrl: "https://api.test",
    adminApiKey: "bad-key",
    fetchFn: mockFetch as typeof fetch,
  });

  await assert.rejects(
    () => client.listPaidOrders(),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test("api-client: claimOrder 409 throws OrderAlreadyClaimed", async () => {
  const mockFetch = async () => new Response("conflict", { status: 409 });

  const client = createApiClient({
    apiUrl: "https://api.test",
    adminApiKey: "k",
    fetchFn: mockFetch as typeof fetch,
  });

  await assert.rejects(
    () => client.claimOrder("order-x"),
    (err: unknown) => {
      assert.ok(err instanceof OrderAlreadyClaimed);
      assert.equal(err.name, "OrderAlreadyClaimed");
      return true;
    }
  );
});

test("api-client: reportOrder sends correct body", async () => {
  let capturedBody = "";

  const mockFetch = async (_url: string, opts?: RequestInit) => {
    capturedBody = opts?.body as string;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createApiClient({
    apiUrl: "https://api.test",
    adminApiKey: "k",
    fetchFn: mockFetch as typeof fetch,
  });

  await client.reportOrder("order-1", {
    report_md: "# Report",
    severity_counts: { high: 0, medium: 0, low: 1, info: 2 },
    verdict: "PASS",
  });

  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal(body.verdict, "PASS");
  assert.deepEqual(body.severity_counts, { high: 0, medium: 0, low: 1, info: 2 });
});
