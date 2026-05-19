import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerHealthChecks } from "../health.js";

type SqlLike = (template: TemplateStringsArray, ...parameters: readonly unknown[]) => Promise<unknown[]>;

function makeSql(impl: () => Promise<unknown>): SqlLike {
  return new Proxy(() => impl(), {
    apply: (_t, _this, args) => {
      const [tpl] = args as [TemplateStringsArray];
      if (!tpl) return impl();
      return impl();
    },
  }) as unknown as SqlLike;
}

async function buildApp(
  sql: SqlLike,
  options?: Parameters<typeof registerHealthChecks>[2],
) {
  const app = Fastify({ logger: false });
  registerHealthChecks(app, sql, options);
  await app.ready();
  return app;
}

describe("GET /api/health", () => {
  it("returns 200 with ok:true", async () => {
    const sql = makeSql(async () => [{ ok: 1 }]);
    const app = await buildApp(sql);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "agentpact-api" });
  });
});

describe("GET /api/health/db", () => {
  it("returns 200 when DB responds", async () => {
    const sql = makeSql(async () => [{ ok: 1 }]);
    const app = await buildApp(sql);
    const res = await app.inject({ method: "GET", url: "/api/health/db" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { database: { status: "healthy" } } });
  });

  it("returns 503 when DB times out", async () => {
    const sql = makeSql(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("connection refused")), 10)));
    const app = await buildApp(sql, {});
    vi.stubEnv("HEALTH_DB_TIMEOUT_MS", "5");
    const res = await app.inject({ method: "GET", url: "/api/health/db" });
    vi.unstubAllEnvs();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, checks: { database: { status: "unhealthy" } } });
  });
});

describe("GET /api/health/matching", () => {
  it("returns degraded when no status callback is registered", async () => {
    const sql = makeSql(async () => []);
    const app = await buildApp(sql, {});
    const res = await app.inject({ method: "GET", url: "/api/health/matching" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, checks: { matching: { status: "degraded", observable: false } } });
  });

  it("returns healthy when queue is idle", async () => {
    const sql = makeSql(async () => []);
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({
        dirty: false,
        inFlight: false,
        lastStartedAt: new Date().toISOString(),
        lastFinishedAt: new Date().toISOString(),
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/health/matching" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { matching: { status: "healthy", stuck: false } } });
  });

  it("returns degraded when queue has lastError", async () => {
    const sql = makeSql(async () => []);
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({
        dirty: false,
        inFlight: false,
        lastError: "DB connection lost",
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/health/matching" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, checks: { matching: { status: "degraded" } } });
  });
});

describe("GET /api/health/agent-runtime", () => {
  it("returns ok:true when DB is reachable and matching is idle", async () => {
    const sql = makeSql(async () => [{ id: "a" }]);
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({ dirty: false, inFlight: false }),
      routeInventoryPath: "/dev/null",
    });
    const res = await app.inject({ method: "GET", url: "/api/health/agent-runtime" });
    const body = res.json();
    expect(body.checks.database.status).toBe("healthy");
    expect(body.checks.browseSmoke.status).toBe("healthy");
    expect(body.ok).toBe(true);
  });

  it("returns ok:false when DB is down even if informational checks are fine", async () => {
    const sql = makeSql(async () => { throw new Error("no connection"); });
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({ dirty: false, inFlight: false }),
      routeInventoryPath: "/dev/null",
    });
    const res = await app.inject({ method: "GET", url: "/api/health/agent-runtime" });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
  });

  it("returns ok:false when matching is stuck", async () => {
    const sql = makeSql(async () => [{ id: "b" }]);
    const startedLongAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({
        dirty: true,
        inFlight: true,
        lastStartedAt: startedLongAgo,
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/health/agent-runtime" });
    const body = res.json();
    expect(body.checks.matching.stuck).toBe(true);
    expect(body.ok).toBe(false);
  });

  it("returns ok:true when TEST_DATABASE_URL is not set (informational only)", async () => {
    const saved = process.env.TEST_DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    const sql = makeSql(async () => [{ id: "c" }]);
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({ dirty: false, inFlight: false }),
      routeInventoryPath: "/dev/null",
    });
    const res = await app.inject({ method: "GET", url: "/api/health/agent-runtime" });
    const body = res.json();
    expect(body.checks.testDatabase.status).toBe("degraded");
    expect(body.ok).toBe(true);
    if (saved !== undefined) process.env.TEST_DATABASE_URL = saved;
  });

  it("returns ok:true when registration is intentionally disabled", async () => {
    const saved = process.env.AGENTPACT_REGISTRATION_DISABLED;
    process.env.AGENTPACT_REGISTRATION_DISABLED = "true";
    const sql = makeSql(async () => [{ id: "d" }]);
    const app = await buildApp(sql, {
      matchingQueueStatus: () => ({ dirty: false, inFlight: false }),
      routeInventoryPath: "/dev/null",
    });
    const res = await app.inject({ method: "GET", url: "/api/health/agent-runtime" });
    const body = res.json();
    expect(body.checks.registration.intentionallyDisabled).toBe(true);
    expect(body.ok).toBe(true);
    if (saved !== undefined) {
      process.env.AGENTPACT_REGISTRATION_DISABLED = saved;
    } else {
      delete process.env.AGENTPACT_REGISTRATION_DISABLED;
    }
  });
});
