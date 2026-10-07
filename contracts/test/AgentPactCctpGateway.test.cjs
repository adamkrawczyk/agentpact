"use strict";
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FEE_BPS = 1000n; // escrow platform fee 10%
const FEE_CAP_BPS = 100n; // gateway maxFee cap 1%
const FEE_CAP_FLAT = 250_000n; // or 0.25 USDC, whichever is larger
const BASE = 6;
const ETH = 0;
const SOL = 5;
const BURN = "0x000000000000000000000000000000000000dEaD";
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
const REMOTE_MESSENGER = ethers.zeroPadValue("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", 32);
const REMOTE_USDC_ETH = ethers.zeroPadValue("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 32);
const USDC = (n) => ethers.parseUnits(String(n), 6);
const b32 = (addr) => ethers.zeroPadValue(addr, 32);

const Reason = {
  MalformedHookData: 1,
  UnknownHookVersion: 2,
  Expired: 3,
  VerifierNotApproved: 4,
  Underfunded: 5,
  InvalidPayoutRoute: 6,
  ZeroDealRef: 7,
  DuplicateIntent: 8,
};
const Status = { None: 0n, Open: 1n, ClaimedA: 2n, CancelledByExpiry: 3n };

// ─────────────────────────────────────────────────────────────────────────────
// Message builders (layouts: contracts/cctp/CctpMessageV2.sol)
// ─────────────────────────────────────────────────────────────────────────────

const HOOK_TYPES = ["uint8", "bytes32", "address", "bytes", "address", "uint64", "uint256", "bytes32", "uint32", "bytes32"];

function encodeHook(h) {
  return ethers.AbiCoder.defaultAbiCoder().encode(HOOK_TYPES, [
    h.version ?? 1,
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

let nonceCounter = 1n;
function nextNonce() {
  return ethers.zeroPadValue(ethers.toBeHex(nonceCounter++), 32);
}

function burnMessage(ctx, o) {
  const body = ethers.solidityPacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [
      o.bodyVersion ?? 1,
      o.burnToken ?? REMOTE_USDC_ETH,
      o.mintRecipient ?? b32(ctx.gwAddr),
      o.amount,
      o.messageSender ?? b32(ctx.remoteBuyer),
      o.maxFee ?? 0n,
      o.feeExecuted ?? 0n,
      o.expirationBlock ?? 0n,
      o.hookData,
    ]
  );
  return ethers.solidityPacked(
    ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32", "bytes"],
    [
      o.version ?? 1,
      o.sourceDomain ?? ETH,
      o.destinationDomain ?? BASE,
      o.nonce ?? nextNonce(),
      o.sender ?? REMOTE_MESSENGER,
      o.recipient ?? b32(ctx.tmAddr),
      o.destinationCaller ?? b32(ctx.gwAddr),
      o.minFinality ?? 1000,
      o.finalityExecuted ?? 2000,
      body,
    ]
  );
}

function attest(message) {
  return ethers.keccak256(ethers.concat([ethers.toUtf8Bytes("mock-attestation"), message]));
}

function dealRef(uuid) {
  return ethers.keccak256(ethers.solidityPacked(["string", "string"], ["agentpact:deal:", uuid]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [platform, relayer, buyer, seller, pauser, stranger, walletOwner] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const hashPre = await (await ethers.getContractFactory("HashPreimagePredicate")).deploy();
  const unapproved = await (await ethers.getContractFactory("HashPreimagePredicate")).deploy();
  const registry = await (await ethers.getContractFactory("PredicateRegistry")).deploy([await hashPre.getAddress()]);
  const escrow = await (await ethers.getContractFactory("AgentPactEscrowV3")).deploy(
    await usdc.getAddress(), await registry.getAddress(), platform.address, BURN, FEE_BPS
  );

  const mt = await (await ethers.getContractFactory("MockMessageTransmitterV2")).deploy(BASE);
  const tm = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy(
    await mt.getAddress(), await usdc.getAddress()
  );
  await tm.setRemoteTokenMessenger(ETH, REMOTE_MESSENGER);
  await tm.setRemoteTokenMessenger(SOL, ethers.zeroPadValue("0x5050", 32));
  await tm.setLocalToken(ETH, REMOTE_USDC_ETH, await usdc.getAddress());

  const gw = await (await ethers.getContractFactory("AgentPactCctpGateway")).deploy(
    await usdc.getAddress(), await mt.getAddress(), await tm.getAddress(), await escrow.getAddress(),
    pauser.address, FEE_CAP_BPS, FEE_CAP_FLAT
  );

  await usdc.mint(buyer.address, USDC(10_000));
  await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);

  const ctx = {
    platform, relayer, buyer, seller, pauser, stranger, walletOwner,
    usdc, hashPre, unapproved, registry, escrow, mt, tm, gw,
    gwAddr: await gw.getAddress(),
    tmAddr: await tm.getAddress(),
    escrowAddr: await escrow.getAddress(),
    remoteBuyer: "0x00000000000000000000000000000000000B0Ee0",
    refundTo: b32("0x00000000000000000000000000000000000Ef0Ed"),
    payoutTo: b32("0x00000000000000000000000000000000000Fa1d0"),
  };
  return ctx;
}

async function defaultHook(ctx, o = {}) {
  const plaintext = ethers.toUtf8Bytes(o.plaintext ?? "the deliverable");
  const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.keccak256(plaintext)]);
  const now = BigInt(await time.latest());
  const crossChain = o.crossChain ?? false;
  const h = {
    version: 1,
    dealRef: dealRef(o.deal ?? "11111111-1111-1111-1111-111111111111"),
    verifier: await ctx.hashPre.getAddress(),
    params,
    sellerTarget: crossChain ? ctx.gwAddr : ctx.seller.address,
    expiresAt: now + 3600n,
    price: USDC(10),
    refundRecipient: ctx.refundTo,
    payoutDomain: crossChain ? SOL : BASE,
    payoutRecipient: crossChain ? ctx.payoutTo : b32(ctx.seller.address),
    ...o.hook,
  };
  return { h, plaintext };
}

/** Relay a deposit; returns { tx, receipt, message, intentId (from event or 0) } */
async function relay(ctx, { h, amount = USDC(10), feeExecuted = 0n, ...msg }) {
  const message = burnMessage(ctx, { amount, feeExecuted, maxFee: feeExecuted, hookData: encodeHook(h), ...msg });
  const tx = await ctx.gw.connect(ctx.relayer).relayDeposit(message, attest(message));
  const receipt = await tx.wait();
  const bound = receipt.logs
    .filter((l) => l.address === ctx.gwAddr)
    .map((l) => ctx.gw.interface.parseLog(l))
    .find((e) => e && e.name === "CctpDepositBound");
  return { tx, receipt, message, intentId: bound ? bound.args.intentId : ethers.ZeroHash };
}

function gwEvents(ctx, receipt, name) {
  return receipt.logs
    .filter((l) => l.address === ctx.gwAddr)
    .map((l) => ctx.gw.interface.parseLog(l))
    .filter((e) => e && e.name === name);
}

async function lastBurn(ctx) {
  const n = await ctx.tm.burnCount();
  return n === 0n ? null : ctx.tm.burns(n - 1n);
}

async function expectGatewayEmpty(ctx) {
  expect(await ctx.usdc.balanceOf(ctx.gwAddr)).to.equal(0n);
  expect(await ctx.usdc.allowance(ctx.gwAddr, ctx.escrowAddr)).to.equal(0n);
  expect(await ctx.usdc.allowance(ctx.gwAddr, ctx.tmAddr)).to.equal(0n);
}

/** Base buyer funds an intent targeted at the gateway (cross-chain payout). */
async function baseFundedGatewayIntent(ctx, buyerSigner = ctx.buyer, price = USDC(20)) {
  const plaintext = ethers.toUtf8Bytes("base-funded deliverable");
  const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.keccak256(plaintext)]);
  const expiresAt = BigInt(await time.latest()) + 3600n;
  const verifier = await ctx.hashPre.getAddress();
  const rc = await (await ctx.escrow.connect(buyerSigner).createIntent(0, verifier, params, ctx.gwAddr, price, expiresAt)).wait();
  return { intentId: createdIntentId(ctx, rc), plaintext, price, expiresAt };
}

function createdIntentId(ctx, receipt) {
  const ev = receipt.logs
    .filter((l) => l.address === ctx.escrowAddr)
    .map((l) => ctx.escrow.interface.parseLog(l))
    .find((e) => e && e.name === "IntentCreated");
  return ev.args.intentId;
}

async function signRoute(ctx, signer, intentId, domain, recipient, deadline) {
  const domainData = {
    name: "AgentPactCctpGateway",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: ctx.gwAddr,
  };
  const types = {
    SetPayoutRoute: [
      { name: "intentId", type: "bytes32" },
      { name: "domain", type: "uint32" },
      { name: "recipient", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  };
  return signer.signTypedData(domainData, types, { intentId, domain, recipient, deadline });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentPactCctpGateway", function () {
  describe("constructor", function () {
    it("binds immutables and the escrow's USDC / CCTP wiring", async function () {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.gw.localDomain()).to.equal(BASE);
      expect(await ctx.gw.usdc()).to.equal(await ctx.usdc.getAddress());
      expect(await ctx.gw.escrow()).to.equal(ctx.escrowAddr);
      expect(await ctx.gw.feeCapBps()).to.equal(FEE_CAP_BPS);
      expect(await ctx.gw.feeCapFlat()).to.equal(FEE_CAP_FLAT);
      expect(await ctx.gw.FORWARD_HOOK_DATA()).to.equal(FORWARD_HOOK);
    });

    it("rejects a transmitter on another domain, mismatched CCTP pair, foreign USDC, zero address and fee caps above the hard limits", async function () {
      const ctx = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("AgentPactCctpGateway");
      const u = await ctx.usdc.getAddress();
      const mt = await ctx.mt.getAddress();
      const ethMt = await (await ethers.getContractFactory("MockMessageTransmitterV2")).deploy(ETH);
      const otherTm = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy(await ethMt.getAddress(), u);
      const otherUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();

      await expect(F.deploy(u, await ethMt.getAddress(), ctx.tmAddr, ctx.escrowAddr, ethers.ZeroAddress, 100, 0))
        .to.be.revertedWithCustomError(ctx.gw, "WrongLocalDomain");
      await expect(F.deploy(u, mt, await otherTm.getAddress(), ctx.escrowAddr, ethers.ZeroAddress, 100, 0))
        .to.be.revertedWithCustomError(ctx.gw, "MismatchedCctpContracts");
      await expect(F.deploy(await otherUsdc.getAddress(), mt, ctx.tmAddr, ctx.escrowAddr, ethers.ZeroAddress, 100, 0))
        .to.be.revertedWithCustomError(ctx.gw, "MismatchedUsdc");
      await expect(F.deploy(ethers.ZeroAddress, mt, ctx.tmAddr, ctx.escrowAddr, ethers.ZeroAddress, 100, 0))
        .to.be.revertedWithCustomError(ctx.gw, "ZeroAddress");
      await expect(F.deploy(u, mt, ctx.tmAddr, ctx.escrowAddr, ethers.ZeroAddress, 101, 0))
        .to.be.revertedWithCustomError(ctx.gw, "FeeCapTooHigh");
      await expect(F.deploy(u, mt, ctx.tmAddr, ctx.escrowAddr, ethers.ZeroAddress, 100, 1_000_001))
        .to.be.revertedWithCustomError(ctx.gw, "FeeCapTooHigh");
    });
  });

  describe("relayDeposit — valid deposit", function () {
    it("binds the mint to a Class-A intent with every event field set", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const nonce = nextNonce();
      const escrowBefore = await ctx.usdc.balanceOf(ctx.escrowAddr);
      const message = burnMessage(ctx, { amount: USDC(10), nonce, hookData: encodeHook(h) });

      const expectedId = await ctx.gw.connect(ctx.relayer).relayDeposit.staticCall(message, attest(message));
      expect(expectedId).to.not.equal(ethers.ZeroHash);
      const tx = await ctx.gw.connect(ctx.relayer).relayDeposit(message, attest(message));
      const receipt = await tx.wait();
      const [bound] = gwEvents(ctx, receipt, "CctpDepositBound");
      const intentId = bound.args.intentId;

      await expect(tx).to.emit(ctx.gw, "CctpDepositBound").withArgs(
        intentId, h.dealRef, ETH, b32(ctx.remoteBuyer), ctx.refundTo, USDC(10), 0n, nonce
      );
      await expect(tx).to.emit(ctx.escrow, "IntentCreated").withArgs(
        intentId, 0, ctx.gwAddr, ctx.seller.address, h.verifier, USDC(10), h.expiresAt
      );
      const it = await ctx.escrow.getIntent(intentId);
      expect(it.status).to.equal(Status.Open);
      expect(it.buyer).to.equal(ctx.gwAddr);
      expect(it.sellerTarget).to.equal(ctx.seller.address);
      expect(it.lockedTotal).to.equal(USDC(10));
      expect(await ctx.escrow.predicateParams(intentId)).to.equal(h.params);

      const d = await ctx.gw.deposits(intentId);
      expect(d.dealRef).to.equal(h.dealRef);
      expect(d.sourceDomain).to.equal(ETH);
      expect(d.refundRecipient).to.equal(ctx.refundTo);
      expect(d.payoutDomain).to.equal(BASE);
      expect(d.payoutRecipient).to.equal(b32(ctx.seller.address));
      expect(d.bound).to.equal(true);
      expect(d.refunded).to.equal(false);

      expect(await ctx.usdc.balanceOf(ctx.escrowAddr) - escrowBefore).to.equal(USDC(10));
      expect(await ctx.mt.usedNonces(nonce)).to.equal(1n);
      await expectGatewayEmpty(ctx);
    });

    it("locks amount - feeExecuted (fast transfer) and accepts net >= price", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const { tx, intentId } = await relay(ctx, {
        h, amount: USDC(10) + 1_300n, feeExecuted: 1_300n, finalityExecuted: 1000,
      });
      await expect(tx).to.emit(ctx.gw, "CctpDepositBound").withArgs(
        intentId, h.dealRef, ETH, b32(ctx.remoteBuyer), ctx.refundTo, USDC(10) + 1_300n, 1_300n, anyNonce()
      );
      expect((await ctx.escrow.getIntent(intentId)).maxPrice).to.equal(USDC(10));
      expect(await ctx.usdc.balanceOf(await ctx.tm.feeRecipient())).to.equal(1_300n);
      await expectGatewayEmpty(ctx);
    });

    it("cross-chain payout deposit takes its payout route from hookData", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { crossChain: true });
      const { tx, intentId } = await relay(ctx, { h });
      await expect(tx).to.emit(ctx.gw, "PayoutRouteSet").withArgs(intentId, SOL, ctx.payoutTo, ctx.gwAddr);
      const r = await ctx.gw.payoutRoutes(intentId);
      expect(r.domain).to.equal(SOL);
      expect(r.recipient).to.equal(ctx.payoutTo);
      expect((await ctx.escrow.getIntent(intentId)).sellerTarget).to.equal(ctx.gwAddr);
    });
  });

  describe("relayDeposit — pre-mint guards (revert; message stays receivable)", function () {
    it("replayed message reverts in the transmitter and creates no second intent", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const { message } = await relay(ctx, { h });
      const escrowBal = await ctx.usdc.balanceOf(ctx.escrowAddr);
      await expect(ctx.gw.relayDeposit(message, attest(message))).to.be.revertedWith("Nonce already used");
      expect(await ctx.usdc.balanceOf(ctx.escrowAddr)).to.equal(escrowBal);
      await expectGatewayEmpty(ctx);
    });

    it("mint to a different recipient reverts before the mint", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const nonce = nextNonce();
      const message = burnMessage(ctx, {
        amount: USDC(10), nonce, hookData: encodeHook(h), mintRecipient: b32(ctx.stranger.address),
      });
      await expect(ctx.gw.relayDeposit(message, attest(message)))
        .to.be.revertedWithCustomError(ctx.gw, "MintRecipientNotGateway").withArgs(b32(ctx.stranger.address));
      expect(await ctx.mt.usedNonces(nonce)).to.equal(0n);
      expect(await ctx.usdc.balanceOf(ctx.stranger.address)).to.equal(0n);
    });

    it("burn token that is not local USDC's remote counterpart reverts before the mint", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const fake = b32("0x00000000000000000000000000000000000BAD00");
      const message = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h), burnToken: fake });
      await expect(ctx.gw.relayDeposit(message, attest(message)))
        .to.be.revertedWithCustomError(ctx.gw, "BurnTokenNotUsdc").withArgs(fake);
      // Same token bytes, but claimed from a domain where it maps to nothing.
      const message2 = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h), sourceDomain: SOL });
      await expect(ctx.gw.relayDeposit(message2, attest(message2)))
        .to.be.revertedWithCustomError(ctx.gw, "BurnTokenNotUsdc");
    });

    it("non-burn message, wrong destination domain, wrong versions and short messages revert", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const hookData = encodeHook(h);
      const cases = [
        [{ recipient: b32(ctx.stranger.address) }, "NotABurnMessage"],
        [{ destinationDomain: 3 }, "WrongDestinationDomain"],
        [{ version: 0 }, "UnsupportedMessageVersion"],
        [{ bodyVersion: 2 }, "UnsupportedBurnMessageVersion"],
      ];
      for (const [o, err] of cases) {
        const m = burnMessage(ctx, { amount: USDC(10), hookData, ...o });
        await expect(ctx.gw.relayDeposit(m, attest(m))).to.be.revertedWithCustomError(ctx.gw, err);
      }
      await expect(ctx.gw.relayDeposit("0x1234", "0x")).to.be.revertedWithCustomError(ctx.gw, "CctpMessageTooShort");
    });

    it("a tampered message fails attestation in the transmitter", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const m = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h) });
      const forged = burnMessage(ctx, { amount: USDC(1000), hookData: encodeHook(h) });
      await expect(ctx.gw.relayDeposit(forged, attest(m))).to.be.revertedWith("Invalid attestation");
    });
  });

  describe("relayDeposit — business-invalid deposits are refunded, never reverted", function () {
    async function expectRejected(ctx, { h, amount = USDC(10), reason, refundTo, sourceDomain = ETH, ...msg }) {
      const escrowBal = await ctx.usdc.balanceOf(ctx.escrowAddr);
      const burnsBefore = await ctx.tm.burnCount();
      const message = burnMessage(ctx, { amount, sourceDomain, hookData: encodeHook(h), ...msg });
      const ret = await ctx.gw.relayDeposit.staticCall(message, attest(message));
      expect(ret).to.equal(ethers.ZeroHash);
      const tx = await ctx.gw.relayDeposit(message, attest(message));
      const messageHash = ethers.keccak256(message);
      const cap = await ctx.gw.feeCap(amount);
      await expect(tx).to.emit(ctx.gw, "CctpDepositRejected").withArgs(messageHash, reason);
      await expect(tx).to.emit(ctx.gw, "CctpRejectRefundSent").withArgs(messageHash, sourceDomain, refundTo, amount, cap);
      await expect(tx).to.not.emit(ctx.gw, "CctpDepositBound");
      expect(await ctx.tm.burnCount()).to.equal(burnsBefore + 1n);
      const b = await lastBurn(ctx);
      expect(b.amount).to.equal(amount);
      expect(b.destinationDomain).to.equal(sourceDomain);
      expect(b.mintRecipient).to.equal(refundTo);
      expect(b.burnToken).to.equal(await ctx.usdc.getAddress());
      expect(b.destinationCaller).to.equal(ethers.ZeroHash);
      expect(b.maxFee).to.equal(cap);
      expect(b.minFinalityThreshold).to.equal(2000);
      expect(b.hookData).to.equal(FORWARD_HOOK);
      expect(await ctx.usdc.balanceOf(ctx.escrowAddr)).to.equal(escrowBal);
      await expectGatewayEmpty(ctx);
    }

    it("net < price → Underfunded, refund burn to (sourceDomain, refundRecipient)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h: hp } = await defaultHook(ctx, { hook: { price: USDC(10) + 1n } });
      await expectRejected(ctx, { h: hp, amount: USDC(10), reason: Reason.Underfunded, refundTo: ctx.refundTo });
    });

    it("price met by amount but not by net (fast fee) → Underfunded, refunds the net", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const message = burnMessage(ctx, {
        amount: USDC(10), feeExecuted: 1n, maxFee: 1n, finalityExecuted: 1000, hookData: encodeHook(h),
      });
      const tx = await ctx.gw.relayDeposit(message, attest(message));
      await expect(tx).to.emit(ctx.gw, "CctpDepositRejected").withArgs(ethers.keccak256(message), Reason.Underfunded);
      expect((await lastBurn(ctx)).amount).to.equal(USDC(10) - 1n);
      await expectGatewayEmpty(ctx);
    });

    it("zero price → Underfunded", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { price: 0n } });
      await expectRejected(ctx, { h, reason: Reason.Underfunded, refundTo: ctx.refundTo });
    });

    it("unapproved verifier → VerifierNotApproved", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { verifier: await ctx.unapproved.getAddress() } });
      await expectRejected(ctx, { h, reason: Reason.VerifierNotApproved, refundTo: ctx.refundTo });
    });

    it("expired (expiresAt <= now) → Expired", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { expiresAt: BigInt(await time.latest()) } });
      await expectRejected(ctx, { h, reason: Reason.Expired, refundTo: ctx.refundTo });
    });

    it("unknown hook version → UnknownHookVersion, refunded to messageSender", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { version: 2 } });
      await expectRejected(ctx, { h, reason: Reason.UnknownHookVersion, refundTo: b32(ctx.remoteBuyer) });
    });

    it("malformed / empty / Forwarding-Service hookData → refunded to messageSender", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const good = encodeHook(h);
      const variants = [
        ["0x", Reason.MalformedHookData],
        [FORWARD_HOOK, Reason.UnknownHookVersion],
        [ethers.dataSlice(good, 0, 351), Reason.MalformedHookData], // truncated
        [ethers.concat([good, "0x00"]), Reason.MalformedHookData], // trailing byte
        [ethers.concat([ethers.dataSlice(good, 0, 64), ethers.zeroPadValue("0x01", 12), ethers.dataSlice(good, 76)]), Reason.MalformedHookData], // dirty address
        [ethers.concat([ethers.dataSlice(good, 0, 96), ethers.zeroPadValue("0x0160", 32), ethers.dataSlice(good, 128)]), Reason.MalformedHookData], // non-canonical offset
      ];
      for (const [hookData, reason] of variants) {
        const message = burnMessage(ctx, { amount: USDC(10), hookData });
        const tx = await ctx.gw.relayDeposit(message, attest(message));
        await expect(tx).to.emit(ctx.gw, "CctpDepositRejected").withArgs(ethers.keccak256(message), reason);
        const b = await lastBurn(ctx);
        expect(b.mintRecipient).to.equal(b32(ctx.remoteBuyer));
        expect(b.amount).to.equal(USDC(10));
        await expectGatewayEmpty(ctx);
      }
    });

    it("zero refundRecipient falls back to messageSender", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { refundRecipient: ethers.ZeroHash, price: USDC(11) } });
      await expectRejected(ctx, { h, reason: Reason.Underfunded, refundTo: b32(ctx.remoteBuyer) });
    });

    it("inconsistent payout route → InvalidPayoutRoute", async function () {
      const ctx = await loadFixture(deployFixture);
      const bad = [
        { sellerTarget: ethers.ZeroAddress, payoutRecipient: ethers.ZeroHash }, // same-chain, no seller
        { payoutRecipient: b32(ctx.stranger.address) }, // same-chain, recipient != sellerTarget
        { sellerTarget: ctx.gwAddr, payoutRecipient: b32(ctx.gwAddr) }, // same-chain to the gateway itself
        { payoutDomain: SOL, sellerTarget: ctx.seller.address, payoutRecipient: ctx.payoutTo }, // x-chain, target not gateway
        { payoutDomain: SOL, sellerTarget: ctx.gwAddr, payoutRecipient: ethers.ZeroHash }, // x-chain, no recipient
      ];
      for (const hook of bad) {
        const { h } = await defaultHook(ctx, { hook });
        await expectRejected(ctx, { h, reason: Reason.InvalidPayoutRoute, refundTo: ctx.refundTo });
      }
    });

    it("zero dealRef → ZeroDealRef", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { dealRef: ethers.ZeroHash } });
      await expectRejected(ctx, { h, reason: Reason.ZeroDealRef, refundTo: ctx.refundTo });
    });

    it("duplicate intent id (same hook, same net, same block) → second is refunded, no stuck funds", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const m1 = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h) });
      const m2 = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h) });
      await ethers.provider.send("evm_setAutomine", [false]);
      let tx1, tx2;
      try {
        tx1 = await ctx.gw.connect(ctx.relayer).relayDeposit(m1, attest(m1), { gasLimit: 2_000_000 });
        tx2 = await ctx.gw.connect(ctx.relayer).relayDeposit(m2, attest(m2), { gasLimit: 2_000_000 });
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
      const r1 = await tx1.wait();
      const r2 = await tx2.wait();
      expect(r1.blockNumber).to.equal(r2.blockNumber);
      expect(gwEvents(ctx, r1, "CctpDepositBound")).to.have.length(1);
      const [rej] = gwEvents(ctx, r2, "CctpDepositRejected");
      expect(rej.args.messageHash).to.equal(ethers.keccak256(m2));
      expect(rej.args.reason).to.equal(Reason.DuplicateIntent);
      const [sent] = gwEvents(ctx, r2, "CctpRejectRefundSent");
      expect(sent.args.amount).to.equal(USDC(10));
      expect(sent.args.recipient).to.equal(ctx.refundTo);
      await expectGatewayEmpty(ctx);
    });

    it("a failing refund burn parks the funds (no revert after the mint) and anyone can re-send them", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { price: USDC(50) } });
      await ctx.tm.setFailBurns(true);
      const message = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h) });
      const messageHash = ethers.keccak256(message);
      const tx = await ctx.gw.relayDeposit(message, attest(message));
      await expect(tx).to.emit(ctx.gw, "CctpDepositRejected").withArgs(messageHash, Reason.Underfunded);
      await expect(tx).to.emit(ctx.gw, "CctpRejectRefundPending").withArgs(messageHash, ETH, ctx.refundTo, USDC(10));
      expect(await ctx.usdc.balanceOf(ctx.gwAddr)).to.equal(USDC(10));
      expect(await ctx.usdc.allowance(ctx.gwAddr, ctx.tmAddr)).to.equal(0n);
      const p = await ctx.gw.pendingRejectRefunds(messageHash);
      expect(p.amount).to.equal(USDC(10));

      await expect(ctx.gw.connect(ctx.stranger).retryRejectedRefund(messageHash, 0, 2000)).to.be.revertedWith("Burns failing (mock)");
      await ctx.tm.setFailBurns(false);
      await expect(ctx.gw.connect(ctx.stranger).retryRejectedRefund(messageHash, USDC(1), 2000))
        .to.be.revertedWithCustomError(ctx.gw, "MaxFeeTooHigh");
      await expect(ctx.gw.connect(ctx.stranger).retryRejectedRefund(messageHash, 0, 2000))
        .to.emit(ctx.gw, "CctpRejectRefundSent").withArgs(messageHash, ETH, ctx.refundTo, USDC(10), 0);
      await expectGatewayEmpty(ctx);
      await expect(ctx.gw.retryRejectedRefund(messageHash, 0, 2000)).to.be.revertedWithCustomError(ctx.gw, "NothingPending");
    });
  });

  describe("refund", function () {
    it("after expiry burns the locked amount back to (sourceDomain, refundRecipient); once only", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const { intentId } = await relay(ctx, { h });
      await expect(ctx.gw.refund(intentId, 0, 2000)).to.be.revertedWith("Escrow: not expired");
      await time.increaseTo(h.expiresAt);
      const tx = ctx.gw.connect(ctx.stranger).refund(intentId, USDC(10) / 100n, 1000);
      await expect(tx).to.emit(ctx.gw, "CctpRefundSent").withArgs(intentId, ETH, ctx.refundTo, USDC(10), USDC(10) / 100n);
      await expect(tx).to.emit(ctx.escrow, "IntentExpired").withArgs(intentId);
      const b = await lastBurn(ctx);
      expect(b.amount).to.equal(USDC(10));
      expect(b.destinationDomain).to.equal(ETH);
      expect(b.mintRecipient).to.equal(ctx.refundTo);
      expect(b.minFinalityThreshold).to.equal(1000);
      expect(b.hookData).to.equal(FORWARD_HOOK);
      expect((await ctx.gw.deposits(intentId)).refunded).to.equal(true);
      await expectGatewayEmpty(ctx);
      await expect(ctx.gw.refund(intentId, 0, 2000)).to.be.revertedWithCustomError(ctx.gw, "AlreadyRefunded");
    });

    it("a valid deposit with zero refundRecipient binds messageSender, so the refund stays deliverable", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { hook: { refundRecipient: ethers.ZeroHash } });
      const { tx, intentId } = await relay(ctx, { h });
      await expect(tx).to.emit(ctx.gw, "CctpDepositBound").withArgs(
        intentId, h.dealRef, ETH, b32(ctx.remoteBuyer), b32(ctx.remoteBuyer), USDC(10), 0n, anyNonce()
      );
      expect((await ctx.gw.deposits(intentId)).refundRecipient).to.equal(b32(ctx.remoteBuyer));
      await time.increaseTo(h.expiresAt);
      await expect(ctx.gw.refund(intentId, 0, 2000))
        .to.emit(ctx.gw, "CctpRefundSent").withArgs(intentId, ETH, b32(ctx.remoteBuyer), USDC(10), 0);
      await expectGatewayEmpty(ctx);
    });

    it("forwards a refund that a third party already pulled from the escrow", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const { intentId } = await relay(ctx, { h });
      await time.increaseTo(h.expiresAt);
      await ctx.escrow.connect(ctx.stranger).refundExpiredIntent(intentId);
      expect(await ctx.usdc.balanceOf(ctx.gwAddr)).to.equal(USDC(10));
      await expect(ctx.gw.refund(intentId, 0, 2000))
        .to.emit(ctx.gw, "CctpRefundSent").withArgs(intentId, ETH, ctx.refundTo, USDC(10), 0);
      await expectGatewayEmpty(ctx);
    });

    it("unknown intent and claimed intent are not refundable", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.gw.refund(ethers.ZeroHash, 0, 2000)).to.be.revertedWithCustomError(ctx.gw, "UnknownDeposit");
      const { h, plaintext } = await defaultHook(ctx);
      const { intentId } = await relay(ctx, { h });
      await ctx.escrow.claimIntentForSeller(intentId, "0x", plaintext);
      await time.increaseTo(h.expiresAt);
      await expect(ctx.gw.refund(intentId, 0, 2000)).to.be.revertedWithCustomError(ctx.gw, "NotRefundable");
    });
  });

  describe("fee caps", function () {
    it("maxFee is capped at max(1% of amount, flat) and always < amount; finality must be 1000..2000", async function () {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.gw.feeCap(USDC(100))).to.equal(USDC(1));
      expect(await ctx.gw.feeCap(USDC(10))).to.equal(FEE_CAP_FLAT);
      expect(await ctx.gw.feeCap(100_000n)).to.equal(99_999n);
      expect(await ctx.gw.feeCap(0n)).to.equal(0n);

      const { h } = await defaultHook(ctx, { hook: { price: USDC(100) } });
      const { intentId } = await relay(ctx, { h, amount: USDC(100) });
      await time.increaseTo(h.expiresAt);
      await expect(ctx.gw.refund(intentId, USDC(1) + 1n, 2000))
        .to.be.revertedWithCustomError(ctx.gw, "MaxFeeTooHigh").withArgs(USDC(1) + 1n, USDC(1));
      await expect(ctx.gw.refund(intentId, 0, 999)).to.be.revertedWithCustomError(ctx.gw, "BadFinalityThreshold");
      await expect(ctx.gw.refund(intentId, 0, 2001)).to.be.revertedWithCustomError(ctx.gw, "BadFinalityThreshold");
      await expect(ctx.gw.refund(intentId, USDC(1), 2000)).to.emit(ctx.gw, "CctpRefundSent");
    });
  });

  describe("payout routes", function () {
    it("Base-funded intent: only the buyer can set the route, once", async function () {
      const ctx = await loadFixture(deployFixture);
      const { intentId } = await baseFundedGatewayIntent(ctx);
      await expect(ctx.gw.connect(ctx.stranger).setPayoutRoute(intentId, SOL, ctx.payoutTo))
        .to.be.revertedWithCustomError(ctx.gw, "NotIntentBuyer");
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, BASE, ctx.payoutTo))
        .to.be.revertedWithCustomError(ctx.gw, "InvalidRoute");
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, SOL, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ctx.gw, "InvalidRoute");
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, SOL, ctx.payoutTo))
        .to.emit(ctx.gw, "PayoutRouteSet").withArgs(intentId, SOL, ctx.payoutTo, ctx.buyer.address);
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, ETH, ctx.payoutTo))
        .to.be.revertedWithCustomError(ctx.gw, "PayoutRouteAlreadySet");
    });

    it("gasless: a valid EIP-712 signature from the buyer sets the route; others, expired or replayed do not", async function () {
      const ctx = await loadFixture(deployFixture);
      const { intentId } = await baseFundedGatewayIntent(ctx);
      const deadline = BigInt(await time.latest()) + 600n;
      const forged = await signRoute(ctx, ctx.stranger, intentId, SOL, ctx.payoutTo, deadline);
      await expect(ctx.gw.connect(ctx.relayer).setPayoutRouteWithSig(intentId, SOL, ctx.payoutTo, deadline, forged))
        .to.be.revertedWithCustomError(ctx.gw, "NotIntentBuyer");
      const sig = await signRoute(ctx, ctx.buyer, intentId, SOL, ctx.payoutTo, deadline);
      // Signature binds the recipient: swapping it fails.
      await expect(ctx.gw.connect(ctx.relayer).setPayoutRouteWithSig(intentId, SOL, b32(ctx.relayer.address), deadline, sig))
        .to.be.revertedWithCustomError(ctx.gw, "NotIntentBuyer");
      await expect(ctx.gw.connect(ctx.relayer).setPayoutRouteWithSig(intentId, SOL, ctx.payoutTo, deadline, sig))
        .to.emit(ctx.gw, "PayoutRouteSet").withArgs(intentId, SOL, ctx.payoutTo, ctx.buyer.address);
      await expect(ctx.gw.connect(ctx.relayer).setPayoutRouteWithSig(intentId, SOL, ctx.payoutTo, deadline, sig))
        .to.be.revertedWithCustomError(ctx.gw, "PayoutRouteAlreadySet");

      const { intentId: id2 } = await baseFundedGatewayIntent(ctx);
      const past = BigInt(await time.latest()) - 1n;
      const old = await signRoute(ctx, ctx.buyer, id2, SOL, ctx.payoutTo, past);
      await expect(ctx.gw.setPayoutRouteWithSig(id2, SOL, ctx.payoutTo, past, old))
        .to.be.revertedWithCustomError(ctx.gw, "SignatureExpired");
    });

    it("gasless: ERC-1271 contract-wallet buyer", async function () {
      const ctx = await loadFixture(deployFixture);
      const wallet = await (await ethers.getContractFactory("MockERC1271Wallet")).deploy(ctx.walletOwner.address);
      const walletAddr = await wallet.getAddress();
      await ctx.usdc.mint(walletAddr, USDC(20));
      await wallet.connect(ctx.walletOwner).approve(await ctx.usdc.getAddress(), ctx.escrowAddr, USDC(20));
      const plaintext = ethers.toUtf8Bytes("wallet deliverable");
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.keccak256(plaintext)]);
      const expiresAt = BigInt(await time.latest()) + 3600n;
      const data = ctx.escrow.interface.encodeFunctionData("createIntent", [
        0, await ctx.hashPre.getAddress(), params, ctx.gwAddr, USDC(20), expiresAt,
      ]);
      const rc = await (await wallet.connect(ctx.walletOwner).call(ctx.escrowAddr, data)).wait();
      const intentId = createdIntentId(ctx, rc);
      const deadline = BigInt(await time.latest()) + 600n;
      const sig = await signRoute(ctx, ctx.walletOwner, intentId, SOL, ctx.payoutTo, deadline);
      await expect(ctx.gw.setPayoutRouteWithSig(intentId, SOL, ctx.payoutTo, deadline, sig))
        .to.emit(ctx.gw, "PayoutRouteSet").withArgs(intentId, SOL, ctx.payoutTo, walletAddr);
    });

    it("route can only be set while the intent is Open (a buyer cannot redirect a share already claimed into the gateway)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { intentId, plaintext } = await baseFundedGatewayIntent(ctx);
      await ctx.escrow.connect(ctx.stranger).claimIntentForSeller(intentId, "0x", plaintext);
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, ETH, b32(ctx.buyer.address)))
        .to.be.revertedWithCustomError(ctx.gw, "NotClaimable");
    });

    it("intent not targeted at the gateway, and gateway-funded intents, cannot take a buyer route", async function () {
      const ctx = await loadFixture(deployFixture);
      const plaintext = ethers.toUtf8Bytes("x");
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.keccak256(plaintext)]);
      const expiresAt = BigInt(await time.latest()) + 3600n;
      const v = await ctx.hashPre.getAddress();
      const id = createdIntentId(ctx, await (await ctx.escrow.connect(ctx.buyer).createIntent(0, v, params, ctx.seller.address, USDC(1), expiresAt)).wait());
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(id, SOL, ctx.payoutTo))
        .to.be.revertedWithCustomError(ctx.gw, "NotGatewayPayout");

      const { h } = await defaultHook(ctx);
      const { intentId } = await relay(ctx, { h }); // same-chain payout; buyer of record = gateway
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, SOL, ctx.payoutTo))
        .to.be.revertedWithCustomError(ctx.gw, "NotIntentBuyer");
      const { h: hx } = await defaultHook(ctx, { crossChain: true, plaintext: "y" });
      const { intentId: xid } = await relay(ctx, { h: hx });
      await expect(ctx.gw.connect(ctx.buyer).setPayoutRoute(xid, ETH, ctx.payoutTo))
        .to.be.revertedWithCustomError(ctx.gw, "PayoutRouteAlreadySet");
    });
  });

  describe("claimAndForward", function () {
    it("forwards exactly the seller-share delta of a gateway-funded cross-chain intent", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h, plaintext } = await defaultHook(ctx, { crossChain: true });
      const { intentId } = await relay(ctx, { h, amount: USDC(10) });
      const share = USDC(10) - (USDC(10) * FEE_BPS) / 10000n;
      const platformBefore = await ctx.usdc.balanceOf(ctx.platform.address);
      const tx = ctx.gw.connect(ctx.relayer).claimAndForward(intentId, "0x", plaintext, 50_000n, 2000);
      await expect(tx).to.emit(ctx.gw, "CctpPayoutSent").withArgs(intentId, SOL, ctx.payoutTo, share, 50_000n);
      await expect(tx).to.emit(ctx.escrow, "IntentClaimedA").withArgs(intentId, ctx.gwAddr, share, USDC(1));
      const b = await lastBurn(ctx);
      expect(b.amount).to.equal(share);
      expect(b.destinationDomain).to.equal(SOL);
      expect(b.mintRecipient).to.equal(ctx.payoutTo);
      expect(b.destinationCaller).to.equal(ethers.ZeroHash);
      expect(b.hookData).to.equal(FORWARD_HOOK);
      expect(await ctx.usdc.balanceOf(ctx.platform.address) - platformBefore).to.equal(USDC(1));
      await expectGatewayEmpty(ctx);
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000))
        .to.be.revertedWithCustomError(ctx.gw, "AlreadyPaidOut");
    });

    it("forwards a Base-funded intent's share to the buyer-set route", async function () {
      const ctx = await loadFixture(deployFixture);
      const { intentId, plaintext, price } = await baseFundedGatewayIntent(ctx);
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000))
        .to.be.revertedWithCustomError(ctx.gw, "NoPayoutRoute");
      await ctx.gw.connect(ctx.buyer).setPayoutRoute(intentId, ETH, ctx.payoutTo);
      const share = price - (price * FEE_BPS) / 10000n;
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000))
        .to.emit(ctx.gw, "CctpPayoutSent").withArgs(intentId, ETH, ctx.payoutTo, share, 0);
      await expectGatewayEmpty(ctx);
    });

    it("forwards a share a third party already claimed into the gateway", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h, plaintext } = await defaultHook(ctx, { crossChain: true });
      const { intentId } = await relay(ctx, { h, amount: USDC(10) });
      await ctx.escrow.connect(ctx.stranger).claimIntentForSeller(intentId, "0x", plaintext);
      const share = USDC(9);
      expect(await ctx.usdc.balanceOf(ctx.gwAddr)).to.equal(share);
      await expect(ctx.gw.claimAndForward(intentId, "0x", "0x", 0, 2000))
        .to.emit(ctx.gw, "CctpPayoutSent").withArgs(intentId, SOL, ctx.payoutTo, share, 0);
      await expectGatewayEmpty(ctx);
    });

    it("a wrong witness reverts and leaves the payout claimable", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h, plaintext } = await defaultHook(ctx, { crossChain: true });
      const { intentId } = await relay(ctx, { h });
      await expect(ctx.gw.claimAndForward(intentId, "0x", ethers.toUtf8Bytes("wrong"), 0, 2000))
        .to.be.revertedWith("Escrow: predicate failed");
      expect(await ctx.gw.payoutSent(intentId)).to.equal(false);
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, USDC(1), 2000))
        .to.be.revertedWithCustomError(ctx.gw, "MaxFeeTooHigh");
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000)).to.emit(ctx.gw, "CctpPayoutSent");
    });

    it("same-chain intents are paid by the escrow directly, not forwarded", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h, plaintext } = await defaultHook(ctx);
      const { intentId } = await relay(ctx, { h });
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000))
        .to.be.revertedWithCustomError(ctx.gw, "NoPayoutRoute");
      await ctx.escrow.claimIntentForSeller(intentId, "0x", plaintext);
      expect(await ctx.usdc.balanceOf(ctx.seller.address)).to.equal(USDC(9));
    });
  });

  describe("pause", function () {
    it("blocks new deposits only; refunds and payouts keep working", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h, plaintext } = await defaultHook(ctx, { crossChain: true });
      const { intentId: payId } = await relay(ctx, { h });
      const { h: h2 } = await defaultHook(ctx, { plaintext: "second" });
      const { intentId: refundId } = await relay(ctx, { h: h2 });

      await expect(ctx.gw.connect(ctx.stranger).pause()).to.be.revertedWithCustomError(ctx.gw, "NotPauser");
      await expect(ctx.gw.connect(ctx.pauser).pause()).to.emit(ctx.gw, "Paused");

      const { h: h3 } = await defaultHook(ctx, { plaintext: "third" });
      const nonce = nextNonce();
      const m = burnMessage(ctx, { amount: USDC(10), nonce, hookData: encodeHook(h3) });
      await expect(ctx.gw.relayDeposit(m, attest(m))).to.be.revertedWithCustomError(ctx.gw, "DepositsPaused");
      expect(await ctx.mt.usedNonces(nonce)).to.equal(0n);

      await expect(ctx.gw.claimAndForward(payId, "0x", plaintext, 0, 2000)).to.emit(ctx.gw, "CctpPayoutSent");
      await time.increaseTo(h2.expiresAt);
      await expect(ctx.gw.refund(refundId, 0, 2000)).to.emit(ctx.gw, "CctpRefundSent");

      await expect(ctx.gw.connect(ctx.pauser).unpause()).to.emit(ctx.gw, "Unpaused");
      const { h: h4 } = await defaultHook(ctx, { plaintext: "fourth" });
      const m4 = burnMessage(ctx, { amount: USDC(10), nonce, hookData: encodeHook(h4) });
      await expect(ctx.gw.relayDeposit(m4, attest(m4))).to.emit(ctx.gw, "CctpDepositBound");
      await expectGatewayEmpty(ctx);
    });

    it("a zero pauser means the gateway can never be paused", async function () {
      const ctx = await loadFixture(deployFixture);
      const gw = await (await ethers.getContractFactory("AgentPactCctpGateway")).deploy(
        await ctx.usdc.getAddress(), await ctx.mt.getAddress(), ctx.tmAddr, ctx.escrowAddr, ethers.ZeroAddress, 100, 0
      );
      for (const s of [ctx.pauser, ctx.stranger]) {
        await expect(gw.connect(s).pause()).to.be.revertedWithCustomError(gw, "NotPauser");
      }
    });
  });

  describe("reentrancy", function () {
    it("re-entering the gateway from the transmitter during receiveMessage fails", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx);
      const inner = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h) });
      await ctx.mt.armReentry(ctx.gwAddr, ctx.gw.interface.encodeFunctionData("relayDeposit", [inner, attest(inner)]));
      const m = burnMessage(ctx, { amount: USDC(10), hookData: encodeHook(h) });
      await expect(ctx.gw.relayDeposit(m, attest(m))).to.be.revertedWithCustomError(ctx.gw, "ReentrancyGuardReentrantCall");
    });

    it("re-entering claimAndForward / refund from the messenger during the burn fails", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h, plaintext } = await defaultHook(ctx, { crossChain: true });
      const { intentId } = await relay(ctx, { h });
      await ctx.tm.armReentry(ctx.gwAddr, ctx.gw.interface.encodeFunctionData("claimAndForward", [intentId, "0x", plaintext, 0, 2000]));
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000))
        .to.be.revertedWithCustomError(ctx.gw, "ReentrancyGuardReentrantCall");
      await ctx.tm.armReentry(ethers.ZeroAddress, "0x");
      await expect(ctx.gw.claimAndForward(intentId, "0x", plaintext, 0, 2000)).to.emit(ctx.gw, "CctpPayoutSent");
    });
  });

  describe("decodeHookDataV1", function () {
    it("round-trips the canonical encoding and rejects malformed input", async function () {
      const ctx = await loadFixture(deployFixture);
      const { h } = await defaultHook(ctx, { crossChain: true });
      const d = await ctx.gw.decodeHookDataV1(encodeHook(h));
      expect(d.dealRef).to.equal(h.dealRef);
      expect(d.verifier).to.equal(h.verifier);
      expect(d.params).to.equal(h.params);
      expect(d.sellerTarget).to.equal(h.sellerTarget);
      expect(d.expiresAt).to.equal(h.expiresAt);
      expect(d.price).to.equal(h.price);
      expect(d.refundRecipient).to.equal(h.refundRecipient);
      expect(d.payoutDomain).to.equal(h.payoutDomain);
      expect(d.payoutRecipient).to.equal(h.payoutRecipient);
      await expect(ctx.gw.decodeHookDataV1("0x01")).to.be.revertedWithCustomError(ctx.gw, "MalformedHookData");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Invariant: the gateway never holds USDC (or an allowance) between txs.
  // ───────────────────────────────────────────────────────────────────────────
  describe("invariant: gateway balance == 0 outside a call", function () {
    function rng(seed) {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
    }

    for (const seed of [1, 7, 42, 1337]) {
      it(`random operation sequence (seed ${seed})`, async function () {
        this.timeout(120_000);
        const ctx = await loadFixture(deployFixture);
        const rand = rng(seed);
        const pick = (arr) => arr[Math.floor(rand() * arr.length)];
        const live = []; // { intentId, plaintext, crossChain, expiresAt, kind }
        let minted = 0n;
        const done = {};
        const did = (k) => { done[k] = (done[k] || 0) + 1; };

        const ACTIONS = [
          "validSame", "validCross", "validCross", "invalid", "underfunded", "baseFunded",
          "claimForward", "claimDirectThenForward", "claimSameChain", "refund", "refundDirectThenGateway",
          "warp", "pauseToggle",
        ];

        for (let step = 0; step < 45; step++) {
          const a = pick(ACTIONS);
          const paused = await ctx.gw.paused();
          try {
            if (a === "validSame" || a === "validCross") {
              if (paused) continue;
              const amount = USDC(1 + Math.floor(rand() * 50));
              const { h, plaintext } = await defaultHook(ctx, {
                crossChain: a === "validCross", plaintext: `p-${seed}-${step}`, hook: { price: amount },
              });
              h.expiresAt = BigInt(await time.latest()) + BigInt(60 + Math.floor(rand() * 600));
              const { intentId } = await relay(ctx, { h, amount });
              minted += amount;
              live.push({ intentId, plaintext, crossChain: a === "validCross", expiresAt: h.expiresAt, kind: "gw" });
              did("deposit");
            } else if (a === "invalid" || a === "underfunded") {
              if (paused) continue;
              const amount = USDC(1 + Math.floor(rand() * 20));
              const { h } = await defaultHook(ctx, {
                plaintext: `bad-${seed}-${step}`,
                hook: a === "invalid" ? { verifier: await ctx.unapproved.getAddress() } : { price: amount + 1n },
              });
              await relay(ctx, { h, amount });
              minted += amount;
              did("reject");
            } else if (a === "baseFunded") {
              const r = await baseFundedGatewayIntent(ctx, ctx.buyer, USDC(1 + Math.floor(rand() * 30)));
              await ctx.gw.connect(ctx.buyer).setPayoutRoute(r.intentId, pick([ETH, SOL]), ctx.payoutTo);
              live.push({ intentId: r.intentId, plaintext: r.plaintext, crossChain: true, expiresAt: r.expiresAt, kind: "base" });
            } else if (live.length > 0) {
              const i = Math.floor(rand() * live.length);
              const t = live[i];
              const now = BigInt(await time.latest());
              const expired = now + 1n >= t.expiresAt;
              if (a === "claimForward" && t.crossChain && !expired) {
                await ctx.gw.claimAndForward(t.intentId, "0x", t.plaintext, 0, pick([1000, 2000]));
                live.splice(i, 1);
                did("forward");
              } else if (a === "claimDirectThenForward" && t.crossChain && !expired) {
                await ctx.escrow.connect(ctx.stranger).claimIntentForSeller(t.intentId, "0x", t.plaintext);
                await ctx.gw.claimAndForward(t.intentId, "0x", "0x", 0, 2000);
                live.splice(i, 1);
                did("forward");
              } else if (a === "claimSameChain" && !t.crossChain && !expired) {
                await ctx.escrow.claimIntentForSeller(t.intentId, "0x", t.plaintext);
                live.splice(i, 1);
              } else if ((a === "refund" || a === "refundDirectThenGateway") && t.kind === "gw") {
                if (!expired) await time.increaseTo(t.expiresAt);
                if (a === "refundDirectThenGateway") await ctx.escrow.refundExpiredIntent(t.intentId);
                await ctx.gw.connect(ctx.stranger).refund(t.intentId, 0, 2000);
                live.splice(i, 1);
                did("refund");
              } else if (a === "warp") {
                await time.increase(30 + Math.floor(rand() * 300));
              }
            }
            if (a === "pauseToggle") {
              await (paused ? ctx.gw.connect(ctx.pauser).unpause() : ctx.gw.connect(ctx.pauser).pause());
            }
          } finally {
            await expectGatewayEmpty(ctx);
          }
        }
        expect(minted).to.be.greaterThan(0n);
        for (const k of ["deposit", "reject", "forward", "refund"]) expect(done[k] || 0, `${k} never ran`).to.be.greaterThan(0);
      });
    }
  });
});

function anyNonce() {
  // withArgs predicate: any bytes32.
  return (v) => typeof v === "string" && v.length === 66;
}
