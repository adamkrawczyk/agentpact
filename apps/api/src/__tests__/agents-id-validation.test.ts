import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, getAuthHeadersForAgent } from "./helpers/testApp.js";

// GET /api/agents/:id (and its read-only siblings) used to pass the raw path
// segment straight into a uuid-typed query. A non-uuid value such as "me" made
// Postgres raise 22P02 and the request came back as a 500. The :id must be
// validated before any query runs: malformed -> 400, well-formed but unknown
// -> 404, existing -> 200.

const MALFORMED_IDS = [
  "me",
  "self",
  "not-a-uuid",
  "123",
  "00000000-0000-0000-0000-00000000000g",
  "550e8400-e29b-41d4-a716-44665544000", // one char short
  "550e8400e29b41d4a716446655440000", // no hyphens
  "%27%3B%20DROP%20TABLE%20agents%3B--", // url-encoded injection attempt
  "%00",
];

const READ_ROUTES = [
  (id: string) => `/api/agents/${id}`,
  (id: string) => `/api/agents/${id}/verification`,
  (id: string) => `/api/agents/${id}/reputation`,
];

describe("GET /api/agents/:id path validation", () => {
  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
  });

  it("GET /api/agents/me -> 400 validation error, not 500", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/agents/me" });
    expect(res.statusCode).toBe(400);
    // Same 400 envelope as the sibling agentIdParamSchema routes (heartbeat,
    // presence, wallet): the message names the failing uuid check on "id".
    expect(res.body).toMatch(/uuid/i);
    expect(res.body).not.toMatch(/invalid input syntax/i);
  });

  it("valid-but-nonexistent uuid -> 404", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: `/api/agents/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: "Agent not found" });
  });

  it("existing agent id -> 200 with the expected shape", async () => {
    const { app } = await createTestApp();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId);
    const agent = generateTestAgent();
    const created = await app.inject({ method: "POST", url: "/api/agents", headers, payload: agent });
    expect(created.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      id: string;
      handle: string;
      display_name: string;
      reputation: { score: number; reviewCount: number };
      trustTier: unknown;
    };
    expect(body.id).toBe(agentId);
    expect(body.handle).toBe(agent.handle);
    expect(body.display_name).toBe(agent.displayName);
    expect(typeof body.reputation.score).toBe("number");
    expect(body.reputation.reviewCount).toBe(0);
    expect(body).toHaveProperty("trustTier");
  });

  it("uppercase uuid of an existing agent still resolves (200)", async () => {
    const { app } = await createTestApp();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId);
    await app.inject({ method: "POST", url: "/api/agents", headers, payload: generateTestAgent() });

    const res = await app.inject({ method: "GET", url: `/api/agents/${agentId.toUpperCase()}` });
    expect(res.statusCode).toBe(200);
  });

  for (const route of READ_ROUTES) {
    for (const bad of MALFORMED_IDS) {
      it(`${route(":id")} with id=${JSON.stringify(bad)} -> 4xx, never 5xx`, async () => {
        const { app } = await createTestApp();
        const res = await app.inject({ method: "GET", url: route(bad) });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      });
    }

    it(`${route(":id")} with unknown uuid -> 404`, async () => {
      const { app } = await createTestApp();
      const res = await app.inject({ method: "GET", url: route(randomUUID()) });
      expect(res.statusCode).toBe(404);
    });
  }
});
