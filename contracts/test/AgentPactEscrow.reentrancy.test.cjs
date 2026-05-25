/**
 * Reentrancy + CEI ordering regression tests for AgentPactEscrow.
 *
 * Pins the post-mortem invariants from the 2026-05-25 CEI fix:
 *   - openDispute() carries nonReentrant
 *   - createMilestone() writes the milestone struct BEFORE the external
 *     usdc.transferFrom call (defensive against cross-function reentrancy
 *     via a hostile USDC implementation)
 *
 * These are the invariants Slither's reentrancy-no-eth detector enforces.
 * Goal: keep `npx slither . --filter-paths "node_modules|test|MockUSDC"`
 * at 0 HIGH and 0 MEDIUM findings.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

describe("AgentPactEscrow — reentrancy + CEI invariants (regression)", function () {
  let escrow;
  let usdc;
  let platform;
  let buyer;
  let seller;

  const PLATFORM_FEE = 10;
  const MILESTONE_AMOUNT = ethers.parseUnits("100", 6);

  beforeEach(async function () {
    [platform, buyer, seller] = await ethers.getSigners();

    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDCFactory.deploy();

    const Escrow = await ethers.getContractFactory("AgentPactEscrow");
    escrow = await Escrow.deploy(await usdc.getAddress(), platform.address, PLATFORM_FEE);

    await usdc.mint(buyer.address, ethers.parseUnits("1000", 6));
    await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  it("openDispute is nonReentrant (source-level check)", function () {
    // We can't trigger reentrancy from outside a hostile token, so pin the
    // source attribute. ABI doesn't expose modifiers — read the .sol file.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../AgentPactEscrow.sol"),
      "utf-8"
    );
    // The openDispute signature on one line must carry nonReentrant.
    const match = src.match(/function\s+openDispute\s*\([^)]*\)\s*external\s+(\w+)/);
    expect(match, "openDispute signature should match `external <modifier>`").to.not.be.null;
    expect(match[1]).to.equal(
      "nonReentrant",
      "openDispute must carry the nonReentrant modifier (regression: 2026-05-25 CEI fix)"
    );
  });

  it("createMilestone writes state BEFORE the external transferFrom call (CEI)", function () {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../AgentPactEscrow.sol"),
      "utf-8"
    );
    // Find the line numbers of the two anchor statements anywhere in the file.
    // CEI invariant: the state write must appear at a smaller character offset
    // than the external call. We assert against the FIRST occurrence of each
    // inside createMilestone (rather than splitting on "function ", which is
    // brittle if any comment or string contains that word — bit us once).
    const fnStart = src.indexOf("function createMilestone");
    expect(fnStart, "createMilestone declaration found").to.be.greaterThan(-1);

    // The function body ends at its closing brace. We scan forward from fnStart
    // to find the matching `}` by brace counting.
    let depth = 0;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = fnStart; i < src.length; i++) {
      if (src[i] === "{") {
        if (depth === 0) bodyStart = i;
        depth += 1;
      } else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    expect(bodyStart, "createMilestone body { found").to.be.greaterThan(-1);
    expect(bodyEnd, "createMilestone body } found").to.be.greaterThan(bodyStart);

    const body = src.slice(bodyStart, bodyEnd);
    const milestoneAssignIdx = body.indexOf("milestones[milestoneId] = Milestone({");
    const externalCallIdx = body.indexOf("usdc.transferFrom(");
    expect(milestoneAssignIdx, "milestone struct assignment found in body").to.be.greaterThan(-1);
    expect(externalCallIdx, "usdc.transferFrom call found in body").to.be.greaterThan(-1);
    expect(milestoneAssignIdx).to.be.lessThan(
      externalCallIdx,
      "createMilestone must write `milestones[id] = Milestone({...})` BEFORE the external usdc.transferFrom call (CEI ordering, regression: 2026-05-25 Slither fix)"
    );
  });

  it("happy path still works after CEI re-ordering", async function () {
    const dealId = ethers.encodeBytes32String("regress-deal");
    const milestoneId = ethers.encodeBytes32String("regress-ms");

    // Buyer creates and funds in one call (no behavior regression from re-order).
    await escrow.connect(buyer).createMilestone(
      dealId, milestoneId, seller.address, MILESTONE_AMOUNT
    );

    // Milestone is funded with the right amount
    const ms = await escrow.milestones(milestoneId);
    expect(ms.amount).to.equal(MILESTONE_AMOUNT);
    expect(ms.buyer).to.equal(buyer.address);
    expect(ms.seller).to.equal(seller.address);
    expect(ms.status).to.equal(0); // Funded

    // USDC moved into escrow
    const escrowBal = await usdc.balanceOf(await escrow.getAddress());
    expect(escrowBal).to.equal(MILESTONE_AMOUNT);

    // Dispute still works (now nonReentrant)
    await escrow.connect(buyer).openDispute(milestoneId);
    const ms2 = await escrow.milestones(milestoneId);
    expect(ms2.status).to.equal(2); // Disputed
  });

  it("openDispute rejects non-buyer (auth invariant unchanged)", async function () {
    const dealId = ethers.encodeBytes32String("auth-deal");
    const milestoneId = ethers.encodeBytes32String("auth-ms");

    await escrow.connect(buyer).createMilestone(
      dealId, milestoneId, seller.address, MILESTONE_AMOUNT
    );

    await expect(
      escrow.connect(seller).openDispute(milestoneId)
    ).to.be.revertedWith("Only buyer can dispute");
  });
});
