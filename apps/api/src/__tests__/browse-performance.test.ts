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

describe("public browse SQL performance", () => {
  it("omits offer text search when query is blank", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers" });

    expect(response.statusCode).toBe(200);
    expect(capture.statements.at(-1)).not.toMatch(/\bILIKE\b/);
  });

  it("omits offer text search when query is whitespace", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?query=%20%20%20" });

    expect(response.statusCode).toBe(200);
    expect(capture.statements.at(-1)).not.toMatch(/\bILIKE\b/);
  });

  it("keeps offer text search when query is non-empty", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?query=alpha" });

    expect(response.statusCode).toBe(200);
    expect(capture.statements.at(-1)).toMatch(/\bILIKE\b/);
  });

  it("caps offer browse limits and preserves offsets", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?limit=500&offset=25" });

    expect(response.statusCode).toBe(200);
    expect(capture.values.at(-1)).toContain(200);
    expect(capture.values.at(-1)).toContain(25);
  });

  it("caps offer browse offsets", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers?offset=999999" });

    expect(response.statusCode).toBe(200);
    expect(capture.values.at(-1)).toContain(1000);
  });

  it("omits grouped offer text search when query is blank", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerOfferRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/offers/grouped" });

    expect(response.statusCode).toBe(200);
    expect(capture.statements.at(-1)).not.toMatch(/\bILIKE\b/);
  });

  it("omits need text search when query is blank", async () => {
    const app = Fastify();
    const capture = createSqlCapture();
    await registerNeedRoutes(app, capture.sql, createDeps(), async () => 0);

    const response = await app.inject({ method: "GET", url: "/api/needs" });

    expect(response.statusCode).toBe(200);
    expect(capture.statements.at(-1)).not.toMatch(/\bILIKE\b/);
  });
});
