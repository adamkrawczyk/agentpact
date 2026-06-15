import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, getAuthHeaders, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Agents API", () => {
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    authHeaders = await getAuthHeaders();
  });

  describe("POST /api/agents", () => {
    it("should create a new agent", async () => {
      const { app } = await createTestApp();
      const agent = generateTestAgent();

      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: agent
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { id: string; handle: string; display_name: string };
      expect(body.id).toBeTruthy();
      expect(body.handle).toBe(agent.handle);
      expect(body.display_name).toBe(agent.displayName);
    });

    it("should update duplicate handle with ON CONFLICT", async () => {
      const { app } = await createTestApp();
      const agent = generateTestAgent();

      const first = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: agent
      });
      const firstBody = JSON.parse(first.body) as { id: string };

      const second = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: { ...agent, displayName: "Updated Agent Name" }
      });

      expect(second.statusCode).toBe(201);
      const secondBody = JSON.parse(second.body) as { id: string; display_name: string };
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.display_name).toBe("Updated Agent Name");
    });

    it("should validate required fields", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: { handle: "x" }
      });

      expect(response.statusCode).toBe(400);
    });

    it("should create a new agent without wallet details", async () => {
      const { app } = await createTestApp();
      const agent = generateTestAgent();

      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: {
          handle: agent.handle,
          displayName: agent.displayName,
          autoBuyEnabled: agent.autoBuyEnabled
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as {
        id: string;
        owner_wallet_address: string | null;
        wallet_provider: string | null;
      };
      expect(body.id).toBeTruthy();
      expect(body.owner_wallet_address).toBeNull();
      expect(body.wallet_provider).toBeNull();
    });
  });

  describe("PATCH /api/agents/:id/wallet", () => {
    it("should allow an agent to set its own wallet", async () => {
      const { app } = await createTestApp();
      const agentId = randomUUID();
      const agentHeaders = await getAuthHeadersForAgent(agentId);

      // Create agent via auth register (already done in getAuthHeadersForAgent), then set handle
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: agentHeaders,
        payload: {
          handle: `wallet-agent-${randomUUID().slice(0, 8)}`,
          displayName: "Wallet Agent"
        }
      });

      // The agent id from auth register is agentId, but POST /api/agents creates a DIFFERENT agent
      // We need to PATCH the agent created by auth register
      const response = await app.inject({
        method: "PATCH",
        url: `/api/agents/${agentId}/wallet`,
        headers: agentHeaders,
        payload: {
          walletAddress: "0x1234567890123456789012345678901234567890"
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        id: string;
        owner_wallet_address: string;
        wallet_provider: string;
      };
      expect(body.id).toBe(agentId);
      expect(body.owner_wallet_address).toBe("0x1234567890123456789012345678901234567890");
    });

    it("should reject wallet updates for another agent", async () => {
      const { app } = await createTestApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: {
          handle: `other-wallet-agent-${randomUUID().slice(0, 8)}`,
          displayName: "Other Wallet Agent"
        }
      });
      const { id } = JSON.parse(createRes.body) as { id: string };
      const otherHeaders = await getAuthHeadersForAgent("550e8400-e29b-41d4-a716-446655440123");

      const response = await app.inject({
        method: "PATCH",
        url: `/api/agents/${id}/wallet`,
        headers: otherHeaders,
        payload: {
          walletAddress: "0x1234567890123456789012345678901234567890",
          chain: "solana"
        }
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("GET /api/agents/count", () => {
    it("should return total and external agent counts", async () => {
      const { app } = await createTestApp();

      // Create one external agent (default — no PLATFORM_OWNER_WALLET match)
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: generateTestAgent()
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/agents/count"
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { total: number; external: number };
      expect(typeof body.total).toBe("number");
      expect(typeof body.external).toBe("number");
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.external).toBeGreaterThanOrEqual(0);
      expect(body.external).toBeLessThanOrEqual(body.total);
    });

    it("should not require authentication", async () => {
      const { app } = await createTestApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/agents/count"
        // No auth headers — this endpoint is intentionally public
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("GET /api/agents/:id/reputation", () => {
    it("should return default reputation for new agent", async () => {
      const { app } = await createTestApp();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: authHeaders,
        payload: generateTestAgent()
      });
      const { id } = JSON.parse(createRes.body) as { id: string };

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${id}/reputation`,
        headers: authHeaders
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { agent_id: string; overall_score: number; total_reviews: number };
      expect(body.agent_id).toBe(id);
      expect(body.overall_score).toBe(50); // NEUTRAL_REPUTATION_SCORE
      expect(body.total_reviews).toBe(0);
    });
  });
});
