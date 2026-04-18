import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { initAuth } from "../auth.js";

const agentId = "550e8400-e29b-41d4-a716-446655440000";
const walletAddress = "0x1234567890123456789012345678901234567890";

function createMockSql() {
  const credentialsByHash = new Map<string, { agentId: string; walletAddress: string | null; revoked: boolean }>();
  const credentialHashesByAgentId = new Map<string, string>();
  const webhooksByAgentId = new Map<string, { id: string; url: string; secret: string; events: string[] }>();

  const mockSql = async (template: TemplateStringsArray, ...parameters: readonly unknown[]) => {
    const statement = template.join(" ");

    if (statement.includes("INSERT INTO agent_webhooks")) {
      // parameters: agent_id, url, secret, events
      const [whAgentId, whUrl, whSecret, whEvents] = parameters as [string, string, string, string[]];
      const whId = randomUUID();
      webhooksByAgentId.set(whAgentId, { id: whId, url: whUrl, secret: whSecret, events: whEvents });
      return [{ id: whId, url: whUrl, events: whEvents, active: true, created_at: new Date().toISOString() }];
    }

    if (statement.includes("INSERT INTO agent_credentials")) {
      const [registeredAgentId, registeredWalletAddress, apiKeyHash] = parameters as [string, string | null, string];
      if (credentialHashesByAgentId.has(registeredAgentId)) {
        return [];
      }

      credentialHashesByAgentId.set(registeredAgentId, apiKeyHash);
      credentialsByHash.set(apiKeyHash, {
        agentId: registeredAgentId,
        walletAddress: registeredWalletAddress,
        revoked: false
      });
      return [{ agent_id: registeredAgentId }];
    }

    if (statement.includes("SELECT agent_id, wallet_address")) {
      const [apiKeyHash] = parameters as [string];
      const found = credentialsByHash.get(apiKeyHash);
      if (!found || found.revoked) {
        return [];
      }
      return [{ agent_id: found.agentId, wallet_address: found.walletAddress }];
    }

    if (statement.includes("UPDATE agent_credentials")) {
      const [apiKeyHash] = parameters as [string];
      const found = credentialsByHash.get(apiKeyHash);
      if (found) {
        found.revoked = true;
      }
      return [];
    }

    return [];
  };

  return { mockSql, webhooksByAgentId };
}

describe("Auth", () => {
  it("Register agent API key", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress
      }
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { apiKey: string };
    expect(body.apiKey).toBeTruthy();
    expect(body.apiKey.length).toBe(64);
    await app.close();
  });

  it("registers an agent API key without a wallet address", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
      }
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { apiKey: string; agentId: string };
    expect(body.apiKey).toBeTruthy();
    expect(body.agentId).toBe(agentId);
    await app.close();
  });

  it("rejects duplicate registration for an existing agent", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress
      }
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress: "0x9999999999999999999999999999999999999999"
      }
    });

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(409);
    expect(JSON.parse(secondResponse.body)).toEqual({
      error: "Agent already registered. Use /api/auth/rotate-key to update credentials."
    });
    await app.close();
  });

  it("Verify valid API key", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const registerRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress
      }
    });
    const registerBody = JSON.parse(registerRes.body) as { apiKey: string };

    const verifyRes = await app.inject({
      method: "GET",
      url: "/api/auth/verify",
      headers: {
        "x-api-key": registerBody.apiKey
      }
    });

    expect(verifyRes.statusCode).toBe(200);
    const body = JSON.parse(verifyRes.body) as { agentId: string };
    expect(body.agentId).toBe(agentId);
    await app.close();
  });

  it("Reject invalid API key", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/verify",
      headers: {
        "x-api-key": "invalid_key"
      }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("Protected route requires API key", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    app.get(
      "/api/protected",
      {
        preHandler: app.authenticate
      },
      async () => ({ success: true })
    );

    const noKeyRes = await app.inject({
      method: "GET",
      url: "/api/protected"
    });
    expect(noKeyRes.statusCode).toBe(401);

    const registerRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress: "0x1234"
      }
    });
    const registerBody = JSON.parse(registerRes.body) as { apiKey: string };

    const withKeyRes = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: {
        "x-api-key": registerBody.apiKey
      }
    });
    expect(withKeyRes.statusCode).toBe(200);
    await app.close();
  });

  it("/api/auth/verify does not apply rate limiting", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const registerRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress
      }
    });
    const registerBody = JSON.parse(registerRes.body) as { apiKey: string };

    for (let i = 0; i < 6; i += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/verify",
        headers: {
          "x-api-key": registerBody.apiKey
        }
      });
      expect(response.statusCode).toBe(200);
    }

    await app.close();
  });
});

describe("Auth — Webhook at Registration (WIS-245)", () => {
  it("auto-creates webhook when webhookUrl is provided", async () => {
    const app = Fastify();
    const { mockSql, webhooksByAgentId } = createMockSql();
    await initAuth(app, mockSql);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress,
        webhookUrl: "https://example.com/webhook"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      agentId: string;
      apiKey: string;
      webhook: { id: string; url: string; secret: string; events: string[]; active: boolean };
    };
    expect(body.apiKey).toBeTruthy();
    expect(body.agentId).toBe(agentId);
    expect(body.webhook).toBeDefined();
    expect(body.webhook.url).toBe("https://example.com/webhook");
    expect(body.webhook.secret).toBeTruthy();
    expect(body.webhook.secret.length).toBe(64); // 32 bytes hex
    expect(body.webhook.active).toBe(true);
    // Should have default events
    expect(body.webhook.events.length).toBeGreaterThan(0);

    // Verify it was stored in our mock
    expect(webhooksByAgentId.has(agentId)).toBe(true);
    await app.close();
  });

  it("auto-creates webhook with custom events", async () => {
    const app = Fastify();
    const { mockSql, webhooksByAgentId } = createMockSql();
    await initAuth(app, mockSql);

    const customEvents = ["deal.proposed", "concierge.message"];
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress,
        webhookUrl: "https://myapp.com/hook",
        webhookEvents: customEvents
      }
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      webhook: { events: string[] };
    };
    expect(body.webhook).toBeDefined();
    expect(body.webhook.events).toEqual(customEvents);

    const stored = webhooksByAgentId.get(agentId);
    expect(stored?.events).toEqual(customEvents);
    await app.close();
  });

  it("does not create webhook when webhookUrl is omitted", async () => {
    const app = Fastify();
    const { mockSql, webhooksByAgentId } = createMockSql();
    await initAuth(app, mockSql);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress
      }
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      agentId: string;
      apiKey: string;
      webhook?: unknown;
    };
    expect(body.webhook).toBeUndefined();
    expect(webhooksByAgentId.has(agentId)).toBe(false);
    await app.close();
  });

  it("rejects invalid webhookUrl", async () => {
    const app = Fastify();
    const { mockSql } = createMockSql();
    await initAuth(app, mockSql);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress,
        webhookUrl: "not-a-valid-url"
      }
    });

    // Zod validation rejects the invalid URL — in unit tests without the full
    // app error handler this surfaces as 500; in production the custom error
    // handler maps ZodError to 400.
    expect([400, 500]).toContain(response.statusCode);
    const body = JSON.parse(response.body) as { error?: string };
    // No webhook should be created, and no apiKey returned on error
    expect(body).not.toHaveProperty("apiKey");
    await app.close();
  });

  it("registration still succeeds if webhook creation fails", async () => {
    // Create a mock that fails on webhook insert
    const credentialsByHash = new Map<string, { agentId: string; walletAddress: string | null; revoked: boolean }>();
    const credentialHashesByAgentId = new Map<string, string>();

    const failingMockSql = async (template: TemplateStringsArray, ...parameters: readonly unknown[]) => {
      const statement = template.join(" ");

      if (statement.includes("INSERT INTO agent_webhooks")) {
        throw new Error("Webhook table does not exist");
      }

      if (statement.includes("INSERT INTO agent_credentials")) {
        const [registeredAgentId, registeredWalletAddress, apiKeyHash] = parameters as [string, string | null, string];
        if (credentialHashesByAgentId.has(registeredAgentId)) {
          return [];
        }
        credentialHashesByAgentId.set(registeredAgentId, apiKeyHash);
        credentialsByHash.set(apiKeyHash, {
          agentId: registeredAgentId,
          walletAddress: registeredWalletAddress,
          revoked: false
        });
        return [{ agent_id: registeredAgentId }];
      }

      if (statement.includes("SELECT agent_id, wallet_address")) {
        const [apiKeyHash] = parameters as [string];
        const found = credentialsByHash.get(apiKeyHash);
        if (!found || found.revoked) return [];
        return [{ agent_id: found.agentId, wallet_address: found.walletAddress }];
      }

      return [];
    };

    const app = Fastify();
    await initAuth(app, failingMockSql);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        agentId,
        walletAddress,
        webhookUrl: "https://example.com/webhook"
      }
    });

    // Registration should succeed even though webhook creation failed
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { apiKey: string; webhook?: unknown };
    expect(body.apiKey).toBeTruthy();
    expect(body.webhook).toBeUndefined();
    await app.close();
  });
});
