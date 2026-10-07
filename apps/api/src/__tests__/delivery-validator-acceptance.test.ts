/**
 * M3: a deal whose acceptance criteria carry `{validator: {...}}` gets a
 * DETERMINISTIC verdict at delivery time, before any LLM judge:
 *   pass → delivery 'auto-verified' → the settlement sweeper releases through
 *          the existing /fulfillment/auto-complete route without the judge;
 *   fail → 422, delivery 'rejected' with reasons, milestone stays open.
 * The sweeper runs here against the REAL schema (its candidate SQL is only
 * fake-sql tested in the relayer workspace).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";
import { isPublicAddress, validatorRuntime } from "../shared/validators/index.js";
import { runSettlementSweep } from "../../../relayer-daemon/src/settlement-sweeper.js";
import type { SqlClient } from "../../../relayer-daemon/src/sweepers.js";

const GOOD = "email,score\na@x.io,1\nb@x.io,2\n";
const BAD = "email,score\n,notanumber\n";
const CSV_VALIDATOR = {
  validator: { type: "csv-schema", columns: [{ name: "email", required: true }, { name: "score", type: "integer" }], minRows: 1 },
};

describe("delivery acceptance with deterministic validators", () => {
  let server: Server;
  let port = 0;
  let buyerId: string;
  let sellerId: string;
  let buyerHeaders: Record<string, string>;
  let sellerHeaders: Record<string, string>;
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-acc-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=artifacts.test",
      "-addext", "subjectAltName=DNS:artifacts.test",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    server = createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
      if (req.url === "/good.csv") { res.writeHead(200); res.end(GOOD); return; }
      if (req.url === "/bad.csv") { res.writeHead(200); res.end(BAD); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
    validatorRuntime.options = {
      ca: cert,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      addressPolicy: (ip, host) => host === "artifacts.test" || isPublicAddress(ip),
    };
  });
  afterAll(async () => {
    validatorRuntime.options = {};
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    buyerId = randomUUID();
    sellerId = randomUUID();
    buyerHeaders = await getAuthHeadersForAgent(buyerId, { walletAddress: "0x00000000000000000000000000000000000000b1" });
    sellerHeaders = await getAuthHeadersForAgent(sellerId, { walletAddress: "0x00000000000000000000000000000000000000c2" });
  });

  const artifact = (path: string) => [{ type: "url", url: `https://artifacts.test:${port}${path}` }];

  async function fundedDeal(needCriteria: unknown[], milestoneCriteria: unknown[] = ["CSV delivered"]) {
    const { app, sql } = await createTestApp();
    const offer = await app.inject({ method: "POST", url: "/api/offers", headers: sellerHeaders, payload: generateTestOffer(sellerId) });
    const need = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { agentId: buyerId, title: "Leads CSV", descriptionMd: "A CSV of leads with emails.", category: "data", budgetMax: 50, acceptanceCriteria: needCriteria },
    });
    expect(need.statusCode).toBe(201);
    const propose = await app.inject({
      method: "POST", url: "/api/deals/propose", headers: buyerHeaders,
      payload: {
        buyerAgentId: buyerId, sellerAgentId: sellerId, offerId: JSON.parse(offer.body).id, needId: JSON.parse(need.body).id,
        negotiatedTotal: 20, maxPriceDeltaPct: 0, milestones: [{ idx: 1, title: "CSV", amount: 20, acceptanceCriteria: milestoneCriteria }],
      },
    });
    expect(propose.statusCode).toBe(201);
    const dealId = JSON.parse(propose.body).id as string;
    expect((await app.inject({ method: "POST", url: `/api/deals/${dealId}/accept`, headers: sellerHeaders, payload: { actorAgentId: sellerId } })).statusCode).toBe(200);
    const [m] = await sql`SELECT id FROM milestones WHERE deal_id = ${dealId}`;
    const fund = await app.inject({
      method: "POST", url: "/api/payments/create-intent", headers: buyerHeaders,
      payload: { provider: "usdc", milestoneId: m.id, buyerAgentId: buyerId, walletProvider: "metamask", buyerWalletAddress: "0x00000000000000000000000000000000000000b1", chain: "base" },
    });
    expect(fund.statusCode).toBe(201);
    return { app, sql, dealId, milestoneId: m.id as string, needId: JSON.parse(need.body).id as string };
  }

  const submit = (app: Awaited<ReturnType<typeof createTestApp>>["app"], milestoneId: string, path: string) =>
    app.inject({ method: "POST", url: "/api/deliveries/submit", headers: sellerHeaders, payload: { milestoneId, submittedBy: sellerId, artifacts: artifact(path) } });

  it("criteria schema: validator objects round-trip on needs; unknown/invalid validators are refused", async () => {
    const { app } = await createTestApp();
    const base = { agentId: buyerId, title: "Leads CSV", descriptionMd: "A CSV of leads with emails.", category: "data" };
    const ok = await app.inject({ method: "POST", url: "/api/needs", headers: buyerHeaders, payload: { ...base, acceptanceCriteria: ["deduped", CSV_VALIDATOR] } });
    expect(ok.statusCode).toBe(201);
    const got = await app.inject({ method: "GET", url: `/api/needs/${JSON.parse(ok.body).id}`, headers: buyerHeaders });
    expect(JSON.parse(got.body).acceptance_criteria).toEqual([
      "deduped",
      { validator: { ...CSV_VALIDATOR.validator, columns: [{ name: "email", type: "string", required: true }, { name: "score", type: "integer", required: false }], maxBytes: 10485760, delimiter: ",", allowExtraColumns: true, artifactIndex: 0 } },
    ]);
    for (const validator of [{ type: "xlsx" }, { type: "csv-schema", columns: [] }, { type: "json-schema", schema: { type: "string", pattern: "(a+)+$" } }]) {
      const res = await app.inject({ method: "POST", url: "/api/needs", headers: buyerHeaders, payload: { ...base, acceptanceCriteria: [{ validator }] } });
      expect(res.statusCode, JSON.stringify(validator)).toBe(400);
    }
  });

  it("fail → 422 with reasons recorded; milestone stays open; buyer not told a delivery arrived", async () => {
    const { app, sql, dealId, milestoneId } = await fundedDeal(["Leads", CSV_VALIDATOR]);
    const res = await submit(app, milestoneId, "/bad.csv");
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("DELIVERY_VALIDATION_FAILED");
    expect(body.validation.passed).toBe(false);
    const [dl] = await sql`SELECT status, auto_verify_result, verification_notes FROM deliveries WHERE milestone_id = ${milestoneId}`;
    expect(dl.status).toBe("rejected");
    expect((dl.auto_verify_result as any).validators.passed).toBe(false);
    expect(String(dl.verification_notes)).toMatch(/column "email" is empty/);
    const [m] = await sql`SELECT status FROM milestones WHERE id = ${milestoneId}`;
    expect(m.status).not.toBe("delivered");
    const [d] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(d.status).toBe("active");
  });

  it("a seller-writable MILESTONE validator can reject, but its pass never replaces the judge", async () => {
    const { app, milestoneId } = await fundedDeal(["Leads"], ["CSV", { validator: { type: "json-schema", schema: {} } }]);
    const res = await submit(app, milestoneId, "/good.csv"); // CSV is not JSON → fails
    expect(res.statusCode).toBe(422);
    const { app: app2, sql: sql2, milestoneId: m2 } = await fundedDeal(["Leads"], ["CSV", CSV_VALIDATOR]);
    const ok = await submit(app2, m2, "/good.csv");
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.body).validation).toMatchObject({ passed: true, releaseEligible: false });
    const [dl] = await sql2`SELECT status FROM deliveries WHERE milestone_id = ${m2}`;
    expect(dl.status).toBe("submitted");
  });

  it("a declared artifact sha256 that differs from the fetched bytes fails the delivery", async () => {
    const { app, milestoneId } = await fundedDeal(["Leads", CSV_VALIDATOR]);
    const res = await app.inject({
      method: "POST", url: "/api/deliveries/submit", headers: sellerHeaders,
      payload: { milestoneId, submittedBy: sellerId, artifacts: [{ type: "url", url: `https://artifacts.test:${port}/good.csv`, hash: `sha256:${"0".repeat(64)}` }] },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(JSON.parse(res.body).validation)).toMatch(/declared artifact hash/);
  });

  it("more than 5 validators in one criteria list is refused", async () => {
    const { app } = await createTestApp();
    const six = Array.from({ length: 6 }, (_, i) => ({ validator: { type: "sha256", sha256: String(i).repeat(64) } }));
    const res = await app.inject({
      method: "POST", url: "/api/needs", headers: buyerHeaders,
      payload: { agentId: buyerId, title: "Leads CSV", descriptionMd: "A CSV of leads with emails.", category: "data", acceptanceCriteria: six },
    });
    expect(res.statusCode).toBe(400);
  });

  it("validator in the MILESTONE criteria applies too (and an x402-style unreachable artifact fails closed)", async () => {
    const { app, milestoneId } = await fundedDeal(["Leads"], ["CSV", CSV_VALIDATOR]);
    const res = await submit(app, milestoneId, "/missing.csv");
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(JSON.parse(res.body).validation)).toMatch(/HTTP 404/);
  });

  it("pass → auto-verified; the real-schema sweeper releases on the validator verdict without the judge", async () => {
    const { app, sql, dealId, milestoneId } = await fundedDeal(["Leads", CSV_VALIDATOR]);
    const res = await submit(app, milestoneId, "/good.csv");
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).validation).toMatchObject({ passed: true, releaseEligible: true });
    const [dl] = await sql`SELECT status, auto_verify_result FROM deliveries WHERE milestone_id = ${milestoneId}`;
    expect(dl.status).toBe("auto-verified");
    expect((dl.auto_verify_result as any).validators.verdicts[0]).toMatchObject({ type: "csv-schema", passed: true, details: { rows: 2 } });

    // Age the deal past its acceptance window, then run the sweeper for real.
    await sql`UPDATE deals SET updated_at = NOW() - INTERVAL '3 days' WHERE id = ${dealId}`;
    process.env.ADMIN_API_KEY = "test-admin-key-m3";
    const judgeCalls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.test") { judgeCalls.push(String(url)); throw new Error("judge must not be called"); }
      const r = await app.inject({ method: (init?.method ?? "GET") as "POST", url: u.pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), payload: init?.body as string | undefined });
      return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await runSettlementSweep(sql as unknown as SqlClient, {
      apiBaseUrl: "https://api.test", adminApiKey: "test-admin-key-m3", completeThreshold: 0.85, maxPerTick: 10,
      autoReleaseEnabled: true, fetchImpl, jev: { endpoint: "https://judge.invalid", fetchImpl, attempts: 1 },
    });
    const decision = result.decisions.find((d) => d.dealId === dealId);
    expect(decision, JSON.stringify(result)).toMatchObject({ outcome: "complete", p: 1 });
    expect(judgeCalls).toEqual([]);
    const [d] = await sql`SELECT status FROM deals WHERE id = ${dealId}`;
    expect(d.status).toBe("completed");
    const [sd] = await sql`SELECT judge FROM sweeper_decisions WHERE deal_id = ${dealId}`;
    expect(sd.judge).toBe("validator");
  });
});
