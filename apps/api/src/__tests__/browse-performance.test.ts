import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Deps } from "../routes/types.js";
import { registerRoutes as registerNeedRoutes } from "../routes/needs.js";
import { registerRoutes as registerOfferRoutes } from "../routes/offers.js";

type CapturedSql = {
  statements: string[];
  values: unknown[][];
  sql: any;
};

function createSqlCapture(): CapturedSql {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    statements.push(strings.join("?"));
    values.push(params);
    return [];
  }) as any;
  return { statements, values, sql };
}

function createDeps(): Deps {
  return {
    computeTrustTier: () => ({ tier: "new", label: "New", color: "gray" }),
    getAgentStats: async () => ({ completedDeals: 0, reputationScore: 0 }),
    notifyAgents: async () => undefined,
    autoVerify: async () => ({ success: true, details: "not used" }),
    FULFILLMENT_TYPES: [],
    PLATFORM_FEE_PCT: 0,
    PLATFORM_WALLET: "0x0000000000000000000000000000000000000000",
    credentialEncryptionKey: Buffer.alloc(32),
    vaultSql: (() => []) as any,
    TRUST_TIERS: [],
    completeDealMilestones: async () => ({ mode: "simulation", action: "completed_without_onchain_release" }),
    storeBuyerContext: async (_fulfillmentId: string, _fulfillmentType: string, data: Record<string, unknown>) => data,
    retrieveBuyerContext: async (_fulfillmentId: string, data: Record<string, unknown>) => data,
  } as unknown as Deps;
}

function lastSelect(capture: CapturedSql): { statement: string; values: unknown[] } {
  for (let index = capture.statements.length - 1; index >= 0; index -= 1) {
    const statement = capture.statements[index] ?? "";
    if (statement.includes("SELECT")) {
      return { statement, values: capture.values[index] ?? [] };
    }
  }
  throw new Error("No SELECT statement captured");
}

describe("public browse SQL performance", () => {
  it("omits offer text search when query is blank", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).statement).not.toMatch(/\bILIKE\b/);
  });

  it("omits offer text search when query is whitespace", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?query=%20%20%20" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).statement).not.toMatch(/\bILIKE\b/);
  });

  it("keeps offer text search when query is non-empty", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?query=alpha" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).statement).toMatch(/\bILIKE\b/);
  });

  it("caps offer browse limits and preserves offsets", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?limit=500&offset=25" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).values).toContain(200);
    expect(lastSelect(capture).values).toContain(25);
  });

  it("records offer browse latency after returning results", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?limit=25&offset=5" });

    expect(response.statusCode).toBe(200);
    const auditIndex = capture.statements.findIndex((statement) => statement.includes("INSERT INTO audit_log"));
    expect(auditIndex).toBeGreaterThan(-1);
    expect(capture.values[auditIndex]).toContain("browse.latency");
    expect(JSON.parse(capture.values[auditIndex]?.at(-1) as string)).toMatchObject({
      endpoint: "/api/offers",
      resultCount: 0,
      limit: 25,
      offset: 5,
    });
  });

  it("records offer detail page views", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    const offerId = "550e8400-e29b-41d4-a716-446655440000";
    capture.sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
      capture.statements.push(strings.join("?"));
      capture.values.push(params);
      if (strings.join("?").includes("SELECT * FROM offers WHERE id")) {
        return [{ id: offerId, base_price: 100, tags: [] }];
      }
      return [];
    }) as any;
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: `/api/offers/${offerId}` });

    expect(response.statusCode).toBe(200);
    const auditIndex = capture.statements.findIndex((statement) => statement.includes("INSERT INTO audit_log"));
    expect(auditIndex).toBeGreaterThan(-1);
    expect(capture.values[auditIndex]).toContain("offer.view");
    expect(capture.values[auditIndex]).toContain(offerId);
  });

  it("caps offer browse offsets", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?offset=999999" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).values).toContain(1000);
  });

  it("omits grouped offer text search when query is blank", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers/grouped" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).statement).not.toMatch(/\bILIKE\b/);
  });

  it("omits need text search when query is blank", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerNeedRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/needs" });

    expect(response.statusCode).toBe(200);
    expect(lastSelect(capture).statement).not.toMatch(/\bILIKE\b/);
  });
});
