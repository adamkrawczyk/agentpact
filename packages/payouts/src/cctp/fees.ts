// CCTP fee math. Integer base units only (bigint); a fee rate arrives from
// Iris as decimal basis points ("1", "1.3") and is turned into an exact
// rational, never a float.
//
// How CCTP v2 charges (https://developers.circle.com/cctp/concepts/fees):
//   - Fast Transfer (minFinalityThreshold 1000): a protocol fee in bps of the
//     burned amount, deducted AT MINT on the destination. The burner caps it
//     with `maxFee` (USDC base units); feeExecuted <= maxFee, and the
//     recipient receives amount - feeExecuted. Live: Ethereum 1 bps, Base 1.3
//     bps, Solana 1 bps (fees API, 2026-10-07).
//   - Standard Transfer (2000): 0 bps today ("subject to change").
//   - If maxFee cannot cover the Fast fee the transfer is NOT reverted; it
//     degrades to Standard speed.
//   - Forwarding Service: an extra fee in USDC base units (fees API with
//     forward=true → forwardFee.{low,med,high}); maxFee must cover protocol
//     fee + forwarding fee. Circle recommends `med` or higher. Excess is spent
//     as priority fee, not refunded — so quote, don't pad.
//
// Every line in a breakdown says whether it is EXACT (the number the user can
// be charged at most, fixed at signing) or an ESTIMATE (gas/rent that moves).

import { FINALITY, type TransferSpeed } from "./constants.js";
import type { IrisFeeTier, IrisForwardFee } from "./iris.js";

export const BPS_DENOMINATOR = 10_000n;

/**
 * Rent-exempt minimum for a 165-byte SPL token account (a Solana USDC ATA).
 * LIVE getMinimumBalanceForRentExemption(165) on mainnet-beta and devnet,
 * 2026-10-07: (128 + 165) × 5080 lamports/byte = 1,488,440. The older,
 * widely-quoted 2,039,280 is the previous rent rate. Changes with the Rent
 * sysvar — always an ESTIMATE; query the RPC at quote time when you can.
 */
export const SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS = 1_488_440n;

/**
 * Gas units for the Ethereum buyer's two transactions. ESTIMATES (observed
 * ranges for ERC-20 approve and TokenMessengerV2.depositForBurnWithHook with a
 * ~400-byte hook); multiply by the live gas price.
 */
export const ETHEREUM_BURN_GAS_UNITS = { approve: 46_000n, depositForBurnWithHook: 200_000n } as const;

export interface Rational {
  num: bigint;
  den: bigint;
}

/** Parse decimal basis points ("1", "1.3", "0") into an exact fraction of 1. */
export function parseBps(bps: string): Rational {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(bps.trim());
  if (!m) throw new Error(`invalid bps value: ${bps}`);
  const frac = m[2] ?? "";
  const scale = 10n ** BigInt(frac.length);
  return { num: BigInt(m[1] + frac), den: scale * BPS_DENOMINATOR };
}

/** amount × rate, rounded. floor = what the chain charges; ceil = a cap that always suffices. */
export function applyRate(amount: bigint, rate: Rational, rounding: "floor" | "ceil"): bigint {
  if (amount < 0n) throw new Error("amount must be non-negative");
  const p = amount * rate.num;
  const q = p / rate.den;
  return rounding === "ceil" && q * rate.den !== p ? q + 1n : q;
}

export function feeTierFor(tiers: IrisFeeTier[], speed: TransferSpeed): IrisFeeTier {
  const want = FINALITY[speed];
  const t = tiers.find((x) => x.finalityThreshold === want);
  if (!t) throw new Error(`Iris returned no fee tier for finality ${want}`);
  return t;
}

export type FeeUnit = "usdc_base_units" | "lamports" | "gas_units";

export interface FeeLine {
  key: string;
  label: string;
  amount: bigint;
  unit: FeeUnit;
  exact: boolean;
  note?: string;
}

export interface DepositQuote {
  speed: TransferSpeed;
  minFinalityThreshold: number;
  /** What the deal costs; the gateway requires net mint >= price. */
  price: bigint;
  /** maxFee passed to depositForBurnWithHook. */
  maxFee: bigint;
  /** amount passed to depositForBurnWithHook = price + maxFee. */
  burnAmount: bigint;
  /** Sum of the exact USDC lines — the most the buyer can pay in USDC. */
  totalUsdcExact: bigint;
  lines: FeeLine[];
}

export interface DepositQuoteInput {
  price: bigint;
  sourceDomain: number;
  speed: TransferSpeed;
  tiers: IrisFeeTier[];
}

/**
 * Quote a buyer's burn into the Base gateway (Ethereum or Solana → Base).
 *
 * Finds the smallest burn amount A with maxFee = ceil(A·r) and A − maxFee ≥
 * price, so the net mint covers the price even if the full cap is charged.
 * The chain charges floor(A·r) ≤ maxFee, so the gateway may receive a few
 * base units MORE than price — never less.
 */
export function quoteDeposit(input: DepositQuoteInput): DepositQuote {
  const { price, sourceDomain, speed } = input;
  if (price <= 0n) throw new Error("price must be > 0");
  if (sourceDomain !== 0 && sourceDomain !== 5) throw new Error(`deposits come from ethereum (0) or solana (5), got ${sourceDomain}`);
  const tier = feeTierFor(input.tiers, speed);
  const rate = parseBps(tier.minimumFeeBps);

  let maxFee = applyRate(price, rate, "ceil");
  for (;;) {
    const next = applyRate(price + maxFee, rate, "ceil");
    if (next <= maxFee) break;
    maxFee = next;
  }
  const burnAmount = price + maxFee;

  const lines: FeeLine[] = [
    { key: "price", label: "Deal price", amount: price, unit: "usdc_base_units", exact: true },
    {
      key: "cctp_fee_cap",
      label: `CCTP ${speed} transfer fee (cap, ${tier.minimumFeeBps} bps)`,
      amount: maxFee,
      unit: "usdc_base_units",
      exact: true,
      note: "maxFee: the most CCTP can deduct at mint. The fee actually executed is ≤ this; any difference stays in escrow with the deal.",
    },
  ];
  if (sourceDomain === 0) {
    lines.push(
      { key: "eth_gas_approve", label: "Ethereum gas: USDC approve", amount: ETHEREUM_BURN_GAS_UNITS.approve, unit: "gas_units", exact: false, note: "Multiply by the current L1 gas price; paid in ETH." },
      { key: "eth_gas_burn", label: "Ethereum gas: depositForBurnWithHook", amount: ETHEREUM_BURN_GAS_UNITS.depositForBurnWithHook, unit: "gas_units", exact: false, note: "Multiply by the current L1 gas price; paid in ETH." },
    );
  }
  return {
    speed,
    minFinalityThreshold: FINALITY[speed],
    price,
    maxFee,
    burnAmount,
    totalUsdcExact: burnAmount,
    lines,
  };
}

export interface ForwardedBurnQuoteInput {
  /** Amount the gateway will burn (refund or seller payout). */
  amount: bigint;
  destinationDomain: number;
  speed: TransferSpeed;
  tiers: IrisFeeTier[];
  /** From Iris with forward=true (and includeRecipientSetup=true for Solana). */
  forwardFee: IrisForwardFee;
}

export interface ForwardedBurnQuote {
  minFinalityThreshold: number;
  /** maxFee for the gateway's burn = protocol fee cap + forwarding fee (med). */
  maxFee: bigint;
  /** What the recipient receives at worst = amount − maxFee. */
  minReceived: bigint;
  lines: FeeLine[];
}

/** maxFee for a gateway → Forwarding Service burn (refunds and cross-chain payouts). */
export function quoteForwardedBurn(input: ForwardedBurnQuoteInput): ForwardedBurnQuote {
  const { amount, destinationDomain, speed } = input;
  if (amount <= 0n) throw new Error("amount must be > 0");
  const tier = feeTierFor(input.tiers, speed);
  const protocolCap = applyRate(amount, parseBps(tier.minimumFeeBps), "ceil");
  const forward = input.forwardFee.med;
  const maxFee = protocolCap + forward;
  if (maxFee >= amount) throw new Error(`fees (${maxFee}) would consume the whole amount (${amount})`);
  const lines: FeeLine[] = [
    { key: "cctp_fee_cap", label: `CCTP ${speed} transfer fee (cap, ${tier.minimumFeeBps} bps)`, amount: protocolCap, unit: "usdc_base_units", exact: true },
    { key: "forwarding_fee", label: "Circle Forwarding Service fee (med)", amount: forward, unit: "usdc_base_units", exact: false, note: "Gas-based quote; the fee moves with destination gas prices." },
  ];
  if (destinationDomain === 5) {
    lines.push({
      key: "solana_ata_rent",
      label: "Solana USDC token account rent (if the recipient has none)",
      amount: SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS,
      unit: "lamports",
      exact: false,
      note: "Covered inside the forwarding fee when quoted with includeRecipientSetup=true; shown for transparency.",
    });
  }
  return { minFinalityThreshold: FINALITY[speed], maxFee, minReceived: amount - maxFee, lines };
}
