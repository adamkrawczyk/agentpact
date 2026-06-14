// apps/relayer-daemon/src/sweepers.ts — settlement_2705 Phase D
//
// Three deterministic sweepers that walk DB rows and call the
// AgentPactEscrowV2 contract. Each one is implemented as a pure function
// over a sql client + a chain client, so it's unit-testable without
// spinning up Postgres or signing real transactions.

export interface SqlClient {
  // Tagged-template SQL (matches the postgres lib the API uses).
  <T = unknown>(template: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}

export interface ChainClient {
  acknowledgeTimeout(intentOnChainId: Buffer): Promise<{ txHash: string }>;
  settleSchelling(intentOnChainId: Buffer): Promise<{ txHash: string }>;
  /** Gasless Class-A intent creation via EIP-3009. Returns the on-chain intentId. */
  createIntentWithAuthorization(args: {
    buyer: string;         // 0x address — EIP-3009 authorizer
    verifier: string;      // 0x address — approved IPredicateVerifier
    params: Buffer;        // ABI-encoded predicate params
    sellerTarget: string;  // 0x address or zero address
    maxPrice: bigint;      // USDC 6-decimal units
    expiresAt: bigint;     // unix seconds
    value: bigint;         // must equal maxPrice
    validAfter: bigint;
    validBefore: bigint;
    nonce: Buffer;         // 32-byte bytes32
    sigV: number;
    sigR: Buffer;          // 32-byte
    sigS: Buffer;          // 32-byte
  }): Promise<{ txHash: string; onChainId: Buffer }>;
  /** Claim a Class-A intent by presenting ciphertext + witness (preimage). */
  claimIntent(
    onChainId: Buffer,
    ciphertext: Buffer,
    witness: Buffer,
  ): Promise<{ txHash: string }>;
}

export interface SweeperResult {
  scanned: number;
  acted: number;
  failed: Array<{ intentId: string; error: string }>;
}

/**
 * Class B ack-timeout sweeper. Picks delivered intents whose ack window has
 * lapsed and calls acknowledgeTimeout. Idempotent: the contract reverts
 * with "not delivered" if a buyer raced us with their own acknowledge(),
 * so we treat that revert as a benign skip rather than a hard failure.
 */
export async function runAckTimeoutSweep(
  sql: SqlClient,
  chain: ChainClient,
  now: Date = new Date(),
): Promise<SweeperResult> {
  const rows = await sql<{ id: string; on_chain_id: Buffer }>`
    SELECT id, on_chain_id FROM intents
    WHERE status = 'delivered'
      AND ack_deadline_at IS NOT NULL
      AND ack_deadline_at < ${now}
    ORDER BY ack_deadline_at ASC
    LIMIT 100
  `;

  const result: SweeperResult = { scanned: rows.length, acted: 0, failed: [] };
  for (const row of rows) {
    try {
      await chain.acknowledgeTimeout(row.on_chain_id);
      result.acted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not delivered|already settled/i.test(msg)) {
        // Benign: someone (sweeper, buyer) raced us.
        continue;
      }
      result.failed.push({ intentId: row.id, error: msg });
    }
  }
  return result;
}

/**
 * Schelling round-timeout sweeper. Picks intents in reveal_round1 /
 * reveal_round2 whose deadline has lapsed and calls settleSchelling.
 */
export async function runSchellingSweep(
  sql: SqlClient,
  chain: ChainClient,
  now: Date = new Date(),
): Promise<SweeperResult> {
  const rows = await sql<{ id: string; on_chain_id: Buffer; status: string }>`
    SELECT id, on_chain_id, status FROM intents
    WHERE status IN ('reveal_round1', 'reveal_round2')
      AND COALESCE(round2_deadline_at, round1_deadline_at) < ${now}
    ORDER BY COALESCE(round2_deadline_at, round1_deadline_at) ASC
    LIMIT 100
  `;

  const result: SweeperResult = { scanned: rows.length, acted: 0, failed: [] };
  for (const row of rows) {
    try {
      await chain.settleSchelling(row.on_chain_id);
      result.acted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not pending settle|round.*still open/i.test(msg)) {
        continue;
      }
      result.failed.push({ intentId: row.id, error: msg });
    }
  }
  return result;
}

/**
 * Stream-stale sweeper. Flags Class C streaming intents that haven't seen
 * a claim_unit in 24h+. Does NOT cancel (cancel is buyer/seller choice).
 * Returns the IDs that would be flagged — the daemon's main loop calls a
 * notifier with the result.
 */
export async function runStreamStaleSweep(
  sql: SqlClient,
  now: Date = new Date(),
): Promise<{ stale: Array<{ id: string }> }> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await sql<{ id: string }>`
    SELECT i.id FROM intents i
    LEFT JOIN (
      SELECT intent_id, MAX(settled_at) AS last_settled
      FROM intent_units
      GROUP BY intent_id
    ) u ON u.intent_id = i.id
    WHERE i.status = 'streaming'
      AND COALESCE(u.last_settled, i.created_at) < ${cutoff}
    LIMIT 100
  `;
  return { stale: rows };
}
