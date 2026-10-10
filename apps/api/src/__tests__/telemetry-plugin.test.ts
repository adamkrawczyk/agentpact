import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import telemetryPlugin, { classifyClient, type UsageRow } from "../plugins/telemetry.js";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// honest_0710 phase D — api_usage writer. The gates in plan v3.1 are read
// from these rows, so the writer must (a) store route templates, (b) never put
// the database on the request path, (c) never turn a DB failure into a
// request failure.

async function standaloneApp(opts: Parameters<typeof telemetryPlugin>[1]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(telemetryPlugin, opts);
  app.get("/things/:id", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("telemetry plugin (isolated, mocked writer)", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("records the route template, method, status, duration and client kind — never the raw URL or UA", async () => {
    const written: UsageRow[] = [];
    app = await standaloneApp({ writer: async (rows) => { written.push(...rows); }, flushIntervalMs: 60_000 });
    const id = randomUUID();
    const res = await app.inject({ method: "GET", url: `/things/${id}?secret=1`, headers: { "user-agent": "agentpact-sdk/0.2.0" } });
    expect(res.statusCode).toBe(200);
    await app.telemetry.flush();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ endpoint: "/things/:id", method: "GET", statusCode: 200, clientKind: "sdk", agentId: null });
    expect(Number.isInteger(written[0].durationMs)).toBe(true);
    expect(JSON.stringify(written[0])).not.toContain(id);
    expect(JSON.stringify(written[0])).not.toContain("agentpact-sdk");
  });

  it("stores unknown routes as <unmatched>", async () => {
    const written: UsageRow[] = [];
    app = await standaloneApp({ writer: async (rows) => { written.push(...rows); }, flushIntervalMs: 60_000 });
    const res = await app.inject({ method: "GET", url: "/no/such/route/abc123" });
    expect(res.statusCode).toBe(404);
    await app.telemetry.flush();
    expect(written.map((r) => r.endpoint)).toEqual(["<unmatched>"]);
  });

  it("a throwing insert never changes the response; the error is swallowed and counted", async () => {
    let calls = 0;
    app = await standaloneApp({
      writer: async () => { calls++; throw new Error("db down"); },
      flushIntervalMs: 60_000,
    });
    const res = await app.inject({ method: "GET", url: `/things/${randomUUID()}` });
    expect(res.statusCode).toBe(200);
    await expect(app.telemetry.flush()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(app.telemetry.stats()).toMatchObject({ flushFailures: 1, rowsLost: 1, rowsWritten: 0 });
  });

  it("the request path does not await the insert (slow writer, latency unaffected)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    app = await standaloneApp({
      // maxBatch 1 → every request triggers a flush immediately.
      writer: async () => { started++; await gate; },
      maxBatch: 1,
      flushIntervalMs: 60_000,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const t0 = performance.now();
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/things/${randomUUID()}`);
      expect(res.status).toBe(200);
      await res.text();
    }
    const elapsed = performance.now() - t0;

    // The writer is still blocked: three requests completed while the first
    // insert never returned.
    expect(started).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(1_000);
    release();
    await app.telemetry.flush();
    expect(app.telemetry.stats().rowsWritten).toBe(3);
  });

  it("bounded queue: overflow is dropped and counted, not buffered without limit", async () => {
    const written: UsageRow[] = [];
    app = await standaloneApp({
      writer: async (rows) => { written.push(...rows); },
      maxQueue: 2,
      maxBatch: 100,
      flushIntervalMs: 60_000,
    });
    for (let i = 0; i < 5; i++) await app.inject({ method: "GET", url: `/things/${i}` });
    expect(app.telemetry.stats()).toMatchObject({ queued: 2, dropped: 3 });
    await app.telemetry.flush();
    expect(written).toHaveLength(2);
  });

  it("flushes by size with ONE writer call per batch", async () => {
    const batches: number[] = [];
    app = await standaloneApp({ writer: async (rows) => { batches.push(rows.length); }, maxBatch: 3, flushIntervalMs: 60_000 });
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: `/things/${i}` });
    await app.telemetry.flush();
    expect(batches).toEqual([3]);
  });

  it("flushes by time", async () => {
    const written: UsageRow[] = [];
    app = await standaloneApp({ writer: async (rows) => { written.push(...rows); }, flushIntervalMs: 50 });
    await app.inject({ method: "GET", url: "/things/1" });
    await new Promise((r) => setTimeout(r, 250));
    expect(written).toHaveLength(1);
  });

  it("flushes the remaining queue on close", async () => {
    const written: UsageRow[] = [];
    const local = await standaloneApp({ writer: async (rows) => { written.push(...rows); }, flushIntervalMs: 60_000 });
    await local.inject({ method: "GET", url: "/things/1" });
    expect(written).toHaveLength(0);
    await local.close();
    expect(written).toHaveLength(1);
  });

  it("classifies clients coarsely", () => {
    expect(classifyClient({ "user-agent": "agentpact-mcp/1.0" })).toBe("mcp");
    expect(classifyClient({ "mcp-protocol-version": "2025-06-18" })).toBe("mcp");
    expect(classifyClient({ "user-agent": "agentpact-sdk/0.2.0" })).toBe("sdk");
    expect(classifyClient({ "user-agent": "agentpact-python/0.1.0" })).toBe("sdk");
    expect(classifyClient({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130" })).toBe("browser");
    expect(classifyClient({ "user-agent": "curl/8.5.0" })).toBe("other");
    expect(classifyClient({})).toBe("other");
  });
});

describe("telemetry plugin (wired into the API, real Postgres)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("one request → exactly one api_usage row with the route template", async () => {
    const { app, sql } = await createTestApp();
    await app.telemetry.flush(); // drain whatever earlier setup produced
    await sql`TRUNCATE api_usage`;

    const dealId = randomUUID();
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}`, headers: { "user-agent": "agentpact-sdk/0.2.0" } });
    await app.telemetry.flush();

    const rows = await sql`SELECT endpoint, method, status_code, response_time_ms, client_kind, agent_id FROM api_usage`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: "/api/deals/:id",
      method: "GET",
      status_code: res.statusCode,
      client_kind: "sdk",
      agent_id: null,
    });
    expect(Number(rows[0].response_time_ms)).toBeGreaterThanOrEqual(0);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM api_usage WHERE endpoint LIKE ${"%" + dealId + "%"}`;
    expect(n).toBe(0);
  });

  it("attributes the caller's agent id — also on public routes where auth is optional", async () => {
    const { app, sql } = await createTestApp();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId);
    await app.telemetry.flush();
    await sql`TRUNCATE api_usage`;

    await app.inject({ method: "GET", url: `/api/deals/${randomUUID()}`, headers });
    await app.inject({ method: "GET", url: "/api/deals", headers });
    await app.telemetry.flush();

    const rows = await sql`SELECT endpoint, agent_id FROM api_usage ORDER BY endpoint`;
    expect(rows.map((r) => [r.endpoint, r.agent_id])).toEqual([
      ["/api/deals", agentId],
      ["/api/deals/:id", agentId],
    ]);
  });

  it("prune_api_usage(days) deletes only rows older than the window and rejects days < 1", async () => {
    const { app, sql } = await createTestApp();
    await app.telemetry.flush();
    await sql`TRUNCATE api_usage`;
    await sql`
      INSERT INTO api_usage (endpoint, method, created_at) VALUES
        ('/old', 'GET', NOW() - INTERVAL '91 days'),
        ('/edge', 'GET', NOW() - INTERVAL '89 days'),
        ('/new', 'GET', NOW())`;
    const [{ deleted }] = await sql`SELECT prune_api_usage() AS deleted`;
    expect(Number(deleted)).toBe(1);
    const rest = await sql`SELECT endpoint FROM api_usage ORDER BY endpoint`;
    expect(rest.map((r) => r.endpoint)).toEqual(["/edge", "/new"]);
    const [{ deleted: d2 }] = await sql`SELECT prune_api_usage(1) AS deleted`;
    expect(Number(d2)).toBe(1);
    await expect(sql`SELECT prune_api_usage(0)`).rejects.toThrow(/days must be >= 1/);
  });
});
