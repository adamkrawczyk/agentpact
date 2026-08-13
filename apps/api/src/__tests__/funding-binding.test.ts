import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { ESCROW_ABI, ESCROW_ADDRESS, publicClient, uuidToBytes32, usdcToUnits } from "../chain.js";

// CUSTODY VERIFICATION HOLE — regression test.
//
// Ground truth (verified 2026-08-13): apps/api/src/chain.ts verifyFunding(txHash)
// used to accept ANY successful transaction sent to the escrow contract without
// checking WHAT it funded. It never parsed a single log despite its own docstring
// claiming it "inspects the receipt for MilestoneCreated events" and despite its
// declared return type promising milestoneId/dealId/buyer/seller/amount.
//
// ATTACK: a buyer takes any successful past tx hash sent to the escrow (their own
// unrelated milestone, or someone else's funding tx) and submits it as `txHash`
// for a DIFFERENT payment intent via POST /api/payments/confirm-funding. The old
// code marked that (unfunded) milestone 'funded'. The seller would then perform
// work with no USDC actually in escrow for their milestone.
//
// CONTRACT under test: verifyFunding — and the confirm-funding route that calls
// it — must decode the receipt's MilestoneCreated event and reject (verified:false
// / HTTP 400) unless milestoneId, buyer, seller, and amount ALL match what the
// payment intent being confirmed actually expects.
//
// We exercise the REAL verifyFunding implementation (no mocking of chain.js's own
// logic) by spying on publicClient.waitForTransactionReceipt — the one true
// network boundary — and feeding it hand-crafted receipts whose logs encode a
// genuine ABI-correct MilestoneCreated event. This proves the binding check in
// chain.ts itself, exercised through the real HTTP route, not a stand-in.

function encodeMilestoneCreatedLog(args: {
  milestoneId: Hex;
  dealId: Hex;
  buyer: Address;
  seller: Address;
  amount: bigint;
  emittedBy?: Address;
}) {
  const topics = encodeEventTopics({
    abi: ESCROW_ABI,
    eventName: "MilestoneCreated",
    args: { milestoneId: args.milestoneId, dealId: args.dealId },
  });
  const data = encodeAbiParameters(
    [
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    [args.buyer, args.seller, args.amount],
  );
  return {
    address: (args.emittedBy ?? ESCROW_ADDRESS) as Address,
    topics,
    data,
    blockNumber: 12345n,
    blockHash: `0x${"1".repeat(64)}` as Hex,
    transactionHash: `0x${"2".repeat(64)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function fakeReceipt(logs: ReturnType<typeof encodeMilestoneCreatedLog>[]) {
  return {
    status: "success" as const,
    to: ESCROW_ADDRESS,
    from: "0x9999999999999999999999999999999999999999" as Address,
    logs,
    transactionHash: `0x${"2".repeat(64)}` as Hex,
    blockNumber: 12345n,
    blockHash: `0x${"1".repeat(64)}` as Hex,
    contractAddress: null,
    cumulativeGasUsed: 21000n,
    effectiveGasPrice: 1n,
    gasUsed: 21000n,
    logsBloom: `0x${"0".repeat(512)}` as Hex,
    transactionIndex: 0,
    type: "eip1559" as const,
  };
}

let sql: Awaited<ReturnType<typeof createTestApp>>["sql"];
let app: Awaited<ReturnType<typeof createTestApp>>["app"];

const BUYER_WALLET = "0x1111111111111111111111111111111111111111" as Address;
const SELLER_WALLET = "0x2222222222222222222222222222222222222222" as Address;
const OTHER_WALLET = "0x3333333333333333333333333333333333333333" as Address;

async function seedFundablePaymentIntent(opts: { amount: number }): Promise<{
  paymentIntentId: string;
  milestoneId: string;
  dealId: string;
  buyerId: string;
  sellerId: string;
  buyerHeaders: Record<string, string>;
}> {
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  const buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: BUYER_WALLET });
  await getAuthHeadersForAgent(sellerId, { walletAddress: SELLER_WALLET });

  const [offer] = await sql`
    INSERT INTO offers (agent_id, title, description_md, category, base_price, max_price_delta_pct, status)
    VALUES (${sellerId}, ${"Custody test offer"}, ${"custody test offer body"}, ${"development"}, ${opts.amount}, ${20}, ${"active"})
    RETURNING id
  `;
  const [need] = await sql`
    INSERT INTO needs (agent_id, title, description_md, category, status)
    VALUES (${buyerId}, ${"Custody test need"}, ${"custody test need body"}, ${"development"}, ${"open"})
    RETURNING id
  `;
  const [deal] = await sql`
    INSERT INTO deals (buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, max_price_delta_pct, is_free_tier)
    VALUES (${buyerId}, ${sellerId}, ${offer.id}, ${need.id}, ${"accepted"}, ${opts.amount}, ${20}, ${false})
    RETURNING id
  `;
  const [milestone] = await sql`
    INSERT INTO milestones (deal_id, idx, title, amount, status)
    VALUES (${deal.id}, ${1}, ${"Delivery"}, ${opts.amount}, ${"in_progress"})
    RETURNING id
  `;
  const [intent] = await sql`
    INSERT INTO payment_intents (
      milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
      buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address, payment_provider
    ) VALUES (
      ${milestone.id}, ${buyerId}, ${sellerId}, ${opts.amount}, 'USDC', 'base', 'created',
      'metamask', ${BUYER_WALLET}, ${SELLER_WALLET}, ${"0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"}, 'usdc'
    )
    RETURNING id
  `;

  return {
    paymentIntentId: String(intent.id),
    milestoneId: String(milestone.id),
    dealId: String(deal.id),
    buyerId,
    sellerId,
    buyerHeaders,
  };
}

describe("funding-binding — verifyFunding must bind to the specific milestone/buyer/seller/amount", () => {
  beforeEach(async () => {
    ({ sql, app } = await createTestApp());
    await cleanDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REJECTS a tx whose MilestoneCreated names a DIFFERENT milestone (the core attack)", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });
    // A milestone that is NOT the one being confirmed — simulates the buyer
    // replaying someone else's (or their own unrelated) funding transaction.
    const unrelatedMilestoneId = uuidToBytes32(randomUUID());

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(
      fakeReceipt([
        encodeMilestoneCreatedLog({
          milestoneId: unrelatedMilestoneId,
          dealId: uuidToBytes32(randomUUID()),
          buyer: BUYER_WALLET,
          seller: SELLER_WALLET,
          amount: usdcToUnits(50),
        }),
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"a".repeat(64)}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.toLowerCase()).toContain("different milestone");

    // The DB must NOT have been mutated — this is the whole point of the fix.
    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("created");
    const [milestone] = await sql`SELECT status FROM milestones WHERE id = ${target.milestoneId}`;
    expect(milestone.status).toBe("in_progress");
  });

  it("REJECTS a tx whose MilestoneCreated amount does not match the intent's amount", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(
      fakeReceipt([
        encodeMilestoneCreatedLog({
          milestoneId: uuidToBytes32(target.milestoneId),
          dealId: uuidToBytes32(target.dealId),
          buyer: BUYER_WALLET,
          seller: SELLER_WALLET,
          amount: usdcToUnits(1), // wrong amount — funded for $1, intent expects $50
        }),
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"b".repeat(64)}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.toLowerCase()).toContain("amount");

    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("created");
  });

  it("REJECTS a tx whose MilestoneCreated buyer does not match the intent's buyer", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(
      fakeReceipt([
        encodeMilestoneCreatedLog({
          milestoneId: uuidToBytes32(target.milestoneId),
          dealId: uuidToBytes32(target.dealId),
          buyer: OTHER_WALLET, // wrong buyer
          seller: SELLER_WALLET,
          amount: usdcToUnits(50),
        }),
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"c".repeat(64)}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.toLowerCase()).toContain("buyer");

    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("created");
  });

  it("REJECTS a tx whose MilestoneCreated seller does not match the intent's seller", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(
      fakeReceipt([
        encodeMilestoneCreatedLog({
          milestoneId: uuidToBytes32(target.milestoneId),
          dealId: uuidToBytes32(target.dealId),
          buyer: BUYER_WALLET,
          seller: OTHER_WALLET, // wrong seller
          amount: usdcToUnits(50),
        }),
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"d".repeat(64)}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.toLowerCase()).toContain("seller");

    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("created");
  });

  it("REJECTS a successful tx to the escrow with NO MilestoneCreated log at all", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(fakeReceipt([]) as never);

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"e".repeat(64)}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.toLowerCase()).toContain("no milestonecreated");

    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("created");
  });

  it("REJECTS a MilestoneCreated-shaped log emitted by a contract OTHER than the escrow", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });
    const impostorContract = "0x9999999999999999999999999999999999999998" as Address;

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(
      fakeReceipt([
        encodeMilestoneCreatedLog({
          milestoneId: uuidToBytes32(target.milestoneId),
          dealId: uuidToBytes32(target.dealId),
          buyer: BUYER_WALLET,
          seller: SELLER_WALLET,
          amount: usdcToUnits(50),
          emittedBy: impostorContract, // NOT the escrow address
        }),
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"f".repeat(64)}` },
    });

    expect(res.statusCode).toBe(400);
    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("created");
  });

  it("ACCEPTS a tx whose MilestoneCreated correctly names this milestone/buyer/seller/amount (control — proves the guard isn't blanket-rejecting)", async () => {
    const target = await seedFundablePaymentIntent({ amount: 50 });

    vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue(
      fakeReceipt([
        encodeMilestoneCreatedLog({
          milestoneId: uuidToBytes32(target.milestoneId),
          dealId: uuidToBytes32(target.dealId),
          buyer: BUYER_WALLET,
          seller: SELLER_WALLET,
          amount: usdcToUnits(50),
        }),
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/payments/confirm-funding",
      headers: target.buyerHeaders,
      payload: { paymentIntentId: target.paymentIntentId, txHash: `0x${"9".repeat(64)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; verified: boolean };
    expect(body.status).toBe("funded");
    expect(body.verified).toBe(true);

    const [intent] = await sql`SELECT status FROM payment_intents WHERE id = ${target.paymentIntentId}`;
    expect(intent.status).toBe("funded");
    const [milestone] = await sql`SELECT status FROM milestones WHERE id = ${target.milestoneId}`;
    expect(milestone.status).toBe("funded");
  });
});
