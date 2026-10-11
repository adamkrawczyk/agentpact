import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// POST /api/needs/:id/respond — a SELLER answers an open NEED with one of its
// own offers. Every case goes through the REAL route (app.inject), never a
// raw-SQL seeder for the thing under test. Contract:
//   - 201 + ONE concierge_messages row to the need owner (match-suggestion,
//     related_need_id / related_offer_id) + `need.response` webhook event
//   - NO deal row and NO payment row, ever
//   - refusals: 401 no key, 400 bad body, 404 unknown need / offer, 403 offer
//     not yours, 409 need not open / own need / offer archived / same owner
//     wallet / duplicate live response, 429 over the hourly limit
//   - GET /api/needs/:id/responses is owner-only (401 / 403 / 404 / 400)

const W_BUYER = "0x1111111111111111111111111111111111111111";
const W_SELLER = "0x2222222222222222222222222222222222222222";
const W_OTHER = "0x3333333333333333333333333333333333333333";
const W_SHARED_LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";
const W_SHARED_MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: App;
let sql: Sql;

async function agent(wallet: string) {
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id, { walletAddress: wallet });
  expect(typeof headers["x-api-key"]).toBe("string");
  return { id, headers };
}

async function offerOf(agentId: string, status: "active" | "archived" = "active") {
  const [row] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status, accepted_payment_methods)
    VALUES (${agentId}, ${"Respond offer " + randomUUID().slice(0, 8)}, 'offer body', 'development', 25, 50, ${status}, 'usdc')
    RETURNING id`;
  return String(row.id);
}

async function needOf(agentId: string, status: "open" | "closed" | "archived" = "open") {
  const [row] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status, accepted_payment_methods)
    VALUES (${agentId}, ${"Respond need " + randomUUID().slice(0, 8)}, 'need body', 'development', ${status}, 'usdc')
    RETURNING id`;
  return String(row.id);
}

function respond(needId: string, headers: Record<string, string> | undefined, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/needs/${needId}/respond`, headers: headers ?? {}, payload });
}

async function counts() {
  const [row] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM deals) AS deals,
      (SELECT COUNT(*)::int FROM milestones) AS milestones,
      (SELECT COUNT(*)::int FROM payment_intents) AS payment_intents,
      (SELECT COUNT(*)::int FROM intents) AS intents,
      (SELECT COUNT(*)::int FROM concierge_messages) AS messages`;
  return row as { deals: number; milestones: number; payment_intents: number; intents: number; messages: number };
}

async function waitForNotification(eventType: string, agentId: string) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const rows = await sql`
      SELECT event_type, payload_json FROM notification_log
      WHERE event_type = ${eventType} AND agent_id = ${agentId}
      ORDER BY created_at DESC LIMIT 1`;
    if (rows.length > 0) {
      // notification_log stores the signed envelope; older writers store it as a JSON string.
      const raw = rows[0].payload_json as unknown;
      const envelope = (typeof raw === "string" ? JSON.parse(raw) : raw) as { event: string; payload: Record<string, unknown> };
      return { event_type: String(rows[0].event_type), envelope };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${eventType}`);
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  ({ app, sql } = await createTestApp());
  await app.ready();
  // Webhook delivery is fire-and-forget over fetch; answer locally.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await cleanDatabase();
});

describe("POST /api/needs/:id/respond — happy path", () => {
  it("201: one concierge message to the need owner, need.response fired, no deal and no money", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const hook = await app.inject({
      method: "POST", url: "/api/webhooks", headers: buyer.headers,
      payload: { url: "https://webhook.test/buyer", events: ["need.response"] },
    });
    expect(hook.statusCode).toBe(201);
    const needId = await needOf(buyer.id);
    const offerId = await offerOf(seller.id);
    const before = await counts();

    const res = await respond(needId, seller.headers, {
      offerId,
      message: "I can do this in 2 days.<script>alert(1)</script>\u0007",
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ needId, offerId, sellerAgentId: seller.id });
    expect(body.message).toBe("I can do this in 2 days.alert(1)");

    const rows = await sql`SELECT * FROM concierge_messages`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(body.id);
    expect(row.agent_id).toBe(buyer.id);
    expect(row.message_type).toBe("match-suggestion");
    expect(row.related_need_id).toBe(needId);
    expect(row.related_offer_id).toBe(offerId);
    expect(row.status).toBe("sent"); // owner's webhook subscribes to need.response
    expect(row.metadata).toMatchObject({ source: "need_response", seller_agent_id: seller.id });
    expect(String(row.body_md)).not.toContain("<script>");
    expect(String(row.body_md)).toContain("/api/deals/propose");

    const note = await waitForNotification("need.response", buyer.id);
    expect(note.envelope.event).toBe("need.response");
    expect(note.envelope.payload).toMatchObject({ responseId: body.id, needId, offerId, sellerAgentId: seller.id });

    const after = await counts();
    expect(after.deals).toBe(before.deals);
    expect(after.milestones).toBe(before.milestones);
    expect(after.payment_intents).toBe(before.payment_intents);
    expect(after.intents).toBe(before.intents);
    expect(after.messages).toBe(before.messages + 1);
  });

  it("queues the message for the concierge relay when the owner has no need.response webhook", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    const res = await respond(needId, seller.headers, { offerId: await offerOf(seller.id) });
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body).message).toBeNull();
    const [row] = await sql`SELECT status, sent_at FROM concierge_messages`;
    expect(row.status).toBe("queued");
    expect(row.sent_at).toBeNull();
  });

  it("the owner reads it via GET /api/needs/:id/responses and the concierge inbox, then proposes through the existing flow", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    const offerId = await offerOf(seller.id);
    const created = await respond(needId, seller.headers, { offerId, message: "Ready when you are" });
    expect(created.statusCode, created.body).toBe(201);
    const responseId = JSON.parse(created.body).id;

    const list = await app.inject({ method: "GET", url: `/api/needs/${needId}/responses`, headers: buyer.headers });
    expect(list.statusCode, list.body).toBe(200);
    const items = JSON.parse(list.body);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: responseId, needId, offerId, sellerAgentId: seller.id, message: "Ready when you are", offerStatus: "active" });

    const inbox = await app.inject({ method: "GET", url: "/api/concierge/messages", headers: buyer.headers });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.body).map((m: { id: string }) => m.id)).toContain(responseId);

    expect((await counts()).deals).toBe(0);
    const propose = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyer.headers,
      payload: {
        buyerAgentId: buyer.id, sellerAgentId: seller.id, offerId, needId,
        negotiatedTotal: 25, maxPriceDeltaPct: 50,
        milestones: [{ idx: 1, title: "M1", amount: 25, acceptanceCriteria: ["Done"] }],
      },
    });
    expect(propose.statusCode, propose.body).toBe(201);
    expect((await counts()).deals).toBe(1);
  });
});

describe("POST /api/needs/:id/respond — refusals (no row, no deal)", () => {
  async function expectNothingWritten() {
    const c = await counts();
    expect(c.messages).toBe(0);
    expect(c.deals).toBe(0);
    expect(c.payment_intents).toBe(0);
  }

  it("401 without an API key", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const res = await respond(await needOf(buyer.id), undefined, { offerId: await offerOf(seller.id) });
    expect(res.statusCode).toBe(401);
    await expectNothingWritten();
  });

  it("400 on a missing offerId, a non-uuid need id, or an over-long message", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    const offerId = await offerOf(seller.id);
    expect((await respond(needId, seller.headers, {})).statusCode).toBe(400);
    expect((await respond("not-a-uuid", seller.headers, { offerId })).statusCode).toBe(400);
    const long = await respond(needId, seller.headers, { offerId, message: "x".repeat(1001) });
    expect(long.statusCode).toBe(400);
    expect(JSON.parse(long.body).code).toBe("VALIDATION_FAILED");
    await expectNothingWritten();
  });

  it("404 unknown need", async () => {
    const seller = await agent(W_SELLER);
    const res = await respond(randomUUID(), seller.headers, { offerId: await offerOf(seller.id) });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe("need_not_found");
    await expectNothingWritten();
  });

  it("404 unknown offer", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const res = await respond(await needOf(buyer.id), seller.headers, { offerId: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe("offer_not_found");
    await expectNothingWritten();
  });

  it("409 need archived or closed", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const offerId = await offerOf(seller.id);
    for (const status of ["archived", "closed"] as const) {
      const res = await respond(await needOf(buyer.id, status), seller.headers, { offerId });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).code).toBe("need_not_open");
    }
    await expectNothingWritten();
  });

  it("409 need archived through the real archive route", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    const archived = await app.inject({ method: "POST", url: `/api/needs/${needId}/archive`, headers: buyer.headers });
    expect(archived.statusCode).toBe(200);
    const res = await respond(needId, seller.headers, { offerId: await offerOf(seller.id) });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("need_not_open");
    await expectNothingWritten();
  });

  it("409 responding to your own need", async () => {
    const buyer = await agent(W_BUYER);
    const res = await respond(await needOf(buyer.id), buyer.headers, { offerId: await offerOf(buyer.id) });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("own_need");
    await expectNothingWritten();
  });

  it("403 responding with an offer you do not own", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const other = await agent(W_OTHER);
    const res = await respond(await needOf(buyer.id), seller.headers, { offerId: await offerOf(other.id) });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("not_offer_owner");
    await expectNothingWritten();
  });

  it("409 responding with an archived offer", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const res = await respond(await needOf(buyer.id), seller.headers, { offerId: await offerOf(seller.id, "archived") });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("offer_not_active");
    await expectNothingWritten();
  });

  it("409 when the seller and the need owner share an owner wallet (case-insensitive)", async () => {
    const buyer = await agent(W_SHARED_LOWER);
    const fleetSeller = await agent(W_SHARED_MIXED);
    const res = await respond(await needOf(buyer.id), fleetSeller.headers, { offerId: await offerOf(fleetSeller.id) });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).code).toBe("same_owner");
    await expectNothingWritten();
  });

  it("409 duplicate live response by the same seller to the same need, pointing at the first one", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    const first = await respond(needId, seller.headers, { offerId: await offerOf(seller.id) });
    expect(first.statusCode).toBe(201);
    // Even with a different offer: one live response per seller per need.
    const second = await respond(needId, seller.headers, { offerId: await offerOf(seller.id) });
    expect(second.statusCode, second.body).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.code).toBe("duplicate_response");
    expect(body.responseId).toBe(JSON.parse(first.body).id);
    expect((await counts()).messages).toBe(1);
  });

  it("concurrent duplicate responses still write exactly one row", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    const offerId = await offerOf(seller.id);
    const results = await Promise.all([1, 2, 3, 4].map(() => respond(needId, seller.headers, { offerId })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
    expect((await counts()).messages).toBe(1);
  });

  it("429 after 10 responses in an hour (per seller, across needs), with retry-after", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const offerId = await offerOf(seller.id);
    for (let i = 0; i < 10; i += 1) {
      const res = await respond(await needOf(buyer.id), seller.headers, { offerId });
      expect(res.statusCode, `response ${i + 1}: ${res.body}`).toBe(201);
    }
    const limited = await respond(await needOf(buyer.id), seller.headers, { offerId });
    expect(limited.statusCode, limited.body).toBe(429);
    expect(JSON.parse(limited.body).code).toBe("need_response_rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const c = await counts();
    expect(c.messages).toBe(10);
    expect(c.deals).toBe(0);

    // Another seller is not affected by the first seller's limit.
    const other = await agent(W_OTHER);
    const ok = await respond(await needOf(buyer.id), other.headers, { offerId: await offerOf(other.id) });
    expect(ok.statusCode).toBe(201);
  });
});

describe("GET /api/needs/:id/responses — owner only", () => {
  it("401 without a key, 403 for a non-owner, 404 unknown need, 400 junk id", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const needId = await needOf(buyer.id);
    expect((await respond(needId, seller.headers, { offerId: await offerOf(seller.id) })).statusCode).toBe(201);

    const anon = await app.inject({ method: "GET", url: `/api/needs/${needId}/responses` });
    expect(anon.statusCode).toBe(401);
    const asSeller = await app.inject({ method: "GET", url: `/api/needs/${needId}/responses`, headers: seller.headers });
    expect(asSeller.statusCode).toBe(403);
    const unknown = await app.inject({ method: "GET", url: `/api/needs/${randomUUID()}/responses`, headers: buyer.headers });
    expect(unknown.statusCode).toBe(404);
    const junk = await app.inject({ method: "GET", url: "/api/needs/not-a-uuid/responses", headers: buyer.headers });
    expect(junk.statusCode).toBe(400);

    // The public need detail route stays public.
    const pub = await app.inject({ method: "GET", url: `/api/needs/${needId}` });
    expect(pub.statusCode).toBe(200);
  });
});
