// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
