// hookData v1 — the payload a buyer embeds in its own CCTP burn so that the
// AgentPactCctpGateway on Base can open the escrow intent for the right deal.
//
// Layout is FIXED by the gateway contract (SHARED_CONTEXT §6) and must stay
// byte-identical to its `abi.decode`:
//
//   abi.encode(uint8 version=1, bytes32 dealRef, address verifier, bytes params,
//              address sellerTarget, uint64 expiresAt, uint256 price,
//              bytes32 refundRecipient, uint32 payoutDomain, bytes32 payoutRecipient)
//
// The buyer authors this inside its own burn, so the refund recipient is the
// buyer's own choice; the API only binds `dealRef` to the deal.

import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const HOOK_DATA_VERSION = 1 as const;

export interface HookDataV1 {
  version: typeof HOOK_DATA_VERSION;
  /** keccak256("agentpact:deal:" + dealUuid) — see dealRef(). */
  dealRef: Hex;
  /** EscrowV3-approved IPredicateVerifier. */
  verifier: Address;
  /** ABI-encoded predicate params for the verifier. */
  params: Hex;
  /** Seller's Base address when payoutDomain == 6, else the gateway itself. */
  sellerTarget: Address;
  /** Intent expiry, unix seconds (uint64). */
  expiresAt: bigint;
  /** Deal price in USDC base units (6 decimals). Net mint must be >= this. */
  price: bigint;
  /** Where a refund is burned back to on the source domain (CCTP bytes32 form). */
  refundRecipient: Hex;
  /** CCTP domain the seller is paid on (0 ethereum, 5 solana, 6 base). */
  payoutDomain: number;
  /** Seller payout recipient on payoutDomain (CCTP bytes32 form). */
  payoutRecipient: Hex;
}

const HOOK_DATA_ABI = [
  { type: "uint8", name: "version" },
  { type: "bytes32", name: "dealRef" },
  { type: "address", name: "verifier" },
  { type: "bytes", name: "params" },
  { type: "address", name: "sellerTarget" },
  { type: "uint64", name: "expiresAt" },
  { type: "uint256", name: "price" },
  { type: "bytes32", name: "refundRecipient" },
  { type: "uint32", name: "payoutDomain" },
  { type: "bytes32", name: "payoutRecipient" },
] as const;

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertBytes32(name: string, v: string): asserts v is Hex {
  if (!BYTES32_RE.test(v)) throw new Error(`hookData.${name} must be a 0x-prefixed bytes32, got ${v}`);
}

function assertUint(name: string, v: bigint, bits: number, min = 0n): void {
  if (typeof v !== "bigint" || v < min || v >= 1n << BigInt(bits)) {
    throw new Error(`hookData.${name} out of range for uint${bits} (min ${min}): ${String(v)}`);
  }
}

/**
 * The bytes32 that ties a burn to exactly one deal:
 * keccak256(abi.encodePacked("agentpact:deal:", dealUuid)), uuid lower-cased.
 */
export function dealRef(dealUuid: string): Hex {
  const id = dealUuid.toLowerCase();
  if (!UUID_RE.test(id)) throw new Error(`dealRef expects a uuid, got ${dealUuid}`);
  return keccak256(toBytes(`agentpact:deal:${id}`));
}

export function encodeHookData(h: HookDataV1): Hex {
  if (h.version !== HOOK_DATA_VERSION) throw new Error(`unsupported hookData version ${h.version}`);
  assertBytes32("dealRef", h.dealRef);
  assertBytes32("refundRecipient", h.refundRecipient);
  assertBytes32("payoutRecipient", h.payoutRecipient);
  if (!isAddress(h.verifier, { strict: false })) throw new Error(`hookData.verifier is not an address: ${h.verifier}`);
  if (!isAddress(h.sellerTarget, { strict: false })) throw new Error(`hookData.sellerTarget is not an address: ${h.sellerTarget}`);
  if (!HEX_RE.test(h.params)) throw new Error("hookData.params must be 0x-prefixed hex bytes");
  assertUint("expiresAt", h.expiresAt, 64);
  // A zero price would let any mint satisfy `net >= price`; refuse it here too.
  assertUint("price", h.price, 256, 1n);
  assertUint("payoutDomain", BigInt(h.payoutDomain), 32);
  if (!Number.isInteger(h.payoutDomain)) throw new Error(`hookData.payoutDomain must be an integer`);

  return encodeAbiParameters(HOOK_DATA_ABI, [
    h.version,
    h.dealRef,
    h.verifier,
    h.params,
    h.sellerTarget,
    h.expiresAt,
    h.price,
    h.refundRecipient,
    h.payoutDomain,
    h.payoutRecipient,
  ]);
}

export function decodeHookData(data: Hex): HookDataV1 {
  // Read the version word first: a future layout must never be decoded with
  // this one's field offsets.
  if (!HEX_RE.test(data) || data.length < 66) throw new Error("hookData is not abi-encoded hex");
  const version = Number(BigInt(data.slice(0, 66)));
  if (version !== HOOK_DATA_VERSION) throw new Error(`unsupported hookData version ${version}`);

  const [v, ref, verifier, params, sellerTarget, expiresAt, price, refundRecipient, payoutDomain, payoutRecipient] =
    decodeAbiParameters(HOOK_DATA_ABI, data);
  return {
    version: v as typeof HOOK_DATA_VERSION,
    dealRef: ref,
    verifier: getAddress(verifier),
    params,
    sellerTarget: getAddress(sellerTarget),
    expiresAt,
    price,
    refundRecipient,
    payoutDomain,
    payoutRecipient,
  };
}
