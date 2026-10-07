"use strict";
// Drift guard: the ABI shipped in packages/escrow must equal the compiled one,
// and must expose the M1 interface other lanes code against (SHARED_CONTEXT §6).
const { expect } = require("chai");
const { artifacts } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");

describe("AgentPactCctpGateway ABI export", function () {
  it("packages/escrow/abi/AgentPactCctpGateway.json and src/cctp-gateway-abi.ts match the artifact", async function () {
    const { abi } = await artifacts.readArtifact("AgentPactCctpGateway");
    const json = JSON.parse(fs.readFileSync(path.join(root, "packages/escrow/abi/AgentPactCctpGateway.json"), "utf8"));
    expect(json).to.deep.equal(abi);
    const ts = fs.readFileSync(path.join(root, "packages/escrow/src/cctp-gateway-abi.ts"), "utf8");
    const literal = ts.slice(ts.indexOf("= ") + 2, ts.lastIndexOf(" as const"));
    expect(JSON.parse(literal)).to.deep.equal(abi);
  });

  it("exposes the locked M1 signatures", async function () {
    const { abi } = await artifacts.readArtifact("AgentPactCctpGateway");
    const { ethers } = require("hardhat");
    const iface = new ethers.Interface(abi);
    for (const sig of [
      "relayDeposit(bytes,bytes)",
      "refund(bytes32,uint256,uint32)",
      "setPayoutRoute(bytes32,uint32,bytes32)",
      "setPayoutRouteWithSig(bytes32,uint32,bytes32,uint256,bytes)",
      "claimAndForward(bytes32,bytes,bytes,uint256,uint32)",
      "retryRejectedRefund(bytes32,uint256,uint32)",
    ]) expect(iface.getFunction(sig), sig).to.not.equal(null);
    for (const sig of [
      "CctpDepositBound(bytes32,bytes32,uint32,bytes32,bytes32,uint256,uint256,bytes32)",
      "CctpDepositRejected(bytes32,uint8)",
      "CctpRefundSent(bytes32,uint32,bytes32,uint256,uint256)",
      "CctpPayoutSent(bytes32,uint32,bytes32,uint256,uint256)",
    ]) expect(iface.getEvent(sig), sig).to.not.equal(null);
  });
});
