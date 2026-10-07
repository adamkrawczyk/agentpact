/**
 * deploy-cctp-gateway.test.ts — config resolution + the mainnet guard.
 * Run: node --import tsx --test scripts/deploy-cctp-gateway.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, constructorArgs } from "./deploy-cctp-gateway.js";

describe("deploy-cctp-gateway resolveConfig", () => {
  test("refuses Base mainnet without CONFIRM_MAINNET=yes", () => {
    assert.throws(() => resolveConfig("base", {}), /CONFIRM_MAINNET=yes/);
    assert.throws(() => resolveConfig("base", { CONFIRM_MAINNET: "true" }), /CONFIRM_MAINNET=yes/);
  });

  test("mainnet with confirmation uses Circle's mainnet CCTP v2 + the verified EscrowV3", () => {
    const c = resolveConfig("base", { CONFIRM_MAINNET: "yes" });
    assert.equal(c.chainId, 8453n);
    assert.deepEqual(constructorArgs(c), [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      "0x1cc92210988522a06d9950241B32750f82005eb7",
      "0x0000000000000000000000000000000000000000",
      100n,
      250000n,
    ]);
  });

  test("base-sepolia uses testnet CCTP v2 and requires an explicit escrow", () => {
    assert.throws(() => resolveConfig("base-sepolia", {}), /ESCROW_V3_ADDRESS is required/);
    const c = resolveConfig("base-sepolia", { ESCROW_V3_ADDRESS: "0x1111111111111111111111111111111111111111" });
    assert.equal(c.chainId, 84532n);
    assert.equal(c.args.usdc, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    assert.equal(c.args.messageTransmitter, "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
    assert.equal(c.args.tokenMessenger, "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
  });

  test("rejects unknown networks and out-of-range fee caps", () => {
    assert.throws(() => resolveConfig("", {}), /--network/);
    assert.throws(() => resolveConfig("ethereum", {}), /--network/);
    const env = { ESCROW_V3_ADDRESS: "0x1111111111111111111111111111111111111111" };
    assert.throws(() => resolveConfig("base-sepolia", { ...env, CCTP_FEE_CAP_BPS: "101" }), /exceeds/);
    assert.throws(() => resolveConfig("base-sepolia", { ...env, CCTP_FEE_CAP_FLAT: "1000001" }), /exceeds/);
    assert.throws(() => resolveConfig("base-sepolia", { ...env, CCTP_FEE_CAP_BPS: "1.5" }), /integer/);
    assert.throws(() => resolveConfig("base-sepolia", { ...env, CCTP_GATEWAY_PAUSER: "0xnope" }), /not an address/);
  });
});
