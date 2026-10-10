import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// POST /api/admin/agents/bulk-mark-internal matches owners by canonical wallet
// key (`ap_wallet_key`), the same key qualifying_deals and the admin
// economics.integrity guard group by. A raw-text match missed case-variant
// copies of a fleet wallet, and matched placeholder wallets verbatim.

const ZERO = "0x" + "0".repeat(40);
const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const SOLANA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const ADMIN_KEY = "bulk-mark-internal-admin-key";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
let app: Ctx["app"];
let sql: Ctx["sql"];

beforeEach(async () => {
  ({ app, sql } = await createTestApp());
  await cleanDatabase();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

/** Register an agent, then force its stored owner wallet to the exact text given. */
async function agentWithStoredWallet(stored: string | null): Promise<string> {
  const id = randomUUID();
  await getAuthHeadersForAgent(id, { walletAddress: null });
  await sql`UPDATE agents SET owner_wallet_address = ${stored}, is_internal = FALSE WHERE id = ${id}`;
  return id;
}

async function bulk(walletAddresses: string[], isInternal = true) {
  const r = await app.inject({
    method: "POST",
    url: "/api/admin/agents/bulk-mark-internal",
    headers: { "x-admin-key": ADMIN_KEY },
    payload: { walletAddresses, isInternal },
  });
  expect(r.statusCode).toBe(200);
  return JSON.parse(r.body) as {
    ok: boolean;
    updated: number;
    agents: Array<{ id: string; isInternal: boolean }>;
    unrecognizedWallets: string[];
  };
}

async function internal(id: string): Promise<boolean> {
  const [r] = await sql`SELECT is_internal FROM agents WHERE id = ${id}`;
  return Boolean(r.is_internal);
}

describe("bulk-mark-internal — canonical wallet matching", () => {
  it("an exact match is flagged and an unrelated owner is not (unchanged behaviour)", async () => {
    const fleet = await agentWithStoredWallet(W(1));
    const other = await agentWithStoredWallet(W(2));
    const res = await bulk([W(1)]);
    expect(res.updated).toBe(1);
    expect(res.agents.map(a => a.id)).toEqual([fleet]);
    expect(res.unrecognizedWallets).toEqual([]);
    expect(await internal(fleet)).toBe(true);
    expect(await internal(other)).toBe(false);
  });

  it("case-variant copies of the same EVM owner are all flagged", async () => {
    const mixed = await agentWithStoredWallet(MIXED);
    const lower = await agentWithStoredWallet(MIXED.toLowerCase());
    const upperPrefix = await agentWithStoredWallet("0X" + MIXED.slice(2).toUpperCase());
    const padded = await agentWithStoredWallet(`  ${MIXED.toLowerCase()} `);
    const other = await agentWithStoredWallet(W(2));
    const res = await bulk([MIXED.toLowerCase()]);
    expect(res.updated).toBe(4);
    expect(new Set(res.agents.map(a => a.id))).toEqual(new Set([mixed, lower, upperPrefix, padded]));
    expect(await internal(other)).toBe(false);
  });

  it("isInternal=false unflags every case variant too", async () => {
    const a = await agentWithStoredWallet(MIXED);
    const b = await agentWithStoredWallet(MIXED.toLowerCase());
    await bulk([MIXED]);
    expect([await internal(a), await internal(b)]).toEqual([true, true]);
    const res = await bulk(["0X" + MIXED.slice(2)], false);
    expect(res.updated).toBe(2);
    expect([await internal(a), await internal(b)]).toEqual([false, false]);
  });

  it("garbage, zero and empty inputs flag nothing — not even agents storing that exact text", async () => {
    const nullWallet = await agentWithStoredWallet(null);
    const zeroWallet = await agentWithStoredWallet(ZERO);
    const placeholder = await agentWithStoredWallet("0xAgentPactPlatformUSDC");
    const empty = await agentWithStoredWallet("");
    const real = await agentWithStoredWallet(W(3));
    const inputs = [ZERO, ZERO.replace("0x", "0X"), "0xAgentPactPlatformUSDC", "", "garbage", "11111111111111111111111111111111"];
    const res = await bulk(inputs);
    expect(res.updated).toBe(0);
    expect(res.agents).toEqual([]);
    expect(res.unrecognizedWallets).toEqual(inputs);
    for (const id of [nullWallet, zeroWallet, placeholder, empty, real]) {
      expect(await internal(id)).toBe(false);
    }
  });

  it("a mix of known and unknown inputs flags only the known owner and reports the rest", async () => {
    const fleet = await agentWithStoredWallet(W(1));
    const zeroWallet = await agentWithStoredWallet(ZERO);
    const res = await bulk([ZERO, W(1).toUpperCase().replace("0X", "0x"), "nope"]);
    expect(res.agents.map(a => a.id)).toEqual([fleet]);
    expect(res.unrecognizedWallets).toEqual([ZERO, "nope"]);
    expect(await internal(zeroWallet)).toBe(false);
  });

  it("Solana keys stay case-sensitive: a lower-cased copy is a different owner", async () => {
    const sol = await agentWithStoredWallet(SOLANA);
    const res = await bulk([SOLANA.toLowerCase()]);
    expect(res.updated).toBe(0);
    expect(await internal(sol)).toBe(false);
    const exact = await bulk([SOLANA]);
    expect(exact.agents.map(a => a.id)).toEqual([sol]);
  });

  it("an empty wallet list is a no-op and handlePatterns still match by handle", async () => {
    const fleet = await agentWithStoredWallet(W(1));
    const byHandle = await agentWithStoredWallet(null);
    const tag = "bulkfleet" + randomUUID().slice(0, 8);
    await sql`UPDATE agents SET handle = ${tag + "-bot"} WHERE id = ${byHandle}`;
    expect((await bulk([])).updated).toBe(0);
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/agents/bulk-mark-internal",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { handlePatterns: [tag], isInternal: true },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).agents.map((a: { id: string }) => a.id)).toEqual([byHandle]);
    expect(await internal(fleet)).toBe(false);
  });
});
