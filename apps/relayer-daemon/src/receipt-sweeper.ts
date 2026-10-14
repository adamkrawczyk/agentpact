// apps/relayer-daemon/src/receipt-sweeper.ts — ap_v31 M2: Receipt v1 issuance + anchoring.
//
// WHAT THIS DOES
// Two ticks, both read-mostly and both OFF the money path:
//   runReceiptSweep  — finds FUNDED deals that reached a terminal outcome and
//                      have no current receipt, builds the apr-1 payload from
//                      the deal's own records, signs it, inserts it. Never
//                      touches deals / payment_intents / milestones.
//   runReceiptAnchor — once a day, puts one RFC 6962 Merkle root over every
//                      not-yet-anchored payload hash into the calldata of a
//                      0-value tx from the relayer wallet to itself. Behind
//                      RECEIPT_ANCHOR_ENABLED (default off).
//
// WHY HERE AND NOT IN THE API
// Issuance is a background job with the same shape as the other sweepers
// (bounded batch, sweeper_runs row per tick, overlap guard in index.ts). The
// builder/signer itself is NOT here: it is packages/receipts, which the API
// also imports to verify. One implementation of canonical JSON + signing, so
// issuer and verifier cannot drift.
//
// IDEMPOTENCY
// The guard is the database, not this process: uq_receipts_current is a
// partial UNIQUE (deal_id, version) WHERE superseded_by IS NULL, and the
// insert is ON CONFLICT DO NOTHING. Two racing ticks (or two daemons) produce
// one receipt. The candidate query excludes deals that already have one, so
// a quiet system scans zero rows per tick.
//
// THE CANDIDATE QUERY MIRRORS classifyOutcome()
// If SQL selected a deal the pure classifier rejects, that deal would be
// re-selected every tick and, ordered first, starve the batch. So the WHERE
// clause encodes exactly the classifier's non-null conditions; any residual
// mismatch shows up as `held` in sweeper_runs instead of hiding.

import {
  buildReceiptPayload,
  decimalToBaseUnits,
  merkleRoot,
  signReceipt,
  signerFromSeed,
  type ReceiptFacts,
  type ReceiptSigner,
} from "@agentpact/receipts";
import type { SqlClient } from "./sweepers.js";

export interface ReceiptSweeperConfig {
  /** base64 32-byte ed25519 seed (RECEIPT_SIGNING_KEY) */
  signingKey: string;
  /** RECEIPT_KEY_ID */
  keyId: string;
  /** Max receipts issued per tick. */
  maxPerTick: number;
  now?: () => Date;
}

export interface ReceiptSweepResult {
  runId: string | null;
  scanned: number;
  acted: number;
  held: number;
  failed: number;
  errors: Array<{ dealId: string; error: string }>;
}

/**
 * Register the signer's public key under its key id, or fail closed. A key id
 * that is already registered with a DIFFERENT public key means someone
 * rotated the seed without rotating the id; signing on would publish receipts
 * that verify against nothing (or, worse, against the wrong key).
 */
async function ensureKeyRegistered(sql: SqlClient, signer: ReceiptSigner): Promise<void> {
  await sql`
    INSERT INTO receipt_signing_keys (key_id, public_key)
    VALUES (${signer.keyId}, ${signer.publicKey})
    ON CONFLICT DO NOTHING
  `;
  const [row] = await sql<{ public_key: string }>`
    SELECT public_key FROM receipt_signing_keys WHERE key_id = ${signer.keyId}
  `;
  if (!row) {
    throw new Error(`receipt key id ${signer.keyId} not registered: this public key is already published under another key id`);
  }
  if (row.public_key !== signer.publicKey) {
    throw new Error(`receipt key id ${signer.keyId} is registered with a different public key — rotate RECEIPT_KEY_ID together with RECEIPT_SIGNING_KEY`);
  }
}

export async function runReceiptSweep(sql: SqlClient, cfg: ReceiptSweeperConfig): Promise<ReceiptSweepResult> {
  const now = cfg.now ?? (() => new Date());
  const signer = signerFromSeed(cfg.signingKey, cfg.keyId);
  await ensureKeyRegistered(sql, signer);

  const result: ReceiptSweepResult = { runId: null, scanned: 0, acted: 0, held: 0, failed: 0, errors: [] };
  // Run row first: a tick that dies mid-way stays visible with finished_at NULL.
  const [run] = await sql<{ id: string }>`
    INSERT INTO sweeper_runs (sweeper, started_at) VALUES ('receipts', ${now()}) RETURNING id
  `;
  result.runId = run?.id ?? null;

  try {
    const candidates = await sql<{ deal_id: string }>`
      SELECT d.id AS deal_id
      FROM deals d
      JOIN deal_integrity di ON di.deal_id = d.id
      LEFT JOIN LATERAL (
        SELECT i.status, i.expires_at, i.updated_at
        FROM intents i
        WHERE i.id = d.intent_id OR i.deal_id = d.id
        ORDER BY i.updated_at DESC
        LIMIT 1
      ) li ON TRUE
      WHERE di.funded
        AND NOT EXISTS (
          SELECT 1 FROM milestones m JOIN payment_intents pi ON pi.milestone_id = m.id
          WHERE m.deal_id = d.id AND pi.status IN ('pending_refund', 'disputed')
        )
        AND (
          d.status IN ('completed', 'cancelled')
          OR li.status IN ('claimed', 'completed', 'acknowledged', 'settled')
          OR (li.status IN ('refunded', 'expired') AND li.expires_at <= li.updated_at)
        )
        AND NOT EXISTS (
          SELECT 1 FROM receipts r
          WHERE r.deal_id = d.id AND r.version = 'apr-1' AND r.superseded_by IS NULL
        )
      ORDER BY d.updated_at ASC, d.id ASC
      LIMIT ${cfg.maxPerTick}
    `;
    result.scanned = candidates.length;

    for (const { deal_id } of candidates) {
      try {
        const outcome = await issueReceiptForDeal(sql, signer, deal_id, now());
        if (outcome === "issued") result.acted++;
        else if (outcome === "held") result.held++;
      } catch (err) {
        result.failed++;
        result.errors.push({ dealId: deal_id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await sql`
      UPDATE sweeper_runs
      SET finished_at = ${now()}, scanned = ${result.scanned}, acted = ${result.acted},
          held = ${result.held}, failed = ${result.failed}
      WHERE id = ${result.runId}
    `;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await sql`
        UPDATE sweeper_runs
        SET finished_at = ${now()}, error = ${msg}, scanned = ${result.scanned},
            acted = ${result.acted}, held = ${result.held}, failed = ${result.failed}
        WHERE id = ${result.runId}
      `;
    } catch { /* the throw below is the real signal */ }
    throw err;
  }
}

/**
 * Build, sign and insert the current receipt for one deal.
 *   "issued" — inserted now
 *   "exists" — a current receipt already exists (another tick won the race)
 *   "held"   — the deal has no terminal funded outcome yet (no receipt)
 */
export async function issueReceiptForDeal(
  sql: SqlClient,
  signer: ReceiptSigner,
  dealId: string,
  issuedAt: Date,
): Promise<"issued" | "exists" | "held"> {
  const facts = await loadReceiptFacts(sql, dealId);
  const payload = facts ? buildReceiptPayload(facts) : null;
  if (!payload) return "held";
  const signed = signReceipt(payload, signer);
  // ::text::jsonb, not ::jsonb: postgres.js JSON-encodes a value bound to
  // a jsonb parameter, which would store the payload as a JSON *string*.
  // ON CONFLICT DO NOTHING (no target) covers both uq_receipts_current and
  // the payload_hash UNIQUE: two racers build the identical payload.
  const inserted = await sql<{ id: string }>`
    INSERT INTO receipts (deal_id, version, issued_at, payload, payload_hash, signature, key_id,
                          outcome, payer_agent_id, payee_agent_id, qualifying, capital_at_risk)
    VALUES (${dealId}, ${signed.version}, ${issuedAt}, ${JSON.stringify(signed.payload)}::text::jsonb,
            ${signed.payload_hash}, ${signed.signature}, ${signed.key_id},
            ${payload.outcome}, ${payload.payer.agent_id}, ${payload.payee.agent_id},
            ${payload.evidence.qualifying}, ${payload.evidence.capital_at_risk})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return inserted.length > 0 ? "issued" : "exists";
}

function disputeOpener(openedBy: string, buyerId: unknown, sellerId: unknown): "buyer" | "seller" | "other" {
  if (openedBy === buyerId) return "buyer";
  if (openedBy === sellerId) return "seller";
  return "other";
}

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
// Simulation-mode hashes ("sim_release_…") are not chain transactions and
// must never appear in a receipt as if they were.
const realTx = (h: unknown): h is string => typeof h === "string" && h.length > 0 && !h.startsWith("sim_");

function nonEmptyJson(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

/** Read every fact the apr-1 payload needs for one deal. Pure reads. */
export async function loadReceiptFacts(sql: SqlClient, dealId: string): Promise<ReceiptFacts | null> {
  const [d] = await sql<Record<string, unknown>>`
    SELECT d.id, d.status, d.currency, d.chain, d.funding_chain, d.negotiated_total::text AS negotiated_total,
           d.task_contract, d.created_at, d.updated_at,
           CASE WHEN d.deliverable_hash IS NULL THEN NULL ELSE '0x' || encode(d.deliverable_hash, 'hex') END AS deliverable_hash,
           b.id AS buyer_id, b.handle AS buyer_handle, ap_wallet_key(b.owner_wallet_address) AS buyer_wallet_key,
           s.id AS seller_id, s.handle AS seller_handle, ap_wallet_key(s.owner_wallet_address) AS seller_wallet_key,
           di.funded, di.qualifying, (di.qualifying AND di.funded) AS capital_at_risk,
           n.acceptance_criteria AS need_criteria,
           l.amount_minor::text AS fee_minor, l.fee_pct_at_close::text AS fee_pct
    FROM deals d
    JOIN agents b ON b.id = d.buyer_agent_id
    JOIN agents s ON s.id = d.seller_agent_id
    JOIN deal_integrity di ON di.deal_id = d.id
    LEFT JOIN needs n ON n.id = d.need_id
    LEFT JOIN platform_fee_ledger l ON l.deal_id = d.id
    WHERE d.id = ${dealId}
  `;
  if (!d) return null;

  const milestones = await sql<{ idx: number; acceptance_criteria: unknown }>`
    SELECT idx, acceptance_criteria FROM milestones WHERE deal_id = ${dealId} ORDER BY idx ASC, id ASC
  `;
  const pis = await sql<{ status: string; tx_hash: string | null }>`
    SELECT pi.status, pi.tx_hash
    FROM payment_intents pi JOIN milestones m ON m.id = pi.milestone_id
    WHERE m.deal_id = ${dealId}
    ORDER BY pi.created_at ASC, pi.id ASC
  `;
  const [intent] = await sql<{ status: string; expired: boolean; on_chain_funding_tx: string | null; on_chain_claim_tx: string | null; updated_at: Date }>`
    SELECT i.status, (i.expires_at <= i.updated_at) AS expired, i.on_chain_funding_tx, i.on_chain_claim_tx, i.updated_at
    FROM intents i
    WHERE i.id = (SELECT intent_id FROM deals WHERE id = ${dealId}) OR i.deal_id = ${dealId}
    ORDER BY i.updated_at DESC
    LIMIT 1
  `;
  const cctp = await sql<{ direction: string; status: string; source_tx_hash: string | null; destination_tx_hash: string | null }>`
    SELECT direction, status, source_tx_hash, destination_tx_hash
    FROM cctp_transfers WHERE deal_id = ${dealId}
  `;
  const [judge] = await sql<{ judge: string; outcome: string; p: string | null; rubric_hash: string | null; decided_at: Date }>`
    SELECT judge, outcome, p::text AS p, rubric_hash, decided_at
    FROM sweeper_decisions
    WHERE deal_id = ${dealId} AND judge IS NOT NULL AND judge <> 'unavailable'
    ORDER BY decided_at DESC
    LIMIT 1
  `;
  const [dispute] = await sql<{ opened_by: string; status: string; created_at: Date; resolved_at: Date | null }>`
    SELECT opened_by, status, created_at, resolved_at
    FROM disputes WHERE deal_id = ${dealId}
    ORDER BY created_at DESC LIMIT 1
  `;
  const [delivery] = await sql<{ checksum: string }>`
    SELECT x.checksum FROM deliveries x JOIN milestones m ON m.id = x.milestone_id
    WHERE m.deal_id = ${dealId}
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  `;

  // Funding vs settlement hashes. payment_intents.tx_hash is overwritten on
  // release/refund, so its meaning follows the row's status.
  const funding: string[] = [];
  const settlement: string[] = [];
  for (const pi of pis) {
    if (!realTx(pi.tx_hash)) continue;
    (pi.status === "released" || pi.status === "refunded" ? settlement : funding).push(pi.tx_hash);
  }
  if (intent) {
    if (realTx(intent.on_chain_funding_tx)) funding.push(intent.on_chain_funding_tx);
    if (realTx(intent.on_chain_claim_tx)) settlement.push(intent.on_chain_claim_tx);
  }
  for (const t of cctp) {
    const bucket = t.direction === "deposit" ? funding : settlement;
    if (realTx(t.source_tx_hash)) bucket.push(t.source_tx_hash);
    if (realTx(t.destination_tx_hash)) bucket.push(t.destination_tx_hash);
  }

  // Acceptance test: the most specific statement of "what would satisfy the buyer".
  const msCriteria = milestones
    .filter((m) => nonEmptyJson(m.acceptance_criteria))
    .map((m) => ({ milestone: m.idx, criteria: m.acceptance_criteria }));
  let acceptance: ReceiptFacts["acceptance"];
  if (msCriteria.length > 0) acceptance = { source: "milestones", criteria: msCriteria };
  else if (nonEmptyJson(d.need_criteria)) acceptance = { source: "need", criteria: d.need_criteria };
  else if (nonEmptyJson(d.task_contract)) acceptance = { source: "task_contract", criteria: d.task_contract };
  else acceptance = { source: "none", criteria: null };

  const dealUpdated = d.updated_at instanceof Date ? d.updated_at : new Date(String(d.updated_at));
  // An escrow-intent outcome can land before the deal row is touched.
  const closedAt = intent && intent.updated_at > dealUpdated ? intent.updated_at : dealUpdated;

  return {
    deal_id: String(d.id),
    deal_status: String(d.status),
    currency: String(d.currency),
    payer: { agent_id: String(d.buyer_id), handle: String(d.buyer_handle), owner_wallet_key: (d.buyer_wallet_key as string | null) ?? null },
    payee: { agent_id: String(d.seller_id), handle: String(d.seller_handle), owner_wallet_key: (d.seller_wallet_key as string | null) ?? null },
    notional_base_units: decimalToBaseUnits(String(d.negotiated_total)),
    ledger_fee_base_units: (d.fee_minor as string | null) ?? null,
    ledger_fee_pct_at_close: (d.fee_pct as string | null) ?? null,
    funding_chain: String(d.funding_chain ?? d.chain ?? "base"),
    funding_tx_hashes: funding,
    settlement_tx_hashes: settlement,
    acceptance,
    deliverable_hash: (d.deliverable_hash as string | null) ?? null,
    delivery_checksum: delivery?.checksum ?? null,
    judge: judge
      ? { judge: judge.judge, verdict: judge.outcome, p: judge.p, rubric_hash: judge.rubric_hash, decided_at: iso(judge.decided_at) }
      : null,
    dispute: dispute
      ? { opened_by: disputeOpener(dispute.opened_by, d.buyer_id, d.seller_id), status: dispute.status, opened_at: iso(dispute.created_at), resolved_at: isoOrNull(dispute.resolved_at) }
      : null,
    payment_intent_statuses: pis.map((p) => p.status),
    intent: intent ? { status: intent.status, expired: Boolean(intent.expired) } : null,
    refund_transfer_completed: cctp.some((t) => t.direction === "refund" && t.status === "completed"),
    funded: Boolean(d.funded),
    qualifying: Boolean(d.qualifying),
    capital_at_risk: Boolean(d.capital_at_risk),
    created_at: iso(d.created_at),
    closed_at: iso(closedAt),
  };
}

// ── Anchoring ───────────────────────────────────────────────────────────

/** Calldata prefix: ASCII "agentpact-receipts:apr-1:" then the 32-byte root. */
const ANCHOR_PREFIX_HEX = Buffer.from("agentpact-receipts:apr-1:", "utf8").toString("hex");

export function anchorCalldata(rootHex: string): `0x${string}` {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) throw new Error("anchor root must be 32-byte lowercase hex");
  return `0x${ANCHOR_PREFIX_HEX}${rootHex}`;
}

export interface ReceiptAnchorConfig {
  /** RECEIPT_ANCHOR_ENABLED — only the literal "true" turns this on (see config.ts). */
  enabled: boolean;
  /**
   * Broadcast a 0-value tx from the relayer wallet to itself carrying `data`,
   * and resolve only once it is mined successfully. Injected so tests never
   * touch a chain.
   */
  broadcast: (data: `0x${string}`) => Promise<{ txHash: string }>;
  chain?: string;
  /** Minimum gap between batches (default 24h). */
  minIntervalMs?: number;
  /** Max leaves per batch (default 10 000). */
  maxLeaves?: number;
  now?: () => Date;
}

export interface ReceiptAnchorResult {
  skipped?: string;
  runId?: string | null;
  anchoredBatchId?: string;
  leafCount?: number;
  root?: string;
  txHash?: string;
}

export async function runReceiptAnchor(sql: SqlClient, cfg: ReceiptAnchorConfig): Promise<ReceiptAnchorResult> {
  if (!cfg.enabled) return { skipped: "disabled (RECEIPT_ANCHOR_ENABLED is not true)" };
  const now = cfg.now ?? (() => new Date());
  const chain = cfg.chain ?? "base";
  const minIntervalMs = cfg.minIntervalMs ?? 24 * 60 * 60_000;
  const maxLeaves = cfg.maxLeaves ?? 10_000;

  const [run] = await sql<{ id: string }>`
    INSERT INTO sweeper_runs (sweeper, started_at) VALUES ('receipt_anchor', ${now()}) RETURNING id
  `;
  const runId = run?.id ?? null;
  const finish = async (acted: number, error: string | null, scanned = 0) => {
    try {
      await sql`
        UPDATE sweeper_runs SET finished_at = ${now()}, scanned = ${scanned}, acted = ${acted}, error = ${error}
        WHERE id = ${runId}
      `;
    } catch { /* never mask the tick's own outcome */ }
  };

  try {
    // 1. A batch whose broadcast did not complete is retried FIRST, with the
    //    same root: re-batching would orphan leaves that are already assigned.
    let [batch] = await sql<{ id: string; root: string; leaf_count: number }>`
      SELECT id, root, leaf_count FROM receipt_anchor_batches
      WHERE tx_hash IS NULL ORDER BY created_at ASC LIMIT 1
    `;

    if (!batch) {
      const [last] = await sql<{ created_at: Date }>`
        SELECT created_at FROM receipt_anchor_batches ORDER BY created_at DESC LIMIT 1
      `;
      if (last && now().getTime() - new Date(last.created_at).getTime() < minIntervalMs) {
        await finish(0, null);
        return { skipped: "not due (last batch < interval)", runId };
      }
      const leaves = await sql<{ id: string; payload_hash: string }>`
        SELECT id, payload_hash FROM receipts
        WHERE anchor_batch_id IS NULL
        ORDER BY issued_at ASC, id ASC
        LIMIT ${maxLeaves}
      `;
      if (leaves.length === 0) {
        await finish(0, null);
        return { skipped: "no unanchored receipts", runId };
      }
      const root = merkleRoot(leaves.map((l) => l.payload_hash));
      const leafIds = leaves.map((l) => l.id);
      // One statement = one atomic snapshot: the batch row exists only if
      // every picked leaf was still unanchored, and the leaves get their
      // index in exactly the order the root was computed over.
      const assigned = await sql<{ id: string; batch_id: string }>`
        WITH b AS (
          INSERT INTO receipt_anchor_batches (root, leaf_count, chain)
          SELECT ${root}, ${leaves.length}, ${chain}
          WHERE (SELECT count(*) FROM receipts WHERE id = ANY(${leafIds}::uuid[]) AND anchor_batch_id IS NULL) = ${leaves.length}
          RETURNING id
        )
        UPDATE receipts r
        SET anchor_batch_id = b.id,
            anchor_leaf_index = array_position(${leafIds}::uuid[], r.id) - 1
        FROM b
        WHERE r.id = ANY(${leafIds}::uuid[]) AND r.anchor_batch_id IS NULL
        RETURNING r.id, b.id AS batch_id
      `;
      if (assigned.length !== leaves.length) {
        // Lost a race with a concurrent anchor tick. Undo our half so no
        // batch ever claims a root its leaves do not produce.
        const batchId = assigned[0]?.batch_id;
        if (batchId) {
          await sql`UPDATE receipts SET anchor_batch_id = NULL, anchor_leaf_index = NULL WHERE anchor_batch_id = ${batchId}`;
          await sql`DELETE FROM receipt_anchor_batches WHERE id = ${batchId} AND tx_hash IS NULL`;
        }
        throw new Error(`anchor batch assignment raced (${assigned.length}/${leaves.length} leaves); retrying next tick`);
      }
      batch = { id: assigned[0].batch_id, root, leaf_count: leaves.length };
    }

    // 2. Broadcast. A broadcast that errors AFTER landing on-chain is retried
    //    with the same root next tick: the worst case is the same root twice
    //    on-chain, which proves nothing false.
    const { txHash } = await cfg.broadcast(anchorCalldata(batch.root));
    await sql`
      UPDATE receipt_anchor_batches SET tx_hash = ${txHash}, anchored_at = ${now()}
      WHERE id = ${batch.id} AND tx_hash IS NULL
    `;
    await finish(1, null, batch.leaf_count);
    return { runId, anchoredBatchId: batch.id, leafCount: batch.leaf_count, root: batch.root, txHash };
  } catch (err) {
    await finish(0, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
