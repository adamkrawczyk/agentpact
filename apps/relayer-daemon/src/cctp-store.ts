// apps/relayer-daemon/src/cctp-store.ts — M1 (lane m1-relay)
//
// Persistence for the CCTP relayer state machine (cctp_transfers, migrations
// 053 + 057). The sweeper talks to this interface, not to SQL, so the state
// machine is tested against an in-memory store in CI AND against this SQL
// implementation on a real Postgres (cctp-sweeper.test.ts, TEST_DATABASE_URL).
//
// Every state change is compare-and-set on the expected status: a row moved
// by someone else since it was read is left alone (update() returns false).
// Statements are single, parameterised, and transaction-free, so they are
// safe behind a transaction-mode pooler with prepare:false.

import type { Hex } from "viem";
import type { SqlClient } from "./sweepers.js";

export type CctpDirection = "deposit" | "payout" | "refund";
export type CctpStatus =
  | "submitted" | "attestation_pending" | "attested" | "relayed" | "bound"
  | "forwarded" | "completed" | "failed" | "stuck" | "refunded";

export interface CctpTransfer {
  id: string;
  direction: CctpDirection;
  dealId: string | null;
  intentId: string | null;
  dealRef: Hex | null;
  sourceDomain: number;
  destinationDomain: number;
  sourceTxHash: Hex | null;
  messageHash: Hex | null;
  nonce: Hex | null;
  amount: bigint;
  maxFee: bigint | null;
  feeExecuted: bigint | null;
  recipient: string | null;
  status: CctpStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  destinationTxHash: Hex | null;
  createdAt: Date;
  /** Last write to the row; for a row holding an unconfirmed tx hash, ≈ broadcast time. */
  updatedAt: Date;
  statusChangedAt: Date;
  message: Hex | null;
  attestation: Hex | null;
  onchainIntentId: Hex | null;
  parentTransferId: string | null;
  payoutDomain: number | null;
  payoutRecipient: Hex | null;
  refundRecipient: Hex | null;
  intentExpiresAt: Date | null;
  stuckReason: string | null;
  stuckAt: Date | null;
}

/** Fields the sweeper may write. `undefined` = leave as is; `null` = clear. */
export interface TransferPatch {
  status?: CctpStatus;
  intentId?: string | null;
  sourceTxHash?: Hex | null;
  messageHash?: Hex | null;
  nonce?: Hex | null;
  amount?: bigint;
  maxFee?: bigint | null;
  feeExecuted?: bigint | null;
  attempts?: number;
  lastError?: string | null;
  nextAttemptAt?: Date | null;
  destinationTxHash?: Hex | null;
  message?: Hex | null;
  attestation?: Hex | null;
  onchainIntentId?: Hex | null;
  payoutDomain?: number | null;
  payoutRecipient?: Hex | null;
  refundRecipient?: Hex | null;
  intentExpiresAt?: Date | null;
  stuckReason?: string | null;
  stuckAt?: Date | null;
  alertedAt?: Date | null;
}

export interface NewChildTransfer {
  direction: "refund" | "payout";
  sourceDomain: number;
  destinationDomain: number;
  amount: bigint;
  recipient: string | null;
  sourceTxHash?: Hex | null;
  status?: CctpStatus;
}

export interface Reveal {
  ciphertext: Hex;
  witness: Hex;
}

export interface RunCounts {
  scanned: number;
  acted: number;
  held: number;
  failed: number;
}

export interface CctpStore {
  openRun(now: Date): Promise<string | null>;
  finishRun(runId: string | null, now: Date, counts: RunCounts, error?: string): Promise<void>;
  /** Rows with work to do now, oldest first. Excludes terminal, stuck, bound, leased and backed-off rows. */
  due(now: Date, limit: number): Promise<CctpTransfer[]>;
  /** Take the broadcast lease on (id, status). False = someone else holds it or the row moved. */
  lease(id: string, status: CctpStatus, now: Date, leaseUntil: Date): Promise<boolean>;
  /** CAS on status. Releases the lease. Bumps status_changed_at when the status changes. */
  update(id: string, expectStatus: CctpStatus, patch: TransferPatch, now: Date): Promise<boolean>;
  /** Bound deposits whose intent expired before `cutoff`, not yet settled, intent not claimed/refunded. */
  refundCandidates(cutoff: Date, limit: number): Promise<CctpTransfer[]>;
  /** Bound deposits with a non-Base payout route whose intent has a seller reveal, not yet settled. */
  payoutCandidates(limit: number): Promise<CctpTransfer[]>;
  /** Insert the refund/payout row for a deposit. Null if the deposit already has one. */
  insertChild(parent: CctpTransfer, child: NewChildTransfer, now: Date): Promise<CctpTransfer | null>;
  reveal(intentId: string): Promise<Reveal | null>;
  /** Mirror of autoclose claimPhase: intent → claimed, linked deal → completed. */
  markIntentClaimed(intentId: string, txHash: Hex): Promise<void>;
  stuckSummary(): Promise<{ count: number; oldestStuckAt: Date | null }>;
}

// ── SQL implementation ─────────────────────────────────────────────────────

interface Row {
  id: string;
  direction: CctpDirection;
  deal_id: string | null;
  intent_id: string | null;
  deal_ref: string | null;
  source_domain: number;
  destination_domain: number;
  source_tx_hash: string | null;
  message_hash: string | null;
  nonce: string | null;
  amount_base_units: string;
  max_fee_base_units: string | null;
  fee_executed_base_units: string | null;
  recipient: string | null;
  status: CctpStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  destination_tx_hash: string | null;
  created_at: Date;
  updated_at: Date;
  status_changed_at: Date;
  message: string | null;
  attestation: string | null;
  onchain_intent_id: string | null;
  parent_transfer_id: string | null;
  payout_domain: number | null;
  payout_recipient: string | null;
  refund_recipient: string | null;
  intent_expires_at: Date | null;
  stuck_reason: string | null;
  stuck_at: Date | null;
}

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));
const hex = (v: string | null): Hex | null => (v === null ? null : (v as Hex));
const date = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

export function rowToTransfer(r: Row): CctpTransfer {
  return {
    id: r.id,
    direction: r.direction,
    dealId: r.deal_id,
    intentId: r.intent_id,
    dealRef: hex(r.deal_ref),
    sourceDomain: Number(r.source_domain),
    destinationDomain: Number(r.destination_domain),
    sourceTxHash: hex(r.source_tx_hash),
    messageHash: hex(r.message_hash),
    nonce: hex(r.nonce),
    amount: BigInt(r.amount_base_units),
    maxFee: big(r.max_fee_base_units),
    feeExecuted: big(r.fee_executed_base_units),
    recipient: r.recipient,
    status: r.status,
    attempts: Number(r.attempts),
    lastError: r.last_error,
    nextAttemptAt: date(r.next_attempt_at),
    destinationTxHash: hex(r.destination_tx_hash),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    statusChangedAt: new Date(r.status_changed_at),
    message: hex(r.message),
    attestation: hex(r.attestation),
    onchainIntentId: hex(r.onchain_intent_id),
    parentTransferId: r.parent_transfer_id,
    payoutDomain: r.payout_domain === null ? null : Number(r.payout_domain),
    payoutRecipient: hex(r.payout_recipient),
    refundRecipient: hex(r.refund_recipient),
    intentExpiresAt: date(r.intent_expires_at),
    stuckReason: r.stuck_reason,
    stuckAt: date(r.stuck_at),
  };
}

// Statuses the sweeper advances. 'bound' is excluded: a bound deposit has no
// step of its own — it waits for a refund/payout child to be spawned.
const WORK_STATUSES = ["submitted", "attestation_pending", "attested", "relayed", "forwarded"];

const COLUMNS: Record<keyof TransferPatch, string> = {
  status: "status",
  intentId: "intent_id",
  sourceTxHash: "source_tx_hash",
  messageHash: "message_hash",
  nonce: "nonce",
  amount: "amount_base_units",
  maxFee: "max_fee_base_units",
  feeExecuted: "fee_executed_base_units",
  attempts: "attempts",
  lastError: "last_error",
  nextAttemptAt: "next_attempt_at",
  destinationTxHash: "destination_tx_hash",
  message: "message",
  attestation: "attestation",
  onchainIntentId: "onchain_intent_id",
  payoutDomain: "payout_domain",
  payoutRecipient: "payout_recipient",
  refundRecipient: "refund_recipient",
  intentExpiresAt: "intent_expires_at",
  stuckReason: "stuck_reason",
  stuckAt: "stuck_at",
  alertedAt: "alerted_at",
};

/** The `unsafe`-free way to build a dynamic SET with a tagged-template client. */
function patchValue(v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export function sqlCctpStore(sql: SqlClient): CctpStore {
  return {
    async openRun(now) {
      const [run] = await sql<{ id: string }>`
        INSERT INTO sweeper_runs (sweeper, started_at) VALUES ('cctp', ${now}) RETURNING id
      `;
      return run?.id ?? null;
    },

    async finishRun(runId, now, c, error) {
      if (!runId) return;
      await sql`
        UPDATE sweeper_runs
        SET finished_at = ${now}, scanned = ${c.scanned}, acted = ${c.acted},
            held = ${c.held}, failed = ${c.failed}, error = ${error ?? null}
        WHERE id = ${runId}
      `;
    },

    async due(now, limit) {
      const rows = await sql<Row>`
        SELECT * FROM cctp_transfers
        WHERE status = ANY(${WORK_STATUSES})
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (lease_until IS NULL OR lease_until <= ${now})
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
      return rows.map(rowToTransfer);
    },

    async lease(id, status, now, leaseUntil) {
      const rows = await sql<{ id: string }>`
        UPDATE cctp_transfers
        SET lease_until = ${leaseUntil}, updated_at = ${now}
        WHERE id = ${id} AND status = ${status}
          AND (lease_until IS NULL OR lease_until <= ${now})
        RETURNING id
      `;
      return rows.length === 1;
    },

    async update(id, expectStatus, patch, now) {
      // One statement, every column explicit: COALESCE-style "keep" is done by
      // passing a flag per column, so a caller can still write NULL on purpose.
      const has = (k: keyof TransferPatch) => (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined);
      const v = (k: keyof TransferPatch) => (has(k) ? patchValue(patch[k]) : null);
      for (const k of Object.keys(patch)) {
        if (!(k in COLUMNS)) throw new Error(`unknown patch field ${k}`);
      }
      const rows = await sql<{ id: string }>`
        UPDATE cctp_transfers SET
          status                  = CASE WHEN ${has("status")} THEN ${v("status")}::text ELSE status END,
          status_changed_at       = CASE WHEN ${has("status")} AND ${v("status")}::text IS DISTINCT FROM status THEN ${now}::timestamptz ELSE status_changed_at END,
          intent_id               = CASE WHEN ${has("intentId")} THEN ${v("intentId")}::uuid ELSE intent_id END,
          source_tx_hash          = CASE WHEN ${has("sourceTxHash")} THEN ${v("sourceTxHash")}::text ELSE source_tx_hash END,
          message_hash            = CASE WHEN ${has("messageHash")} THEN ${v("messageHash")}::text ELSE message_hash END,
          nonce                   = CASE WHEN ${has("nonce")} THEN ${v("nonce")}::text ELSE nonce END,
          amount_base_units       = CASE WHEN ${has("amount")} THEN ${v("amount")}::numeric ELSE amount_base_units END,
          max_fee_base_units      = CASE WHEN ${has("maxFee")} THEN ${v("maxFee")}::numeric ELSE max_fee_base_units END,
          fee_executed_base_units = CASE WHEN ${has("feeExecuted")} THEN ${v("feeExecuted")}::numeric ELSE fee_executed_base_units END,
          attempts                = CASE WHEN ${has("attempts")} THEN ${v("attempts")}::int ELSE attempts END,
          last_error              = CASE WHEN ${has("lastError")} THEN ${v("lastError")}::text ELSE last_error END,
          next_attempt_at         = CASE WHEN ${has("nextAttemptAt")} THEN ${v("nextAttemptAt")}::timestamptz ELSE next_attempt_at END,
          destination_tx_hash     = CASE WHEN ${has("destinationTxHash")} THEN ${v("destinationTxHash")}::text ELSE destination_tx_hash END,
          message                 = CASE WHEN ${has("message")} THEN ${v("message")}::text ELSE message END,
          attestation             = CASE WHEN ${has("attestation")} THEN ${v("attestation")}::text ELSE attestation END,
          onchain_intent_id       = CASE WHEN ${has("onchainIntentId")} THEN ${v("onchainIntentId")}::text ELSE onchain_intent_id END,
          payout_domain           = CASE WHEN ${has("payoutDomain")} THEN ${v("payoutDomain")}::int ELSE payout_domain END,
          payout_recipient        = CASE WHEN ${has("payoutRecipient")} THEN ${v("payoutRecipient")}::text ELSE payout_recipient END,
          refund_recipient        = CASE WHEN ${has("refundRecipient")} THEN ${v("refundRecipient")}::text ELSE refund_recipient END,
          intent_expires_at       = CASE WHEN ${has("intentExpiresAt")} THEN ${v("intentExpiresAt")}::timestamptz ELSE intent_expires_at END,
          stuck_reason            = CASE WHEN ${has("stuckReason")} THEN ${v("stuckReason")}::text ELSE stuck_reason END,
          stuck_at                = CASE WHEN ${has("stuckAt")} THEN ${v("stuckAt")}::timestamptz ELSE stuck_at END,
          alerted_at              = CASE WHEN ${has("alertedAt")} THEN ${v("alertedAt")}::timestamptz ELSE alerted_at END,
          lease_until             = NULL,
          updated_at              = ${now}
        WHERE id = ${id} AND status = ${expectStatus}
        RETURNING id
      `;
      return rows.length === 1;
    },

    async refundCandidates(cutoff, limit) {
      const rows = await sql<Row>`
        SELECT t.* FROM cctp_transfers t
        LEFT JOIN intents i ON i.id = t.intent_id
        WHERE t.direction = 'deposit' AND t.status = 'bound'
          AND t.onchain_intent_id IS NOT NULL
          AND t.intent_expires_at IS NOT NULL AND t.intent_expires_at < ${cutoff}
          AND (i.id IS NULL OR i.status NOT IN ('claimed', 'refunded', 'reveal_ready'))
          AND NOT EXISTS (SELECT 1 FROM cctp_transfers c WHERE c.parent_transfer_id = t.id)
        ORDER BY t.intent_expires_at ASC
        LIMIT ${limit}
      `;
      return rows.map(rowToTransfer);
    },

    async payoutCandidates(limit) {
      const rows = await sql<Row>`
        SELECT t.* FROM cctp_transfers t
        JOIN intents i ON i.id = t.intent_id
        WHERE t.direction = 'deposit' AND t.status = 'bound'
          AND t.onchain_intent_id IS NOT NULL
          AND t.payout_domain IS NOT NULL AND t.payout_domain <> 6
          AND i.status = 'reveal_ready'
          AND EXISTS (SELECT 1 FROM intent_reveals r WHERE r.intent_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM cctp_transfers c WHERE c.parent_transfer_id = t.id)
        ORDER BY t.updated_at ASC
        LIMIT ${limit}
      `;
      return rows.map(rowToTransfer);
    },

    async insertChild(parent, child, now) {
      const rows = await sql<Row>`
        INSERT INTO cctp_transfers (
          direction, deal_id, intent_id, deal_ref, source_domain, destination_domain,
          source_tx_hash, amount_base_units, recipient, status, onchain_intent_id,
          parent_transfer_id, created_at, updated_at, status_changed_at
        ) VALUES (
          ${child.direction}, ${parent.dealId}, ${parent.intentId}, ${parent.dealRef},
          ${child.sourceDomain}, ${child.destinationDomain}, ${child.sourceTxHash ?? null},
          ${child.amount.toString()}, ${child.recipient}, ${child.status ?? "submitted"},
          ${parent.onchainIntentId}, ${parent.id}, ${now}, ${now}, ${now}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      return rows[0] ? rowToTransfer(rows[0]) : null;
    },

    async reveal(intentId) {
      const rows = await sql<{ ciphertext: Buffer | null; preimage: Buffer }>`
        SELECT ciphertext, preimage FROM intent_reveals WHERE intent_id = ${intentId} LIMIT 1
      `;
      const r = rows[0];
      if (!r) return null;
      const h = (b: Buffer | null): Hex => `0x${b ? Buffer.from(b).toString("hex") : ""}`;
      // hash-preimage-v1: the witness IS the preimage (same as autoclose claimPhase).
      return { ciphertext: h(r.ciphertext), witness: h(r.preimage) };
    },

    async markIntentClaimed(intentId, txHash) {
      const rows = await sql<{ deal_id: string | null }>`
        UPDATE intents
        SET status = 'claimed', on_chain_claim_tx = ${txHash}, updated_at = NOW()
        WHERE id = ${intentId} AND status = 'reveal_ready'
        RETURNING deal_id
      `;
      const dealId = rows[0]?.deal_id;
      if (dealId) {
        await sql`
          UPDATE deals SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = ${dealId} AND status NOT IN ('completed', 'cancelled')
        `;
      }
    },

    async stuckSummary() {
      const [r] = await sql<{ n: string | number; oldest: Date | null }>`
        SELECT COUNT(*) AS n, MIN(stuck_at) AS oldest FROM cctp_transfers WHERE status = 'stuck'
      `;
      return { count: Number(r?.n ?? 0), oldestStuckAt: r?.oldest ? new Date(r.oldest) : null };
    },
  };
}
