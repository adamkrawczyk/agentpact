import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { initAuth } from "../auth.js";

const agentId = "550e8400-e29b-41d4-a716-446655440000";
const walletAddress = "0x1234567890123456789012345678901234567890";

function createMockSql() {
  const credentialsByHash = new Map<string, { agentId: string; walletAddress: string | null; revoked: boolean }>();
  const credentialHashesByAgentId = new Map<string, string>();

  const mockSql = async (template: TemplateStringsArray, ...parameters: readonly unknown[]) => {
    const statement = template.join(" ");

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

  return mockSql;
}

describe("Auth", () => {
  it("Register agent API key", async () => {
    const app = Fastify();
    await initAuth(app, createMockSql());

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
    await initAuth(app, createMockSql());

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
    await initAuth(app, createMockSql());

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
    await initAuth(app, createMockSql());

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
    await initAuth(app, createMockSql());

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
    await initAuth(app, createMockSql());

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
    await initAuth(app, createMockSql());

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
