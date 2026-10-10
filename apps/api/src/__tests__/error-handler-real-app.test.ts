import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestApp, getAuthHeaders } from "./helpers/testApp.js";

// Regression for the global error handler's REGISTRATION ORDER.
//
// error-envelope.test.ts pins the envelope shape on an isolated Fastify copy of
// the handler, so it cannot see where index.ts registers it. Fastify binds a
// route's error handler when the route is flushed (every `await app.register`),
// not at ready(): when setErrorHandler sat below the route registrations, every
// route registered earlier silently kept Fastify's default handler. A non-uuid
// :id then reached Postgres, raised 22P02, and surfaced as a 500 that leaked the
// raw driver message, while Zod failures came back in Fastify's default body
// instead of VALIDATION_FAILED.
//
// These tests drive the REAL app and assert the documented envelope
// ({ error, code, requestId[, details] }, docs/agent-integration-guide.md).

const ADMIN_KEY = "test-admin-key-error-handler";
const JUNK = "not-a-uuid";

type Envelope = { error: unknown; code: unknown; requestId: unknown; details?: unknown };

function expectEnvelope(
  res: { statusCode: number; body: string; headers: Record<string, unknown> },
  status: number,
  code: string,
): Envelope {
  expect(res.statusCode, res.body).toBe(status);
  const body = JSON.parse(res.body) as Envelope;
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
  expect((body.error as string).length).toBeGreaterThan(0);
  expect(typeof body.requestId).toBe("string");
  // requestId in the body is the same correlation id echoed in the header.
  expect(body.requestId).toBe(res.headers["x-request-id"]);
  // Fastify's default error body must not leak through any more.
  expect(body).not.toHaveProperty("statusCode");
  return body;
}

describe("global error handler governs every route (real app)", () => {
  let auth: Record<string, string>;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { app } = await createTestApp();
    await app.ready();
    auth = await getAuthHeaders();
  });

  it("setErrorHandler is registered before any route or plugin in index.ts", () => {
    const raw = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    // Blank out comment-only lines (keeping offsets meaningful) so prose that
    // mentions `app.register(...)` cannot satisfy or defeat the order check.
    const src = raw
      .split("\n")
      .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
      .join("\n");
    const handlerAt = src.indexOf("app.setErrorHandler(");
    expect(handlerAt).toBeGreaterThan(0);
    const firstRoute = src.search(/\bapp\.(get|post|put|patch|delete|route|register)\(/);
    expect(firstRoute).toBeGreaterThan(0);
    expect(handlerAt).toBeLessThan(firstRoute);
    expect(src.indexOf("registerHealthChecks(app")).toBeGreaterThan(handlerAt);
    // The onError "fallback" violated Fastify's hook contract and is gone.
    expect(src).not.toMatch(/addHook\(\s*['"]onError['"]/);
  });

  const junkIdCases: Array<{ area: string; method: "GET" | "PATCH"; url: string; withAuth?: boolean; admin?: boolean; payload?: unknown }> = [
    { area: "deals", method: "GET", url: `/api/deals/${JUNK}` },
    { area: "offers", method: "GET", url: `/api/offers/${JUNK}` },
    { area: "needs", method: "GET", url: `/api/needs/${JUNK}` },
    { area: "intents", method: "GET", url: `/api/intents/${JUNK}`, withAuth: true },
    { area: "fulfillment", method: "GET", url: `/api/deals/${JUNK}/fulfillment`, withAuth: true },
    { area: "payments", method: "GET", url: `/api/deals/${JUNK}/payment-methods` },
    { area: "audit-orders", method: "PATCH", url: `/api/audit/orders/${JUNK}/claim`, admin: true },
  ];

  for (const c of junkIdCases) {
    it(`${c.area}: ${c.method} ${c.url} -> 400 DB_DATA_EXCEPTION, not 500`, async () => {
      const { app } = await createTestApp();
      const headers: Record<string, string> = {};
      if (c.withAuth) Object.assign(headers, auth);
      if (c.admin) headers["x-admin-api-key"] = ADMIN_KEY;
      const res = await app.inject({ method: c.method, url: c.url, headers, payload: c.payload as never });
      expectEnvelope(res, 400, "DB_DATA_EXCEPTION");
    });
  }

  it("a Zod failure thrown by a route handler -> 400 VALIDATION_FAILED with issue details", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ agentId: "junk" }),
    });
    const body = expectEnvelope(res, 400, "VALIDATION_FAILED");
    expect(body.error).toBe("Validation error");
    expect(Array.isArray(body.details)).toBe(true);
    expect((body.details as unknown[]).length).toBeGreaterThan(0);
    expect((body.details as Array<{ path?: unknown }>)[0]).toHaveProperty("path");
  });

  it("an unparseable JSON body -> 400 BAD_REQUEST envelope", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not json",
    });
    expectEnvelope(res, 400, "BAD_REQUEST");
  });

  it("honours an inbound x-request-id in the error envelope", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: `/api/deals/${JUNK}`, headers: { "x-request-id": "trace-abc-123" } });
    const body = expectEnvelope(res, 400, "DB_DATA_EXCEPTION");
    expect(body.requestId).toBe("trace-abc-123");
  });
});
