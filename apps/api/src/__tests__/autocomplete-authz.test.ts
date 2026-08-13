import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// Issue #103 — POST /api/deals/:id/fulfillment/auto-complete had NO route-level
// authorization, while index.ts's global preHandler EXEMPTED it from agent auth
// by comparing a request header against process.env:
//
//   if (adminKey === process.env.ADMIN_API_KEY || cronSecret === process.env.CRON_SECRET) return;
//
// With ADMIN_API_KEY unset and no header sent, that is `undefined === undefined`
// => TRUE => agent auth skipped entirely. The handler then called
// completeDealMilestones(id, { skipOnChainRelease: false }) — i.e. an
// unauthenticated caller who knew a deal id could drive settlement for a deal
// they were not party to.
//
// Two independent contracts are asserted here, because either alone is
// insufficient:
//   1. the ROUTE fails closed — 503 when ADMIN_API_KEY is unset, 403 on a wrong
//      key, and it still works with the right one (the legitimate cron path)
//   2. the PREHANDLER exemption cannot be satisfied by an unset env var
//
// Test style follows dispute-authz.test.ts (its sibling guard from #99).

let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: Awaited<ReturnType<typeof createTestApp>>["app"];

const ADMIN_KEY = "test-admin-key-103";

async function seedTimedOutDeliveredDeal(): Promise<{ dealId: string }> {
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  await getAuthHeadersForAgent(buyerId);
  await getAuthHeadersForAgent(sellerId);

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Autocomplete authz offer"}, ${"body"}, ${"development"}, ${50}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Autocomplete authz need"}, ${"body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  // acceptance_timeout_days = 1 and updated_at well in the past, so the
  // handler's own timeout precondition is satisfied and the ONLY thing standing
  // between a caller and completeDealMilestones() is authorization.
  const [deal] = await sql`
    INSERT INTO deals (
      buyer_agent_id, seller_agent_id, offer_id, need_id, status,
      negotiated_total, max_price_delta_pct, acceptance_timeout_days, updated_at
    )
    VALUES (
      ${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"delivered"},
      ${50}, ${20}, ${1}, NOW() - INTERVAL '30 days'
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${50}, ${"delivered"})
  `;
  return { dealId: String(deal.id) };
}

async function dealStatus(dealId: string): Promise<string> {
  const [row] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
  return String(row?.status);
}

describe("issue #103 — auto-complete requires admin authorization", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase();
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("FAILS CLOSED (503) and does not settle when ADMIN_API_KEY is unset — the #103 bypass", async () => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.CRON_SECRET;
    const { dealId } = await seedTimedOutDeliveredDeal();

    // No headers at all: this is the exact shape that satisfied
    // `undefined === undefined` in the preHandler exemption.
    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/auto-complete`,
      payload: {},
    });

    // Layered defense, and the OUTER layer answers first: with ADMIN_API_KEY
    // unset the hardened preHandler refuses to grant the exemption at all, so
    // the request falls through to normal agent auth and is rejected 401 before
    // the route's own fail-closed 503 is reached. Either code is a refusal;
    // asserting a specific one would pin the wrong layer. What must NOT happen
    // is a 2xx.
    expect([401, 403, 503]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
    // The contract that actually matters: no settlement happened.
    expect(await dealStatus(dealId)).toBe("delivered");
  });

  it("rejects a completely unauthenticated request when ADMIN_API_KEY IS set", async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { dealId } = await seedTimedOutDeliveredDeal();

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/auto-complete`,
      payload: {},
    });

    expect([401, 403]).toContain(res.statusCode);
    expect(await dealStatus(dealId)).toBe("delivered");
  });

  it("rejects a WRONG admin key", async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { dealId } = await seedTimedOutDeliveredDeal();

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/auto-complete`,
      headers: { "x-admin-key": "not-the-key" },
      payload: {},
    });

    expect([401, 403]).toContain(res.statusCode);
    expect(await dealStatus(dealId)).toBe("delivered");
  });

  it("rejects a plain (non-admin) authenticated agent", async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { dealId } = await seedTimedOutDeliveredDeal();
    const outsiderHeaders = await getAuthHeadersForAgent(randomUUID());

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/auto-complete`,
      headers: outsiderHeaders,
      payload: {},
    });

    expect([401, 403]).toContain(res.statusCode);
    expect(await dealStatus(dealId)).toBe("delivered");
  });

  it("STILL works with the correct admin key — the legitimate cron path is preserved", async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { dealId } = await seedTimedOutDeliveredDeal();

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/auto-complete`,
      headers: { "x-admin-key": ADMIN_KEY },
      payload: {},
    });

    // The point is that authorization PASSES: the handler executes and answers
    // on its own terms. It must not be an auth rejection.
    expect(res.statusCode).toBe(200);
    expect([401, 403, 503]).not.toContain(res.statusCode);
  });

  it("also accepts the admin key via Authorization: Bearer (credential-shape parity)", async () => {
    // requireAdminKey() accepts `Authorization: Bearer <key>`, so the preHandler
    // exemption must accept it too — otherwise a Bearer-authenticated operator
    // is rejected by agent auth before the route's gate ever runs. Tightening
    // the exemption for #103 without this parity silently broke every
    // Bearer-authenticated cron caller; dispute-authz.test.ts caught it.
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { dealId } = await seedTimedOutDeliveredDeal();

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fulfillment/auto-complete`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect([401, 403, 503]).not.toContain(res.statusCode);
  });
});
