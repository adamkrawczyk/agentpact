/**
 * apps/api/src/__tests__/agent-verification.test.ts
 * GET /api/agents/:id/verification — public, no auth.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, cleanDatabase, generateTestAgent, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("GET /api/agents/:id/verification", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns verified:false and verified_at:null for a fresh agent", async () => {
    const { app } = await createTestApp();
    const testAgent = generateTestAgent();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId, { walletAddress: testAgent.ownerWalletAddress });
    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: {
        handle: testAgent.handle,
        displayName: testAgent.displayName,
        ownerWalletAddress: testAgent.ownerWalletAddress,
        walletProvider: testAgent.walletProvider,
      },
    });

    const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}/verification` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { verified: boolean; verified_at: string | null };
    expect(body.verified).toBe(false);
    expect(body.verified_at).toBeNull();
  });

  it("returns verified:true and a verified_at timestamp once set", async () => {
    const { app, sql } = await createTestApp();
    const testAgent = generateTestAgent();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId, { walletAddress: testAgent.ownerWalletAddress });
    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: {
        handle: testAgent.handle,
        displayName: testAgent.displayName,
        ownerWalletAddress: testAgent.ownerWalletAddress,
        walletProvider: testAgent.walletProvider,
      },
    });
    await sql`UPDATE agents SET verified_at = NOW() WHERE id = ${agentId}`;

    const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}/verification` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { verified: boolean; verified_at: string | null };
    expect(body.verified).toBe(true);
    expect(body.verified_at).not.toBeNull();
  });

  it("returns 404 for an unknown agent id", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: `/api/agents/${randomUUID()}/verification` });
    expect(res.statusCode).toBe(404);
  });

  it("requires no auth header (public route)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/agents/${randomUUID()}/verification`,
      headers: {},
    });
    // Should reach the route handler (404 for unknown id), never 401.
    expect(res.statusCode).not.toBe(401);
  });
});
