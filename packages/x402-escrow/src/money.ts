import type { UsdAmount } from "./types.js";

/** USDC has 6 decimals; every amount in this package is an integer number of base units. */
export const USDC_DECIMALS = 6;
const SCALE = 1_000_000n;
const DECIMAL = /^\$?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a USD amount into USDC base units without ever touching a float.
 * Numbers are accepted for convenience but go through their decimal string
 * form, so `0.1 + 0.2` style artefacts or exponent notation are rejected.
 */
export function parseUsd(value: UsdAmount): bigint {
  if (typeof value === "object" && value !== null) {
    const raw = typeof value.amountBaseUnits === "bigint" ? value.amountBaseUnits : String(value.amountBaseUnits);
    if (typeof raw === "bigint") {
      if (raw < 0n) throw new Error("USD amount must not be negative");
      return raw;
    }
    if (!/^\d+$/.test(raw)) throw new Error(`Invalid USD base-unit amount: ${raw}`);
    return BigInt(raw);
  }
  const text = typeof value === "number" ? String(value) : value.trim();
  const m = DECIMAL.exec(text);
  if (!m) throw new Error(`Invalid USD amount: ${text} (expected e.g. "$0.02")`);
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) throw new Error(`USD amount ${text} has more than 6 decimals`);
  return BigInt(m[1]) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** Base units → canonical decimal string ("25", "0.02"). */
export function formatUsd(baseUnits: bigint): string {
  const whole = baseUnits / SCALE;
  const frac = (baseUnits % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
