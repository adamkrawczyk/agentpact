# Codex Step 1: Smart Contracts (USDC Escrow)

## Objective
Create Solidity smart contracts for AgentPact with:
- USDC escrow for milestone-based payments
- 10% platform fee distribution
- Dispute resolution mechanism
- 7-day timeout for disputes

## TDD Approach

### 1. Set Up Hardhat Environment

```bash
cd /home/adam/repos/agentpact
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox @nomicfoundation/hardhat-chai-matchers chai ethers
npx hardhat init
# Select: "Create a TypeScript project"
```

### 2. Create Test File FIRST (Red Phase)

Create `contracts/test/AgentPactEscrow.test.ts`:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentPactEscrow, MockUSDC } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgentPactEscrow", function () {
  let escrow: AgentPactEscrow;
  let usdc: MockUSDC;
  let platform: SignerWithAddress;
  let buyer: SignerWithAddress;
  let seller: SignerWithAddress;
  
  const PLATFORM_FEE = 10; // 10%
  const MILESTONE_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC
  const PLATFORM_FEE_AMOUNT = MILESTONE_AMOUNT * BigInt(PLATFORM_FEE) / BigInt(100);
  
  beforeEach(async function () {
    [platform, buyer, seller] = await ethers.getSigners();
    
    // Deploy mock USDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    
    // Deploy escrow
    const Escrow = await ethers.getContractFactory("AgentPactEscrow");
    escrow = await Escrow.deploy(await usdc.getAddress(), platform.address, PLATFORM_FEE);
    
    // Mint USDC to buyer
    await usdc.mint(buyer.address, ethers.parseUnits("1000", 6));
    await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  describe("Milestone Creation", function () {
    it("should create milestone with correct amount", async function () {
      const dealId = ethers.encodeBytes32String("deal1");
      const milestoneId = ethers.encodeBytes32String("milestone1");
      
      await escrow.connect(buyer).createMilestone(
        dealId,
        milestoneId,
        seller.address,
        MILESTONE_AMOUNT
      );
      
      const milestone = await escrow.milestones(milestoneId);
      expect(milestone.amount).to.equal(MILESTONE_AMOUNT);
      expect(milestone.seller).to.equal(seller.address);
      expect(milestone.status).to.equal(0); // Funded
    });
    
    it("should transfer USDC from buyer to contract", async function () {
      const dealId = ethers.encodeBytes32String("deal1");
      const milestoneId = ethers.encodeBytes32String("milestone1");
      const buyerBalanceBefore = await usdc.balanceOf(buyer.address);
      
      await escrow.connect(buyer).createMilestone(
        dealId,
        milestoneId,
        seller.address,
        MILESTONE_AMOUNT
      );
      
      const buyerBalanceAfter = await usdc.balanceOf(buyer.address);
      expect(buyerBalanceBefore - buyerBalanceAfter).to.equal(MILESTONE_AMOUNT);
    });
  });
  
  describe("Milestone Acceptance", function () {
    let dealId: string;
    let milestoneId: string;
    
    beforeEach(async function () {
      dealId = ethers.encodeBytes32String("deal1");
      milestoneId = ethers.encodeBytes32String("milestone1");
      await escrow.connect(buyer).createMilestone(
        dealId,
        milestoneId,
        seller.address,
        MILESTONE_AMOUNT
      );
    });
    
    it("should allow buyer to accept delivery", async function () {
      await escrow.connect(buyer).acceptMilestone(milestoneId);
      
      const milestone = await escrow.milestones(milestoneId);
      expect(milestone.status).to.equal(1); // Accepted
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
      await expect(
        escrow.connect(seller).acceptMilestone(milestoneId)
      ).to.be.revertedWith("Only buyer can accept");
    });
  });
  
  describe("Dispute Resolution", function () {
    let dealId: string;
    let milestoneId: string;
    
    beforeEach(async function () {
      dealId = ethers.encodeBytes32String("deal1");
      milestoneId = ethers.encodeBytes32String("milestone1");
      await escrow.connect(buyer).createMilestone(
        dealId,
        milestoneId,
        seller.address,
        MILESTONE_AMOUNT
      );
    });
    
    it("should allow buyer to open dispute", async function () {
      await escrow.connect(buyer).openDispute(milestoneId);
      
      const milestone = await escrow.milestones(milestoneId);
      expect(milestone.status).to.equal(2); // Disputed
    });
    
    it("should allow platform to resolve dispute (refund)", async function () {
      await escrow.connect(buyer).openDispute(milestoneId);
      
      const buyerBalanceBefore = await usdc.balanceOf(buyer.address);
      await escrow.connect(platform).resolveDispute(milestoneId, true); // true = refund buyer
      const buyerBalanceAfter = await usdc.balanceOf(buyer.address);
      
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(MILESTONE_AMOUNT);
    });
    
    it("should allow platform to resolve dispute (pay seller)", async function () {
      await escrow.connect(buyer).openDispute(milestoneId);
      
      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      const platformBalanceBefore = await usdc.balanceOf(platform.address);
      
      await escrow.connect(platform).resolveDispute(milestoneId, false); // false = pay seller
      
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
      
      await escrow.connect(buyer).createMilestone(
        dealId,
        milestoneId,
        seller.address,
        MILESTONE_AMOUNT
      );
      
      // Fast forward 7 days
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
      
      await escrow.connect(buyer).createMilestone(
        dealId,
        milestoneId,
        seller.address,
        MILESTONE_AMOUNT
      );
      
      await expect(
        escrow.connect(seller).claimAfterTimeout(milestoneId)
      ).to.be.revertedWith("Timeout not reached");
    });
  });
});
```

### 3. Create Contract Implementation (Green Phase)

Create `contracts/AgentPactEscrow.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract AgentPactEscrow is ReentrancyGuard {
    IERC20 public immutable usdc;
    address public immutable platformWallet;
    uint256 public immutable platformFeePercent; // 10 = 10%
    
    enum MilestoneStatus { Funded, Accepted, Disputed, Resolved }
    
    struct Milestone {
        bytes32 dealId;
        address buyer;
        address seller;
        uint256 amount;
        MilestoneStatus status;
        uint256 createdAt;
    }
    
    mapping(bytes32 => Milestone) public milestones;
    
    uint256 public constant TIMEOUT_PERIOD = 7 days;
    
    event MilestoneCreated(bytes32 indexed milestoneId, bytes32 indexed dealId, address buyer, address seller, uint256 amount);
    event MilestoneAccepted(bytes32 indexed milestoneId, uint256 sellerAmount, uint256 platformFee);
    event DisputeOpened(bytes32 indexed milestoneId);
    event DisputeResolved(bytes32 indexed milestoneId, bool refundedBuyer, uint256 amount);
    event TimeoutClaimed(bytes32 indexed milestoneId, uint256 sellerAmount);
    
    constructor(address _usdc, address _platformWallet, uint256 _platformFeePercent) {
        require(_usdc != address(0), "Invalid USDC address");
        require(_platformWallet != address(0), "Invalid platform wallet");
        require(_platformFeePercent <= 100, "Fee too high");
        
        usdc = IERC20(_usdc);
        platformWallet = _platformWallet;
        platformFeePercent = _platformFeePercent;
    }
    
    function createMilestone(
        bytes32 dealId,
        bytes32 milestoneId,
        address seller,
        uint256 amount
    ) external nonReentrant {
        require(milestones[milestoneId].amount == 0, "Milestone exists");
        require(seller != address(0), "Invalid seller");
        require(amount > 0, "Invalid amount");
        
        // Transfer USDC from buyer to contract
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        
        milestones[milestoneId] = Milestone({
            dealId: dealId,
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            status: MilestoneStatus.Funded,
            createdAt: block.timestamp
        });
        
        emit MilestoneCreated(milestoneId, dealId, msg.sender, seller, amount);
    }
    
    function acceptMilestone(bytes32 milestoneId) external nonReentrant {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.buyer == msg.sender, "Only buyer can accept");
        require(milestone.status == MilestoneStatus.Funded, "Invalid status");
        
        milestone.status = MilestoneStatus.Accepted;
        
        uint256 platformFee = (milestone.amount * platformFeePercent) / 100;
        uint256 sellerAmount = milestone.amount - platformFee;
        
        require(usdc.transfer(milestone.seller, sellerAmount), "Seller transfer failed");
        require(usdc.transfer(platformWallet, platformFee), "Platform transfer failed");
        
        emit MilestoneAccepted(milestoneId, sellerAmount, platformFee);
    }
    
    function openDispute(bytes32 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.buyer == msg.sender, "Only buyer can dispute");
        require(milestone.status == MilestoneStatus.Funded, "Invalid status");
        
        milestone.status = MilestoneStatus.Disputed;
        emit DisputeOpened(milestoneId);
    }
    
    function resolveDispute(bytes32 milestoneId, bool refundBuyer) external nonReentrant {
        require(msg.sender == platformWallet, "Only platform can resolve");
        
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Disputed, "Not disputed");
        
        milestone.status = MilestoneStatus.Resolved;
        
        if (refundBuyer) {
            require(usdc.transfer(milestone.buyer, milestone.amount), "Refund failed");
            emit DisputeResolved(milestoneId, true, milestone.amount);
        } else {
            uint256 platformFee = (milestone.amount * platformFeePercent) / 100;
            uint256 sellerAmount = milestone.amount - platformFee;
            
            require(usdc.transfer(milestone.seller, sellerAmount), "Seller transfer failed");
            require(usdc.transfer(platformWallet, platformFee), "Platform transfer failed");
            
            emit DisputeResolved(milestoneId, false, sellerAmount);
        }
    }
    
    function claimAfterTimeout(bytes32 milestoneId) external nonReentrant {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.seller == msg.sender, "Only seller can claim");
        require(milestone.status == MilestoneStatus.Funded, "Invalid status");
        require(block.timestamp >= milestone.createdAt + TIMEOUT_PERIOD, "Timeout not reached");
        
        milestone.status = MilestoneStatus.Accepted;
        
        uint256 platformFee = (milestone.amount * platformFeePercent) / 100;
        uint256 sellerAmount = milestone.amount - platformFee;
        
        require(usdc.transfer(milestone.seller, sellerAmount), "Seller transfer failed");
        require(usdc.transfer(platformWallet, platformFee), "Platform transfer failed");
        
        emit TimeoutClaimed(milestoneId, sellerAmount);
    }
}
```

Create `contracts/MockUSDC.sol` (for testing):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    
    function decimals() public pure override returns (uint8) {
        return 6;
    }
    
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
```

### 4. Install Dependencies

```bash
npm install --save-dev @openzeppelin/contracts
```

### 5. Run Tests

```bash
npx hardhat test
```

Expected output: **All tests should PASS** ✅

### 6. Deploy Script

Create `scripts/deploy-escrow.ts`:

```typescript
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("Deploying contracts with account:", deployer.address);
  
  // Base mainnet USDC address
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const PLATFORM_WALLET = process.env.PLATFORM_WALLET!;
  const PLATFORM_FEE = 10; // 10%
  
  const Escrow = await ethers.getContractFactory("AgentPactEscrow");
  const escrow = await Escrow.deploy(USDC_ADDRESS, PLATFORM_WALLET, PLATFORM_FEE);
  
  await escrow.waitForDeployment();
  
  console.log("AgentPactEscrow deployed to:", await escrow.getAddress());
  console.log("Platform wallet:", PLATFORM_WALLET);
  console.log("Platform fee:", PLATFORM_FEE + "%");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### 7. Verify Deployment

After tests pass, update `apps/api/.env`:
```bash
ESCROW_CONTRACT_ADDRESS=<deployed_address>
```

### When Complete

Run this command:
```bash
openclaw gateway wake --text "Smart contracts complete! All tests passing ✅" --mode now
```

## Success Criteria

- ✅ All Hardhat tests pass
- ✅ Contract handles milestone creation
- ✅ 10% platform fee calculated correctly
- ✅ Dispute resolution works
- ✅ 7-day timeout implemented
- ✅ ReentrancyGuard protects all state changes
- ✅ Events emitted for all actions

## Notes

- Using Base network (lowest fees for USDC)
- MockUSDC for testing only (use real USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base)
- Tests use ethers.js v6 syntax
- All amounts in 6 decimals (USDC standard)
