// Address forms used by CCTP v2.
//
// CCTP addresses every party as a bytes32 (`mintRecipient`, `destinationCaller`,
// message `sender`/`recipient`). EVM addresses are left-padded with 12 zero
// bytes; Solana public keys are already 32 bytes.
//
// SOLANA mintRecipient MUST BE A TOKEN ACCOUNT, not the owner wallet: the
// Solana TokenMessengerMinter mints into the token account named in the
// message (developers.circle.com/cctp/solana-programs, "mintRecipient … must be
// the USDC associated token account"). solanaUsdcAta() derives it. When a
// transfer goes through Circle's Forwarding Service the forwarder mints for us,
// and the caller can address the owner wallet's ATA without having created it
// first (the forwarder creates it and charges the rent inside its fee — see
// fees.ts SOLANA_ATA_RENT_LAMPORTS). The bytes32 is still the ATA either way.
//
// Solana primitives here (base58, PDA, ed25519 on-curve check) are implemented
// in ~80 lines instead of depending on @solana/web3.js (a large dependency
// tree for three pure functions). They are pinned by known-answer vectors
// generated with web3.js + spl-token in tests/address.test.ts.

import { bytesToHex, getAddress, hexToBytes, isAddress, sha256, type Address, type Hex } from "viem";

// ── EVM ────────────────────────────────────────────────────────────────────

export function evmAddressToBytes32(address: string): Hex {
  if (!isAddress(address, { strict: false })) throw new Error(`not an EVM address: ${address}`);
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

export function bytes32ToEvmAddress(b: Hex): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) throw new Error(`not a bytes32: ${b}`);
  if (!/^0x0{24}/.test(b)) throw new Error(`bytes32 ${b} is not an EVM address (top 12 bytes non-zero)`);
  return getAddress(`0x${b.slice(26)}`);
}

// ── base58 (bitcoin alphabet, as used by Solana) ───────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + v;
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

// ── Solana ↔ bytes32 ───────────────────────────────────────────────────────

const toHex = (b: Uint8Array): Hex => bytesToHex(b);
const fromHex = (h: Hex): Uint8Array => hexToBytes(h);

export function solanaAddressToBytes32(address: string): Hex {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error(`Solana address must decode to 32 bytes, got ${b.length}`);
  return toHex(b);
}

export function bytes32ToSolanaAddress(b: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) throw new Error(`not a bytes32: ${b}`);
  return base58Encode(fromHex(b));
}

// ── ed25519 on-curve check (for PDA derivation) ────────────────────────────
// A PDA is valid only if it is NOT a valid ed25519 point. Same acceptance rule
// as @noble/curves ExtendedPoint.fromHex with zip215 (what web3.js uses): the
// point decodes iff (y² − 1) / (d·y² + 1) is a square mod p.

const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function modPow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

function modInv(a: bigint): bigint {
  return modPow(a, P - 2n);
}

export function isOnEd25519Curve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * modInv(v)) % P;
  if (x2 === 0n) return true;
  // Euler's criterion: x2 is a quadratic residue iff x2^((p-1)/2) == 1.
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

// ── PDA + associated token account ─────────────────────────────────────────

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array | null {
  const parts: number[] = [];
  for (const s of seeds) {
    if (s.length > 32) throw new Error("PDA seed longer than 32 bytes");
    parts.push(...s);
  }
  parts.push(...programId, ...PDA_MARKER);
  const hash = fromHex(sha256(Uint8Array.from(parts)));
  return isOnEd25519Curve(hash) ? null : hash;
}

/** Solana's findProgramAddressSync: highest bump in 255..0 that is off-curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  if (seeds.length > 15) throw new Error("too many PDA seeds");
  const pid = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const addr = createProgramAddress([...seeds, Uint8Array.of(bump)], pid);
    if (addr) return { address: base58Encode(addr), bump };
  }
  throw new Error("unable to find a viable program address bump");
}

/** The owner's associated token account for `mint` (classic SPL Token program). */
export function solanaUsdcAta(owner: string, mint: string): string {
  const ownerBytes = base58Decode(owner);
  if (ownerBytes.length !== 32) throw new Error("owner must be a 32-byte Solana address");
  return findProgramAddress(
    [ownerBytes, base58Decode(SPL_TOKEN_PROGRAM_ID), base58Decode(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).address;
}
