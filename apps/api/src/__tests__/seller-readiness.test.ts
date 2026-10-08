/**
 * M3 self-serve seller onboarding: GET /api/sellers/me/readiness.
 * Every checklist item reports done/todo and, when todo, the exact next call
 * (HTTP + MCP). No item may require a human.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

type Item = { id: string; required: boolean; done: boolean; detail: string; next: null | { http: string; mcp?: string; body?: unknown } };
type Readiness = { agentId: string; ready: boolean; progress: { done: number; required: number }; nextStep: string | null; items: Item[] };

describe("GET /api/sellers/me/readiness", () => {
  let sellerId: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    sellerId = randomUUID();
  });

  async function readiness(): Promise<Readiness> {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/sellers/me/readiness", headers });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Readiness;
  }
  const item = (r: Readiness, id: string) => {
    const it = r.items.find((i) => i.id === id);
    if (!it) throw new Error(`missing item ${id}`);
    return it;
  };

  it("fresh wallet-less agent: every required item is todo, each with an exact next call", async () => {
    headers = await getAuthHeadersForAgent(sellerId, { walletAddress: null });
    const r = await readiness();
    expect(r.agentId).toBe(sellerId);
    expect(r.ready).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(["profile", "payout_destination", "priced_offer", "notifications", "x402_endpoint"]);
    for (const i of r.items) {
      expect(i.done).toBe(false);
      expect(i.next?.http).toMatch(/^(GET|POST|PATCH|PUT) \/api\//);
    }
    expect(item(r, "profile").next?.mcp).toBe("agentpact.create_agent");
    expect(item(r, "payout_destination").next?.http).toBe(`PATCH /api/agents/${sellerId}/wallet`);
    expect(item(r, "priced_offer").next?.mcp).toBe("agentpact.create_offer");
    expect(item(r, "x402_endpoint").required).toBe(false);
    expect(r.progress).toEqual({ done: 0, required: 4 });
    expect(r.nextStep).toBe("profile");
  });

  it("all required items done → ready (x402 endpoint stays optional)", async () => {
    headers = await getAuthHeadersForAgent(sellerId);
    const { app } = await createTestApp();
    const prof = await app.inject({
      method: "POST", url: "/api/agents", headers,
      payload: { handle: `csv-checker-${sellerId.slice(0, 6)}`, displayName: "CSV Checker" },
    });
    expect(prof.statusCode).toBe(200);
    const offer = await app.inject({ method: "POST", url: "/api/offers", headers, payload: generateTestOffer(sellerId) });
    expect(offer.statusCode).toBe(201);
    const hook = await app.inject({ method: "POST", url: "/api/webhooks", headers, payload: { agentId: sellerId, url: "https://seller.example.com/hook", events: ["deal.proposed"] } });
    expect(hook.statusCode).toBeLessThan(300);

    const r = await readiness();
    expect(item(r, "profile").done).toBe(true);
    expect(item(r, "payout_destination").done).toBe(true);
    expect(item(r, "priced_offer").done).toBe(true);
    expect(item(r, "notifications").done).toBe(true);
    expect(item(r, "x402_endpoint").done).toBe(false);
    expect(r.ready).toBe(true);
    expect(r.progress).toEqual({ done: 4, required: 4 });
    expect(r.nextStep).toBe(null);
    for (const i of r.items.filter((x) => x.done)) expect(i.next).toBe(null);
  });

  it("payout: a verified, unrevoked payout route counts; a revoked one does not", async () => {
    headers = await getAuthHeadersForAgent(sellerId, { walletAddress: null });
    const { sql } = await createTestApp();
    await sql`
      INSERT INTO agent_payout_routes (agent_id, chain, cctp_domain, address, recipient_bytes32, proof_message, proof_signature, verified_at, revoked_at)
      VALUES (${sellerId}, 'solana', 5, 'So1anaAddr', ${"0x" + "1".repeat(64)}, 'm', 's', NOW(), NOW())
    `;
    expect(item(await readiness(), "payout_destination").done).toBe(false);
    await sql`
      INSERT INTO agent_payout_routes (agent_id, chain, cctp_domain, address, recipient_bytes32, proof_message, proof_signature, verified_at)
      VALUES (${sellerId}, 'ethereum', 0, '0x00000000000000000000000000000000000000aa', ${"0x" + "2".repeat(64)}, 'm', 's', NOW())
    `;
    expect(item(await readiness(), "payout_destination").done).toBe(true);
  });

  it("priced offer: a $0 or archived offer does not count", async () => {
    headers = await getAuthHeadersForAgent(sellerId);
    const { app, sql } = await createTestApp();
    const free = { ...generateTestOffer(sellerId), basePrice: 0 };
    expect((await app.inject({ method: "POST", url: "/api/offers", headers, payload: free })).statusCode).toBe(201);
    expect(item(await readiness(), "priced_offer").done).toBe(false);
    const paid = await app.inject({ method: "POST", url: "/api/offers", headers, payload: generateTestOffer(sellerId) });
    await sql`UPDATE offers SET status = 'archived' WHERE id = ${JSON.parse(paid.body).id}`;
    expect(item(await readiness(), "priced_offer").done).toBe(false);
  });

  it("notifications: a recent heartbeat counts when no webhook exists; a stale one does not", async () => {
    headers = await getAuthHeadersForAgent(sellerId);
    const { app, sql } = await createTestApp();
    await sql`UPDATE agents SET last_seen_at = NOW() - INTERVAL '3 days' WHERE id = ${sellerId}`;
    expect(item(await readiness(), "notifications").done).toBe(false);
    const hb = await app.inject({ method: "POST", url: `/api/agents/${sellerId}/heartbeat`, headers });
    expect(hb.statusCode).toBe(200);
    expect(item(await readiness(), "notifications").done).toBe(true);
  });

  it("x402 endpoint: https only, then the item is done", async () => {
    headers = await getAuthHeadersForAgent(sellerId);
    const { app } = await createTestApp();
    const bad = await app.inject({ method: "POST", url: "/api/sellers/me/x402-endpoints", headers, payload: { url: "http://seller.example.com/x" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/sellers/me/x402-endpoints", headers, payload: { url: "https://seller.example.com/validate" } });
    expect(ok.statusCode).toBe(201);
    const again = await app.inject({ method: "POST", url: "/api/sellers/me/x402-endpoints", headers, payload: { url: "https://seller.example.com/validate" } });
    expect(again.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/sellers/me/x402-endpoints", headers });
    expect(JSON.parse(list.body).endpoints).toHaveLength(1);
    expect(item(await readiness(), "x402_endpoint").done).toBe(true);
  });

  it("x402 endpoint: an offerId that is not the caller's own offer is refused", async () => {
    headers = await getAuthHeadersForAgent(sellerId);
    const other = randomUUID();
    const otherHeaders = await getAuthHeadersForAgent(other);
    const { app } = await createTestApp();
    const offer = await app.inject({ method: "POST", url: "/api/offers", headers: otherHeaders, payload: generateTestOffer(other) });
    const res = await app.inject({
      method: "POST", url: "/api/sellers/me/x402-endpoints", headers,
      payload: { url: "https://seller.example.com/v", offerId: JSON.parse(offer.body).id },
    });
    expect(res.statusCode).toBe(403);
  });

  it("anonymous → 401", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/sellers/me/readiness" });
    expect(res.statusCode).toBe(401);
  });
});
