"use strict";
// Base mainnet fork test for AgentPactCctpGateway against the REAL Circle CCTP v2
// contracts, Base USDC and the deployed AgentPactEscrowV3. Read-only against the
// public RPC; nothing is broadcast to any live network.
//
// Skipped automatically when the RPC is unreachable. RPC: BASE_RPC_URL, else the
// public https://mainnet.base.org. Set CCTP_FORK_TEST=0 to skip explicitly.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const BASE_CHAIN_ID = 8453n;
const ADDR = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002",
  escrowV3: "0x1cc92210988522a06d9950241B32750f82005eb7",
  hashPreimagePredicate: "0x542535b7804E54877E5cd45695a3D6d50182D976",
};
const ETH_USDC_B32 = ethers.zeroPadValue("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 32);
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

const CCTP_ABI = [
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
  "function messageBodyVersion() view returns (uint32)",
  "function localMessageTransmitter() view returns (address)",
  "function localMinter() view returns (address)",
  "function remoteTokenMessengers(uint32) view returns (bytes32)",
  "function getLocalToken(uint32,bytes32) view returns (address)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
];
const USDC_ABI = [
  "function mint(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const ESCROW_ABI = [
  "function usdc() view returns (address)",
  "function predicateRegistry() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function createIntent(uint8,address,bytes,address,uint256,uint64) returns (bytes32)",
  "event IntentCreated(bytes32 indexed intentId, uint8 class, address indexed buyer, address indexed sellerTarget, address verifier, uint256 maxPrice, uint64 expiresAt)",
];

async function rpcReachable(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await res.json();
    return BigInt(j.result) === BASE_CHAIN_ID ? null : `unexpected chainId ${j.result}`;
  } catch (e) {
    return `unreachable: ${e.message}`;
  }
}

describe("AgentPactCctpGateway — Base mainnet fork", function () {
  this.timeout(300_000);
  const url = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  let gw;
  let forked = false;

  before(async function () {
    if (process.env.CCTP_FORK_TEST === "0") {
      console.log("      [fork] skipped: CCTP_FORK_TEST=0");
      this.skip();
    }
    const why = await rpcReachable(url);
    if (why) {
      console.log(`      [fork] skipped: Base RPC ${why}`);
      this.skip();
    }
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
    forked = true;
    const [deployer] = await ethers.getSigners();
    gw = await (await ethers.getContractFactory("AgentPactCctpGateway")).connect(deployer).deploy(
      ADDR.usdc, ADDR.messageTransmitterV2, ADDR.tokenMessengerV2, ADDR.escrowV3, ethers.ZeroAddress, 100, 250_000
    );
  });

  after(async function () {
    if (forked) await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("deploys against the real CCTP v2 + USDC + EscrowV3 and reads compatible versions", async function () {
    const mt = new ethers.Contract(ADDR.messageTransmitterV2, CCTP_ABI, ethers.provider);
    const tm = new ethers.Contract(ADDR.tokenMessengerV2, CCTP_ABI, ethers.provider);
    expect(await gw.localDomain()).to.equal(6n);
    expect(await mt.localDomain()).to.equal(6n);
    expect(await mt.version()).to.equal(await gw.MESSAGE_VERSION());
    expect(await tm.messageBodyVersion()).to.equal(await gw.BURN_MESSAGE_VERSION());
    expect(await tm.localMessageTransmitter()).to.equal(ADDR.messageTransmitterV2);
    const minterAddr = await tm.localMinter();
    expect(minterAddr).to.equal(ADDR.tokenMinterV2);
    const minter = new ethers.Contract(minterAddr, CCTP_ABI, ethers.provider);
    // Ethereum USDC burned on domain 0 mints Base USDC: the gateway's burn-token check.
    expect(await minter.getLocalToken(0, ETH_USDC_B32)).to.equal(ADDR.usdc);
    expect(await tm.remoteTokenMessengers(0)).to.not.equal(ethers.ZeroHash);
    expect(await tm.remoteTokenMessengers(5)).to.not.equal(ethers.ZeroHash);
  });

  it("reaches the escrow's predicate registry", async function () {
    const escrow = new ethers.Contract(ADDR.escrowV3, ESCROW_ABI, ethers.provider);
    expect(await escrow.usdc()).to.equal(ADDR.usdc);
    const registry = new ethers.Contract(await escrow.predicateRegistry(), ["function isApproved(address) view returns (bool)"], ethers.provider);
    expect(await registry.isApproved(ADDR.hashPreimagePredicate)).to.equal(true);
    expect(await registry.isApproved(await gw.getAddress())).to.equal(false);
  });

  it("pre-mint guards revert before the real transmitter; a forged attestation is rejected by it", async function () {
    const gwAddr = await gw.getAddress();
    const pack = (mintRecipient) => ethers.solidityPacked(
      ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32",
        "uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
      [1, 0, 6, ethers.id("fork-nonce"), ethers.zeroPadValue(ADDR.tokenMessengerV2, 32),
        ethers.zeroPadValue(ADDR.tokenMessengerV2, 32), ethers.zeroPadValue(gwAddr, 32), 1000, 2000,
        1, ETH_USDC_B32, mintRecipient, 1_000_000n, ethers.zeroPadValue("0x1234", 32), 0, 0, 0, "0x01"]
    );
    const other = ethers.zeroPadValue("0x00000000000000000000000000000000000Bad00", 32);
    await expect(gw.relayDeposit(pack(other), "0x")).to.be.revertedWithCustomError(gw, "MintRecipientNotGateway");
    // All gateway checks pass; the real MessageTransmitterV2 rejects the attestation.
    await expect(gw.relayDeposit(pack(ethers.zeroPadValue(gwAddr, 32)), "0x" + "11".repeat(65))).to.be.reverted;
  });

  it("claimAndForward burns a real EscrowV3 seller share through the real TokenMessengerV2 with the Forwarding hook", async function () {
    const gwAddr = await gw.getAddress();
    const [, buyer] = await ethers.getSigners();
    // Fund the buyer by minting as the CCTP TokenMinterV2 (a USDC minter).
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [ADDR.tokenMinterV2] });
    await network.provider.request({ method: "hardhat_setBalance", params: [ADDR.tokenMinterV2, "0xDE0B6B3A7640000"] });
    const minterSigner = await ethers.getSigner(ADDR.tokenMinterV2);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, ethers.provider);
    await usdc.connect(minterSigner).mint(buyer.address, 5_000_000n);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [ADDR.tokenMinterV2] });

    const escrow = new ethers.Contract(ADDR.escrowV3, ESCROW_ABI, ethers.provider);
    await usdc.connect(buyer).approve(ADDR.escrowV3, 5_000_000n);
    const plaintext = ethers.toUtf8Bytes("fork deliverable");
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.keccak256(plaintext)]);
    const block = await ethers.provider.getBlock("latest");
    const rc = await (await escrow.connect(buyer).createIntent(
      0, ADDR.hashPreimagePredicate, params, gwAddr, 5_000_000n, BigInt(block.timestamp) + 3600n
    )).wait();
    const intentId = rc.logs.map((l) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "IntentCreated").args.intentId;

    const recipient = ethers.zeroPadValue("0x00000000000000000000000000000000000Fa1d0", 32);
    await gw.connect(buyer).setPayoutRoute(intentId, 0, recipient);
    const bps = await escrow.platformFeeBps();
    const share = 5_000_000n - (5_000_000n * bps) / 10000n;

    const tx = await gw.claimAndForward(intentId, "0x", plaintext, 50_000n, 2000);
    const r = await tx.wait();
    await expect(tx).to.emit(gw, "CctpPayoutSent").withArgs(intentId, 0, recipient, share, 50_000n);
    const tmIface = new ethers.Interface(CCTP_ABI);
    const burn = r.logs.filter((l) => l.address === ADDR.tokenMessengerV2)
      .map((l) => { try { return tmIface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "DepositForBurn");
    expect(burn, "real DepositForBurn event").to.not.equal(undefined);
    expect(burn.args.burnToken).to.equal(ADDR.usdc);
    expect(burn.args.amount).to.equal(share);
    expect(burn.args.depositor).to.equal(gwAddr);
    expect(burn.args.mintRecipient).to.equal(recipient);
    expect(burn.args.destinationDomain).to.equal(0n);
    expect(burn.args.destinationCaller).to.equal(ethers.ZeroHash);
    expect(burn.args.maxFee).to.equal(50_000n);
    expect(burn.args.minFinalityThreshold).to.equal(2000n);
    expect(burn.args.hookData).to.equal(FORWARD_HOOK);
    expect(await usdc.balanceOf(gwAddr)).to.equal(0n);
  });
});
