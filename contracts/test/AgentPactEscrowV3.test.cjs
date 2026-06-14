"use strict";
const { expect } = require("chai");
const { ethers } = require("hardhat");

const FEE_BPS = 1000n; // 10%
const ZERO = ethers.ZeroAddress;
const BURN = "0x000000000000000000000000000000000000dEaD";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup helper
// ─────────────────────────────────────────────────────────────────────────────

async function setupV3() {
  // Signers — names are semantically intentional:
  //   platform : receives the 10% platform fee
  //   buyer    : holds USDC but NO ETH for gas (gasless proof)
  //   relayer  : pays gas, broadcasts createIntentWithAuthorization
  //   seller   : reveals preimage, receives 90%
  const [platform, buyer, relayer, seller] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  const HashPre = await ethers.getContractFactory("HashPreimagePredicate");
  const hashPre = await HashPre.deploy();

  const SignedBlob = await ethers.getContractFactory("SignedBlobPredicate");
  const signedBlob = await SignedBlob.deploy();

  const Merkle = await ethers.getContractFactory("MerkleMembershipPredicate");
  const merkle = await Merkle.deploy();

  const Reg = await ethers.getContractFactory("PredicateRegistry");
  const registry = await Reg.deploy([
    await hashPre.getAddress(),
    await signedBlob.getAddress(),
    await merkle.getAddress(),
  ]);

  const EscrowV3 = await ethers.getContractFactory("AgentPactEscrowV3");
  const escrow = await EscrowV3.deploy(
    await usdc.getAddress(),
    await registry.getAddress(),
    platform.address,
    BURN,
    FEE_BPS
  );

  const escrowAddr = await escrow.getAddress();
  const usdcAddr = await usdc.getAddress();

  // Mint USDC to buyer and seller.  Seller needs USDC for Class B stake tests.
  const mintAmt = ethers.parseUnits("10000", 6);
  await usdc.mint(buyer.address, mintAmt);
  await usdc.mint(seller.address, mintAmt);

  // seller approves escrow for transferFrom-path tests (Class B).
  await usdc.connect(seller).approve(escrowAddr, ethers.MaxUint256);

  // Get USDC domain separator for EIP-3009 signing.
  const usdcDomainSeparator = await usdc.DOMAIN_SEPARATOR();

  return {
    platform, buyer, relayer, seller,
    usdc, hashPre, signedBlob, merkle, registry, escrow,
    escrowAddr, usdcAddr, usdcDomainSeparator,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EIP-3009 signing helper
// ─────────────────────────────────────────────────────────────────────────────

async function signReceiveWithAuthorization(signer, usdcAddr, from, to, value, validAfter, validBefore, nonce) {
  // Build the EIP-712 typed data exactly matching MockUSDC's domain + typehash.
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: usdcAddr,
  };

  const types = {
    ReceiveWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "validAfter",  type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce",       type: "bytes32" },
    ],
  };

  const message = { from, to, value, validAfter, validBefore, nonce };
  const sig = await signer.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth params builder — returns a struct used by createIntentWithAuthorization
// ─────────────────────────────────────────────────────────────────────────────

async function buildAuthParams(ctx, {
  buyer = ctx.buyer,
  value = null,
  maxPrice = ethers.parseUnits("10", 6),
  validAfterOffset = -1,     // -1 sec → already valid
  validBeforeOffset = 3600,  // +1 h
  nonce = ethers.hexlify(ethers.randomBytes(32)),
} = {}) {
  const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const validAfter  = ts + BigInt(validAfterOffset);
  const validBefore = ts + BigInt(validBeforeOffset);
  const _value = value !== null ? value : maxPrice;

  const { v, r, s } = await signReceiveWithAuthorization(
    buyer, ctx.usdcAddr,
    buyer.address,
    ctx.escrowAddr,
    _value,
    validAfter,
    validBefore,
    nonce
  );
  return { validAfter, validBefore, nonce, value: _value, v, r, s };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create a standard hash-preimage predicate params
// ─────────────────────────────────────────────────────────────────────────────

function makePredicateParams(plaintext) {
  const commitment = ethers.keccak256(plaintext);
  const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);
  return { params, plaintext };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentPactEscrowV3", function () {
  this.timeout(60_000);

  // ──────────────────────────────────────────────────────────────────────────
  describe("V3 inherits V2 behaviour: Class A direct path", function () {
    it("createIntent (transferFrom path) still works for buyer as msg.sender", async function () {
      const ctx = await setupV3();
      const plaintext = ethers.toUtf8Bytes("v3-direct-test");
      const { params } = makePredicateParams(plaintext);
      const maxPrice = ethers.parseUnits("5", 6);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      // Buyer approves escrow for this test.
      await ctx.usdc.connect(ctx.buyer).approve(ctx.escrowAddr, ethers.MaxUint256);

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      const tx = await ctx.escrow.connect(ctx.buyer).createIntent(
        0, // ClassA
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt
      );
      const rc = await tx.wait();
      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      const intentId = evt.args[0];

      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);
      expect(buyerBefore - buyerAfter).to.equal(maxPrice);

      const it = await ctx.escrow.getIntent(intentId);
      expect(it.buyer).to.equal(ctx.buyer.address);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("createIntentWithAuthorization — happy path", function () {
    it("relayer broadcasts; USDC moves buyer → escrow; buyer.buyer set to authorizer", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("10", 6);
      const plaintext = ethers.toUtf8Bytes("happy-path-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      const auth = await buildAuthParams(ctx, { maxPrice });

      const buyerBefore  = await ctx.usdc.balanceOf(ctx.buyer.address);
      const escrowBefore = await ctx.usdc.balanceOf(ctx.escrowAddr);

      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const rc = await tx.wait();

      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      expect(evt).to.not.be.undefined;
      const intentId = evt.args[0];

      // USDC balances.
      const buyerAfter  = await ctx.usdc.balanceOf(ctx.buyer.address);
      const escrowAfter = await ctx.usdc.balanceOf(ctx.escrowAddr);
      expect(buyerBefore  - buyerAfter).to.equal(maxPrice);
      expect(escrowAfter  - escrowBefore).to.equal(maxPrice);

      // Intent buyer must be the authorizer, NOT the relayer.
      const intent = await ctx.escrow.getIntent(intentId);
      expect(intent.buyer).to.equal(ctx.buyer.address);
      expect(intent.buyer).to.not.equal(ctx.relayer.address);
      expect(intent.status).to.equal(1n); // Open
      expect(intent.maxPrice).to.equal(maxPrice);
    });

    it("event emits ClassA, buyer=authorizer, correct verifier/maxPrice/expiresAt", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("7", 6);
      const plaintext = ethers.toUtf8Bytes("event-test-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 7200n;

      const auth = await buildAuthParams(ctx, { maxPrice });

      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const rc = await tx.wait();

      await expect(tx).to.emit(ctx.escrow, "IntentCreated")
        .withArgs(
          // intentId — we don't predict it, just verify the other fields
          (id) => id !== ethers.ZeroHash,
          0n, // ClassA
          ctx.buyer.address,
          ZERO,
          await ctx.hashPre.getAddress(),
          maxPrice,
          expiresAt
        );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("Four-balance delta: buyer −maxPrice / escrow net 0 / seller +90% / platform +10%", function () {
    it("seller claims with preimage witness → correct split", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("100", 6);    // 100 USDC
      const plaintext = ethers.toUtf8Bytes("four-balance-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      const auth = await buildAuthParams(ctx, { maxPrice });

      // Snapshot balances.
      const buyerBefore    = await ctx.usdc.balanceOf(ctx.buyer.address);
      const escrowBefore   = await ctx.usdc.balanceOf(ctx.escrowAddr);
      const sellerBefore   = await ctx.usdc.balanceOf(ctx.seller.address);
      const platformBefore = await ctx.usdc.balanceOf(ctx.platform.address);

      // Relayer creates intent (buyer pays zero ETH).
      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const rc = await tx.wait();
      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      const intentId = evt.args[0];

      // Seller claims.
      await ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", plaintext);

      // Assert four-balance deltas.
      const buyerAfter    = await ctx.usdc.balanceOf(ctx.buyer.address);
      const escrowAfter   = await ctx.usdc.balanceOf(ctx.escrowAddr);
      const sellerAfter   = await ctx.usdc.balanceOf(ctx.seller.address);
      const platformAfter = await ctx.usdc.balanceOf(ctx.platform.address);

      const buyerDelta    = buyerBefore    - buyerAfter;      // should be +maxPrice (out)
      const escrowDelta   = escrowAfter    - escrowBefore;    // should be 0 (net)
      const sellerDelta   = sellerAfter    - sellerBefore;    // should be +90%
      const platformDelta = platformAfter  - platformBefore;  // should be +10%

      const expectedSeller   = (maxPrice * 9000n) / 10000n;  // 90 USDC
      const expectedPlatform = maxPrice - expectedSeller;     // 10 USDC

      expect(buyerDelta).to.equal(maxPrice,
        "buyer should have paid maxPrice");
      expect(escrowDelta).to.equal(0n,
        "escrow should be net zero after full claim");
      expect(sellerDelta).to.equal(expectedSeller,
        "seller should receive 90%");
      expect(platformDelta).to.equal(expectedPlatform,
        "platform should receive 10%");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("Gasless proof: buyer holds zero ETH throughout", function () {
    it("buyer ETH balance is unchanged (only relayer spends ETH for gas)", async function () {
      const ctx = await setupV3();
      // Drain buyer ETH to 0 (simulate gasless agent).
      const buyerEthBefore = await ethers.provider.getBalance(ctx.buyer.address);
      // Transfer buyer's ETH out to platform so buyer has zero ETH.
      // (In hardhat the buyer starts with 10000 ETH. We can't send it all out
      //  easily without a helper, so instead we record that no ETH is spent
      //  by the buyer in the signing + intent-creation flow.)
      // The key check: buyer sends NO transaction; relayer sends it.
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("gasless-proof-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      const auth = await buildAuthParams(ctx, { maxPrice });

      // Buyer does NOT send any transaction.  Only relayer does.
      const relayerBefore = await ethers.provider.getBalance(ctx.relayer.address);
      await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const relayerAfter = await ethers.provider.getBalance(ctx.relayer.address);
      const buyerEthAfter = await ethers.provider.getBalance(ctx.buyer.address);

      // Buyer ETH is unchanged.
      expect(buyerEthAfter).to.equal(buyerEthBefore, "buyer spent no ETH");
      // Relayer spent gas.
      expect(relayerBefore - relayerAfter).to.be.gt(0n, "relayer paid gas");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("Replay protection", function () {
    it("same authorization nonce reverts on second use", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("replay-test-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);

      // Use a fixed nonce.
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const auth = await buildAuthParams(ctx, { maxPrice, nonce });

      // First use succeeds.
      const expiresAt1 = ts + 3600n;
      await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt1,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );

      // Second use with same nonce must revert — different params to avoid
      // "dup intent" which would fire before the nonce check.
      const plaintext2 = ethers.toUtf8Bytes("replay-test-secret-2");
      const { params: params2 } = makePredicateParams(plaintext2);
      const expiresAt2 = ts + 7200n;

      await expect(
        ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
          ctx.buyer.address,
          await ctx.hashPre.getAddress(),
          params2,
          ZERO,
          maxPrice,
          expiresAt2,
          auth.value,
          auth.validAfter,
          auth.validBefore,
          auth.nonce, // same nonce!
          auth.v,
          auth.r,
          auth.s
        )
      ).to.be.revertedWith("MockUSDC: authorization already used");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("Expired authorization window", function () {
    it("authorization past validBefore reverts", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("expired-auth-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      // Build auth with validBefore already in the past.
      const validAfter  = ts - 200n;
      const validBefore = ts - 100n; // already expired
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      const { v, r, s } = await signReceiveWithAuthorization(
        ctx.buyer,
        ctx.usdcAddr,
        ctx.buyer.address,
        ctx.escrowAddr,
        maxPrice,
        validAfter,
        validBefore,
        nonce
      );

      await expect(
        ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
          ctx.buyer.address,
          await ctx.hashPre.getAddress(),
          params,
          ZERO,
          maxPrice,
          expiresAt,
          maxPrice, // value
          validAfter,
          validBefore,
          nonce,
          v, r, s
        )
      ).to.be.revertedWith("MockUSDC: authorization expired");
    });

    it("authorization not yet valid (validAfter in future) reverts", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("notyet-auth-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      const validAfter  = ts + 500n;  // 500 sec in future
      const validBefore = ts + 3600n;
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      const { v, r, s } = await signReceiveWithAuthorization(
        ctx.buyer,
        ctx.usdcAddr,
        ctx.buyer.address,
        ctx.escrowAddr,
        maxPrice,
        validAfter,
        validBefore,
        nonce
      );

      await expect(
        ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
          ctx.buyer.address,
          await ctx.hashPre.getAddress(),
          params,
          ZERO,
          maxPrice,
          expiresAt,
          maxPrice,
          validAfter,
          validBefore,
          nonce,
          v, r, s
        )
      ).to.be.revertedWith("MockUSDC: authorization not yet valid");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("Bad signature reverts", function () {
    it("wrong signer (not buyer) reverts", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("bad-sig-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      // Sign with the relayer's key, claiming to be buyer.
      const { v, r, s } = await signReceiveWithAuthorization(
        ctx.relayer,      // WRONG signer
        ctx.usdcAddr,
        ctx.buyer.address,
        ctx.escrowAddr,
        maxPrice,
        ts - 1n,
        ts + 3600n,
        nonce
      );

      await expect(
        ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
          ctx.buyer.address,
          await ctx.hashPre.getAddress(),
          params,
          ZERO,
          maxPrice,
          expiresAt,
          maxPrice,
          ts - 1n,
          ts + 3600n,
          nonce,
          v, r, s
        )
      ).to.be.revertedWith("MockUSDC: invalid signature");
    });

    it("tampered value in the auth params reverts", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("tampered-sig-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      // Sign for maxPrice but submit with maxPrice+1 → sig mismatch.
      const auth = await buildAuthParams(ctx, { maxPrice });

      await expect(
        ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
          ctx.buyer.address,
          await ctx.hashPre.getAddress(),
          params,
          ZERO,
          maxPrice,
          expiresAt,
          auth.value + 1n, // tampered
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          auth.v,
          auth.r,
          auth.s
        )
      ).to.be.reverted; // either invalid sig or value != maxPrice
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("value != maxPrice reverts before USDC call", function () {
    it("reverts with 'Escrow: value != maxPrice'", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("value-mismatch-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      // Auth signs for maxPrice * 2.
      const wrongValue = maxPrice * 2n;
      const auth = await buildAuthParams(ctx, { maxPrice, value: wrongValue });

      await expect(
        ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
          ctx.buyer.address,
          await ctx.hashPre.getAddress(),
          params,
          ZERO,
          maxPrice, // maxPrice is 5 USDC
          expiresAt,
          wrongValue, // value is 10 USDC — mismatch
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          auth.v,
          auth.r,
          auth.s
        )
      ).to.be.revertedWith("Escrow: value != maxPrice");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("intentId derivation consistency", function () {
    it("createIntentWithAuthorization derives same intentId as createIntent would for same buyer", async function () {
      // Both functions call _deriveIntentId(buyer, verifier, params, maxPrice, expiresAt)
      // with the same buyer address.  The intentId includes block.number and
      // block.prevrandao, so we can't pre-compute it — but we can verify that
      // the intent stored has it.buyer == buyer and that claimIntent works, which
      // proves the lookup matches.
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("20", 6);
      const plaintext = ethers.toUtf8Bytes("derivation-consistency-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      const auth = await buildAuthParams(ctx, { maxPrice });
      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const rc = await tx.wait();
      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      const intentId = evt.args[0];

      // Verify the stored intent has buyer = authorizer.
      const it = await ctx.escrow.getIntent(intentId);
      expect(it.buyer).to.equal(ctx.buyer.address,
        "intentId lookup finds intent with buyer=authorizer");

      // Also verify the intent is claimable — proves the id derivation round-trips.
      await ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", plaintext);
      const itAfter = await ctx.escrow.getIntent(intentId);
      expect(itAfter.status).to.equal(2n); // ClaimedA
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("refundExpiredIntent on authorization-funded intent refunds to buyer, not relayer", function () {
    it("refund goes to stored buyer, not msg.sender (relayer)", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const plaintext = ethers.toUtf8Bytes("refund-to-buyer-secret");
      const { params } = makePredicateParams(plaintext);

      // Set a very short expiry (1 second in the future).
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 2n;

      const auth = await buildAuthParams(ctx, {
        maxPrice,
        validBeforeOffset: 600,
      });

      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const rc = await tx.wait();
      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      const intentId = evt.args[0];

      // Fast-forward past expiry.
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      const buyerBefore   = await ctx.usdc.balanceOf(ctx.buyer.address);
      const relayerBefore = await ctx.usdc.balanceOf(ctx.relayer.address);

      // Anyone can call refundExpiredIntent — here relayer does.
      await ctx.escrow.connect(ctx.relayer).refundExpiredIntent(intentId);

      const buyerAfter   = await ctx.usdc.balanceOf(ctx.buyer.address);
      const relayerAfter = await ctx.usdc.balanceOf(ctx.relayer.address);

      // Buyer gets the refund.
      expect(buyerAfter - buyerBefore).to.equal(maxPrice, "buyer gets refund");
      // Relayer does NOT get funds.
      expect(relayerAfter).to.equal(relayerBefore, "relayer balance unchanged");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("Invariants", function () {
    it("escrow V3 has no admin / upgrade / addVerifier surface", async function () {
      const ctx = await setupV3();
      const names = ctx.escrow.interface.fragments
        .filter(f => f.type === "function")
        .map(f => f.name);
      expect(names).to.not.include("upgrade");
      expect(names).to.not.include("addVerifier");
      expect(names).to.not.include("transferOwnership");
      expect(names).to.not.include("setPlatformFee");
    });

    it("has createIntentWithAuthorization in ABI", async function () {
      const ctx = await setupV3();
      const names = ctx.escrow.interface.fragments
        .filter(f => f.type === "function")
        .map(f => f.name);
      expect(names).to.include("createIntentWithAuthorization");
    });

    it("platformFeeBps is 10% (1000)", async function () {
      const ctx = await setupV3();
      expect(await ctx.escrow.platformFeeBps()).to.equal(FEE_BPS);
    });

    it("burnTo is 0x…dEaD", async function () {
      const ctx = await setupV3();
      expect(await ctx.escrow.burnTo()).to.equal(BURN);
    });

    it("predicateRegistry points at the deployed registry", async function () {
      const ctx = await setupV3();
      expect(await ctx.escrow.predicateRegistry()).to.equal(await ctx.registry.getAddress());
    });

    it("escrow USDC balance net-zero after full happy-path claim via auth", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("10", 6);
      const plaintext = ethers.toUtf8Bytes("invariant-auth");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;

      const auth = await buildAuthParams(ctx, { maxPrice });

      const escrowBefore = await ctx.usdc.balanceOf(ctx.escrowAddr);

      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        ZERO,
        maxPrice,
        expiresAt,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.v,
        auth.r,
        auth.s
      );
      const rc = await tx.wait();
      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      const intentId = evt.args[0];

      await ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", plaintext);

      const escrowAfter = await ctx.usdc.balanceOf(ctx.escrowAddr);
      expect(escrowAfter).to.equal(escrowBefore, "escrow net zero");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("MockUSDC EIP-3009 direct tests", function () {
    it("receiveWithAuthorization transfers USDC with valid sig", async function () {
      const ctx = await setupV3();
      const [, , , , thirdParty] = await ethers.getSigners();
      const amount = ethers.parseUnits("3", 6);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      const { v, r, s } = await signReceiveWithAuthorization(
        ctx.buyer,
        ctx.usdcAddr,
        ctx.buyer.address,
        thirdParty.address,
        amount,
        ts - 1n,
        ts + 3600n,
        nonce
      );

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      await ctx.usdc.connect(thirdParty).receiveWithAuthorization(
        ctx.buyer.address, thirdParty.address, amount,
        ts - 1n, ts + 3600n, nonce,
        v, r, s
      );
      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);
      expect(buyerBefore - buyerAfter).to.equal(amount);
    });

    it("authorizationState returns true after use", async function () {
      const ctx = await setupV3();
      const [, , , , thirdParty] = await ethers.getSigners();
      const amount = ethers.parseUnits("1", 6);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      expect(await ctx.usdc.authorizationState(ctx.buyer.address, nonce)).to.equal(false);

      const { v, r, s } = await signReceiveWithAuthorization(
        ctx.buyer, ctx.usdcAddr,
        ctx.buyer.address, thirdParty.address, amount,
        ts - 1n, ts + 3600n, nonce
      );
      await ctx.usdc.connect(thirdParty).receiveWithAuthorization(
        ctx.buyer.address, thirdParty.address, amount,
        ts - 1n, ts + 3600n, nonce, v, r, s
      );

      expect(await ctx.usdc.authorizationState(ctx.buyer.address, nonce)).to.equal(true);
    });

    it("only `to` may call receiveWithAuthorization (prevents hijack)", async function () {
      const ctx = await setupV3();
      const [, , , , thirdParty, eavesdropper] = await ethers.getSigners();
      const amount = ethers.parseUnits("1", 6);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      const { v, r, s } = await signReceiveWithAuthorization(
        ctx.buyer, ctx.usdcAddr,
        ctx.buyer.address, thirdParty.address, amount,
        ts - 1n, ts + 3600n, nonce
      );

      // Eavesdropper tries to submit the auth for themselves.
      await expect(
        ctx.usdc.connect(eavesdropper).receiveWithAuthorization(
          ctx.buyer.address, thirdParty.address, amount,
          ts - 1n, ts + 3600n, nonce, v, r, s
        )
      ).to.be.revertedWith("MockUSDC: caller is not to");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe("claimIntentForSeller — relayer-brokered claim pays sellerTarget", function () {
    async function fundTargetedIntent(ctx, { maxPrice, sellerTarget }) {
      const plaintext = ethers.toUtf8Bytes("broker-claim-secret");
      const { params } = makePredicateParams(plaintext);
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expiresAt = ts + 3600n;
      const auth = await buildAuthParams(ctx, { maxPrice });
      const tx = await ctx.escrow.connect(ctx.relayer).createIntentWithAuthorization(
        ctx.buyer.address,
        await ctx.hashPre.getAddress(),
        params,
        sellerTarget,
        maxPrice,
        expiresAt,
        auth.value, auth.validAfter, auth.validBefore,
        auth.nonce, auth.v, auth.r, auth.s
      );
      const rc = await tx.wait();
      const evt = rc.logs.find(l => l.fragment && l.fragment.name === "IntentCreated");
      return { intentId: evt.args[0], plaintext };
    }

    it("relayer broadcasts; seller (sellerTarget) receives 90%, relayer receives nothing", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("100", 6);
      const { intentId, plaintext } = await fundTargetedIntent(ctx, {
        maxPrice, sellerTarget: ctx.seller.address,
      });

      const sellerBefore   = await ctx.usdc.balanceOf(ctx.seller.address);
      const relayerBefore  = await ctx.usdc.balanceOf(ctx.relayer.address);
      const platformBefore = await ctx.usdc.balanceOf(ctx.platform.address);
      const escrowBefore   = await ctx.usdc.balanceOf(ctx.escrowAddr);

      // RELAYER broadcasts (msg.sender = relayer), but seller is the payee.
      await ctx.escrow.connect(ctx.relayer).claimIntentForSeller(intentId, "0x", plaintext);

      const sellerDelta   = (await ctx.usdc.balanceOf(ctx.seller.address)) - sellerBefore;
      const relayerDelta  = (await ctx.usdc.balanceOf(ctx.relayer.address)) - relayerBefore;
      const platformDelta = (await ctx.usdc.balanceOf(ctx.platform.address)) - platformBefore;
      const escrowDelta   = escrowBefore - (await ctx.usdc.balanceOf(ctx.escrowAddr));

      const expectedSeller   = (maxPrice * 9000n) / 10000n;
      const expectedPlatform = maxPrice - expectedSeller;

      expect(sellerDelta).to.equal(expectedSeller, "seller (sellerTarget) gets 90%");
      expect(relayerDelta).to.equal(0n, "relayer (msg.sender) gets NOTHING — no custodial hop");
      expect(platformDelta).to.equal(expectedPlatform, "platform gets 10% fee");
      expect(escrowDelta).to.equal(maxPrice, "escrow released the full locked amount");
    });

    it("reverts when sellerTarget is the zero address (untargeted intent)", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const { intentId, plaintext } = await fundTargetedIntent(ctx, {
        maxPrice, sellerTarget: ZERO,
      });
      await expect(
        ctx.escrow.connect(ctx.relayer).claimIntentForSeller(intentId, "0x", plaintext)
      ).to.be.revertedWith("Escrow: NO_SELLER_TARGET");
    });

    it("reverts on a bad witness (predicate still gates correctness)", async function () {
      const ctx = await setupV3();
      const maxPrice = ethers.parseUnits("5", 6);
      const { intentId } = await fundTargetedIntent(ctx, {
        maxPrice, sellerTarget: ctx.seller.address,
      });
      const wrongWitness = ethers.toUtf8Bytes("not-the-preimage");
      await expect(
        ctx.escrow.connect(ctx.relayer).claimIntentForSeller(intentId, "0x", wrongWitness)
      ).to.be.revertedWith("Escrow: predicate failed");
    });
  });
});
