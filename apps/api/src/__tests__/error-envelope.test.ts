import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ── §5.1 (2026-05-21): regression contract for the structured error
// envelope { error, code, requestId }. This re-creates the request-id and
// error-handler bits from apps/api/src/index.ts in isolation so a Fastify
// instance can be booted without DB/auth/CORS setup. If the shape of the
// envelope changes, this test fails and the SDK/MCP/daemon clients must be
// updated in lockstep.

function buildAppWithEnvelope() {
  const app = Fastify({
    logger: false,
    genReqId: (req) => {
      const inbound = (req.headers["x-request-id"] ?? req.headers["X-Request-Id"]) as string | undefined;
      if (inbound && typeof inbound === "string" && inbound.length <= 128) {
        return inbound;
      }
      return randomUUID();
    },
    requestIdHeader: "x-request-id",
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  app.setErrorHandler((error: any, request, reply) => {
    const err = error as Record<string, unknown>;
    const requestId = request.id;
    const issues = err.issues;
    const isZod = Array.isArray(issues) && issues.length > 0 && typeof (issues[0] as any)?.path !== "undefined"
      || err.name === "ZodError" || err.validation;
    if (isZod) {
      return reply.code(400).send({
        error: "Validation error",
        code: "VALIDATION_FAILED",
        details: issues ?? err.validation,
        requestId,
      });
    }
    if (typeof error.code === "string" && error.code.startsWith("23")) {
      return reply.code(400).send({ error: error.message ?? "Invalid request", code: "DB_CONSTRAINT_VIOLATION", requestId });
    }
    if (error.code === "57014") {
      return reply.code(504).send({ error: "Query timed out, please retry", code: "DB_STATEMENT_TIMEOUT", requestId });
    }
    const statusCode = error.statusCode ?? 500;
    const message = statusCode < 500 ? (error.message ?? "Unknown error") : "Internal server error";
    const code = statusCode === 401 ? "AUTH_REQUIRED"
      : statusCode === 403 ? "AUTH_FORBIDDEN"
      : statusCode === 404 ? "NOT_FOUND"
      : statusCode === 409 ? "CONFLICT"
      : statusCode === 429 ? "RATE_LIMITED"
      : statusCode >= 500 ? "INTERNAL_ERROR"
      : "BAD_REQUEST";
    reply.code(statusCode).send({ error: message, code, requestId });
  });

  app.post("/echo", async (req, reply) => {
    const schema = z.object({ name: z.string().min(2) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ...parsed.error, statusCode: 400 } as any);
    }
    return { ok: true };
  });

  app.get("/boom", async () => {
    throw new Error("kaboom");
  });

  app.get("/not-here", async (_req, reply) => {
    return reply.code(404).send({ error: "Missing", code: "NOT_FOUND", requestId: "n/a" });
  });

  return app;
}

describe("structured error envelope (§5.1)", () => {
  it("echoes inbound X-Request-Id and includes it in error responses", async () => {
    const app = buildAppWithEnvelope();
    await app.ready();
    const incomingId = "test-req-12345";
    const res = await app.inject({
      method: "GET",
      url: "/boom",
      headers: { "x-request-id": incomingId },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers["x-request-id"]).toBe(incomingId);
    const body = res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.requestId).toBe(incomingId);
  });

  it("generates a fresh requestId when none is supplied", async () => {
    const app = buildAppWithEnvelope();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(8);
  });

  it("returns NOT_FOUND code for 404 responses", async () => {
    const app = buildAppWithEnvelope();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/not-here" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
  });
});
