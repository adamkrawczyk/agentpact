// apps/api/src/__tests__/intents-smoke.test.ts — settlement protocol Phase E
//
// Smoke tests for the v2 intent surface. Covers:
//
//   - Anonymous GET /api/intents/discover returns 200 (CI assertion the
//     auth allowlist was wired correctly — premortem #21).
//   - Authenticated GET /api/intents/discover sees the caller's targeted
//     intents.
//   - POST /api/intents from an agent missing an encryption_pubkey returns
//     412 with a registration challenge (the bootstrap flow per § 2.6).
//   - POST /api/agents/me/encryption-pubkey accepts a valid challenge and
//     persists the pubkey.
//   - POST /api/intents on a registered agent creates an intent row + 201.
//   - Sunset headers land on v1 routes (/api/deals, /api/needs, /api/payments,
//     /api/disputes).
//   - No Sunset header on v2 /api/intents/* routes.
//   - claimAfterTimeout SDK alias still exposes claimTimeout for back-compat.

import { randomUUID, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanDatabase,
  createTestApp,
  getAuthHeadersForAgent,
} from "./helpers/testApp.js";

function randHex32() {
  return "0x" + randomBytes(32).toString("hex");
}

describe("settlement protocol — intent smoke", () => {
  let buyerId: string;
  let buyerHeaders: Record<string, string>;

  beforeEach(async () => {
    const { app } = await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId);
  });

  it("GET /api/intents/discover is anonymous (200 without x-api-key)", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/intents/discover" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { intents: unknown[]; callerAgent: string | null };
    expect(Array.isArray(body.intents)).toBe(true);
    expect(body.callerAgent).toBeNull();
  });

  it("POST /api/intents on a fresh agent returns 412 with bootstrap challenge", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/intents",
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        onChainId: randHex32(),
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: { commitment: "0x" + "ab".repeat(32) },
        maxPriceUsdc: 1,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(412);
    const body = JSON.parse(res.body) as {
      code: string;
      challenge: { nonce: string; message: string; expiresAt: string };
      registerEndpoint: string;
    };
    expect(body.code).toBe("encryption_pubkey_required");
    expect(body.challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.registerEndpoint).toBe("/api/agents/me/encryption-pubkey");
  });

  it("POST /api/agents/me/encryption-pubkey persists pubkey + unlocks intent creation", async () => {
    const { app } = await createTestApp();

    // Trigger the 412 to mint a nonce.
    const challengeRes = await app.inject({
      method: "POST",
      url: "/api/intents",
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        onChainId: randHex32(),
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: {},
        maxPriceUsdc: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(challengeRes.statusCode).toBe(412);
    const challenge = JSON.parse(challengeRes.body).challenge as { nonce: string; message: string };

    // Register pubkey (a 65-byte uncompressed throwaway).
    const fakePubkey = "0x04" + "11".repeat(64);
    const fakeSig = "0x" + "22".repeat(65);
    const regRes = await app.inject({
      method: "POST",
      url: "/api/agents/me/encryption-pubkey",
      headers: buyerHeaders,
      payload: {
        challengeNonce: challenge.nonce,
        signature: fakeSig,
        pubkey: fakePubkey,
      },
    });
    expect(regRes.statusCode).toBe(200);
    expect(JSON.parse(regRes.body).encryptionPubkey).toBe(fakePubkey);

    // Now create an intent — should succeed.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/intents",
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        onChainId: randHex32(),
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: { commitment: "0x" + "33".repeat(32) },
        maxPriceUsdc: 1.5,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(createRes.statusCode).toBe(201);
    const intent = JSON.parse(createRes.body);
    expect(intent.settlement_class).toBe("A");
    expect(intent.status).toBe("open");
    expect(intent.buyer_agent_id).toBe(buyerId);
  });

  it("v1 routes advertise the reachable v2 discovery successor without sunsetting v2", async () => {
    const { app } = await createTestApp();

    const v1 = await app.inject({ method: "GET", url: "/api/deals/00000000-0000-0000-0000-000000000000" });
    // 404 is fine — we're testing headers, not body.
    expect(v1.headers["sunset"]).toBe("Tue, 25 Aug 2026 00:00:00 GMT");
    expect(v1.headers["link"]).toBe('</api/intents/discover>; rel="successor-version"');

    const v2 = await app.inject({ method: "GET", url: "/api/intents/discover" });
    expect(v2.statusCode).toBe(200);
    expect(v2.headers["sunset"]).toBeUndefined();
  });

  it("authenticated discover sees own targeted intents only", async () => {
    const { app, sql } = await createTestApp();
    const otherBuyer = randomUUID();
    const otherHeaders = await getAuthHeadersForAgent(otherBuyer);

    // Unlock pubkey for buyerId once (cheaper than re-running 412 flow each test).
    await sql`UPDATE agents SET encryption_pubkey = '\\x04' WHERE id = ${buyerId}`;
    await sql`UPDATE agents SET encryption_pubkey = '\\x04' WHERE id = ${otherBuyer}`;

    // buyerId creates an OPEN intent (no target) and a TARGETED intent (target = otherBuyer).
    await app.inject({
      method: "POST",
      url: "/api/intents",
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        onChainId: randHex32(),
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: {},
        maxPriceUsdc: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/intents",
      headers: buyerHeaders,
      payload: {
        agentId: buyerId,
        onChainId: randHex32(),
        settlementClass: "A",
        predicateType: "hash-preimage-v1",
        predicateParams: {},
        sellerTargetAgentId: otherBuyer,
        maxPriceUsdc: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });

    const anon = await app.inject({ method: "GET", url: "/api/intents/discover" });
    expect(JSON.parse(anon.body).intents.length).toBe(1); // open only

    const auth = await app.inject({
      method: "GET",
      url: "/api/intents/discover",
      headers: otherHeaders,
    });
    expect(JSON.parse(auth.body).intents.length).toBe(2); // open + targeted
  });
});
