// apps/relayer-daemon/src/autoclose-sweeper.ts — autoclose rollout Change 3
//
// Two-phase autonomous execution sweeper for Class-A intents:
//   FUND  — broadcasts createIntentWithAuthorization for awaiting_funding intents
//   CLAIM — broadcasts claimIntent for reveal_ready intents
//
// Pure function over sql + chain clients; no Postgres / no real chain in tests.
// Mirror exactly the style of the existing sweepers in sweepers.ts.

import type { SqlClient, ChainClient, SweeperResult } from "./sweepers.js";
import type { Config } from "./config.js";

// ── DB row shapes ──────────────────────────────────────────────────────────

interface FundRow {
  intent_id: string;
  agent_id: string;
  buyer_wallet: string;
  verifier_address: string;
  predicate_params: string;         // 0x-prefixed ABI-encoded bytes (hex text from JSONB ->>)
  seller_target: string;            // 0x address or '0x0000000000000000000000000000000000000000'
  max_price_usdc: string;           // numeric string from postgres
  expires_at: Date;
  // from intent_funding_authorizations
  auth_id: string;
  value_usdc: string;               // must match max_price_usdc
  valid_after: string;
  valid_before: string;
  nonce: Buffer;
  sig_v: number;
  sig_r: Buffer;
  sig_s: Buffer;
}

interface ClaimRow {
  intent_id: string;
  on_chain_id: Buffer;
  deal_id: string;
  // from intent_reveals
  reveal_id: string;
  preimage: Buffer;
  ciphertext: Buffer;
}

// ── USDC unit conversion ───────────────────────────────────────────────────

/** Convert a decimal USDC string (6-decimal, no fraction larger than 6 places)
 *  to its raw bigint representation (e.g. "1.5" → 1_500_000n). */
function parseUsdc(s: string): bigint {
  // Split on decimal point.
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = frac.slice(0, 6).padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

// ── FUND phase ─────────────────────────────────────────────────────────────

async function fundPhase(
  sql: SqlClient,
  chain: ChainClient,
  config: Config,
): Promise<SweeperResult> {
  const capRaw = BigInt(Math.round(config.autocloseMaxUsdc * 1_000_000));

  // SELECT intents that need on-chain funding:
  //   • status = 'awaiting_funding' and no on_chain_id yet
  //   • joined to a 'queued' funding authorization
  //   • the buyer agent has autoclose_enabled = true
  //   • max_price_usdc within the relayer spend cap
  const rows = await sql<FundRow>`
    SELECT
      i.id                        AS intent_id,
      a.id                        AS agent_id,
      a.owner_wallet_address      AS buyer_wallet,
      i.predicate_params->>'verifier' AS verifier_address,
      i.predicate_params->>'params'   AS predicate_params,
      COALESCE(
        i.predicate_params->>'seller_target',
        '0x0000000000000000000000000000000000000000'
      )                           AS seller_target,
      i.max_price_usdc            AS max_price_usdc,
      i.expires_at                AS expires_at,
      ifa.id                      AS auth_id,
      ifa.value_usdc              AS value_usdc,
      ifa.valid_after             AS valid_after,
      ifa.valid_before            AS valid_before,
      ifa.nonce                   AS nonce,
      ifa.sig_v                   AS sig_v,
      ifa.sig_r                   AS sig_r,
      ifa.sig_s                   AS sig_s
    FROM intents i
    JOIN agents a ON a.id = i.buyer_agent_id
    JOIN intent_funding_authorizations ifa ON ifa.intent_id = i.id
    WHERE i.status = 'awaiting_funding'
      AND i.on_chain_id IS NULL
      AND ifa.status = 'queued'
      AND a.autoclose_enabled = true
      AND (i.max_price_usdc * 1000000)::bigint <= ${Number(capRaw)}
    ORDER BY i.created_at ASC
    LIMIT 50
  `;

  const result: SweeperResult = { scanned: rows.length, acted: 0, failed: [] };

  for (const row of rows) {
    try {
      const maxPrice = parseUsdc(row.max_price_usdc);
      const value = parseUsdc(row.value_usdc);
      const expiresAt = BigInt(Math.floor(new Date(row.expires_at).getTime() / 1000));

      const { txHash, onChainId } = await chain.createIntentWithAuthorization({
        buyer: row.buyer_wallet,
        verifier: row.verifier_address,
        params: row.predicate_params as `0x${string}`,
        sellerTarget: row.seller_target,
        maxPrice,
        expiresAt,
        value,
        validAfter: BigInt(row.valid_after),
        validBefore: BigInt(row.valid_before),
        nonce: row.nonce,
        sigV: row.sig_v,
        sigR: row.sig_r,
        sigS: row.sig_s,
      });

      // Persist the on_chain_id and advance status to 'open'.
      await sql`
        UPDATE intents
        SET on_chain_id = ${onChainId},
            status = 'open',
            on_chain_funding_tx = ${txHash},
            updated_at = NOW()
        WHERE id = ${row.intent_id}
          AND status = 'awaiting_funding'
      `;

      // Mark the authorization consumed so it can't be replayed.
      await sql`
        UPDATE intent_funding_authorizations
        SET status = 'consumed',
            updated_at = NOW()
        WHERE id = ${row.auth_id}
      `;

      result.acted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Benign: a duplicate intent means someone else (or a prior sweeper run)
      // already funded this intent. Skip, don't fail.
      if (/dup intent|already funded|intent already exists/i.test(msg)) {
        continue;
      }
      result.failed.push({ intentId: row.intent_id, error: msg });
    }
  }

  return result;
}

// ── CLAIM phase ────────────────────────────────────────────────────────────

async function claimPhase(
  sql: SqlClient,
  chain: ChainClient,
): Promise<SweeperResult> {
  // SELECT intents that are ready to be claimed:
  //   • status = 'reveal_ready' (seller has submitted the preimage via API)
  //   • on_chain_id IS NOT NULL (was funded in a prior cycle or in this one)
  //   • joined to intent_reveals for ciphertext + preimage (witness)
  const rows = await sql<ClaimRow>`
    SELECT
      i.id          AS intent_id,
      i.on_chain_id AS on_chain_id,
      i.deal_id     AS deal_id,
      ir.id         AS reveal_id,
      ir.preimage   AS preimage,
      COALESCE(ir.ciphertext, ''::bytea) AS ciphertext
    FROM intents i
    JOIN intent_reveals ir ON ir.intent_id = i.id
    WHERE i.status = 'reveal_ready'
      AND i.on_chain_id IS NOT NULL
    ORDER BY i.updated_at ASC
    LIMIT 50
  `;

  const result: SweeperResult = { scanned: rows.length, acted: 0, failed: [] };

  for (const row of rows) {
    try {
      // For hash-preimage-v1, the witness IS the preimage bytes.
      const { txHash } = await chain.claimIntent(
        row.on_chain_id,
        row.ciphertext,
        row.preimage,  // witness = preimage
      );

      // Flip intent to 'claimed' and the linked deal to 'completed'.
      await sql`
        UPDATE intents
        SET status = 'claimed',
            on_chain_claim_tx = ${txHash},
            updated_at = NOW()
        WHERE id = ${row.intent_id}
          AND status = 'reveal_ready'
      `;

      if (row.deal_id) {
        await sql`
          UPDATE deals
          SET status = 'completed',
              completed_at = NOW(),
              updated_at = NOW()
          WHERE id = ${row.deal_id}
            AND status NOT IN ('completed', 'cancelled')
        `;
      }

      result.acted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Benign: already claimed means a race (another sweeper run, the seller
      // themselves, or an on-chain replay). Skip, don't fail.
      if (/already claimed|not class a open|predicate failed/i.test(msg)) {
        continue;
      }
      result.failed.push({ intentId: row.intent_id, error: msg });
    }
  }

  return result;
}

// ── Public entry point ─────────────────────────────────────────────────────

export interface AutoCloseSweepResult {
  fund: SweeperResult;
  claim: SweeperResult;
}

/**
 * runAutoCloseSweep — two-phase autonomous Class-A settlement sweeper.
 *
 * FUND phase:  picks `awaiting_funding` intents with a queued EIP-3009
 *              authorization, broadcasts createIntentWithAuthorization, and
 *              advances the intent to `open`.
 *
 * CLAIM phase: picks `reveal_ready` intents, broadcasts claimIntent with the
 *              seller's preimage as the witness, and flips the intent to
 *              `claimed` + the linked deal to `completed`.
 *
 * Each phase handles benign-race reverts as skips (not failures), matching
 * the existing sweepers' pattern.
 */
export async function runAutoCloseSweep(
  sql: SqlClient,
  chain: ChainClient,
  config: Config,
  _now: Date = new Date(),
): Promise<AutoCloseSweepResult> {
  const [fund, claim] = await Promise.all([
    fundPhase(sql, chain, config),
    claimPhase(sql, chain),
  ]);
  return { fund, claim };
}
