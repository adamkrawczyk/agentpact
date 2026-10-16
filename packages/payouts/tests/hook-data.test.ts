// Known-answer vectors for hookData v1 + dealRef. The expected hex was produced
// by Foundry, independently of viem, so a regression in either the field order
// or the encoder shows up as a byte diff rather than a silent round-trip pass:
//
//   cast abi-encode "f(uint8,bytes32,address,bytes,address,uint64,uint256,bytes32,uint32,bytes32)" \
//     1 0x11..11 0x22..22 0xdeadbeef 0x33..33 1790000000 5000000 0x00..0044..44 5 0x55..55
//   cast keccak "agentpact:deal:0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f"

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_DATA_VERSION,
  dealRef,
  decodeHookData,
  encodeHookData,
  type HookDataV1,
} from "../src/cctp/hook-data.js";

const W = (b: string) => b.repeat(64);

const VECTOR: HookDataV1 = {
  version: 1,
  dealRef: `0x${W("1")}`,
  verifier: "0x2222222222222222222222222222222222222222",
  params: "0xdeadbeef",
  sellerTarget: "0x3333333333333333333333333333333333333333",
  expiresAt: 1_790_000_000n,
  price: 5_000_000n,
  refundRecipient: `0x${"0".repeat(24)}${"4".repeat(40)}`,
  payoutDomain: 5,
  payoutRecipient: `0x${W("5")}`,
};

const VECTOR_HEX =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "1111111111111111111111111111111111111111111111111111111111111111" +
  "0000000000000000000000002222222222222222222222222222222222222222" +
  "0000000000000000000000000000000000000000000000000000000000000140" +
  "0000000000000000000000003333333333333333333333333333333333333333" +
  "000000000000000000000000000000000000000000000000000000006ab13b80" +
  "00000000000000000000000000000000000000000000000000000000004c4b40" +
  "0000000000000000000000004444444444444444444444444444444444444444" +
  "0000000000000000000000000000000000000000000000000000000000000005" +
  "5555555555555555555555555555555555555555555555555555555555555555" +
  "0000000000000000000000000000000000000000000000000000000000000004" +
  "deadbeef00000000000000000000000000000000000000000000000000000000";

describe("hookData v1", () => {
  it("encodes byte-identically to the contract's abi.encode layout", () => {
    assert.equal(encodeHookData(VECTOR), VECTOR_HEX);
  });

  it("decodes the known vector back to every field", () => {
    const d = decodeHookData(VECTOR_HEX);
    assert.deepEqual(d, VECTOR);
  });

  it("pins version 1", () => {
    assert.equal(HOOK_DATA_VERSION, 1);
  });

  it("refuses to decode an unknown version instead of guessing a layout", () => {
    const v2 = "0x" + "0".repeat(62) + "02" + VECTOR_HEX.slice(66);
    assert.throws(() => decodeHookData(v2 as `0x${string}`), /unsupported hookData version 2/);
  });

  it("refuses to encode out-of-range integers (uint32 domain, uint64 expiry, non-positive price)", () => {
    assert.throws(() => encodeHookData({ ...VECTOR, payoutDomain: 2 ** 32 }), /payoutDomain/);
    assert.throws(() => encodeHookData({ ...VECTOR, expiresAt: 2n ** 64n }), /expiresAt/);
    assert.throws(() => encodeHookData({ ...VECTOR, price: -1n }), /price/);
    assert.throws(() => encodeHookData({ ...VECTOR, price: 0n }), /price/);
  });

  it("refuses a malformed bytes32 rather than left-padding it into a different address", () => {
    assert.throws(
      () => encodeHookData({ ...VECTOR, refundRecipient: "0x4444" as `0x${string}` }),
      /refundRecipient/,
    );
  });
});

describe("dealRef", () => {
  it("is keccak256(abi.encodePacked('agentpact:deal:', uuid))", () => {
    assert.equal(
      dealRef("0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f"),
      "0xd3a02653d32272d7ee7a5766b56d29f5f1401deb279481a3d5e204f268c0420f",
    );
  });

  it("canonicalises the uuid to lower case so the API and the buyer agree", () => {
    assert.equal(
      dealRef("0B8F3C1E-5D2A-4F6B-9C7D-1A2B3C4D5E6F"),
      dealRef("0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f"),
    );
  });

  it("rejects anything that is not a uuid", () => {
    assert.throws(() => dealRef("deal-1"), /uuid/);
  });
});
