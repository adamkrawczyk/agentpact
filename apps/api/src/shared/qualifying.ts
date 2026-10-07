/**
 * The ONE definition of "a deal that counts" (honest_0710 foundation).
 *
 * SQL twin: `ap_wallet_key()` + views `deal_integrity` / `qualifying_deals`
 * in migrations/052_qualifying_deals.sql. `qualifying.test.ts` asserts both
 * definitions agree on identical fixtures — change both or neither.
 *
 * Levels:
 *  - qualifying:      priced (> 0), buyer ≠ seller, both owner wallets KNOWN and
 *                     DIFFERENT, neither party internal, deal not quarantined.
 *  - capitalAtRisk:   qualifying AND money actually moved (funded escrow /
 *                     payment intent, including later refunds and disputes).
 *
 * Reputation, trust tiers, receipts and public "paid" counters must use
 * `capitalAtRisk`. Self-deals, same-owner deals, fleet deals and $0 practice
 * deals never count as evidence.
 */

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_ZERO_RE = /^0x0{40}$/i;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_NULL_RE = /^1+$/;

/** Canonical wallet key, or null when the wallet is unknown/placeholder. */
export function walletKey(wallet: string | null | undefined): string | null {
  if (wallet == null) return null;
  const w = wallet.trim();
  if (EVM_RE.test(w)) return EVM_ZERO_RE.test(w) ? null : w.toLowerCase();
  if (SOLANA_RE.test(w)) return SOLANA_NULL_RE.test(w) ? null : w;
  return null;
}

export interface DealIntegrityInput {
  negotiatedTotal: number | string | null | undefined;
  buyerAgentId: string;
  sellerAgentId: string;
  buyerOwnerWallet: string | null | undefined;
  sellerOwnerWallet: string | null | undefined;
  buyerIsInternal: boolean;
  sellerIsInternal: boolean;
  integrityClass?: string | null;
}

export type DisqualifyReason =
  | "unpriced"
  | "self_deal"
  | "unknown_owner_wallet"
  | "same_owner"
  | "internal_party"
  | "quarantined";

/** Every reason a deal fails to qualify (empty array = qualifying). */
export function disqualifyReasons(d: DealIntegrityInput): DisqualifyReason[] {
  const reasons: DisqualifyReason[] = [];
  if (!(Number(d.negotiatedTotal ?? 0) > 0)) reasons.push("unpriced");
  if (d.buyerAgentId === d.sellerAgentId) reasons.push("self_deal");
  const b = walletKey(d.buyerOwnerWallet);
  const s = walletKey(d.sellerOwnerWallet);
  if (b === null || s === null) reasons.push("unknown_owner_wallet");
  else if (b === s) reasons.push("same_owner");
  if (d.buyerIsInternal || d.sellerIsInternal) reasons.push("internal_party");
  if (d.integrityClass) reasons.push("quarantined");
  return reasons;
}

export function isQualifyingDeal(d: DealIntegrityInput): boolean {
  return disqualifyReasons(d).length === 0;
}

export function isCapitalAtRisk(d: DealIntegrityInput & { funded: boolean }): boolean {
  return d.funded && isQualifyingDeal(d);
}

/** Name of the SQL views every SQL consumer must read instead of re-deriving the rule. */
export const DEAL_INTEGRITY_VIEW = "deal_integrity" as const;
export const QUALIFYING_DEALS_VIEW = "qualifying_deals" as const;
