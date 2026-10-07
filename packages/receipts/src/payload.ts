// apr-1 receipt payload: the pure builder.
//
// Input is a flat bag of FACTS read from the database by the issuer (the
// relayer's receipt sweeper). Output is the payload that gets canonicalised,
// hashed and signed. Everything here is a pure function of its input, so the
// same deal always produces the byte-identical payload — that determinism is
// what lets anyone re-derive and check a receipt later.
//
// Rules the builder enforces rather than trusts:
//   - no receipt for a deal that was never funded (practice deals included:
//     they get a receipt only if money actually moved, and are then labelled
//     non-qualifying via `evidence`)
//   - no receipt until the deal reached a terminal outcome
//   - money is integer base units as decimal strings; the fee is the ledger's
//     recorded number or an explicit "not charged"/"unrecorded" — it is never
//     recomputed here
//   - timestamps must already be canonical ISO-8601 UTC

import { canonicalize, sha256Hex } from "./canonical.js";

export const RECEIPT_VERSION = "apr-1" as const;

export type ReceiptOutcome =
  | "settled"
  | "refunded"
  | "disputed_buyer_won"
  | "disputed_seller_won"
  | "timed_out"
  | "cancelled_after_funding";

export const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = [
  "settled", "refunded", "disputed_buyer_won", "disputed_seller_won", "timed_out", "cancelled_after_funding",
];

export interface ReceiptParty {
  agent_id: string;
  handle: string;
  /** ap_wallet_key(owner_wallet_address): lowercased EVM / base58 Solana, null = unknown */
  owner_wallet_key: string | null;
}

export interface ReceiptJudge {
  /** judge@version, e.g. "jev-1@classifier.dev" (sweeper_decisions.judge) */
  judge: string;
  /** the sweeper decision: complete | review | hold | ... */
  verdict: string;
  /** P(satisfied) as the exact NUMERIC string stored, never a float */
  p: string | null;
  rubric_hash: string | null;
  decided_at: string;
}

export interface ReceiptDispute {
  opened_by: "buyer" | "seller" | "other";
  status: string;
  opened_at: string;
  resolved_at: string | null;
}

export interface OutcomeFacts {
  funded: boolean;
  deal_status: string;
  payment_intent_statuses: string[];
  /** EscrowV3 intent bound to the deal, if any. `expired` = expires_at passed before it closed. */
  intent: { status: string; expired: boolean } | null;
  disputed: boolean;
  /** a cross-chain refund transfer for this deal completed */
  refund_transfer_completed: boolean;
}

export interface ReceiptFacts {
  deal_id: string;
  deal_status: string;
  currency: string;
  payer: ReceiptParty;
  payee: ReceiptParty;
  /** deals.negotiated_total in base units (decimal string) */
  notional_base_units: string;
  /** platform_fee_ledger.amount_minor for this deal, or null when no row */
  ledger_fee_base_units: string | null;
  ledger_fee_pct_at_close: string | null;
  funding_chain: string;
  funding_tx_hashes: string[];
  settlement_tx_hashes: string[];
  acceptance: { source: "milestones" | "need" | "task_contract" | "none"; criteria: unknown };
  deliverable_hash: string | null;
  delivery_checksum: string | null;
  judge: ReceiptJudge | null;
  dispute: ReceiptDispute | null;
  payment_intent_statuses: string[];
  intent: OutcomeFacts["intent"];
  refund_transfer_completed: boolean;
  funded: boolean;
  qualifying: boolean;
  capital_at_risk: boolean;
  created_at: string;
  closed_at: string;
}

export interface ReceiptPayload {
  v: typeof RECEIPT_VERSION;
  deal_id: string;
  outcome: ReceiptOutcome;
  payer: ReceiptParty;
  payee: ReceiptParty;
  amount: {
    currency: string;
    decimals: 6;
    notional_base_units: string;
    fee_base_units: string | null;
    fee_source: "ledger" | "not_charged" | "unrecorded";
    fee_pct_at_close: string | null;
  };
  funding: { chain: string; tx_hashes: string[] };
  settlement: { tx_hashes: string[] };
  acceptance_test: { source: ReceiptFacts["acceptance"]["source"]; criteria_text: string; sha256: string };
  artifact: { deliverable_hash: string | null; delivery_checksum: string | null };
  judge: ReceiptJudge | null;
  dispute: ReceiptDispute | null;
  timestamps: { deal_created_at: string; closed_at: string };
  evidence: { qualifying: boolean; capital_at_risk: boolean };
}

const ESCROW_PAID_INTENT = new Set(["claimed", "completed", "acknowledged", "settled"]);
const ESCROW_RETURNED_INTENT = new Set(["refunded", "expired"]);
// Money is still moving: a receipt now would have to be superseded later.
const IN_FLIGHT_PAYMENT = new Set(["pending_refund", "disputed"]);

/**
 * Map a funded deal's state to its terminal outcome, or null when it has not
 * ended (or was never funded — those never get a receipt).
 *
 *   completed                                  -> settled | disputed_seller_won
 *   escrow intent expired + returned           -> timed_out (| disputed_buyer_won)
 *   cancelled + refund recorded                -> refunded | disputed_buyer_won
 *   cancelled, funded, no refund on record     -> cancelled_after_funding
 *   escrow intent claimed (deal row lagging)   -> settled | disputed_seller_won
 */
export function classifyOutcome(f: OutcomeFacts): ReceiptOutcome | null {
  if (!f.funded) return null;
  if (f.payment_intent_statuses.some((s) => IN_FLIGHT_PAYMENT.has(s))) return null;

  const intentPaid = f.intent !== null && ESCROW_PAID_INTENT.has(f.intent.status);
  const intentReturned = f.intent !== null && ESCROW_RETURNED_INTENT.has(f.intent.status);
  const refunded = f.payment_intent_statuses.includes("refunded") || f.refund_transfer_completed || intentReturned;

  if (f.deal_status === "completed") return f.disputed ? "disputed_seller_won" : "settled";
  if (intentReturned && f.intent?.expired) return f.disputed ? "disputed_buyer_won" : "timed_out";
  if (f.deal_status === "cancelled") {
    if (refunded) return f.disputed ? "disputed_buyer_won" : "refunded";
    return "cancelled_after_funding";
  }
  if (intentPaid) return f.disputed ? "disputed_seller_won" : "settled";
  return null;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Exact NUMERIC-string -> integer base units (default 6 decimals). Never rounds. */
export function decimalToBaseUnits(value: string, decimals = 6): string {
  const m = DECIMAL.exec(String(value).trim());
  if (!m) throw new Error(`not a non-negative decimal: ${JSON.stringify(value)}`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(`${value} exceeds ${decimals}-decimal precision`);
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0"));
  return units.toString();
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE_UNITS = /^\d+$/;

function iso(name: string, v: string): string {
  if (!ISO_UTC.test(v)) throw new Error(`${name} must be an ISO-8601 UTC timestamp, got ${JSON.stringify(v)}`);
  return v;
}

function units(name: string, v: string): string {
  if (!BASE_UNITS.test(v)) throw new Error(`${name} must be integer base units, got ${JSON.stringify(v)}`);
  return v.replace(/^0+(?=\d)/, "");
}

// EVM hashes are case-insensitive hex and get lowercased; Solana signatures
// are case-SENSITIVE base58 and are kept byte-for-byte.
function normTx(h: string): string {
  const t = h.trim();
  return /^0x[0-9a-fA-F]+$/.test(t) ? t.toLowerCase() : t;
}

function txSet(hashes: string[]): string[] {
  return [...new Set(hashes.filter((h) => typeof h === "string" && h.trim().length > 0).map(normTx))].sort();
}

export function buildReceiptPayload(f: ReceiptFacts): ReceiptPayload | null {
  const outcome = classifyOutcome({
    funded: f.funded,
    deal_status: f.deal_status,
    payment_intent_statuses: f.payment_intent_statuses,
    intent: f.intent,
    disputed: f.dispute !== null || f.payment_intent_statuses.includes("disputed"),
    refund_transfer_completed: f.refund_transfer_completed,
  });
  if (outcome === null) return null;

  const sellerPaid = outcome === "settled" || outcome === "disputed_seller_won";
  let fee: Pick<ReceiptPayload["amount"], "fee_base_units" | "fee_source" | "fee_pct_at_close">;
  if (f.ledger_fee_base_units !== null) {
    fee = { fee_base_units: units("ledger_fee_base_units", f.ledger_fee_base_units), fee_source: "ledger", fee_pct_at_close: f.ledger_fee_pct_at_close };
  } else if (sellerPaid) {
    // Seller was paid but no ledger row exists. Say so; do not invent a number.
    fee = { fee_base_units: null, fee_source: "unrecorded", fee_pct_at_close: null };
  } else {
    fee = { fee_base_units: "0", fee_source: "not_charged", fee_pct_at_close: null };
  }

  const criteria = f.acceptance.criteria ?? null;
  const criteriaText = typeof criteria === "string" ? criteria : f.acceptance.source === "none" ? "" : canonicalize(criteria);

  return {
    v: RECEIPT_VERSION,
    deal_id: f.deal_id,
    outcome,
    payer: { agent_id: f.payer.agent_id, handle: f.payer.handle, owner_wallet_key: f.payer.owner_wallet_key },
    payee: { agent_id: f.payee.agent_id, handle: f.payee.handle, owner_wallet_key: f.payee.owner_wallet_key },
    amount: {
      currency: f.currency,
      decimals: 6,
      notional_base_units: units("notional_base_units", f.notional_base_units),
      ...fee,
    },
    funding: { chain: f.funding_chain, tx_hashes: txSet(f.funding_tx_hashes) },
    settlement: { tx_hashes: txSet(f.settlement_tx_hashes) },
    acceptance_test: { source: f.acceptance.source, criteria_text: criteriaText, sha256: sha256Hex(criteriaText) },
    artifact: { deliverable_hash: f.deliverable_hash, delivery_checksum: f.delivery_checksum },
    judge: f.judge
      ? { judge: f.judge.judge, verdict: f.judge.verdict, p: f.judge.p, rubric_hash: f.judge.rubric_hash, decided_at: iso("judge.decided_at", f.judge.decided_at) }
      : null,
    dispute: f.dispute
      ? {
          opened_by: f.dispute.opened_by,
          status: f.dispute.status,
          opened_at: iso("dispute.opened_at", f.dispute.opened_at),
          resolved_at: f.dispute.resolved_at === null ? null : iso("dispute.resolved_at", f.dispute.resolved_at),
        }
      : null,
    timestamps: { deal_created_at: iso("created_at", f.created_at), closed_at: iso("closed_at", f.closed_at) },
    evidence: { qualifying: f.qualifying, capital_at_risk: f.capital_at_risk },
  };
}
