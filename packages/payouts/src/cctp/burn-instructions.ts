// Copy-paste burn calls for buyers funding a Base deal from another chain.
// Consumed by the API quote endpoint and the SDK; nothing here signs or sends.
//
// EVM (Ethereum → Base):
//   1. USDC.approve(TokenMessengerV2, amount)
//   2. TokenMessengerV2.depositForBurnWithHook(amount, 6, mintRecipient,
//        usdc, destinationCaller, maxFee, minFinalityThreshold, hookData)
//   Signature: circlefin/evm-cctp-contracts src/v2/TokenMessengerV2.sol
//   (depositForBurnWithHook requires non-empty hookData).
//
// Solana (Solana → Base): TokenMessengerMinterV2 `deposit_for_burn_with_hook`.
//   circlefin/solana-cctp-contracts programs/v2/token-messenger-minter-v2/src/
//   token_messenger_v2/instructions/deposit_for_burn_with_hook.rs (accounts =
//   DepositForBurnContext in deposit_for_burn.rs), IDL
//   examples/target/idl/token_messenger_minter_v2.json,
//   https://developers.circle.com/cctp/references/solana-programs
//   Returned as a plain {programId, keys, data} so any Solana SDK can wrap it
//   (web3.js `new TransactionInstruction(...)`, @solana/kit, etc.) without
//   this package depending on one.
//
// For deposits into AgentPact, mintRecipient AND destinationCaller are both
// the gateway: the mint must land in the gateway, and only the gateway may
// receive the message (so nobody can mint it to the gateway without running
// relayDeposit's binding logic).

import { encodeFunctionData, hexToBytes as hexBytes, parseAbi, type Address, type Hex } from "viem";
import {
  base58Decode,
  evmAddressToBytes32,
  findProgramAddress,
  solanaUsdcAta,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from "./address.js";
import { CCTP_DOMAIN, cctpConstants, type CctpNetwork } from "./constants.js";

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
export const TOKEN_MESSENGER_V2_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

export interface BurnParams {
  network: CctpNetwork;
  /** Burn amount in USDC base units (price + maxFee — see fees.ts quoteDeposit). */
  amount: bigint;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
  /** The AgentPactCctpGateway on Base. Used as mintRecipient AND destinationCaller. */
  gateway: Address;
}

export interface EvmCall {
  chainId: number;
  to: Address;
  data: Hex;
  value: 0n;
  description: string;
}

function checkCommon(p: BurnParams): void {
  if (p.amount <= 0n) throw new Error("amount must be > 0");
  if (p.maxFee < 0n || p.maxFee >= p.amount) throw new Error("maxFee must be >= 0 and < amount");
  if (p.hookData === "0x" || !/^0x([0-9a-fA-F]{2})+$/.test(p.hookData)) throw new Error("hookData must be non-empty hex");
  if (!Number.isInteger(p.minFinalityThreshold) || p.minFinalityThreshold < 0 || p.minFinalityThreshold > 0xffffffff) {
    throw new Error("minFinalityThreshold must be a uint32");
  }
}

/** Ethereum buyer: approve + depositForBurnWithHook, destination Base. */
export function buildEthereumBurn(p: BurnParams): { approve: EvmCall; depositForBurnWithHook: EvmCall } {
  checkCommon(p);
  const c = cctpConstants(p.network);
  const gateway32 = evmAddressToBytes32(p.gateway);
  return {
    approve: {
      chainId: c.ethereum.chainId,
      to: c.ethereum.usdc,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [c.ethereum.tokenMessengerV2, p.amount] }),
      value: 0n,
      description: `Approve TokenMessengerV2 to burn ${p.amount} USDC base units`,
    },
    depositForBurnWithHook: {
      chainId: c.ethereum.chainId,
      to: c.ethereum.tokenMessengerV2,
      data: encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: "depositForBurnWithHook",
        args: [p.amount, CCTP_DOMAIN.base, gateway32, c.ethereum.usdc, gateway32, p.maxFee, p.minFinalityThreshold, p.hookData],
      }),
      value: 0n,
      description: "Burn USDC on Ethereum for the AgentPact gateway on Base",
    },
  };
}

export interface SolanaAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SolanaInstruction {
  programId: string;
  keys: SolanaAccountMeta[];
  data: Uint8Array;
}

export interface SolanaBurnParams extends BurnParams {
  /** Buyer wallet (base58) — signs, owns the USDC token account. */
  owner: string;
  /**
   * A FRESH keypair's public key for the MessageSent event account. It must
   * also sign the transaction. Rent for it is reclaimable after 5 days via
   * reclaim_event_account.
   */
  messageSentEventData: string;
  /** Payer for the event account rent; defaults to owner. */
  eventRentPayer?: string;
  /** Source USDC token account; defaults to the owner's USDC ATA. */
  burnTokenAccount?: string;
}

/** sha256("global:deposit_for_burn_with_hook")[0..8] — Anchor discriminator. */
export const DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR = Uint8Array.of(111, 245, 62, 131, 204, 108, 223, 155);

const enc = new TextEncoder();

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64le(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 64n) throw new Error("value out of range for u64");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}


/** Borsh DepositForBurnWithHookParams, field order fixed by the program (#[repr(C)]). */
export function encodeDepositForBurnWithHookData(args: {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
}): Uint8Array {
  const hook = hexBytes(args.hookData);
  const parts = [
    DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR,
    u64le(args.amount),
    u32le(args.destinationDomain),
    hexBytes(args.mintRecipient),
    hexBytes(args.destinationCaller),
    u64le(args.maxFee),
    u32le(args.minFinalityThreshold),
    u32le(hook.length),
    hook,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Solana buyer: deposit_for_burn_with_hook, destination Base. */
export function buildSolanaBurn(p: SolanaBurnParams): SolanaInstruction {
  checkCommon(p);
  const c = cctpConstants(p.network).solana;
  const tmm = c.tokenMessengerMinterV2;
  const mt = c.messageTransmitterV2;
  const pda = (seeds: Uint8Array[], program: string) => findProgramAddress(seeds, program).address;
  const owner = base58Decode(p.owner);
  if (owner.length !== 32) throw new Error("owner must be a 32-byte Solana address");
  const gateway32 = evmAddressToBytes32(p.gateway);

  const keys: SolanaAccountMeta[] = [
    { pubkey: p.owner, isSigner: true, isWritable: false },
    { pubkey: p.eventRentPayer ?? p.owner, isSigner: true, isWritable: true },
    { pubkey: pda([enc.encode("sender_authority")], tmm), isSigner: false, isWritable: false },
    { pubkey: p.burnTokenAccount ?? solanaUsdcAta(p.owner, c.usdcMint), isSigner: false, isWritable: true },
    { pubkey: pda([enc.encode("denylist_account"), owner], tmm), isSigner: false, isWritable: false },
    { pubkey: pda([enc.encode("message_transmitter")], mt), isSigner: false, isWritable: true },
    { pubkey: pda([enc.encode("token_messenger")], tmm), isSigner: false, isWritable: false },
    { pubkey: pda([enc.encode("remote_token_messenger"), enc.encode(String(CCTP_DOMAIN.base))], tmm), isSigner: false, isWritable: false },
    { pubkey: pda([enc.encode("token_minter")], tmm), isSigner: false, isWritable: false },
    { pubkey: pda([enc.encode("local_token"), base58Decode(c.usdcMint)], tmm), isSigner: false, isWritable: true },
    { pubkey: c.usdcMint, isSigner: false, isWritable: true },
    { pubkey: p.messageSentEventData, isSigner: true, isWritable: true },
    { pubkey: mt, isSigner: false, isWritable: false },
    { pubkey: tmm, isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pda([enc.encode("__event_authority")], tmm), isSigner: false, isWritable: false },
    { pubkey: tmm, isSigner: false, isWritable: false },
  ];

  return {
    programId: tmm,
    keys,
    data: encodeDepositForBurnWithHookData({
      amount: p.amount,
      destinationDomain: CCTP_DOMAIN.base,
      mintRecipient: gateway32,
      destinationCaller: gateway32,
      maxFee: p.maxFee,
      minFinalityThreshold: p.minFinalityThreshold,
      hookData: p.hookData,
    }),
  };
}
