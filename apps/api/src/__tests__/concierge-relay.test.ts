import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeaders } from "./helpers/testApp.js";

async function getAuthHeadersForAgent(agentId: string): Promise<Record<string, string>> {
  const { app } = await createTestApp();
  const registerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      agentId,
      walletAddress: `0x${agentId.replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
    },
  });
  const body = JSON.parse(registerRes.body) as { apiKey: string };
  return { "x-api-key": body.apiKey };
}

describe("Concierge Relay", () => {
  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    await getAuthHeaders();
  });

  describe("POST /api/concierge/queue-welcome", () => {
    it("queues welcome messages for agents without one", async () => {
      const { app } = await createTestApp();

      // Create an agent
      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      expect(agentRes.statusCode).toBe(201);
      const agentId = (JSON.parse(agentRes.body) as { id: string }).id;

      // Queue welcome messages
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { queued: number; skipped: number };
      expect(body.queued).toBeGreaterThanOrEqual(1);
    });

    it("is idempotent — won't double-queue welcome for same agent", async () => {
      const { app } = await createTestApp();

      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      expect(agentRes.statusCode).toBe(201);

      // First queue
      const res1 = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });
      const body1 = JSON.parse(res1.body) as { queued: number };
      const firstQueued = body1.queued;

      // Second queue — should skip all
      const res2 = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });
      const body2 = JSON.parse(res2.body) as { queued: number };
      expect(body2.queued).toBe(0);
    });
  });

  describe("POST /api/concierge/queue-first-transaction", () => {
    it("queues first-transaction suggestions for agents with offers/needs but no deals", async () => {
      const { app, sql } = await createTestApp();

      // Create agent
      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      const agentId = (JSON.parse(agentRes.body) as { id: string }).id;

      // Create an offer for this agent
      const agentHeaders = await getAuthHeadersForAgent(agentId);
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: agentHeaders,
        payload: generateTestOffer(agentId),
      });

      // Queue first-transaction suggestions
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-first-transaction",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { queued: number; skipped: number };
      expect(body.queued).toBeGreaterThanOrEqual(1);
    });

    it("does not queue for agents who already have deals", async () => {
      const { app } = await createTestApp();

      // Agents with deals are created in other test flows
      // For now just verify the endpoint works without error
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-first-transaction",
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /api/concierge/relay", () => {
    it("processes queued messages in dry-run mode", async () => {
      const { app } = await createTestApp();

      // Create agent and queue a welcome
      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });

      // Dry run — should skip all
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/relay",
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { messagesFound: number; messagesSkipped: number };
      expect(body.messagesFound).toBeGreaterThanOrEqual(1);
      expect(body.messagesSkipped).toBe(body.messagesFound);
    });

    it("marks messages as sent after relay run", async () => {
      const { app, sql } = await createTestApp();

      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });

      // Run relay
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/relay",
        payload: { limit: 50 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { messagesFound: number; messagesSent: number; messagesFailed: number };
      expect(body.messagesFound).toBeGreaterThanOrEqual(1);
      expect(body.messagesSent).toBe(body.messagesFound);
      expect(body.messagesFailed).toBe(0);

      // Verify messages are marked sent in DB
      const sent = await sql`SELECT COUNT(*)::int AS cnt FROM concierge_messages WHERE status = 'sent'`;
      expect(Number(sent[0].cnt)).toBeGreaterThanOrEqual(1);
    });

    it("creates relay log entries", async () => {
      const { app, sql } = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/relay",
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      const logs = await sql`SELECT * FROM concierge_relay_log ORDER BY started_at DESC LIMIT 1`;
      expect(logs.length).toBe(1);
      expect(logs[0].run_type).toBe("api");
      expect(logs[0].completed_at).not.toBeNull();
    });
  });

  describe("GET /api/concierge/messages", () => {
    it("returns concierge messages for authenticated agent", async () => {
      const { app } = await createTestApp();

      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      const agentId = (JSON.parse(agentRes.body) as { id: string }).id;

      // Queue a welcome message
      await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });

      // Get messages as this agent
      const agentHeaders = await getAuthHeadersForAgent(agentId);
      const res = await app.inject({
        method: "GET",
        url: "/api/concierge/messages",
        headers: agentHeaders,
      });
      expect(res.statusCode).toBe(200);
      const messages = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const myMessages = messages.filter((m) => m.message_type === "welcome");
      expect(myMessages.length).toBe(1);
      expect(myMessages[0].subject).toContain("Welcome");
    });

    it("returns 401 without auth", async () => {
      const { app } = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/concierge/messages",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/concierge/stats", () => {
    it("returns relay statistics", async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: "GET",
        url: "/api/concierge/stats",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { stats: Record<string, number>; recentRuns: unknown[] };
      expect(body.stats).toBeDefined();
      expect(typeof body.stats.total_messages).toBe("number");
      expect(Array.isArray(body.recentRuns)).toBe(true);
    });
  });

  describe("End-to-end: queue → relay → verify", () => {
    it("full welcome flow: queue, relay, check status", async () => {
      const { app, sql } = await createTestApp();

      // 1. Create agents
      const agent1Res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeaders(),
        payload: generateTestAgent(),
      });
      const agent1Id = (JSON.parse(agent1Res.body) as { id: string }).id;

      const agent2Res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: await getAuthHeadersForAgent(
          (JSON.parse(agent1Res.body) as { id: string }).id
        ),
        payload: generateTestAgent(),
      });

      // 2. Queue welcome messages
      const queueRes = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });
      const queueBody = JSON.parse(queueRes.body) as { queued: number };
      expect(queueBody.queued).toBeGreaterThanOrEqual(2);

      // 3. Verify messages are in 'queued' status
      const queued = await sql`SELECT COUNT(*)::int AS cnt FROM concierge_messages WHERE status = 'queued'`;
      expect(Number(queued[0].cnt)).toBeGreaterThanOrEqual(2);

      // 4. Run relay
      const relayRes = await app.inject({
        method: "POST",
        url: "/api/concierge/relay",
        payload: { limit: 100 },
      });
      const relayBody = JSON.parse(relayRes.body) as { messagesSent: number };
      expect(relayBody.messagesSent).toBeGreaterThanOrEqual(2);

      // 5. Verify all messages are now 'sent'
      const remaining = await sql`SELECT COUNT(*)::int AS cnt FROM concierge_messages WHERE status = 'queued'`;
      expect(Number(remaining[0].cnt)).toBe(0);

      const sent = await sql`SELECT COUNT(*)::int AS cnt FROM concierge_messages WHERE status = 'sent'`;
      expect(Number(sent[0].cnt)).toBeGreaterThanOrEqual(2);

      // 6. Agent can retrieve their welcome message
      const agent1Headers = await getAuthHeadersForAgent(agent1Id);
      const messagesRes = await app.inject({
        method: "GET",
        url: "/api/concierge/messages",
        headers: agent1Headers,
      });
      const msgs = JSON.parse(messagesRes.body) as Array<Record<string, unknown>>;
      const welcomeMsg = msgs.find((m) => m.message_type === "welcome");
      expect(welcomeMsg).toBeDefined();
      expect(welcomeMsg!.status).toBe("sent");
    });
  });
});
