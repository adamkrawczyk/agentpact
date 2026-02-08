import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, getAuthHeaders } from "./helpers/testApp.js";

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
      const body = JSON.parse(response.body) as { agentId: string; score: number; reviewCount: number };
      expect(body.agentId).toBe(id);
      expect(body.score).toBe(0);
      expect(body.reviewCount).toBe(0);
    });
  });
});
