const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentPactEscrow", function () {
  let escrow;
  let usdc;
  let platform;
  let buyer;
  let seller;

  const PLATFORM_FEE = 10;
  const MILESTONE_AMOUNT = ethers.parseUnits("100", 6);
  const PLATFORM_FEE_AMOUNT = (MILESTONE_AMOUNT * BigInt(PLATFORM_FEE)) / BigInt(100);

  beforeEach(async function () {
    [platform, buyer, seller] = await ethers.getSigners();

    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDCFactory.deploy();

    const Escrow = await ethers.getContractFactory("AgentPactEscrow");
    escrow = await Escrow.deploy(await usdc.getAddress(), platform.address, PLATFORM_FEE);

    await usdc.mint(buyer.address, ethers.parseUnits("1000", 6));
    await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  describe("Milestone Creation", function () {
    it("should create milestone with correct amount", async function () {
      const dealId = ethers.encodeBytes32String("deal1");
      const milestoneId = ethers.encodeBytes32String("milestone1");

      await escrow.connect(buyer).createMilestone(dealId, milestoneId, seller.address, MILESTONE_AMOUNT);

      const milestone = await escrow.milestones(milestoneId);
      expect(milestone.amount).to.equal(MILESTONE_AMOUNT);
      expect(milestone.seller).to.equal(seller.address);
      expect(milestone.status).to.equal(0n);
    });

    it("should transfer USDC from buyer to contract", async function () {
      const dealId = ethers.encodeBytes32String("deal1");
      const milestoneId = ethers.encodeBytes32String("milestone1");
      const buyerBalanceBefore = await usdc.balanceOf(buyer.address);

      await escrow.connect(buyer).createMilestone(dealId, milestoneId, seller.address, MILESTONE_AMOUNT);

      const buyerBalanceAfter = await usdc.balanceOf(buyer.address);
      expect(buyerBalanceBefore - buyerBalanceAfter).to.equal(MILESTONE_AMOUNT);
    });
  });

  describe("Milestone Acceptance", function () {
    let dealId;
    let milestoneId;

    beforeEach(async function () {
      dealId = ethers.encodeBytes32String("deal1");
      milestoneId = ethers.encodeBytes32String("milestone1");
      await escrow.connect(buyer).createMilestone(dealId, milestoneId, seller.address, MILESTONE_AMOUNT);
    });

    it("should allow buyer to accept delivery", async function () {
      await escrow.connect(buyer).acceptMilestone(milestoneId);

      const milestone = await escrow.milestones(milestoneId);
      expect(milestone.status).to.equal(1n);
    });

    it("should transfer 90% to seller and 10% to platform", async function () {
      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      const platformBalanceBefore = await usdc.balanceOf(platform.address);

      await escrow.connect(buyer).acceptMilestone(milestoneId);

      const sellerBalanceAfter = await usdc.balanceOf(seller.address);
      const platformBalanceAfter = await usdc.balanceOf(platform.address);

      const expectedSellerAmount = MILESTONE_AMOUNT - PLATFORM_FEE_AMOUNT;
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedSellerAmount);
      expect(platformBalanceAfter - platformBalanceBefore).to.equal(PLATFORM_FEE_AMOUNT);
    });

    it("should revert if non-buyer tries to accept", async function () {
      await expect(escrow.connect(seller).acceptMilestone(milestoneId)).to.be.revertedWith("Only buyer can accept");
    });
  });

  describe("Dispute Resolution", function () {
    let dealId;
    let milestoneId;

    beforeEach(async function () {
      dealId = ethers.encodeBytes32String("deal1");
      milestoneId = ethers.encodeBytes32String("milestone1");
      await escrow.connect(buyer).createMilestone(dealId, milestoneId, seller.address, MILESTONE_AMOUNT);
    });

    it("should allow buyer to open dispute", async function () {
      await escrow.connect(buyer).openDispute(milestoneId);

      const milestone = await escrow.milestones(milestoneId);
      expect(milestone.status).to.equal(2n);
    });

    it("should allow platform to resolve dispute (refund)", async function () {
      await escrow.connect(buyer).openDispute(milestoneId);

      const buyerBalanceBefore = await usdc.balanceOf(buyer.address);
      await escrow.connect(platform).resolveDispute(milestoneId, true);
      const buyerBalanceAfter = await usdc.balanceOf(buyer.address);

      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(MILESTONE_AMOUNT);
    });

    it("should allow platform to resolve dispute (pay seller)", async function () {
      await escrow.connect(buyer).openDispute(milestoneId);

      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      const platformBalanceBefore = await usdc.balanceOf(platform.address);

      await escrow.connect(platform).resolveDispute(milestoneId, false);

      const sellerBalanceAfter = await usdc.balanceOf(seller.address);
      const platformBalanceAfter = await usdc.balanceOf(platform.address);

      const expectedSellerAmount = MILESTONE_AMOUNT - PLATFORM_FEE_AMOUNT;
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedSellerAmount);
      expect(platformBalanceAfter - platformBalanceBefore).to.equal(PLATFORM_FEE_AMOUNT);
    });
  });

  describe("Auto-Release After Timeout", function () {
    it("should allow seller to claim after 7 days if no acceptance/dispute", async function () {
      const dealId = ethers.encodeBytes32String("deal1");
      const milestoneId = ethers.encodeBytes32String("milestone1");

      await escrow.connect(buyer).createMilestone(dealId, milestoneId, seller.address, MILESTONE_AMOUNT);

      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      await escrow.connect(seller).claimAfterTimeout(milestoneId);
      const sellerBalanceAfter = await usdc.balanceOf(seller.address);

      const expectedAmount = MILESTONE_AMOUNT - PLATFORM_FEE_AMOUNT;
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedAmount);
    });

    it("should revert if timeout not reached", async function () {
      const dealId = ethers.encodeBytes32String("deal1");
      const milestoneId = ethers.encodeBytes32String("milestone1");

      await escrow.connect(buyer).createMilestone(dealId, milestoneId, seller.address, MILESTONE_AMOUNT);

      await expect(escrow.connect(seller).claimAfterTimeout(milestoneId)).to.be.revertedWith("Timeout not reached");
    });
  });
});
