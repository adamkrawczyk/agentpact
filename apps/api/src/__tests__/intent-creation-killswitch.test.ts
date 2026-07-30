// apps/api/src/__tests__/intent-creation-killswitch.test.ts
//
// The settlement-protocol emergency brake (INTENT_CREATION_DISABLED).
//
// Context: docs/BUG_DISCOVERED_PROTOCOL.md instructs an operator to stop new
// intent creation if a contract invariant (WHITEPAPER.md I1-I6) is ever found to
// be violable. That instruction referenced an env gate that DID NOT EXIST — the
// documented mitigation was a lie, and the real fallback was hand-running
// iptables against the API port, which also kills every in-flight settlement.
// This suite pins the gate that makes the doc true.
//
// What must hold:
//   1. Both creation paths are gated — POST /api/intents AND the deal-accept
//      auto-mint. Gating only the explicit route would leave the auto-mint open,
//      which is the entire bug class the brake exists to stop.
//   2. Accepting a deal must still SUCCEED with the brake on; it simply stays a
//      manual-settlement deal. The brake stops minting, not commerce.
//   3. In-flight intents remain settleable. A brake that traps escrowed USDC is
//      worse than the bug it is meant to contain.
//   4. Default OFF — an unset env var must never disable production.
//   5. The state is observable via /health/detailed. A kill switch you cannot
//      confirm is a kill switch you cannot trust under pressure.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanDatabase,
  createTestApp,
  generateTestNeed,
  generateTestOffer,
  getAuthHeadersForAgent,
} from "./helpers/testApp.js";

const DELIVERABLE_HASH_HEX = "0x" + "aa".repeat(32);
const ON_CHAIN_ID = "0x" + "11".repeat(32);

const BUYER_WALLET = "0x1111111111111111111111111111111111111111";
const SELLER_WALLET = "0x2222222222222222222222222222222222222222";

function setBrake(on: boolean | undefined) {
  if (on === undefined) {
    delete process.env.INTENT_CREATION_DISABLED;
  } else {
    process.env.INTENT_CREATION_DISABLED = on ? "true" : "false";
  }
}

/**
 * Builds a paid USDC deal carrying a deliverable-hash commitment, up to (but not
 * including) accept. Returns the ids + headers so each test can accept with the
 * brake in whatever state it wants — the brake is read at REQUEST time, so
 * toggling it between setup and accept is the realistic operator sequence.
 */
async function seedProposedDeal() {
  const { app, sql } = await createTestApp();
  const buyerId = randomUUID();
  const sellerId = randomUUID();

  const buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: BUYER_WALLET });
  const sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: SELLER_WALLET });

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
      negotiatedTotal: 50,
      maxPriceDeltaPct: 20,
      milestones: [
        { idx: 1, title: "Milestone 1", amount: 50, acceptanceCriteria: ["Deliver work"] },
      ],
      deliverableHash: DELIVERABLE_HASH_HEX,
    },
  });
  expect(proposeRes.statusCode).toBe(201);
  const dealId = (JSON.parse(proposeRes.body) as { id: string }).id;

  return { app, sql, dealId, buyerId, sellerId, buyerHeaders, sellerHeaders };
}

describe("INTENT_CREATION_DISABLED — settlement-protocol emergency brake", () => {
  beforeEach(async () => {
    setBrake(undefined);
    await cleanDatabase();
  });

  afterEach(() => {
    setBrake(undefined);
  });

  // ── Path 1: the explicit creation route ────────────────────────────────────

  it("blocks POST /api/intents with 503 + INTENT_CREATION_DISABLED when tripped", async () => {
    const { app } = await createTestApp();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId, { walletAddress: BUYER_WALLET });

    setBrake(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/intents",
      headers,
      payload: {
        agentId,
        onChainId: ON_CHAIN_ID,
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: { hash: DELIVERABLE_HASH_HEX },
        maxPriceUsdc: 10,
      },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { code?: string; error?: string };
    // Machine-branchable code, not just prose — SDK/MCP clients switch on this.
    expect(body.code).toBe("INTENT_CREATION_DISABLED");
    expect(body.error).toMatch(/temporarily disabled/i);
  });

  it("does not touch the DB when the brake short-circuits the route", async () => {
    const { app, sql } = await createTestApp();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId, { walletAddress: BUYER_WALLET });

    const [{ count: before }] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count FROM intents
    `;

    setBrake(true);
    await app.inject({
      method: "POST",
      url: "/api/intents",
      headers,
      payload: {
        agentId,
        onChainId: ON_CHAIN_ID,
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: { hash: DELIVERABLE_HASH_HEX },
        maxPriceUsdc: 10,
      },
    });

    const [{ count: after }] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count FROM intents
    `;
    expect(after).toBe(before);
  });

  // ── Path 2: the deal-accept auto-mint (the path a naive fix would miss) ────

  it("blocks the deal-accept auto-mint while still ACCEPTING the deal", async () => {
    const { app, sql, dealId, sellerId, sellerHeaders } = await seedProposedDeal();

    setBrake(true);

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });

    // The brake stops MINTING, not commerce: accept must still succeed.
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql<Array<{ intent_id: string | null; status: string }>>`
      SELECT intent_id, status FROM deals WHERE id = ${dealId}
    `;
    // No intent minted — the deal degrades to manual settlement.
    expect(deal.intent_id).toBeNull();
    // ...and it is a normal accepted deal, not a wedged one.
    expect(deal.status).not.toBe("proposed");
  });

  it("mints normally on the same fixture once the brake is released (negative control)", async () => {
    const { app, sql, dealId, sellerId, sellerHeaders } = await seedProposedDeal();

    setBrake(false);

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql<Array<{ intent_id: string | null }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    // Proves the previous test's null was caused by the BRAKE, not by a broken
    // fixture. Without this control, a fixture that never mints would pass.
    expect(deal.intent_id).not.toBeNull();
  });

  // ── The brake must not trap in-flight value ───────────────────────────────

  it("leaves an already-minted intent fundable + revealable with the brake ON", async () => {
    const { app, sql, dealId, sellerId, sellerHeaders } = await seedProposedDeal();

    // Mint first, brake OFF.
    setBrake(false);
    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/accept`,
      headers: sellerHeaders,
      payload: { actorAgentId: sellerId },
    });
    expect(acceptRes.statusCode).toBe(200);

    const [deal] = await sql<Array<{ intent_id: string }>>`
      SELECT intent_id FROM deals WHERE id = ${dealId}
    `;
    expect(deal.intent_id).not.toBeNull();

    // Now trip the brake — settlement of the EXISTING intent must keep working.
    setBrake(true);

    // Reads stay available.
    const getRes = await app.inject({
      method: "GET",
      url: `/api/intents/${deal.intent_id}`,
      headers: sellerHeaders,
    });
    expect(getRes.statusCode).toBe(200);

    // The seller reveal path must NOT be gated: whatever it answers, it must not
    // be the brake's 503. (A wrong-state answer is fine here; a brake-block is not.)
    const revealRes = await app.inject({
      method: "POST",
      url: `/api/intents/${deal.intent_id}/reveal-preimage`,
      headers: sellerHeaders,
      payload: { preimage: "0x" + "bb".repeat(16) },
    });
    if (revealRes.statusCode === 503) {
      const body = JSON.parse(revealRes.body) as { code?: string };
      expect(body.code).not.toBe("INTENT_CREATION_DISABLED");
    }

    // Cancel is the escape hatch for trapped value — never gate it.
    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/intents/${deal.intent_id}/cancel`,
      headers: sellerHeaders,
      payload: {},
    });
    if (cancelRes.statusCode === 503) {
      const body = JSON.parse(cancelRes.body) as { code?: string };
      expect(body.code).not.toBe("INTENT_CREATION_DISABLED");
    }
  });

  // ── Fail-safe defaults ────────────────────────────────────────────────────

  it("defaults to ENABLED when the env var is unset (no accidental prod outage)", async () => {
    const { app } = await createTestApp();
    const agentId = randomUUID();
    const headers = await getAuthHeadersForAgent(agentId, { walletAddress: BUYER_WALLET });

    setBrake(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/intents",
      headers,
      payload: {
        agentId,
        onChainId: ON_CHAIN_ID,
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: { hash: DELIVERABLE_HASH_HEX },
        maxPriceUsdc: 10,
      },
    });

    // Must not be brake-blocked. Any other outcome (201, 412 pubkey gate, 4xx)
    // is acceptable — we assert only that the brake did not fire.
    if (res.statusCode === 503) {
      const body = JSON.parse(res.body) as { code?: string };
      expect(body.code).not.toBe("INTENT_CREATION_DISABLED");
    }
  });

  it.each(["false", "0", "no", "", "TRUE_ISH_GARBAGE"])(
    "treats INTENT_CREATION_DISABLED=%j as NOT disabled (only true/1/yes trip it)",
    async (value) => {
      const { app } = await createTestApp();
      const agentId = randomUUID();
      const headers = await getAuthHeadersForAgent(agentId, { walletAddress: BUYER_WALLET });

      process.env.INTENT_CREATION_DISABLED = value;

      const res = await app.inject({
        method: "POST",
        url: "/api/intents",
        headers,
        payload: {
          agentId,
          onChainId: ON_CHAIN_ID,
          settlementClass: "A",
          predicateType: "hash-preimage-v1",
          predicateParams: { hash: DELIVERABLE_HASH_HEX },
          maxPriceUsdc: 10,
        },
      });

      if (res.statusCode === 503) {
        const body = JSON.parse(res.body) as { code?: string };
        expect(body.code).not.toBe("INTENT_CREATION_DISABLED");
      }
    },
  );

  it.each(["true", "1", "yes", "TRUE", " true "])(
    "treats INTENT_CREATION_DISABLED=%j as disabled",
    async (value) => {
      const { app } = await createTestApp();
      const agentId = randomUUID();
      const headers = await getAuthHeadersForAgent(agentId, { walletAddress: BUYER_WALLET });

      process.env.INTENT_CREATION_DISABLED = value;

      const res = await app.inject({
        method: "POST",
        url: "/api/intents",
        headers,
        payload: {
          agentId,
          onChainId: ON_CHAIN_ID,
          settlementClass: "A",
          predicateType: "hash-preimage-v1",
          predicateParams: { hash: DELIVERABLE_HASH_HEX },
          maxPriceUsdc: 10,
        },
      });

      expect(res.statusCode).toBe(503);
      expect((JSON.parse(res.body) as { code?: string }).code).toBe(
        "INTENT_CREATION_DISABLED",
      );
    },
  );

  // ── Observability: the operator must be able to confirm the brake ─────────

  it("reports the brake state on both check-carrying health endpoints", async () => {
    const { app } = await createTestApp();

    // NOTE: `/health` and `/api/health` are deliberately minimal liveness probes
    // (ok/service/timestamp only) — no `checks` object, and we do NOT add one,
    // because that shape is a public contract used by uptime monitors. The
    // brake is surfaced on the two endpoints that already carry checks.
    for (const url of ["/api/health/agent-runtime", "/health/detailed"]) {
      setBrake(true);
      const onRes = await app.inject({ method: "GET", url });
      const onBody = JSON.parse(onRes.body) as {
        checks?: Record<string, { intentionallyDisabled?: boolean; enabled?: boolean }>;
      };
      expect(
        onBody.checks?.intentCreation?.intentionallyDisabled,
        `${url} must report the brake as tripped`,
      ).toBe(true);
      expect(onBody.checks?.intentCreation?.enabled).toBe(false);

      setBrake(false);
      const offRes = await app.inject({ method: "GET", url });
      const offBody = JSON.parse(offRes.body) as {
        checks?: Record<string, { intentionallyDisabled?: boolean; enabled?: boolean }>;
      };
      expect(
        offBody.checks?.intentCreation?.intentionallyDisabled,
        `${url} must report the brake as released`,
      ).toBe(false);
      expect(offBody.checks?.intentCreation?.enabled).toBe(true);
    }
  });

  it("keeps the liveness probes lean (no checks object) — public contract", async () => {
    const { app } = await createTestApp();
    setBrake(true);
    for (const url of ["/health", "/api/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok?: boolean; checks?: unknown };
      // A tripped brake must not make the liveness probe fail or grow a payload.
      expect(body.ok).toBe(true);
      expect(body.checks).toBeUndefined();
    }
  });

  it("keeps /health/detailed non-503 while the brake is on (degraded, not down)", async () => {
    const { app } = await createTestApp();
    setBrake(true);
    const res = await app.inject({ method: "GET", url: "/health/detailed" });
    // A tripped brake is an intentional, healthy-but-restricted state. If this
    // 503s, uptime monitors page the operator for their own mitigation.
    expect(res.statusCode).toBeLessThan(500);
  });
});
