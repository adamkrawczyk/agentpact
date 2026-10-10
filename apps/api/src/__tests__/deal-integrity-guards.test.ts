import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// honest_0710 phases A + H (lane m0-integrity).
//
//  A. No deal can be proposed / countered / accepted between an agent and
//     itself, or between two agents with the same owner wallet at a price > 0
//     (decision D4: a $0 same-owner deal is allowed as a practice deal).
//     Reputation only moves for capital_at_risk deals (qualifying_deals view),
//     through ONE helper; trust tiers count only capital_at_risk deals.
//  H. A paid deal cannot be proposed to / accepted by a seller with no known
//     payout destination (the $8.5K March loss).

const ADMIN_KEY = "m0-integrity-admin-key";
const W_BUYER = "0x1111111111111111111111111111111111111111";
const W_SELLER = "0x2222222222222222222222222222222222222222";
const W_SHARED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ZERO = "0x0000000000000000000000000000000000000000";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: App;
let sql: Sql;

async function agent(wallet: string | null, opts: { internal?: boolean } = {}) {
  const id = randomUUID();
  const headers = await getAuthHeadersForAgent(id, { walletAddress: wallet });
  if (opts.internal) await sql`UPDATE agents SET is_internal = TRUE WHERE id = ${id}`;
  return { id, headers };
}

async function listings(sellerId: string, buyerId: string, basePrice = 10) {
  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status, accepted_payment_methods)
    VALUES (${sellerId}, ${"Integrity offer " + randomUUID().slice(0, 8)}, 'integrity offer body', 'development', ${basePrice}, 50, 'active', 'usdc')
    RETURNING id`;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status, accepted_payment_methods)
    VALUES (${buyerId}, 'Integrity need', 'integrity need body', 'development', 'open', 'usdc')
    RETURNING id`;
  return { offerId: String(offer.id), needId: String(need.id) };
}

function proposal(buyerId: string, sellerId: string, l: { offerId: string; needId: string }, total: number) {
  return {
    buyerAgentId: buyerId,
    sellerAgentId: sellerId,
    offerId: l.offerId,
    needId: l.needId,
    negotiatedTotal: total,
    maxPriceDeltaPct: 50,
    milestones: [{ idx: 1, title: "M1", amount: total, acceptanceCriteria: ["Done"] }],
  };
}

/** Insert a deal directly (legacy rows / states the routes can no longer create). */
async function seedDeal(o: {
  buyerId: string;
  sellerId: string;
  total: number;
  status: string;
  funded: boolean;
  acceptanceTimeoutDays?: number;
  stale?: boolean;
  fulfillment?: boolean;
}) {
  const l = await listings(o.sellerId, o.buyerId, o.total || 10);
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency,
                       max_price_delta_pct, is_free_tier, acceptance_timeout_days)
    VALUES (${o.buyerId}, ${o.sellerId}, ${l.offerId}, ${l.needId}, ${o.status}, ${o.total}, 'USDC', 50,
            ${o.total === 0}, ${o.acceptanceTimeoutDays ?? 1})
    RETURNING id`;
  const dealId = String(deal.id);
  const milestoneStatus = o.status === "completed" ? "accepted" : o.status === "proposed" ? "pending" : "in_progress";
  const [m] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, currency, status)
    VALUES (${dealId}, 1, 'M1', ${o.total}, 'USDC', ${milestoneStatus}) RETURNING id`;
  if (o.funded) {
    await sql`
      INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status,
                                   buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
      VALUES (${m.id}, ${o.buyerId}, ${o.sellerId}, ${o.total}, ${o.status === "completed" ? "released" : "funded"},
              'metamask', ${W_BUYER}, ${W_SELLER}, ${W_SELLER})`;
  }
  if (o.fulfillment) {
    await sql`
      INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status, fulfillment_data, provided_at)
      VALUES (${dealId}, 'generic', 'provided', '{"description":"delivered the integrity fixture"}'::jsonb, NOW())`;
  }
  if (o.stale) {
    await sql`UPDATE deals SET updated_at = NOW() - INTERVAL '30 days' WHERE id = ${dealId}`;
  }
  return dealId;
}

async function rep(agentId: string): Promise<number> {
  const [r] = await sql`SELECT COALESCE(reputation_score, 0) AS rep FROM agents WHERE id = ${agentId}`;
  return Number(r.rep);
}

async function dealStatus(dealId: string): Promise<string> {
  const [d] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
  return String(d.status);
}

beforeEach(async () => {
  ({ app, sql } = await createTestApp());
  await cleanDatabase();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

// ── A1: self-deal / same-owner guard on every path that creates or re-prices a deal ──

describe("self-deal guard — propose", () => {
  it("rejects a proposal from an agent to itself (403 self_deal)", async () => {
    const a = await agent(W_BUYER);
    const l = await listings(a.id, a.id);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: a.headers,
      payload: proposal(a.id, a.id, l, 10),
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("self_deal");
    expect(typeof body.hint).toBe("string");
    expect(typeof body.error).toBe("string");
  });

  it("rejects a $0 proposal to itself too (self deals are never practice deals)", async () => {
    const a = await agent(W_BUYER);
    const l = await listings(a.id, a.id, 0);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: a.headers,
      payload: proposal(a.id, a.id, l, 0),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("self_deal");
  });

  it("rejects a paid proposal between two agents of the same owner, case-insensitively (403 same_owner)", async () => {
    const buyer = await agent(W_SHARED.toLowerCase());
    const seller = await agent(W_SHARED.toUpperCase().replace("0X", "0x"));
    const l = await listings(seller.id, buyer.id);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyer.headers,
      payload: proposal(buyer.id, seller.id, l, 10),
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("same_owner");
    expect(body.hint).toMatch(/practice|\$0/i);
  });

  it("allows a $0 same-owner practice deal (201), and completing it leaves reputation unchanged", async () => {
    const buyer = await agent(W_SHARED);
    const seller = await agent(W_SHARED);
    const l = await listings(seller.id, buyer.id, 0);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyer.headers,
      payload: proposal(buyer.id, seller.id, l, 0),
    });
    expect(res.statusCode).toBe(201);
    const dealId = JSON.parse(res.body).id as string;

    const before = await rep(seller.id);
    const forced = await app.inject({
      method: "POST", url: "/api/admin/force-close", headers: { "x-admin-key": ADMIN_KEY },
      payload: { dealId },
    });
    expect(forced.statusCode).toBe(200);
    expect(await dealStatus(dealId)).toBe("completed");
    expect(await rep(seller.id)).toBe(before);
  });

  it("allows a paid proposal between distinct owners (201)", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const l = await listings(seller.id, buyer.id);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyer.headers,
      payload: proposal(buyer.id, seller.id, l, 10),
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("self-deal guard — counter", () => {
  it("rejects a counter that raises a same-owner practice deal above $0 (403 same_owner)", async () => {
    const buyer = await agent(W_SHARED);
    const seller = await agent(W_SHARED);
    const l = await listings(seller.id, buyer.id, 0);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyer.headers,
      payload: proposal(buyer.id, seller.id, l, 0),
    });
    expect(res.statusCode).toBe(201);
    const dealId = JSON.parse(res.body).id as string;

    const counter = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/counter`, headers: seller.headers,
      payload: { actorAgentId: seller.id, negotiatedTotal: 25, milestones: [{ idx: 1, title: "M1", amount: 25, acceptanceCriteria: ["Done"] }] },
    });
    expect(counter.statusCode).toBe(403);
    expect(JSON.parse(counter.body).code).toBe("same_owner");
    const [d] = await sql`SELECT negotiated_total FROM deals WHERE id = ${dealId}`;
    expect(Number(d.negotiated_total)).toBe(0);
  });

  it("rejects any counter on a legacy self-deal (403 self_deal)", async () => {
    const a = await agent(W_BUYER);
    const dealId = await seedDeal({ buyerId: a.id, sellerId: a.id, total: 10, status: "proposed", funded: false });
    const counter = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/counter`, headers: a.headers,
      payload: { actorAgentId: a.id, negotiatedTotal: 10, milestones: [{ idx: 1, title: "M1", amount: 10, acceptanceCriteria: ["Done"] }] },
    });
    expect(counter.statusCode).toBe(403);
    expect(JSON.parse(counter.body).code).toBe("self_deal");
  });
});

describe("self-deal guard — accept", () => {
  it("rejects accepting a legacy paid same-owner proposal (403 same_owner)", async () => {
    const buyer = await agent(W_SHARED);
    const seller = await agent(W_SHARED.toLowerCase());
    const dealId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 10, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: seller.headers,
      payload: { actorAgentId: seller.id },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("same_owner");
    expect(await dealStatus(dealId)).toBe("proposed");
  });

  it("rejects accepting a legacy self-deal (403 self_deal)", async () => {
    const a = await agent(W_BUYER);
    const dealId = await seedDeal({ buyerId: a.id, sellerId: a.id, total: 0, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: a.headers,
      payload: { actorAgentId: a.id },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("self_deal");
  });

  it("accepts a $0 same-owner practice deal", async () => {
    const buyer = await agent(W_SHARED);
    const seller = await agent(W_SHARED);
    const dealId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 0, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: seller.headers,
      payload: { actorAgentId: seller.id },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("self-deal guard — other creation paths", () => {
  it("autopilot never auto-proposes a paid same-owner deal", async () => {
    const buyer = await agent(W_SHARED);
    const seller = await agent(W_SHARED.toLowerCase());
    const l = await listings(seller.id, buyer.id, 100);
    await sql`UPDATE agents SET auto_buy_enabled = true, max_auto_deal_price = 100000 WHERE id = ${buyer.id}`;
    await sql`
      INSERT INTO matches (offer_id, need_id, score, reason_json)
      VALUES (${l.offerId}, ${l.needId}, 0.950, '{"seeded":"same-owner"}'::jsonb)
      ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score`;
    const res = await app.inject({ method: "POST", url: "/api/autopilot/run", headers: { "x-admin-key": ADMIN_KEY }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).dealsProposed).toBe(0);
    const deals = await sql`SELECT id FROM deals WHERE offer_id = ${l.offerId}`;
    expect(deals.length).toBe(0);
  });

  it("decompose rejects a same-owner paid child and creates no children (403 same_owner)", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(W_SELLER);
    const twin = await agent(W_BUYER.toUpperCase().replace("0X", "0x"));
    const parentId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 50, status: "active", funded: false });
    const c1 = await listings(seller.id, buyer.id);
    const c2 = await listings(twin.id, buyer.id);
    const res = await app.inject({
      method: "POST", url: "/api/deals/decompose", headers: buyer.headers,
      payload: {
        parentDealId: parentId,
        children: [
          { sellerAgentId: seller.id, offerId: c1.offerId, needId: c1.needId, negotiatedTotal: 10, title: "child one" },
          { sellerAgentId: twin.id, offerId: c2.offerId, needId: c2.needId, negotiatedTotal: 10, title: "child two" },
        ],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("same_owner");
    const children = await sql`SELECT id FROM deals WHERE parent_deal_id = ${parentId}`;
    expect(children.length).toBe(0);
  });
});

// ── H: seller payout destination required for paid deals ─────────────────────

async function addPayoutRoute(agentId: string, opts: { verified: boolean; isDefault: boolean; revoked?: boolean }) {
  await sql`
    INSERT INTO agent_payout_routes (agent_id, chain, cctp_domain, address, recipient_bytes32, proof_message, proof_signature, verified_at, is_default, revoked_at)
    VALUES (${agentId}, 'base', 6, ${W_SELLER}, ${"0x" + "0".repeat(24) + W_SELLER.slice(2)}, 'challenge', '0xsig',
            ${opts.verified ? new Date() : new Date(0)}, ${opts.isDefault}, ${opts.revoked ? new Date() : null})`;
}

describe("seller payout wallet required (H)", () => {
  it("rejects a paid proposal to a seller with no payout wallet (409 seller_payout_wallet_required)", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(ZERO);
    const l = await listings(seller.id, buyer.id);
    const res = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyer.headers,
      payload: proposal(buyer.id, seller.id, l, 10),
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("seller_payout_wallet_required");
    expect(body.hint).toMatch(/\/api\//);
  });

  it("rejects accepting a paid proposal without a payout wallet (409), deal stays proposed", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(null);
    const dealId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 10, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: seller.headers,
      payload: { actorAgentId: seller.id },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("seller_payout_wallet_required");
    expect(await dealStatus(dealId)).toBe("proposed");
  });

  it("a revoked default payout route does not count (409)", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(ZERO);
    await addPayoutRoute(seller.id, { verified: true, isDefault: true, revoked: true });
    const dealId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 10, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: seller.headers,
      payload: { actorAgentId: seller.id },
    });
    expect(res.statusCode).toBe(409);
  });

  it("accepts a paid proposal when the seller has a verified default payout route", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(ZERO);
    await addPayoutRoute(seller.id, { verified: true, isDefault: true });
    const dealId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 10, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: seller.headers,
      payload: { actorAgentId: seller.id },
    });
    expect(res.statusCode).toBe(200);
    expect(await dealStatus(dealId)).toBe("active");
  });

  it("a $0 practice deal needs no payout wallet", async () => {
    const buyer = await agent(W_BUYER);
    const seller = await agent(null);
    const dealId = await seedDeal({ buyerId: buyer.id, sellerId: seller.id, total: 0, status: "proposed", funded: false });
    const res = await app.inject({
      method: "POST", url: `/api/deals/${dealId}/accept`, headers: seller.headers,
      payload: { actorAgentId: seller.id },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── A2: every former reputation write site only credits capital_at_risk deals ──

type Pair = { buyer: Awaited<ReturnType<typeof agent>>; seller: Awaited<ReturnType<typeof agent>> };
async function externalPair(): Promise<Pair> {
  return { buyer: await agent(W_BUYER), seller: await agent(W_SELLER) };
}
async function sameOwnerPair(): Promise<Pair> {
  return { buyer: await agent(W_SHARED), seller: await agent(W_SHARED.toLowerCase()) };
}

/**
 * Each site: drive the real route to completion. `nonQualifying` builds a
 * deal that is NOT capital_at_risk; `expected` is the seller's score after the
 * capital_at_risk run (0.5 per completion, or rating/10 when the buyer rated).
 */
const SITES: Array<{
  name: string;
  nonQualifying: () => Promise<Pair>;
  seed: (p: Pair, funded: boolean) => Promise<string>;
  drive: (p: Pair, dealId: string) => Promise<void>;
  expected: number;
}> = [
  {
    name: "admin auto-complete-timeouts (admin.ts)",
    nonQualifying: sameOwnerPair,
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "delivered", funded, stale: true }),
    drive: async () => {
      const r = await app.inject({ method: "POST", url: "/api/admin/auto-complete-timeouts", headers: { "x-admin-key": ADMIN_KEY } });
      expect(r.statusCode).toBe(200);
    },
    expected: 0.5,
  },
  {
    name: "admin force-close (admin.ts)",
    nonQualifying: async () => {
      const p = await externalPair();
      await sql`UPDATE agents SET is_internal = TRUE WHERE id = ${p.buyer.id}`;
      return p;
    },
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "delivered", funded }),
    drive: async (_p, dealId) => {
      const r = await app.inject({ method: "POST", url: "/api/admin/force-close", headers: { "x-admin-key": ADMIN_KEY }, payload: { dealId } });
      expect(r.statusCode).toBe(200);
    },
    expected: 0.5,
  },
  {
    name: "instant auto-complete on fulfillment (fulfillment.ts, acceptance_timeout_days=0)",
    nonQualifying: sameOwnerPair,
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "active", funded, acceptanceTimeoutDays: 0 }),
    drive: async (p, dealId) => {
      const r = await app.inject({
        method: "POST", url: `/api/deals/${dealId}/fulfillment`, headers: p.seller.headers,
        payload: { agentId: p.seller.id, fulfillmentData: { description: "delivered the integrity fixture" } },
      });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).auto_completed).toBe(true);
    },
    expected: 0.5,
  },
  {
    name: "buyer confirm-delivery with rating (fulfillment.ts)",
    nonQualifying: sameOwnerPair,
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "delivered", funded, fulfillment: true }),
    drive: async (p, dealId) => {
      const r = await app.inject({
        method: "POST", url: `/api/deals/${dealId}/confirm-delivery`, headers: p.buyer.headers,
        payload: { agentId: p.buyer.id, rating: 4 },
      });
      expect(r.statusCode).toBe(200);
    },
    expected: 0.4,
  },
  {
    name: "buyer close with rating (fulfillment.ts)",
    nonQualifying: sameOwnerPair,
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "delivered", funded }),
    drive: async (p, dealId) => {
      const r = await app.inject({
        method: "POST", url: `/api/deals/${dealId}/close`, headers: p.buyer.headers,
        payload: { agentId: p.buyer.id, rating: 3 },
      });
      expect(r.statusCode).toBe(200);
    },
    expected: 0.3,
  },
  {
    name: "admin-keyed fulfillment auto-complete (fulfillment.ts)",
    nonQualifying: sameOwnerPair,
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "delivered", funded, stale: true }),
    drive: async (_p, dealId) => {
      const r = await app.inject({ method: "POST", url: `/api/deals/${dealId}/fulfillment/auto-complete`, headers: { "x-admin-key": ADMIN_KEY } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).completed).toBe(true);
    },
    expected: 0.5,
  },
  {
    name: "feedback (feedback.ts) on a completed deal",
    nonQualifying: sameOwnerPair,
    seed: (p, funded) => seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "completed", funded }),
    drive: async (p, dealId) => {
      const r = await app.inject({
        method: "POST", url: "/api/feedback", headers: p.buyer.headers,
        payload: { dealId, fromAgentId: p.buyer.id, toAgentId: p.seller.id, ratingQuality: 2, ratingTimeliness: 2, ratingCommunication: 2, ratingAccuracy: 2 },
      });
      expect(r.statusCode).toBe(201);
    },
    // the buyer's own review replaces the neutral completion credit: 2/10
    expected: 0.2,
  },
];

describe("reputation only moves for capital_at_risk deals — every former write site", () => {
  for (const site of SITES) {
    it(`${site.name}: non-qualifying deal → reputation unchanged`, async () => {
      const p = await site.nonQualifying();
      const dealId = await site.seed(p, true);
      const before = await rep(p.seller.id);
      await site.drive(p, dealId);
      expect(await dealStatus(dealId)).toBe("completed");
      expect(await rep(p.seller.id)).toBe(before);
    });

    it(`${site.name}: qualifying but unfunded deal → reputation unchanged`, async () => {
      const p = await externalPair();
      const dealId = await site.seed(p, false);
      const before = await rep(p.seller.id);
      await site.drive(p, dealId);
      expect(await rep(p.seller.id)).toBe(before);
    });

    it(`${site.name}: capital_at_risk deal → reputation credited`, async () => {
      const p = await externalPair();
      const dealId = await site.seed(p, true);
      const [q] = await sql`SELECT capital_at_risk FROM qualifying_deals WHERE deal_id = ${dealId}`;
      expect(q?.capital_at_risk).toBe(true);
      await site.drive(p, dealId);
      expect(await dealStatus(dealId)).toBe("completed");
      expect(await rep(p.seller.id)).toBeCloseTo(site.expected, 3);
    });
  }

  it("a $0 practice deal between distinct owners earns nothing either", async () => {
    const p = await externalPair();
    const dealId = await seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 0, status: "delivered", funded: false });
    const r = await app.inject({ method: "POST", url: "/api/admin/force-close", headers: { "x-admin-key": ADMIN_KEY }, payload: { dealId } });
    expect(r.statusCode).toBe(200);
    expect(await dealStatus(dealId)).toBe("completed");
    expect(await rep(p.seller.id)).toBe(0);
  });
});

describe("completion from any path (relayer, buyer-signed on-chain release) is credited", () => {
  it("a capital_at_risk deal completed outside the API routes credits the seller", async () => {
    const p = await externalPair();
    const dealId = await seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "release_pending_chain", funded: true });
    // e.g. apps/relayer-daemon autoclose-sweeper, or the buyer-signed release confirmation
    await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
    expect(await rep(p.seller.id)).toBeCloseTo(0.5, 3);
  });

  it("a non-qualifying deal completed outside the API routes credits nothing", async () => {
    const p = await sameOwnerPair();
    const dealId = await seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "release_pending_chain", funded: true });
    await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
    expect(await rep(p.seller.id)).toBe(0);
  });

  it("quarantining a completed deal removes its credit", async () => {
    const p = await externalPair();
    const dealId = await seedDeal({ buyerId: p.buyer.id, sellerId: p.seller.id, total: 10, status: "release_pending_chain", funded: true });
    await sql`UPDATE deals SET status = 'completed' WHERE id = ${dealId}`;
    expect(await rep(p.seller.id)).toBeCloseTo(0.5, 3);
    await sql`UPDATE deals SET integrity_class = 'quarantined_test' WHERE id = ${dealId}`;
    expect(await rep(p.seller.id)).toBe(0);
  });
});

// ── A3: trust tier counts only capital_at_risk deals ──────────────────────────

describe("trust tier ignores self / free / same-owner / internal deals", () => {
  async function completedWithFeedback(buyerId: string, sellerId: string, total: number, funded: boolean) {
    const dealId = await seedDeal({ buyerId, sellerId, total, status: "completed", funded });
    if (buyerId !== sellerId) {
      await sql`
        INSERT INTO feedback (deal_id, from_agent_id, to_agent_id, rating_quality, rating_timeliness, rating_communication, rating_accuracy)
        VALUES (${dealId}, ${buyerId}, ${sellerId}, 5, 5, 5, 5)`;
    }
  }

  it("non-evidence deals do not count toward the tier (2 real deals + 16 farmed stays 'new')", async () => {
    const seller = await agent(W_SELLER);
    const twin = await agent(W_SELLER);
    const free = await agent(W_BUYER);
    const internal = await agent("0x3333333333333333333333333333333333333333", { internal: true });
    // Two genuine 5-star deals: rating qualifies for bronze, deal count (2 < 3) does not.
    for (const w of ["0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555"]) {
      const b = await agent(w);
      await completedWithFeedback(b.id, seller.id, 10, true);
    }
    for (let i = 0; i < 4; i++) {
      await completedWithFeedback(seller.id, seller.id, 10, true); // self
      await completedWithFeedback(twin.id, seller.id, 10, true); // same owner
      await completedWithFeedback(free.id, seller.id, 0, false); // $0 practice
      await completedWithFeedback(internal.id, seller.id, 10, true); // internal party
    }
    const res = await app.inject({ method: "GET", url: `/api/agents/${seller.id}`, headers: seller.headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).trustTier.tier).toBe("new");

    const profile = await app.inject({ method: "GET", url: `/api/reputation/${seller.id}`, headers: seller.headers });
    expect(JSON.parse(profile.body).trustTier.tier).toBe("new");
  });

  it("three paid, funded, external deals with good feedback reach bronze", async () => {
    const seller = await agent(W_SELLER);
    for (const w of ["0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666"]) {
      const b = await agent(w);
      await completedWithFeedback(b.id, seller.id, 10, true);
    }
    const res = await app.inject({ method: "GET", url: `/api/agents/${seller.id}`, headers: seller.headers });
    expect(JSON.parse(res.body).trustTier.tier).toBe("bronze");
  });
});
