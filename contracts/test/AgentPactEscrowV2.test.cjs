const { expect } = require("chai");
const { ethers } = require("hardhat");

const FEE_BPS = 1000; // 10%
const ZERO = ethers.ZeroAddress;
const BURN = "0x000000000000000000000000000000000000dEaD";

async function setupV2() {
  const [platform, buyer, seller, otherSeller, sweeper] = await ethers.getSigners();

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

  const EscrowV2 = await ethers.getContractFactory("AgentPactEscrowV2");
  const escrow = await EscrowV2.deploy(
    await usdc.getAddress(),
    await registry.getAddress(),
    platform.address,
    BURN,
    FEE_BPS
  );

  const mint = ethers.parseUnits("10000", 6);
  for (const a of [buyer, seller, otherSeller]) {
    await usdc.mint(a.address, mint);
    await usdc.connect(a).approve(await escrow.getAddress(), ethers.MaxUint256);
  }

  return { platform, buyer, seller, otherSeller, sweeper, usdc, hashPre, signedBlob, merkle, registry, escrow };
}

async function getBlockTime() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

function logArg(rc, name, idx = 0) {
  const evt = rc.logs.find((l) => l.fragment && l.fragment.name === name);
  return evt.args[idx];
}

describe("AgentPactEscrowV2", function () {
  this.timeout(60000);

  // ──────────────────────────────────────────────────────────────────
  describe("PredicateRegistry — immutability", function () {
    it("registers initial verifiers and is queryable", async function () {
      const ctx = await setupV2();
      expect(await ctx.registry.verifierCount()).to.equal(3n);
      expect(await ctx.registry.isApproved(await ctx.hashPre.getAddress())).to.equal(true);
      expect(await ctx.registry.isApproved(ZERO)).to.equal(false);
    });

    it("reverts on empty initialVerifiers", async function () {
      const Reg = await ethers.getContractFactory("PredicateRegistry");
      await expect(Reg.deploy([])).to.be.revertedWith("PredicateRegistry: empty");
    });

    it("reverts on duplicate verifier", async function () {
      const Hash = await ethers.getContractFactory("HashPreimagePredicate");
      const h = await Hash.deploy();
      const Reg = await ethers.getContractFactory("PredicateRegistry");
      await expect(
        Reg.deploy([await h.getAddress(), await h.getAddress()])
      ).to.be.revertedWith("PredicateRegistry: duplicate");
    });

    it("has no add/remove function (immutable)", async function () {
      const ctx = await setupV2();
      const fragment = ctx.registry.interface.fragments.find(
        (f) => f.name === "add" || f.name === "remove"
      );
      expect(fragment).to.equal(undefined);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("Predicate verifiers — pure", function () {
    it("HashPreimagePredicate returns true on match, false on mismatch", async function () {
      const ctx = await setupV2();
      const plaintext = ethers.toUtf8Bytes("hello-secret");
      const commitment = ethers.keccak256(plaintext);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);
      expect(await ctx.hashPre.verify(params, "0x", plaintext)).to.equal(true);
      const wrong = ethers.toUtf8Bytes("not-the-secret");
      expect(await ctx.hashPre.verify(params, "0x", wrong)).to.equal(false);
    });

    it("HashPreimagePredicate reverts on malformed params", async function () {
      const ctx = await setupV2();
      await expect(ctx.hashPre.verify("0x1234", "0x", "0x")).to.be.revertedWith(
        "HashPreimagePredicate: bad params length"
      );
    });

    it("SignedBlobPredicate validates ECDSA signature", async function () {
      const ctx = await setupV2();
      const domainTag = ethers.keccak256(ethers.toUtf8Bytes("agentpact:test:v1"));
      const plaintext = ethers.toUtf8Bytes("api-key-12345");
      const digest = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes"], [domainTag, plaintext]));

      const sk = new ethers.SigningKey(ethers.id("test-priv-key-xyz"));
      const signer = ethers.computeAddress(sk.publicKey);
      const rawSig = sk.sign(digest).serialized;

      const params = ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [signer, domainTag]);
      const witness = ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [plaintext, rawSig]);
      expect(await ctx.signedBlob.verify(params, "0x", witness)).to.equal(true);

      const badParams = ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [ctx.buyer.address, domainTag]);
      expect(await ctx.signedBlob.verify(badParams, "0x", witness)).to.equal(false);
    });

    it("MerkleMembershipPredicate validates inclusion proofs (4-leaf tree)", async function () {
      const ctx = await setupV2();
      const leaves = ["alpha", "beta", "gamma", "delta"].map((s) =>
        ethers.keccak256(ethers.solidityPacked(["bytes"], [ethers.toUtf8Bytes(s)]))
      );
      const sorted = [...leaves].sort();
      const hashPair = (a, b) => {
        const [x, y] = a < b ? [a, b] : [b, a];
        return ethers.keccak256(ethers.concat([x, y]));
      };
      const l01 = hashPair(sorted[0], sorted[1]);
      const l23 = hashPair(sorted[2], sorted[3]);
      const root = hashPair(l01, l23);

      const alphaLeaf = ethers.keccak256(ethers.solidityPacked(["bytes"], [ethers.toUtf8Bytes("alpha")]));
      const idx = sorted.indexOf(alphaLeaf);
      // Two-level proof: sibling within its pair + the opposite subtree root
      let siblingIdx;
      if (idx === 0) siblingIdx = 1;
      else if (idx === 1) siblingIdx = 0;
      else if (idx === 2) siblingIdx = 3;
      else siblingIdx = 2;
      const sibling = sorted[siblingIdx];
      const upperSibling = idx < 2 ? l23 : l01;
      const proof = [sibling, upperSibling];

      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [root]);
      const witness = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "bytes32[]"],
        [ethers.toUtf8Bytes("alpha"), proof]
      );
      expect(await ctx.merkle.verify(params, "0x", witness)).to.equal(true);

      const badWitness = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "bytes32[]"],
        [ethers.toUtf8Bytes("not-in-tree"), proof]
      );
      expect(await ctx.merkle.verify(params, "0x", badWitness)).to.equal(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("Class A — create + claim", function () {
    async function createClassA(ctx, plaintextStr, sellerTarget, price) {
      sellerTarget = sellerTarget || ZERO;
      price = price || ethers.parseUnits("1", 6);
      const ptBytes = ethers.toUtf8Bytes(plaintextStr);
      const commitment = ethers.keccak256(ptBytes);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);
      const expiresAt = BigInt((await getBlockTime()) + 3600);
      const tx = await ctx.escrow
        .connect(ctx.buyer)
        .createIntent(0, await ctx.hashPre.getAddress(), params, sellerTarget, price, expiresAt);
      const rc = await tx.wait();
      const intentId = logArg(rc, "IntentCreated");
      return { intentId, ptBytes, params, price };
    }

    it("happy path: buyer locks, seller claims, 90/10 split", async function () {
      const ctx = await setupV2();
      const { intentId, ptBytes, price } = await createClassA(ctx, "secret-document-v1");
      const sellerBefore = await ctx.usdc.balanceOf(ctx.seller.address);
      const platBefore = await ctx.usdc.balanceOf(ctx.platform.address);
      const escrowBefore = await ctx.usdc.balanceOf(await ctx.escrow.getAddress());

      await expect(
        ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0xdeadbeef", ptBytes)
      ).to.emit(ctx.escrow, "IntentClaimedA");

      const sellerAfter = await ctx.usdc.balanceOf(ctx.seller.address);
      const platAfter = await ctx.usdc.balanceOf(ctx.platform.address);
      const escrowAfter = await ctx.usdc.balanceOf(await ctx.escrow.getAddress());

      expect(sellerAfter - sellerBefore).to.equal(900_000n);
      expect(platAfter - platBefore).to.equal(100_000n);
      expect(escrowAfter).to.equal(escrowBefore - price);
    });

    it("rejects bad predicate witness", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassA(ctx, "secret-document-v1");
      const wrong = ethers.toUtf8Bytes("not-the-secret");
      await expect(
        ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", wrong)
      ).to.be.revertedWith("Escrow: predicate failed");
    });

    it("rejects unapproved verifier", async function () {
      const ctx = await setupV2();
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.ZeroHash]);
      const expiresAt = BigInt((await getBlockTime()) + 3600);
      await expect(
        ctx.escrow.connect(ctx.buyer).createIntent(0, ctx.buyer.address, params, ZERO, 1_000_000n, expiresAt)
      ).to.be.revertedWith("Escrow: verifier not approved");
    });

    it("respects sellerTarget restriction", async function () {
      const ctx = await setupV2();
      const { intentId, ptBytes } = await createClassA(ctx, "secret", ctx.seller.address);
      await expect(
        ctx.escrow.connect(ctx.otherSeller).claimIntent(intentId, "0x", ptBytes)
      ).to.be.revertedWith("Escrow: INTENT_TARGETED_TO_OTHER_SELLER");
      await expect(ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", ptBytes)).to.emit(
        ctx.escrow, "IntentClaimedA"
      );
    });

    it("rejects double-claim", async function () {
      const ctx = await setupV2();
      const { intentId, ptBytes } = await createClassA(ctx, "secret");
      await ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", ptBytes);
      await expect(
        ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", ptBytes)
      ).to.be.revertedWith("Escrow: not Class A open");
    });

    it("rejects claim after expiry; refunds expired intent to buyer", async function () {
      const ctx = await setupV2();
      const ptBytes = ethers.toUtf8Bytes("secret");
      const commitment = ethers.keccak256(ptBytes);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);
      const expiresAt = BigInt((await getBlockTime()) + 60);
      const tx = await ctx.escrow.connect(ctx.buyer).createIntent(
        0, await ctx.hashPre.getAddress(), params, ZERO, 1_000_000n, expiresAt
      );
      const rc = await tx.wait();
      const intentId = logArg(rc, "IntentCreated");

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        ctx.escrow.connect(ctx.seller).claimIntent(intentId, "0x", ptBytes)
      ).to.be.revertedWith("Escrow: expired");

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      await expect(ctx.escrow.connect(ctx.sweeper).refundExpiredIntent(intentId)).to.emit(
        ctx.escrow, "IntentExpired"
      );
      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);
      expect(buyerAfter - buyerBefore).to.equal(1_000_000n);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("Class B — Schelling commit-reveal", function () {
    async function createClassB(ctx, price, buyerStakeBps) {
      price = price || ethers.parseUnits("1", 6);
      buyerStakeBps = buyerStakeBps || 1000;
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.ZeroHash]);
      const expiresAt = BigInt((await getBlockTime()) + 3600);
      const tx = await ctx.escrow
        .connect(ctx.buyer)
        .createIntentB(await ctx.hashPre.getAddress(), params, ZERO, price, buyerStakeBps, expiresAt);
      const rc = await tx.wait();
      const intentId = logArg(rc, "IntentCreated");
      return { intentId, price };
    }

    it("happy path: accept → deliver → acknowledge → seller paid + stakes returned", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 2000); // 20% = 200_000
      await ctx.escrow.connect(ctx.seller).deliver(intentId, "0xdeadbeef");

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      const sellerBefore = await ctx.usdc.balanceOf(ctx.seller.address);
      const platBefore = await ctx.usdc.balanceOf(ctx.platform.address);

      await expect(ctx.escrow.connect(ctx.buyer).acknowledge(intentId)).to.emit(
        ctx.escrow, "ClassBAcknowledged"
      );

      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);
      const sellerAfter = await ctx.usdc.balanceOf(ctx.seller.address);
      const platAfter = await ctx.usdc.balanceOf(ctx.platform.address);

      expect(buyerAfter - buyerBefore).to.equal(100_000n);
      expect(sellerAfter - sellerBefore).to.equal(900_000n + 200_000n);
      expect(platAfter - platBefore).to.equal(100_000n);
    });

    it("auto-ack timeout: anyone can acknowledgeTimeout once window elapsed", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 2000);
      await ctx.escrow.connect(ctx.seller).deliver(intentId, "0x");
      await ethers.provider.send("evm_increaseTime", [11 * 60]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        ctx.escrow.connect(ctx.sweeper).acknowledgeTimeout(intentId)
      ).to.emit(ctx.escrow, "ClassBAcknowledged");
    });

    it("stake cap enforced: 60% of $1 (= 600k) > min(500k, 50M) reverts", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await expect(
        ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 6000)
      ).to.be.revertedWith("STAKE_EXCEEDS_CAP");
    });

    it("stake cap absolute ceiling at 50 USDC for large prices", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx, ethers.parseUnits("1000", 6));
      // price = 1000 USDC. Cap = min(500 USDC, 50 USDC) = 50 USDC. 60 USDC = 600 bps revert.
      await expect(
        ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 600)
      ).to.be.revertedWith("STAKE_EXCEEDS_CAP");
    });

    it("reject + commit-reveal HASH-MATCH → seller wins, buyer stake → 90% seller / 10% platform", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 2000);
      await ctx.escrow.connect(ctx.seller).deliver(intentId, "0x");

      const deliverable = ethers.toUtf8Bytes("the-real-thing");
      const salt = ethers.id("salt-1");
      const commit = ethers.keccak256(ethers.solidityPacked(["bytes", "bytes32"], [deliverable, salt]));

      await ctx.escrow.connect(ctx.buyer).reject(intentId, commit);
      await ctx.escrow.connect(ctx.seller).commitRound1Seller(intentId, commit);
      await ctx.escrow.connect(ctx.buyer).revealRound2Buyer(intentId, deliverable, salt);
      await ctx.escrow.connect(ctx.seller).revealRound2Seller(intentId, deliverable, salt);

      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const sellerBefore = await ctx.usdc.balanceOf(ctx.seller.address);
      const platBefore = await ctx.usdc.balanceOf(ctx.platform.address);
      await expect(ctx.escrow.connect(ctx.sweeper).settleSchelling(intentId)).to.emit(
        ctx.escrow, "ClassBSettled"
      );
      const sellerAfter = await ctx.usdc.balanceOf(ctx.seller.address);
      const platAfter = await ctx.usdc.balanceOf(ctx.platform.address);

      // Seller: 900_000 (price-fee) + 200_000 (own stake) + 90_000 (90% buyer stake) = 1_190_000
      expect(sellerAfter - sellerBefore).to.equal(1_190_000n);
      // Platform: 100_000 (price fee) + 10_000 (10% buyer stake) = 110_000
      expect(platAfter - platBefore).to.equal(110_000n);
    });

    it("reject + commit-reveal HASH-MISMATCH → both stakes burn, buyer refunded price", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 2000);
      await ctx.escrow.connect(ctx.seller).deliver(intentId, "0x");

      const buyerDel = ethers.toUtf8Bytes("what-buyer-saw");
      const sellerDel = ethers.toUtf8Bytes("what-seller-claimed");
      const buyerSalt = ethers.id("b");
      const sellerSalt = ethers.id("s");
      const buyerCommit = ethers.keccak256(ethers.solidityPacked(["bytes", "bytes32"], [buyerDel, buyerSalt]));
      const sellerCommit = ethers.keccak256(ethers.solidityPacked(["bytes", "bytes32"], [sellerDel, sellerSalt]));

      await ctx.escrow.connect(ctx.buyer).reject(intentId, buyerCommit);
      await ctx.escrow.connect(ctx.seller).commitRound1Seller(intentId, sellerCommit);
      await ctx.escrow.connect(ctx.buyer).revealRound2Buyer(intentId, buyerDel, buyerSalt);
      await ctx.escrow.connect(ctx.seller).revealRound2Seller(intentId, sellerDel, sellerSalt);

      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      const burnBefore = await ctx.usdc.balanceOf(BURN);
      await expect(ctx.escrow.connect(ctx.sweeper).settleSchelling(intentId)).to.emit(
        ctx.escrow, "StakesBurned"
      );
      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);
      const burnAfter = await ctx.usdc.balanceOf(BURN);

      expect(buyerAfter - buyerBefore).to.equal(1_000_000n);
      expect(burnAfter - burnBefore).to.equal(300_000n); // 100k buyer + 200k seller
    });

    it("seller default at round 1 → buyer refunded + own stake; seller stake burns", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 2000);
      await ctx.escrow.connect(ctx.seller).deliver(intentId, "0x");
      const commit = ethers.keccak256(ethers.toUtf8Bytes("buyer-commit"));
      await ctx.escrow.connect(ctx.buyer).reject(intentId, commit);
      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      const burnBefore = await ctx.usdc.balanceOf(BURN);
      await ctx.escrow.connect(ctx.sweeper).settleSchelling(intentId);
      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);
      const burnAfter = await ctx.usdc.balanceOf(BURN);
      expect(buyerAfter - buyerBefore).to.equal(1_100_000n);
      expect(burnAfter - burnBefore).to.equal(200_000n);
    });

    it("buyer default at round 2 → seller paid + own stake; buyer stake burns", async function () {
      const ctx = await setupV2();
      const { intentId } = await createClassB(ctx);
      await ctx.escrow.connect(ctx.seller).acceptIntentB(intentId, 2000);
      await ctx.escrow.connect(ctx.seller).deliver(intentId, "0x");
      const commit = ethers.keccak256(ethers.toUtf8Bytes("buyer-commit"));
      await ctx.escrow.connect(ctx.buyer).reject(intentId, commit);
      await ctx.escrow.connect(ctx.seller).commitRound1Seller(intentId, ethers.keccak256(ethers.toUtf8Bytes("s")));

      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const sellerBefore = await ctx.usdc.balanceOf(ctx.seller.address);
      const burnBefore = await ctx.usdc.balanceOf(BURN);
      await ctx.escrow.connect(ctx.sweeper).settleSchelling(intentId);
      const sellerAfter = await ctx.usdc.balanceOf(ctx.seller.address);
      const burnAfter = await ctx.usdc.balanceOf(BURN);
      expect(sellerAfter - sellerBefore).to.equal(900_000n + 200_000n);
      expect(burnAfter - burnBefore).to.equal(100_000n);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("Class C — streaming", function () {
    async function createStream(ctx, perUnit, maxUnits) {
      perUnit = perUnit || 100_000n;
      maxUnits = maxUnits || 3n;
      const plaintext = ethers.toUtf8Bytes("unit-payload");
      const commitment = ethers.keccak256(plaintext);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);
      const expiresAt = BigInt((await getBlockTime()) + 3600);
      const tx = await ctx.escrow
        .connect(ctx.buyer)
        .createStreamingIntent(await ctx.hashPre.getAddress(), params, ZERO, perUnit, maxUnits, expiresAt);
      const rc = await tx.wait();
      const intentId = logArg(rc, "IntentCreated");
      return { intentId, plaintext };
    }

    it("per-unit settle in order; unused balance refunds on cancel", async function () {
      const ctx = await setupV2();
      const { intentId, plaintext } = await createStream(ctx);

      const sellerBefore = await ctx.usdc.balanceOf(ctx.seller.address);
      const platBefore = await ctx.usdc.balanceOf(ctx.platform.address);

      await ctx.escrow.connect(ctx.seller).claimUnit(intentId, 0, "0x", plaintext);
      await ctx.escrow.connect(ctx.seller).claimUnit(intentId, 1, "0x", plaintext);

      await expect(
        ctx.escrow.connect(ctx.seller).claimUnit(intentId, 3, "0x", plaintext)
      ).to.be.revertedWith("StreamingEngine: bad unit index");

      const buyerBefore = await ctx.usdc.balanceOf(ctx.buyer.address);
      await expect(ctx.escrow.connect(ctx.buyer).cancelStream(intentId)).to.emit(
        ctx.escrow, "StreamCancelled"
      );
      const buyerAfter = await ctx.usdc.balanceOf(ctx.buyer.address);

      expect(buyerAfter - buyerBefore).to.equal(100_000n);
      expect((await ctx.usdc.balanceOf(ctx.seller.address)) - sellerBefore).to.equal(180_000n);
      expect((await ctx.usdc.balanceOf(ctx.platform.address)) - platBefore).to.equal(20_000n);
    });

    it("stream owned by first claiming seller; otherSeller cannot pile on", async function () {
      const ctx = await setupV2();
      const { intentId, plaintext } = await createStream(ctx);
      await ctx.escrow.connect(ctx.seller).claimUnit(intentId, 0, "0x", plaintext);
      await expect(
        ctx.escrow.connect(ctx.otherSeller).claimUnit(intentId, 1, "0x", plaintext)
      ).to.be.revertedWith("Escrow: stream owned by another seller");
    });

    it("monotonic ordering: claim unit 0 must be claimed before unit 1", async function () {
      const ctx = await setupV2();
      const { intentId, plaintext } = await createStream(ctx);
      await expect(
        ctx.escrow.connect(ctx.seller).claimUnit(intentId, 1, "0x", plaintext)
      ).to.be.revertedWith("StreamingEngine: bad unit index");
    });

    it("cannot exceed maxUnits", async function () {
      const ctx = await setupV2();
      const { intentId, plaintext } = await createStream(ctx, 100_000n, 2n);
      await ctx.escrow.connect(ctx.seller).claimUnit(intentId, 0, "0x", plaintext);
      await ctx.escrow.connect(ctx.seller).claimUnit(intentId, 1, "0x", plaintext);
      await expect(
        ctx.escrow.connect(ctx.seller).claimUnit(intentId, 2, "0x", plaintext)
      ).to.be.revertedWith("StreamingEngine: max units reached");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("Invariants", function () {
    it("escrow has no admin / upgrade / addVerifier surface", async function () {
      const ctx = await setupV2();
      const names = ctx.escrow.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.not.include("upgrade");
      expect(names).to.not.include("addVerifier");
      expect(names).to.not.include("transferOwnership");
      expect(names).to.not.include("setPlatformFee");
    });

    it("escrow USDC balance returns to pre-deal level after N happy-path Class A claims", async function () {
      const ctx = await setupV2();
      const plaintext = ethers.toUtf8Bytes("invariant-test");
      const commitment = ethers.keccak256(plaintext);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);

      const startBal = await ctx.usdc.balanceOf(await ctx.escrow.getAddress());
      for (let i = 0; i < 5; i++) {
        const expiresAt = BigInt((await getBlockTime()) + 3600);
        const tx = await ctx.escrow.connect(ctx.buyer).createIntent(
          0, await ctx.hashPre.getAddress(), params, ZERO, 1_000_000n, expiresAt
        );
        const rc = await tx.wait();
        const id = logArg(rc, "IntentCreated");
        await ctx.escrow.connect(ctx.seller).claimIntent(id, "0x", plaintext);
      }
      const endBal = await ctx.usdc.balanceOf(await ctx.escrow.getAddress());
      expect(endBal).to.equal(startBal);
    });

    it("burn-to-dEaD destination is configured correctly", async function () {
      const ctx = await setupV2();
      expect(await ctx.escrow.burnTo()).to.equal(BURN);
    });

    it("predicateRegistry on escrow points at the deployed registry", async function () {
      const ctx = await setupV2();
      expect(await ctx.escrow.predicateRegistry()).to.equal(await ctx.registry.getAddress());
    });
  });
});
