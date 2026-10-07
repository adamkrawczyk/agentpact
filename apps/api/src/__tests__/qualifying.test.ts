import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import {
  disqualifyReasons,
  isCapitalAtRisk,
  isQualifyingDeal,
  walletKey,
  type DealIntegrityInput,
} from "../shared/qualifying.js";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const SOL1 = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("walletKey", () => {
  it("normalises EVM case and rejects zero/placeholder", () => {
    expect(walletKey(W1.toUpperCase().replace("0X", "0x"))).toBe(W1);
    expect(walletKey(ZERO)).toBeNull();
    expect(walletKey("0xAgentPactPlatformUSDC")).toBeNull();
    expect(walletKey("")).toBeNull();
    expect(walletKey(null)).toBeNull();
  });
  it("keeps Solana base58 case-sensitive and rejects the system program", () => {
    expect(walletKey(SOL1)).toBe(SOL1);
    expect(walletKey("11111111111111111111111111111111")).toBeNull();
  });
});

type Case = { name: string; input: Omit<DealIntegrityInput, "buyerAgentId" | "sellerAgentId"> & { self?: boolean }; funded: boolean; qualifying: boolean };

const base = {
  negotiatedTotal: 25,
  buyerOwnerWallet: W1,
  sellerOwnerWallet: W2,
  buyerIsInternal: false,
  sellerIsInternal: false,
  integrityClass: null,
};

const CASES: Case[] = [
  { name: "clean paid external, funded", input: { ...base }, funded: true, qualifying: true },
  { name: "clean paid external, unfunded", input: { ...base }, funded: false, qualifying: true },
  { name: "cross-chain owners (EVM vs Solana)", input: { ...base, sellerOwnerWallet: SOL1 }, funded: true, qualifying: true },
  { name: "$0 practice deal", input: { ...base, negotiatedTotal: 0 }, funded: false, qualifying: false },
  { name: "self deal", input: { ...base, self: true }, funded: true, qualifying: false },
  { name: "same owner, different case", input: { ...base, sellerOwnerWallet: W1.toUpperCase().replace("0X", "0x") }, funded: true, qualifying: false },
  { name: "zero-address owner", input: { ...base, sellerOwnerWallet: ZERO }, funded: true, qualifying: false },
  { name: "placeholder owner", input: { ...base, buyerOwnerWallet: "0xAgentPactPlatformUSDC" }, funded: true, qualifying: false },
  { name: "internal buyer", input: { ...base, buyerIsInternal: true }, funded: true, qualifying: false },
  { name: "internal seller", input: { ...base, sellerIsInternal: true }, funded: true, qualifying: false },
  { name: "quarantined", input: { ...base, integrityClass: "quarantined_farm" }, funded: true, qualifying: false },
];

describe("isQualifyingDeal (pure)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const d = { ...c.input, buyerAgentId: "a", sellerAgentId: c.input.self ? "a" : "b" };
      expect(isQualifyingDeal(d)).toBe(c.qualifying);
      expect(isCapitalAtRisk({ ...d, funded: c.funded })).toBe(c.qualifying && c.funded);
      if (!c.qualifying) expect(disqualifyReasons(d).length).toBeGreaterThan(0);
    });
  }
});

describe("SQL views agree with the TS rule (parity)", () => {
  const rows: { dealId: string; c: Case }[] = [];
  let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];

  beforeAll(async () => {
    const t = await createTestApp();
    sql = t.sql;
    await cleanDatabase();

    // One offer/need pair to satisfy deal FKs.
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const hA = await getAuthHeadersForAgent(ownerA);
    const hB = await getAuthHeadersForAgent(ownerB);
    const offer = await t.app.inject({
      method: "POST", url: "/api/offers", headers: hA,
      payload: { agentId: ownerA, title: "Parity offer", descriptionMd: "Parity fixture offer text", category: "Data", tags: ["x"], basePrice: 25, currency: "USDC", maxPriceDeltaPct: 20, slaDays: 3, proofs: [] },
    });
    const need = await t.app.inject({
      method: "POST", url: "/api/needs", headers: hB,
      payload: { agentId: ownerB, title: "Parity need", descriptionMd: "Parity fixture need text", category: "Data", tags: ["x"], budgetMax: 30, currency: "USDC", acceptanceCriteria: ["done"] },
    });
    const offerId = JSON.parse(offer.body).id as string;
    const needId = JSON.parse(need.body).id as string;

    for (const c of CASES) {
      const buyerId = randomUUID();
      const sellerId = c.input.self ? buyerId : randomUUID();
      const mk = async (id: string, wallet: string | null | undefined, internal: boolean) => {
        await sql`
          INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider, is_internal)
          VALUES (${id}, ${"p-" + id.slice(0, 8)}, 'parity', ${wallet ?? ""}, 'metamask', ${internal})
          ON CONFLICT (id) DO NOTHING`;
      };
      await mk(buyerId, c.input.buyerOwnerWallet, c.input.buyerIsInternal);
      if (sellerId !== buyerId) await mk(sellerId, c.input.sellerOwnerWallet, c.input.sellerIsInternal);

      const [deal] = await sql`
        INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, integrity_class)
        VALUES (${buyerId}, ${sellerId}, ${offerId}, ${needId}, 'completed', ${Number(c.input.negotiatedTotal)}, 'USDC', 20, ${c.input.integrityClass ?? null})
        RETURNING id`;
      const dealId = String(deal.id);
      if (c.funded) {
        const [m] = await sql`
          INSERT INTO milestones (deal_id, idx, title, amount, currency)
          VALUES (${dealId}, 0, 'm', ${Number(c.input.negotiatedTotal)}, 'USDC') RETURNING id`;
        await sql`
          INSERT INTO payment_intents (milestone_id, buyer_agent_id, seller_agent_id, amount, status, buyer_wallet_address, seller_wallet_address, platform_wallet_address)
          VALUES (${m.id}, ${buyerId}, ${sellerId}, ${Number(c.input.negotiatedTotal)}, 'released', ${W1}, ${W2}, ${W2})`;
      }
      rows.push({ dealId, c });
    }
  });

  it("deal_integrity.qualifying and .funded match the TS rule for every case", async () => {
    for (const { dealId, c } of rows) {
      const [r] = await sql`SELECT qualifying, funded FROM deal_integrity WHERE deal_id = ${dealId}`;
      expect({ name: c.name, qualifying: r.qualifying, funded: r.funded }).toEqual({ name: c.name, qualifying: c.qualifying, funded: c.funded });
    }
  });

  it("qualifying_deals.capital_at_risk = qualifying AND funded", async () => {
    const got = await sql`SELECT deal_id, capital_at_risk FROM qualifying_deals`;
    const byId = new Map(got.map((r) => [String(r.deal_id), Boolean(r.capital_at_risk)]));
    for (const { dealId, c } of rows) {
      if (!c.qualifying) expect(byId.has(dealId)).toBe(false);
      else expect(byId.get(dealId)).toBe(c.funded);
    }
  });
});
