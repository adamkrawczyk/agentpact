// CCTP v2 message decoding.
//
// Offsets follow circlefin/evm-cctp-contracts:
//   src/messages/v2/MessageV2.sol      (header, 148 bytes, then messageBody)
//   src/messages/v2/BurnMessageV2.sol  (body, 228 bytes, then hookData)
// https://developers.circle.com/cctp/technical-guide#message-format
//
// The message a burn emits on the source chain carries a zero nonce and zero
// finalityThresholdExecuted/feeExecuted; Iris fills them in the attested
// message returned by /v2/messages. Decode the ATTESTED bytes.

import { hexToBigInt, keccak256, type Hex } from "viem";

export interface BurnMessageV2 {
  version: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
}

export interface CctpMessageV2 {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** bytes32 nonce — the replay key MessageTransmitterV2.usedNonces() is indexed by. */
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  messageBody: Hex;
  /** The body decoded as a BurnMessageV2 (TokenMessengerV2 messages only). */
  burn: BurnMessageV2;
}

const HEADER_BYTES = 148;
const BURN_FIXED_BYTES = 228;

function slice(hex: string, offset: number, len: number): Hex {
  return `0x${hex.slice(offset * 2, (offset + len) * 2)}`;
}

function u32(hex: string, offset: number): number {
  return Number(hexToBigInt(slice(hex, offset, 4)));
}

export function decodeBurnMessage(body: Hex): BurnMessageV2 {
  const h = body.slice(2);
  if (h.length < BURN_FIXED_BYTES * 2) throw new Error(`burn message too short: ${h.length / 2} bytes`);
  return {
    version: u32(h, 0),
    burnToken: slice(h, 4, 32),
    mintRecipient: slice(h, 36, 32),
    amount: hexToBigInt(slice(h, 68, 32)),
    messageSender: slice(h, 100, 32),
    maxFee: hexToBigInt(slice(h, 132, 32)),
    feeExecuted: hexToBigInt(slice(h, 164, 32)),
    expirationBlock: hexToBigInt(slice(h, 196, 32)),
    hookData: `0x${h.slice(BURN_FIXED_BYTES * 2)}`,
  };
}

export function decodeCctpMessage(message: Hex): CctpMessageV2 {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(message)) throw new Error("CCTP message is not hex bytes");
  const h = message.slice(2);
  if (h.length < HEADER_BYTES * 2) throw new Error(`CCTP message too short: ${h.length / 2} bytes`);
  const messageBody: Hex = `0x${h.slice(HEADER_BYTES * 2)}`;
  return {
    version: u32(h, 0),
    sourceDomain: u32(h, 4),
    destinationDomain: u32(h, 8),
    nonce: slice(h, 12, 32),
    sender: slice(h, 44, 32),
    recipient: slice(h, 76, 32),
    destinationCaller: slice(h, 108, 32),
    minFinalityThreshold: u32(h, 140),
    finalityThresholdExecuted: u32(h, 144),
    messageBody,
    burn: decodeBurnMessage(messageBody),
  };
}

export function messageHash(message: Hex): Hex {
  return keccak256(message);
}
