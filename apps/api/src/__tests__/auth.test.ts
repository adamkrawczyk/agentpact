import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { initAuth } from "../auth.js";

const agentId = "550e8400-e29b-41d4-a716-446655440000";
const walletAddress = "0x1234567890123456789012345678901234567890";

function createMockSql() {
  const credentials = new Map<string, { agentId: string; walletAddress: string; revoked: boolean }>();

  const mockSql = async (template: TemplateStringsArray, ...parameters: readonly unknown[]) => {
    const statement = template.join(" ");

    if (statement.includes("INSERT INTO agent_credentials")) {
      const [registeredAgentId, registeredWalletAddress, apiKeyHash] = parameters as [string, string, string];
      credentials.set(apiKeyHash, {
        agentId: registeredAgentId,
        walletAddress: registeredWalletAddress,
        revoked: false
      });
      return [];
    }

    if (statement.includes("SELECT agent_id, wallet_address")) {
      const [apiKeyHash] = parameters as [string];
      const found = credentials.get(apiKeyHash);
      if (!found || found.revoked) {
        return [];
      }
      return [{ agent_id: found.agentId, wallet_address: found.walletAddress }];
    }

    if (statement.includes("UPDATE agent_credentials")) {
      const [apiKeyHash] = parameters as [string];
      const found = credentials.get(apiKeyHash);
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

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { apiKey: string };
    expect(body.apiKey).toBeTruthy();
    expect(body.apiKey.length).toBe(64);
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

  it("Rate Limiting blocks after limit exceeded", async () => {
    const app = Fastify();
    await initAuth(app, createMockSql());

    const apiKey = "test_key";

    for (let i = 0; i < 6; i += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/verify",
        headers: {
          "x-api-key": apiKey
        }
      });

      if (i < 5) {
        expect(response.statusCode).toBeLessThanOrEqual(401);
      } else {
        expect(response.statusCode).toBe(429);
      }
    }
    await app.close();
  });
});
