// apps/api/src/__tests__/autoclose.test.ts — autoclose rollout Change 1 + 2 API tests
//
// Tests:
//  1. Auto-mint Class-A intent fires when a paid USDC deal with deliverable_hash
//     is accepted.
//  2. Auto-mint does NOT fire for: free-tier deals, deals without deliverable_hash,
//     deals where one party lacks a wallet address.
//  3. POST /api/deals/:id/funding-authorization validates ownership (403 for seller),
//     validates value match (400 for mismatch), and succeeds (201) for valid buyer.
//  4. POST /api/intents/:id/reveal validates seller identity (403 for wrong agent),
//     rejects bad intent state, and succeeds (200) setting status=reveal_ready.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanDatabase,
  createTestApp,
  generateTestNeed,
  generateTestOffer,
  getAuthHeadersForAgent,
} from "./helpers/testApp.js";

// A valid 32-byte EIP-3009 nonce / r / s for testing (values don't need to be
// cryptographically valid since we're not doing on-chain verification here).
const FAKE_HEX32 = "0x" + "ab".repeat(32);
const FAKE_HEX32_B = "0x" + "cd".repeat(32);

// A raw 32-byte deliverable hash (keccak256 of some preimage)
const DELIVERABLE_HASH_HEX = "0x" + "aa".repeat(32);
// The matching preimage for the hash above (for reveal tests)
const PREIMAGE_HEX = "0x" + "bb".repeat(16);

// ── Helpers ─────────────────────────────────────────────────────────────────

async function createAcceptedDeal(options: {
  withDeliverableHash?: boolean;
  freeTier?: boolean;
  buyerWallet?: string | null;
  sellerWallet?: string | null;
  amount?: number;
  // When true, the deliverable hash is supplied through the PUBLIC API
  // (propose_deal payload) instead of a raw SQL UPDATE. This exercises the
  // producer half of the gasless path — the half an agent actually calls.
  hashViaApi?: boolean;
}) {
  const {
    withDeliverableHash = true,
    freeTier = false,
    buyerWallet = "0x1111111111111111111111111111111111111111",
    sellerWallet = "0x2222222222222222222222222222222222222222",
    amount = 50,
    hashViaApi = false,
  } = options;

  const { app, sql } = await createTestApp();

  const buyerId = randomUUID();
  const sellerId = randomUUID();

  // Always register agents WITH a wallet address (wallet-less agents can't
  // create offers/needs). We'll null out the wallet address AFTER deal setup
  // but BEFORE accept, to test the auto-mint guard.
  const effectiveBuyerWallet = buyerWallet ?? "0x3333333333333333333333333333333333333333";
  const effectiveSellerWallet = sellerWallet ?? "0x4444444444444444444444444444444444444444";

  const buyerHeaders = await getAuthHeadersForAgent(buyerId, {
    walletAddress: effectiveBuyerWallet,
  });
  const sellerHeaders = await getAuthHeadersForAgent(sellerId, {
    walletAddress: effectiveSellerWallet,
  });

  const offerRes = await app.inject({
    method: "POST",
    url: "/api/offers",
    headers: sellerHeaders,
    payload: generateTestOffer(sellerId),
  });
  expect(offerRes.statusCode).toBe(201);
  const offerId = (JSON.parse(offerRes.body) as { id: string }).id;

  const needRes = await app.inject({
    method: "POST",
    url: "/api/needs",
    headers: buyerHeaders,
    payload: generateTestNeed(buyerId),
  });
  expect(needRes.statusCode).toBe(201);
  const needId = (JSON.parse(needRes.body) as { id: string }).id;

  const proposeRes = await app.inject({
    method: "POST",
    url: "/api/deals/propose",
    headers: buyerHeaders,
    payload: {
      buyerAgentId: buyerId,
      sellerAgentId: sellerId,
      offerId,
      needId,
      negotiatedTotal: freeTier ? 0 : amount,
      maxPriceDeltaPct: 20,
      milestones: [
        {
          idx: 1,
          title: "Milestone 1",
          amount: freeTier ? 0 : amount,
          acceptanceCriteria: ["Deliver work"],
        },
      ],
      // Producer path: the gasless commitment travels in the propose payload.
      ...(withDeliverableHash && hashViaApi
        ? { deliverableHash: DELIVERABLE_HASH_HEX }
        : {}),
    },
  });
  expect(proposeRes.statusCode).toBe(201);
  const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

  // Set deliverable_hash on deal (simulating the buyer/seller setting it
  // at propose/accept time — seeder pattern per spec).
  if (withDeliverableHash && !hashViaApi) {
    const hashBuf = Buffer.from(DELIVERABLE_HASH_HEX.slice(2), "hex");
    await sql`UPDATE deals SET deliverable_hash = ${hashBuf} WHERE id = ${dealId}`;
  }

  // Null out wallets AFTER setup but BEFORE accept, to test the guard
  if (buyerWallet === null) {
    await sql`UPDATE agents SET owner_wallet_address = NULL WHERE id = ${buyerId}`;
  }
  if (sellerWallet === null) {
    await sql`UPDATE agents SET owner_wallet_address = NULL WHERE id = ${sellerId}`;
  }

  // Accept the deal (seller)
  const acceptRes = await app.inject({
    method: "POST",
    url: `/api/deals/${dealId}/accept`,
    headers: sellerHeaders,
    payload: { actorAgentId: sellerId },
  });
  expect(acceptRes.statusCode).toBe(200);

  return { app, sql, dealId, buyerId, sellerId, buyerHeaders, sellerHeaders };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("autoclose — Change 1: auto-mint Class-A intent on deal accept", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("mints an intent with status=awaiting_funding for a paid USDC deal with deliverable_hash", async () => {
    const { sql, dealId } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
    });

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).not.toBeNull();

    const [intent] = await sql<Array<{
      status: string;
      settlement_class: string;
      predicate_type: string;
      predicate_params: unknown;
      on_chain_id: Buffer | null;
    }>>`
      SELECT status, settlement_class, predicate_type, predicate_params, on_chain_id
      FROM intents WHERE id = ${deal.intent_id}
    `;
    expect(intent).toBeDefined();
    expect(intent.status).toBe("awaiting_funding");
    expect(intent.settlement_class).toBe("A");
    expect(intent.predicate_type).toBe("hash-preimage-v1");
    // predicate_params is JSONB; postgres.js returns it as a JS object
    expect(intent.predicate_params).toBeDefined();
    // Accept either a JS object or a string (postgres.js parses JSONB, but check both)
    let params: { hash?: string };
    if (typeof intent.predicate_params === "string") {
      params = JSON.parse(intent.predicate_params as string);
    } else {
      params = intent.predicate_params as { hash?: string };
    }
    expect(params).toHaveProperty("hash");
    expect(params.hash!.toLowerCase()).toBe(DELIVERABLE_HASH_HEX.toLowerCase());
    // on_chain_id must be NULL at auto-mint time (relayer fills it after broadcast)
    expect(intent.on_chain_id).toBeNull();
  });

  it("mints the intent when deliverableHash is supplied via the PUBLIC propose API (producer path)", async () => {
    const { sql, dealId } = await createAcceptedDeal({
      withDeliverableHash: true,
      hashViaApi: true,
      freeTier: false,
    });

    // The commitment must have been persisted by the propose route itself —
    // no raw SQL seeding involved in this test.
    const [deal] = await sql<Array<{
      deliverable_hash: Buffer | null;
      intent_id: string | null;
    }>>`
      SELECT deliverable_hash, intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.deliverable_hash).not.toBeNull();
    expect("0x" + Buffer.from(deal.deliverable_hash as Buffer).toString("hex")).toBe(
      DELIVERABLE_HASH_HEX,
    );
    // ...and the auto-mint guard must have fired off the API-supplied value.
    expect(deal.intent_id).not.toBeNull();

    const [intent] = await sql<Array<{ status: string; settlement_class: string }>>`
      SELECT status, settlement_class FROM intents WHERE id = ${deal.intent_id}
    `;
    expect(intent.status).toBe("awaiting_funding");
    expect(intent.settlement_class).toBe("A");
  });

  it("rejects a malformed deliverableHash on propose (400, not a silent null)", async () => {
    const { app } = await createTestApp();
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const buyerHeaders = await getAuthHeadersForAgent(buyerId, {
      walletAddress: "0x1111111111111111111111111111111111111111",
    });
    const sellerHeaders = await getAuthHeadersForAgent(sellerId, {
      walletAddress: "0x2222222222222222222222222222222222222222",
    });

    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: sellerHeaders,
      payload: generateTestOffer(sellerId),
    });
    const offerId = (JSON.parse(offerRes.body) as { id: string }).id;
    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      headers: buyerHeaders,
      payload: generateTestNeed(buyerId),
    });
    const needId = (JSON.parse(needRes.body) as { id: string }).id;

    const res = await app.inject({
      method: "POST",
      url: "/api/deals/propose",
      headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 50,
        maxPriceDeltaPct: 20,
        milestones: [
          { idx: 1, title: "Milestone 1", amount: 50, acceptanceCriteria: ["Deliver work"] },
        ],
        deliverableHash: "0xdeadbeef", // too short — must be 32 bytes
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does NOT mint an intent for a free-tier deal (negotiated_total=0)", async () => {
    const { sql, dealId } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: true,
    });

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).toBeNull();
  });

  it("does NOT mint an intent when deliverable_hash is absent", async () => {
    const { sql, dealId } = await createAcceptedDeal({
      withDeliverableHash: false,
      freeTier: false,
    });

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).toBeNull();
  });

  it("does NOT mint an intent when buyer lacks a wallet address", async () => {
    const { sql, dealId } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
      buyerWallet: null,
    });

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).toBeNull();
  });

  it("does NOT mint an intent when seller lacks a wallet address", async () => {
    const { sql, dealId } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
      sellerWallet: null,
    });

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).toBeNull();
  });

  it("is idempotent — double-accepting does not create a second intent", async () => {
    // Prepare a deal that we can double-accept (using SQL to reset status)
    const { sql, dealId, sellerHeaders, sellerId } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
    });

    // Manually reset deal to 'proposed' and re-accept to test idempotency guard
    await sql`UPDATE deals SET status = 'proposed', intent_id = deals.intent_id WHERE id = ${dealId}`;
    const { app } = await createTestApp();
    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });

    const intents = await sql`
      SELECT id FROM intents WHERE buyer_agent_id = (SELECT buyer_agent_id FROM deals WHERE id = ${dealId})
    `;
    // Should still be exactly 1 intent (the idempotency guard skips if intent_id already set)
    expect(intents.length).toBe(1);
  });
});

describe("autoclose — Change 2: POST /api/deals/:id/funding-authorization", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns 201 when the buyer submits a valid EIP-3009 authorization", async () => {
    const { app, sql, dealId, buyerId, buyerHeaders } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
      amount: 50,
    });

    const [deal] = await sql<Array<{ intent_id: string; negotiated_total: string }>>`
      SELECT intent_id, negotiated_total FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).not.toBeNull();

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/funding-authorization`,
      headers: buyerHeaders,
      payload: {
        agentId:     buyerId,
        value:       Number(deal.negotiated_total),
        validAfter:  0,
        validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce:       FAKE_HEX32,
        v:           27,
        r:           FAKE_HEX32,
        s:           FAKE_HEX32_B,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.intent_id).toBe(deal.intent_id);
    expect(body.status).toBe("queued");

    // Verify the row is in the DB
    const [authRow] = await sql`
      SELECT status FROM intent_funding_authorizations WHERE intent_id = ${deal.intent_id}
    `;
    expect(authRow.status).toBe("queued");
  });

  it("returns 403 when the seller tries to submit a funding authorization", async () => {
    const { app, sql, dealId, sellerId, sellerHeaders } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
      amount: 50,
    });

    const [deal] = await sql<Array<{ negotiated_total: string }>>`
      SELECT negotiated_total FROM deals WHERE id = ${dealId}
    `;

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/funding-authorization`,
      headers: sellerHeaders,
      payload: {
        agentId:     sellerId,
        value:       Number(deal.negotiated_total),
        validAfter:  0,
        validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce:       FAKE_HEX32,
        v:           27,
        r:           FAKE_HEX32,
        s:           FAKE_HEX32_B,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 when value does not match intent max_price_usdc", async () => {
    const { app, dealId, buyerId, buyerHeaders } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: false,
      amount: 50,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/funding-authorization`,
      headers: buyerHeaders,
      payload: {
        agentId:     buyerId,
        value:       99.99,  // wrong amount
        validAfter:  0,
        validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce:       FAKE_HEX32,
        v:           27,
        r:           FAKE_HEX32,
        s:           FAKE_HEX32_B,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("VALUE_MISMATCH");
  });

  it("returns 409 for a deal without an auto-minted intent (free-tier deal)", async () => {
    const { app, dealId, buyerId, buyerHeaders } = await createAcceptedDeal({
      withDeliverableHash: true,
      freeTier: true,
    });

    // For a free-tier deal, the API should reject with 409 before value validation
    // because the deal has no intent_id. Use a non-zero value to avoid Zod rejection.
    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/funding-authorization`,
      headers: buyerHeaders,
      payload: {
        agentId:     buyerId,
        value:       1,  // non-zero to pass zod; 409 should fire before value-match check
        validAfter:  0,
        validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce:       FAKE_HEX32,
        v:           27,
        r:           FAKE_HEX32,
        s:           FAKE_HEX32_B,
      },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("autoclose — Change 2: POST /api/intents/:id/reveal", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupIntentForReveal() {
    const { app, sql, dealId, buyerId, sellerId, buyerHeaders, sellerHeaders } =
      await createAcceptedDeal({
        withDeliverableHash: true,
        freeTier: false,
        amount: 25,
      });

    const [deal] = await sql<Array<{ intent_id: string }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).not.toBeNull();

    // Register seller auth headers and return intent details
    return { app, sql, intentId: deal.intent_id, sellerId, sellerHeaders, buyerId, buyerHeaders };
  }

  it("returns 200 and sets status=reveal_ready when seller submits preimage", async () => {
    const { app, sql, intentId, sellerId, sellerHeaders } = await setupIntentForReveal();

    const res = await app.inject({
      method: "POST",
      url: `/api/intents/${intentId}/reveal-preimage`,
      headers: sellerHeaders,
      payload: {
        agentId:  sellerId,
        preimage: PREIMAGE_HEX,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("reveal_ready");

    // Verify the reveal row is stored
    const [revealRow] = await sql`
      SELECT preimage FROM intent_reveals WHERE intent_id = ${intentId}
    `;
    expect(revealRow).toBeDefined();
    const storedHex = "0x" + Buffer.from(revealRow.preimage as Buffer).toString("hex");
    expect(storedHex).toBe(PREIMAGE_HEX);
  });

  it("accepts optional ciphertext along with the preimage", async () => {
    const { app, sql, intentId, sellerId, sellerHeaders } = await setupIntentForReveal();
    const ciphertextHex = "0x" + "cc".repeat(32);

    const res = await app.inject({
      method: "POST",
      url: `/api/intents/${intentId}/reveal-preimage`,
      headers: sellerHeaders,
      payload: {
        agentId:    sellerId,
        preimage:   PREIMAGE_HEX,
        ciphertext: ciphertextHex,
      },
    });
    expect(res.statusCode).toBe(200);

    const [revealRow] = await sql`
      SELECT ciphertext FROM intent_reveals WHERE intent_id = ${intentId}
    `;
    const storedCiphertextHex = "0x" + Buffer.from(revealRow.ciphertext as Buffer).toString("hex");
    expect(storedCiphertextHex).toBe(ciphertextHex);
  });

  it("returns 403 when a different agent tries to reveal", async () => {
    const { app, intentId, buyerId, buyerHeaders } = await setupIntentForReveal();

    const res = await app.inject({
      method: "POST",
      url: `/api/intents/${intentId}/reveal-preimage`,
      headers: buyerHeaders,  // buyer, not seller
      payload: {
        agentId:  buyerId,
        preimage: PREIMAGE_HEX,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 409 when intent is already in reveal_ready state", async () => {
    const { app, sql, intentId, sellerId, sellerHeaders } = await setupIntentForReveal();

    // First reveal — should succeed
    const firstRes = await app.inject({
      method: "POST",
      url: `/api/intents/${intentId}/reveal-preimage`,
      headers: sellerHeaders,
      payload: { agentId: sellerId, preimage: PREIMAGE_HEX },
    });
    expect(firstRes.statusCode).toBe(200);

    // Second reveal — intent is now reveal_ready, should 409
    const secondRes = await app.inject({
      method: "POST",
      url: `/api/intents/${intentId}/reveal-preimage`,
      headers: sellerHeaders,
      payload: { agentId: sellerId, preimage: PREIMAGE_HEX },
    });
    expect(secondRes.statusCode).toBe(409);
    const body = JSON.parse(secondRes.body);
    expect(body.code).toBe("INTENT_BAD_STATE");
  });

  it("returns 404 for a non-existent intent", async () => {
    const { app, sellerId, sellerHeaders } = await setupIntentForReveal();

    const res = await app.inject({
      method: "POST",
      url: `/api/intents/${randomUUID()}/reveal-preimage`,
      headers: sellerHeaders,
      payload: { agentId: sellerId, preimage: PREIMAGE_HEX },
    });
    expect(res.statusCode).toBe(404);
  });
});
