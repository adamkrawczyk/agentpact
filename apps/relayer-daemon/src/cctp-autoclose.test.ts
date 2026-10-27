// apps/relayer-daemon/src/cctp-autoclose.test.ts — M1 (lane m1-relay)
//
// The autoclose CLAIM phase calls escrow.claimIntentForSeller on every
// reveal_ready intent. For a gateway intent with a cross-chain payout route,
// sellerTarget is the GATEWAY: a direct claim would land the seller's USDC in
// the gateway without the forward burn, and only claimAndForward (the CCTP
// sweeper) may settle it. This runs the real claim query on Postgres
// (TEST_DATABASE_URL, migrated) — a fake-sql test cannot prove a WHERE clause.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { runAutoCloseSweep } from "./autoclose-sweeper.js";
import type { ChainClient, SqlClient } from "./sweepers.js";
import type { Config } from "./config.js";

const PG_URL = process.env.TEST_DATABASE_URL;

describe("autoclose claim phase vs CCTP payout intents [postgres]", { skip: PG_URL ? false : "set TEST_DATABASE_URL to a migrated database" }, () => {
  let pg: Awaited<ReturnType<typeof connect>>;
  let agentId: string;
  const claimed: string[] = [];

  async function connect() {
    const { default: postgres } = await import("postgres");
    return postgres(PG_URL as string, { prepare: false, max: 2, onnotice: () => {} });
  }

  const chain: ChainClient = {
    async acknowledgeTimeout() { return { txHash: "0x" }; },
    async settleSchelling() { return { txHash: "0x" }; },
    async createIntentWithAuthorization() { throw new Error("fund phase not under test"); },
    async claimIntent(onChainId) { claimed.push(onChainId.toString("hex")); return { txHash: "0xc1a1" }; },
  };

  async function revealReadyIntent(): Promise<{ id: string; onChain: string }> {
    const onChain = randomBytes(32);
    const [i] = await pg`
      INSERT INTO intents (on_chain_id, buyer_agent_id, settlement_class, predicate_type, predicate_params, max_price_usdc, status, expires_at)
      VALUES (${onChain}, ${agentId}, 'A', 'hash-preimage-v1', '{}'::jsonb, 5, 'reveal_ready', NOW() + INTERVAL '1 day')
      RETURNING id
    `;
    await pg`INSERT INTO intent_reveals (intent_id, preimage) VALUES (${i.id}, ${Buffer.from("aa", "hex")})`;
    return { id: i.id as string, onChain: onChain.toString("hex") };
  }

  async function cctpDeposit(intentId: string, payoutDomain: number) {
    await pg`
      INSERT INTO cctp_transfers (direction, intent_id, source_domain, destination_domain, source_tx_hash, amount_base_units, status, payout_domain)
      VALUES ('deposit', ${intentId}, 5, 6, ${"0x" + randomBytes(32).toString("hex")}, 5000000, 'bound', ${payoutDomain})
    `;
  }

  before(async () => {
    pg = await connect();
    const [a] = await pg`INSERT INTO agents (handle, display_name) VALUES (${"m1relay-ac-" + Date.now()}, 'm1-relay autoclose') RETURNING id`;
    agentId = a.id as string;
  });

  after(async () => {
    await pg`DELETE FROM cctp_transfers WHERE intent_id IN (SELECT id FROM intents WHERE buyer_agent_id = ${agentId})`;
    await pg`DELETE FROM intent_reveals WHERE intent_id IN (SELECT id FROM intents WHERE buyer_agent_id = ${agentId})`;
    await pg`DELETE FROM intents WHERE buyer_agent_id = ${agentId}`;
    await pg`DELETE FROM agents WHERE id = ${agentId}`;
    await pg.end();
  });

  it("claims a plain intent and a Base-payout gateway intent, never a cross-chain payout intent", async () => {
    const plain = await revealReadyIntent();
    const basePayout = await revealReadyIntent();
    await cctpDeposit(basePayout.id, 6);
    const solanaPayout = await revealReadyIntent();
    await cctpDeposit(solanaPayout.id, 5);

    await runAutoCloseSweep(pg as unknown as SqlClient, chain, { autocloseMaxUsdc: 5 } as Config);

    assert.ok(claimed.includes(plain.onChain), "plain Class-A intent is still claimed");
    assert.ok(claimed.includes(basePayout.onChain), "payout on Base: sellerTarget is the seller, direct claim is right");
    assert.ok(!claimed.includes(solanaPayout.onChain), "cross-chain payout must be left to claimAndForward");
    const [s] = await pg`SELECT status FROM intents WHERE id = ${solanaPayout.id}`;
    assert.equal(s.status, "reveal_ready");
  });
});
