/**
 * @agentpact/payouts — Unified payout API (Stripe Connect + USDC on-chain)
 */

import { blake2b } from './blake2b.js';

export type Rail = 'stripe' | 'usdc-base' | 'usdc-solana' | 'nano-xno';

export interface PayoutParams {
  recipient: string;       // Stripe account ID or wallet address
  amount: number;          // in smallest unit (cents for Stripe, microUSDC for on-chain)
  currency: string;        // 'usd', 'usdc'
  rail: Rail;
  // nano-xno only: amount in raw as a decimal integer string (1 XNO = 10^30 raw).
  // Raw does not fit in a JS number, so this rail reads amountRaw and never `amount`.
  amountRaw?: string;
  metadata?: Record<string, string>;
}

export interface PayoutResult {
  id: string;
  rail: Rail;
  status: 'pending' | 'completed' | 'failed';
  amount: number;
  currency: string;
  txHash?: string;         // on-chain tx hash (for USDC rails)
  stripeTransferId?: string;
}

export interface PayoutAdapter {
  send(params: PayoutParams): Promise<PayoutResult>;
  getStatus(id: string): Promise<PayoutResult>;
}

// Placeholder adapters — build session fills in real implementations
export class StripeConnectAdapter implements PayoutAdapter {
  // TODO: implement with Stripe Connect Express
  async send(params: PayoutParams): Promise<PayoutResult> {
    throw new Error('StripeConnectAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

export class USDCBaseAdapter implements PayoutAdapter {
  // TODO: implement with ethers + USDC contract on Base
  async send(params: PayoutParams): Promise<PayoutResult> {
    throw new Error('USDCBaseAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

export class USDCSolanaAdapter implements PayoutAdapter {
  // TODO: implement with @solana/web3.js
  async send(params: PayoutParams): Promise<PayoutResult> {
    throw new Error('USDCSolanaAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

// Nano account: 'nano_' (or legacy 'xrb_') + 60 base32 chars = 52 chars of the
// 32-byte public key (256 bits, 4 zero pad bits up front, so the first char is
// '1' or '3') + 8 chars of checksum. The checksum is the 5-byte blake2b digest
// of the public key, byte-reversed. 'nano_' addresses are 65 chars in total.
const NANO_ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';
const NANO_ACCOUNT = /^(?:nano|xrb)_([13][13-9a-km-uw-z]{51})([13-9a-km-uw-z]{8})$/;

function base32ToBigInt(s: string): bigint {
  let n = 0n;
  for (const c of s) n = (n << 5n) | BigInt(NANO_ALPHABET.indexOf(c));
  return n;
}

function bigIntToBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** True only for a well-formed nano_/xrb_ account whose blake2b checksum matches. */
export function isValidNanoAccount(account: string): boolean {
  if (typeof account !== 'string') return false;
  const m = NANO_ACCOUNT.exec(account);
  if (!m) return false;
  const publicKey = bigIntToBytes(base32ToBigInt(m[1]), 32);
  const checksum = bigIntToBytes(base32ToBigInt(m[2]), 5);
  const expected = blake2b(publicKey, 5).reverse();
  return expected.every((b, i) => b === checksum[i]);
}

// Nano amounts are integers of raw: 1 XNO = 10^30 raw, and balances are 128-bit.
// They are carried as bigint (or a decimal string), never as a JS number.
export const RAW_PER_XNO = 10n ** 30n;
export const MAX_RAW = (1n << 128n) - 1n;

/** Parse a decimal integer string of raw. Refuses numbers, signs, exponents and > MAX_RAW. */
export function parseRaw(raw: string): bigint {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`invalid raw amount: ${String(raw)}`);
  }
  const n = BigInt(raw);
  if (n > MAX_RAW) throw new Error(`raw amount exceeds 2^128-1: ${raw}`);
  return n;
}

/** Convert a decimal XNO string (at most 30 fractional digits) to raw, exactly. */
export function xnoToRaw(xno: string): bigint {
  if (typeof xno !== 'string') throw new Error(`XNO amount must be a decimal string, got ${typeof xno}`);
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,30}))?$/.exec(xno);
  if (!m) throw new Error(`invalid XNO amount (max 30 decimals): ${xno}`);
  const raw = BigInt(m[1]) * RAW_PER_XNO + BigInt((m[2] ?? '').padEnd(30, '0'));
  if (raw > MAX_RAW) throw new Error(`XNO amount exceeds 2^128-1 raw: ${xno}`);
  return raw;
}

/** Convert raw to a decimal XNO string, exactly, without trailing fractional zeros. */
export function rawToXno(raw: bigint): string {
  if (typeof raw !== 'bigint' || raw < 0n || raw > MAX_RAW) {
    throw new Error(`invalid raw amount: ${String(raw)}`);
  }
  const whole = raw / RAW_PER_XNO;
  const frac = (raw % RAW_PER_XNO).toString().padStart(30, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export class NanoXNOAdapter implements PayoutAdapter {
  // Inert stub. TODO: implement the send with a Nano wallet/RPC. Until then the adapter
  // validates the rail, the recipient (incl. blake2b checksum) and amountRaw, then
  // refuses, so no caller is told a payout is pending or completed when nothing was sent.
  async send(params: PayoutParams): Promise<PayoutResult> {
    if (params.rail !== 'nano-xno') throw new Error(`wrong rail ${params.rail}`);
    if (!isValidNanoAccount(params.recipient)) {
      throw new Error(`invalid Nano account: ${params.recipient}`);
    }
    if (params.amountRaw === undefined) throw new Error('nano-xno requires amountRaw (decimal string of raw)');
    if (parseRaw(params.amountRaw) === 0n) throw new Error('nano-xno amountRaw must be greater than 0');
    throw new Error('NanoXNOAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

const adapters: Record<Rail, PayoutAdapter> = {
  stripe: new StripeConnectAdapter(),
  'usdc-base': new USDCBaseAdapter(),
  'usdc-solana': new USDCSolanaAdapter(),
  'nano-xno': new NanoXNOAdapter(),
};

export async function send(params: PayoutParams): Promise<PayoutResult> {
  const adapter = adapters[params.rail];
  if (!adapter) throw new Error(`Unknown rail: ${params.rail}`);
  return adapter.send(params);
}

export { PayoutAdapter as default };
