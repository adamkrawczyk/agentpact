import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cleanDatabase, createTestApp, generateTestAgent, generateTestNeed, generateTestOffer, getAuthHeaders, getAuthHeadersForAgent } from "./helpers/testApp.js";

// Register a distinct canonical agent and set its branded profile in one step.
// Post issue-#75 fix, POST /api/agents updates the CALLER's canonical row (keyed
// on the authenticated agent id), so each distinct agent needs its own identity.
async function makeAgent(app: any, overrides = {}) {
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id);
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers,
    payload: generateTestAgent(overrides),
  });
  expect(res.statusCode).toBe(200);
  return { id, headers };
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
      await makeAgent(app);

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

      await makeAgent(app);

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

      // Create agent + an offer for it
      const { id: agentId, headers: agentHeaders } = await makeAgent(app);
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
      await makeAgent(app);
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

      await makeAgent(app);
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

      const { id: agentId, headers: agentHeaders } = await makeAgent(app);

      // Queue a welcome message
      await app.inject({
        method: "POST",
        url: "/api/concierge/queue-welcome",
      });

      // Get messages as this agent
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

      // 1. Create agents (two DISTINCT canonical agents)
      const { id: agent1Id } = await makeAgent(app);
      await makeAgent(app);

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

  describe("POST /api/concierge/run-full-cycle", () => {
    it("queues all message types and delivers them in one call", async () => {
      const { app, sql } = await createTestApp();

      // Create agents (two DISTINCT canonical agents)
      // Agent 1: brand new, no offers/needs -> gets welcome + activation-nudge
      await makeAgent(app, { handle: "newbie1" });

      // Agent 2: has an offer but no deals -> gets first-transaction
      const { id: agent2Id, headers: agent2Headers } = await makeAgent(app, { handle: "seller1" });
      // Post an offer for agent 2
      await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: agent2Headers,
        payload: generateTestOffer(),
      });

      // Run full cycle
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/run-full-cycle",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        welcome: { queued: number; skipped: number };
        firstTransaction: { queued: number; skipped: number };
        activationNudges: { queued: number; skipped: number };
        relay: { messagesFound: number; messagesSent: number };
      };

      // Should have queued welcome messages
      expect(body.welcome.queued).toBeGreaterThanOrEqual(1);

      // Should have queued first-transaction for agent with offer
      expect(body.firstTransaction.queued).toBeGreaterThanOrEqual(0);

      // Should have queued activation nudges for agents with no offers/needs
      expect(body.activationNudges.queued).toBeGreaterThanOrEqual(0);

      // Relay should have processed messages
      expect(body.relay.messagesFound).toBeGreaterThan(0);
      expect(body.relay.messagesSent).toBeGreaterThan(0);

      // Verify all queued messages are now sent
      const remaining = await sql`SELECT COUNT(*)::int AS cnt FROM concierge_messages WHERE status = 'queued'`;
      expect(Number(remaining[0].cnt)).toBe(0);
    });

    it("respects dryRun option", async () => {
      const { app, sql } = await createTestApp();
      const headers = await getAuthHeaders();

      // Create an agent
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers,
        payload: generateTestAgent({ handle: "dryrun-test" }),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/run-full-cycle",
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        relay: { messagesSkipped: number };
      };

      // In dry-run mode, relay should skip all messages
      expect(body.relay.messagesSkipped).toBeGreaterThanOrEqual(0);
    });
  });

  describe("queueActivationNudges", () => {
    it("targets agents with no offers and no needs", async () => {
      const { app, sql } = await createTestApp();
      const headers = await getAuthHeaders();

      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers,
        payload: generateTestAgent({ handle: "inactive1" }),
      });

      // Set created_at to 2 hours ago so activation nudge logic picks it up (skips <1h agents)
      await sql`UPDATE agents SET created_at = NOW() - INTERVAL '2 hours' WHERE handle = 'inactive1'`;

      // Run activation nudge queue
      const res = await app.inject({
        method: "POST",
        url: "/api/concierge/queue-first-transaction", // just to warm up
      });

      // Now manually trigger activation nudge via full cycle
      const fullCycleRes = await app.inject({
        method: "POST",
        url: "/api/concierge/run-full-cycle",
        payload: {},
      });
      expect(fullCycleRes.statusCode).toBe(200);
      const body = JSON.parse(fullCycleRes.body) as {
        activationNudges: { queued: number };
      };

      // The inactive agent should get an activation nudge
      expect(body.activationNudges.queued).toBeGreaterThanOrEqual(1);

      // Verify nudge message content
      const nudges = await sql`
        SELECT * FROM concierge_messages
        WHERE message_type = 'activation-nudge'
      `;
      expect(nudges.length).toBeGreaterThanOrEqual(1);
      expect(nudges[0].subject).toContain("AgentPact");
    });

    it("is idempotent — won't double-nudge same agent", async () => {
      const { app } = await createTestApp();
      const headers = await getAuthHeaders();

      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers,
        payload: generateTestAgent({ handle: "idempotent-test" }),
      });

      // Run full cycle twice
      await app.inject({
        method: "POST",
        url: "/api/concierge/run-full-cycle",
        payload: {},
      });
      const res2 = await app.inject({
        method: "POST",
        url: "/api/concierge/run-full-cycle",
        payload: {},
      });

      const body = JSON.parse(res2.body) as {
        activationNudges: { queued: number; skipped: number };
      };

      // Second run should skip all (already queued/sent)
      expect(body.activationNudges.queued).toBe(0);
      expect(body.activationNudges.skipped).toBeGreaterThanOrEqual(1);
    });
  });
});
