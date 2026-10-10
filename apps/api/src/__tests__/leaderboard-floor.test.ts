/**
 * honest_0710 phase B — leaderboard floor.
 *
 * Both boards rank only agents with ≥3 completed capital-at-risk deals with
 * ≥2 distinct counterparty owners. When nobody clears the floor, the boards
 * say so instead of crowning a one-deal agent.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";

const W = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;
const NOTE = "No ranked agents yet — ranking needs 3 paid, external, settled deals.";

type Sql = Awaited<ReturnType<typeof createTestApp>>["sql"];

describe("leaderboard floor", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let sql: Sql;
  let fixture: { offerId: string; needId: string };

  async function mkAgent(wallet: string, name: string): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, reputation_score)
      VALUES (${id}, ${"lb-" + id.slice(0, 8)}, ${name}, ${wallet}, 'metamask', 4.9)`;
    return id;
  }

  async function mkDeal(buyer: string, seller: string, total: string, opts: { funded?: boolean; integrityClass?: string } = {}) {
    const [deal] = await sql`
      INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, integrity_class)
      VALUES (${buyer}, ${seller}, ${fixture.offerId}, ${fixture.needId}, 'completed', ${total}, 'USDC', 20, ${opts.integrityClass ?? null})
      RETURNING id`;
    if (opts.funded ?? true) {
      const [m] = await sql`INSERT INTO milestones (deal_id, idx, title, amount) VALUES (${deal.id}, 1, 'm', ${total}) RETURNING id`;
      await sql`
        INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
        VALUES (${m.id}, ${buyer}, ${seller}, ${total}, 'released', ${W(1)}, ${W(2)}, ${W(9)})`;
    }
  }

  const getBoards = async () => {
    const a = await app.inject({ method: "GET", url: "/api/leaderboard" });
    const b = await app.inject({ method: "GET", url: "/api/reputation/leaderboard" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    return { main: JSON.parse(a.body), rep: JSON.parse(b.body) };
  };

  beforeAll(async () => {
    const t = await createTestApp();
    app = t.app;
    sql = t.sql;
    await cleanDatabase();
    const host = await mkAgent(W(8), "host");
    const [o] = await sql`INSERT INTO offers (agent_id, title, description_md, category, base_price) VALUES (${host}, 'o', 'offer body', 'Data', 1) RETURNING id`;
    const [n] = await sql`INSERT INTO needs (agent_id, title, description_md, category) VALUES (${host}, 'n', 'need body', 'Data') RETURNING id`;
    fixture = { offerId: String(o.id), needId: String(n.id) };

    // Farm shapes that must never be ranked.
    const oneFriend = await mkAgent(W(4), "one-friend seller");
    const friend = await mkAgent(W(5), "the friend");
    for (let i = 0; i < 3; i++) await mkDeal(friend, oneFriend, "10"); // 3 paid, 1 counterparty owner
    const free = await mkAgent(W(6), "free farmer");
    for (const w of [11, 12, 13]) await mkDeal(await mkAgent(W(w), "free buyer"), free, "0", { funded: false });
    for (let i = 0; i < 3; i++) await mkDeal(free, free, "10"); // self
    const twoDeals = await mkAgent(W(7), "two deals");
    await mkDeal(await mkAgent(W(2), "x"), twoDeals, "10");
    await mkDeal(await mkAgent(W(3), "y"), twoDeals, "10");
    const quarantined = await mkAgent(W(14), "quarantined");
    for (const w of [15, 16, 17]) await mkDeal(await mkAgent(W(w), "q buyer"), quarantined, "10", { integrityClass: "quarantined_farm" });
  });

  it("when nobody clears the floor, both boards say so explicitly", async () => {
    const { main, rep } = await getBoards();
    expect(main.ranked).toEqual([]);
    expect(main.note).toBe(NOTE);
    expect(main.unrankedCount).toBeGreaterThan(0);
    expect(rep.ranked).toEqual([]);
    expect(rep.leaderboard).toEqual([]);
    expect(rep.note).toBe(NOTE);
  });

  it("ranks only the agent with ≥3 paid settled deals from ≥2 counterparty owners", async () => {
    const seller = await mkAgent(W(1), "real seller");
    const b1 = await mkAgent(W(18), "buyer one");
    const b2 = await mkAgent(W(19), "buyer two");
    const b2twin = await mkAgent(W(19).toUpperCase().replace("0X", "0x"), "buyer two again");
    await mkDeal(b1, seller, "20");
    await mkDeal(b2, seller, "20");
    await mkDeal(b2twin, seller, "20"); // same owner as b2: still a 3rd deal, but not a 3rd owner

    const { main, rep } = await getBoards();
    expect(main.note).toBeNull();
    expect(main.ranked.map((e: { agentId: string }) => e.agentId)).toEqual([seller]);
    expect(main.ranked[0]).toMatchObject({ rank: 1, paidSettledDeals: 3, distinctCounterpartyOwners: 2 });
    expect(rep.note).toBeNull();
    expect(rep.ranked.map((e: { agentId: string }) => e.agentId)).toEqual([seller]);
    expect(rep.leaderboard).toEqual(rep.ranked);
    expect(rep.ranked[0]).toMatchObject({ rank: 1, paidSettledDeals: 3, distinctCounterpartyOwners: 2 });
    expect(typeof main.rule).toBe("string");
  });
});
