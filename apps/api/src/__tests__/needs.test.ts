import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, getAuthHeaders } from "./helpers/testApp.js";

describe("Needs API", () => {
  let authHeaders: Record<string, string>;
  let agentId: string;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    authHeaders = await getAuthHeaders();

    const agentRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders,
      payload: generateTestAgent()
    });
    agentId = (JSON.parse(agentRes.body) as { id: string }).id;
  });

  it("should create a need", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: authHeaders,
      payload: generateTestNeed(agentId)
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { id: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("open");
  });

  it("should list open needs", async () => {
    const { app } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: authHeaders,
      payload: generateTestNeed(agentId)
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/needs",
      headers: authHeaders
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as unknown[];
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("should archive a need", async () => {
    const { app } = await createTestApp();
    const createRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: authHeaders,
      payload: generateTestNeed(agentId)
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const archiveRes = await app.inject({
      method: "POST",
      url: `/api/needs/${id}/archive`,
      headers: authHeaders
    });
    expect(archiveRes.statusCode).toBe(200);
    const archived = JSON.parse(archiveRes.body) as { status: string };
    expect(archived.status).toBe("archived");
  });
});
