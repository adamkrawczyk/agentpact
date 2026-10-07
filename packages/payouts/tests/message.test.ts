// CCTP v2 message + BurnMessageV2 decoding. The vector is assembled field by
// field as raw hex here (not with the decoder's own helpers), following the
// offsets in circlefin/evm-cctp-contracts src/messages/v2/MessageV2.sol and
// BurnMessageV2.sol.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { decodeCctpMessage, messageHash } from "../src/cctp/message.js";
import { encodeHookData } from "../src/cctp/hook-data.js";

const u32 = (n: number) => n.toString(16).padStart(8, "0");
const u256 = (n: bigint) => n.toString(16).padStart(64, "0");
const b32 = (c: string) => c.repeat(64);

const hook = encodeHookData({
  version: 1,
  dealRef: `0x${b32("1")}`,
  verifier: "0x2222222222222222222222222222222222222222",
  params: "0x",
  sellerTarget: "0x3333333333333333333333333333333333333333",
  expiresAt: 1_790_000_000n,
  price: 5_000_000n,
  refundRecipient: `0x${b32("4")}`,
  payoutDomain: 6,
  payoutRecipient: `0x${"0".repeat(24)}${"3".repeat(40)}`,
});

const BODY =
  u32(1) + // body version
  b32("a") + // burnToken
  "000000000000000000000000" + "9".repeat(40) + // mintRecipient (gateway)
  u256(5_010_000n) + // amount
  b32("b") + // messageSender
  u256(10_000n) + // maxFee
  u256(5_000n) + // feeExecuted
  u256(0n) + // expirationBlock
  hook.slice(2);

const MESSAGE = ("0x" +
  u32(1) + // version
  u32(5) + // sourceDomain (solana)
  u32(6) + // destinationDomain (base)
  b32("c") + // nonce
  b32("d") + // sender (source TokenMessenger)
  b32("e") + // recipient (destination TokenMessenger)
  "000000000000000000000000" + "9".repeat(40) + // destinationCaller (gateway)
  u32(1000) + // minFinalityThreshold
  u32(1000) + // finalityThresholdExecuted
  BODY) as `0x${string}`;

describe("decodeCctpMessage", () => {
  it("decodes every header field at its MessageV2 offset", () => {
    const m = decodeCctpMessage(MESSAGE);
    assert.equal(m.version, 1);
    assert.equal(m.sourceDomain, 5);
    assert.equal(m.destinationDomain, 6);
    assert.equal(m.nonce, `0x${b32("c")}`);
    assert.equal(m.sender, `0x${b32("d")}`);
    assert.equal(m.recipient, `0x${b32("e")}`);
    assert.equal(m.destinationCaller, `0x${"0".repeat(24)}${"9".repeat(40)}`);
    assert.equal(m.minFinalityThreshold, 1000);
    assert.equal(m.finalityThresholdExecuted, 1000);
  });

  it("decodes every BurnMessageV2 field and the embedded hookData", () => {
    const { burn } = decodeCctpMessage(MESSAGE);
    assert.ok(burn);
    assert.equal(burn.version, 1);
    assert.equal(burn.burnToken, `0x${b32("a")}`);
    assert.equal(burn.mintRecipient, `0x${"0".repeat(24)}${"9".repeat(40)}`);
    assert.equal(burn.amount, 5_010_000n);
    assert.equal(burn.messageSender, `0x${b32("b")}`);
    assert.equal(burn.maxFee, 10_000n);
    assert.equal(burn.feeExecuted, 5_000n);
    assert.equal(burn.expirationBlock, 0n);
    assert.equal(burn.hookData, hook);
  });

  it("messageHash is keccak256 over the full message bytes", () => {
    assert.equal(messageHash(MESSAGE), keccak256(MESSAGE));
  });

  it("refuses a message shorter than the 148-byte header", () => {
    assert.throws(() => decodeCctpMessage(MESSAGE.slice(0, 200) as `0x${string}`), /too short/);
  });

  it("refuses a burn body shorter than its 228-byte fixed part", () => {
    assert.throws(() => decodeCctpMessage(MESSAGE.slice(0, 2 + 148 * 2 + 100) as `0x${string}`), /burn message too short/);
  });
});
