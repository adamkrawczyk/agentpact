// moneypath_0920 §3 M1 "the ask" — make the paid (fee-bearing) tier the
// VISIBLE default for deals ≥ $5.
//
// What tier concept exists today (recon 2026-09-22): exactly one binary flag,
// `deals.is_free_tier` = (negotiated_total == 0). A free-tier deal is
// reputation-only (zero-value milestones, no funding, no fee). Anything with a
// non-zero total is already fee-bearing at PLATFORM_FEE_PCT, taken at
// milestone release (AgentPactEscrow.sol:79, shared/deal-helpers.ts ledger
// insert). There is NO threshold tier and this module does not invent one —
// it makes the existing economics legible in the propose_deal / get_deal
// responses so an agent sees, at proposal time:
//   - which tier its deal is on and why,
//   - what the platform fee will be (integer base units, floor, same rounding
//     as the contract and the fee ledger),
//   - the ≥ PAID_DEFAULT_MIN_USD guidance,
//   - whether the seller holds the Verified Seller badge and where to buy it.
//
// PAID_DEFAULT_MIN_USD is configurable (default 5) so ops can tune the
// guidance line without a redeploy.

import { PLATFORM_FEE_PCT } from "./deal-helpers.js";
import { isZeroPrice } from "./utils.js";

export const PAID_DEFAULT_MIN_USD = Number(process.env.PAID_DEFAULT_MIN_USD ?? 5);

export const VERIFIED_SELLER_URL = "https://agentpact.xyz/verified";

export type DealPricing = {
  /** "paid" = fee-bearing (negotiated_total > 0); "free" = reputation-only (== 0). */
  tier: "paid" | "free";
  platform_fee_pct: number;
  /** Fee the platform will take at release, in whole currency units (USDC), floor-rounded like the escrow contract. */
  platform_fee_estimate: number;
  /** negotiated_total minus the fee estimate — what the seller nets. */
  seller_net_estimate: number;
  /** Deals at or above this USD value are expected to be on the paid tier. */
  paid_default_min_usd: number;
  /** true when negotiated_total >= paid_default_min_usd AND tier is "paid". */
  meets_paid_default: boolean;
  seller_verified: boolean;
  verified_seller_url: string;
  note: string;
};

/**
 * Pure fee math, mirroring AgentPactEscrow.sol:79-80 and the ledger insert in
 * shared/deal-helpers.ts: integer base units (6dp), fee = floor(gross * pct / 100).
 */
export function estimatePlatformFee(negotiatedTotal: number, feePct: number = PLATFORM_FEE_PCT): { feeAmount: number; sellerAmount: number } {
  const grossMinor = Math.round(negotiatedTotal * 1_000_000);
  const feeMinor = Math.floor((grossMinor * feePct) / 100);
  return {
    feeAmount: feeMinor / 1_000_000,
    sellerAmount: (grossMinor - feeMinor) / 1_000_000,
  };
}

export function describeDealPricing(
  negotiatedTotal: number,
  sellerVerifiedAt: string | Date | null | undefined,
): DealPricing {
  const free = isZeroPrice(negotiatedTotal);
  const { feeAmount, sellerAmount } = free ? { feeAmount: 0, sellerAmount: 0 } : estimatePlatformFee(negotiatedTotal);
  const meetsPaidDefault = !free && negotiatedTotal >= PAID_DEFAULT_MIN_USD;
  const sellerVerified = sellerVerifiedAt != null;
  const note = free
    ? `Free tier: reputation-only, no funding and no platform fee. Deals worth ≥ $${PAID_DEFAULT_MIN_USD} should be proposed on the paid tier (negotiated_total > 0) so escrow and settlement apply.`
    : `Paid tier: ${PLATFORM_FEE_PCT}% platform fee (${feeAmount} USDC) taken from each milestone at release; seller nets ${sellerAmount} USDC.` +
      (meetsPaidDefault ? "" : ` Below the $${PAID_DEFAULT_MIN_USD} paid-default guidance.`) +
      (sellerVerified ? " Seller is a Verified Seller." : ` Seller is not verified — Verified Seller badge ($19 one-time) at ${VERIFIED_SELLER_URL}.`);
  return {
    tier: free ? "free" : "paid",
    platform_fee_pct: PLATFORM_FEE_PCT,
    platform_fee_estimate: feeAmount,
    seller_net_estimate: sellerAmount,
    paid_default_min_usd: PAID_DEFAULT_MIN_USD,
    meets_paid_default: meetsPaidDefault,
    seller_verified: sellerVerified,
    verified_seller_url: VERIFIED_SELLER_URL,
    note,
  };
}
