/**
 * @agentpact/escrow — TypeScript SDK for AgentPact on-chain escrow
 *
 * Supports: Base, Arbitrum, Optimism, Solana (via adapter)
 * Lifecycle: create → fund → accept | dispute → resolve | timeout-claim
 */
import { Contract, ethers } from 'ethers';
import ESCROW_ABI from './abi.js';
/** Well-known contract addresses per chain (Base mainnet default) */
export const CHAIN_ADDRESSES = {
    'base': {
        '8453': '0x0000000000000000000000000000000000000000', // TODO: deploy and fill
    },
    'arbitrum': {
        '42161': '0x0000000000000000000000000000000000000000',
    },
    'optimism': {
        '10': '0x0000000000000000000000000000000000000000',
    },
};
export class EscrowSDK {
    contract;
    constructor(config) {
        const provider = new ethers.JsonRpcProvider(config.rpcUrl);
        this.contract = new Contract(config.contractAddress, ESCROW_ABI, config.signer ?? provider);
    }
    /** Create a funded milestone — buyer calls this */
    async createMilestone(params) {
        const milestoneId = params.milestoneId ?? ethers.keccak256(ethers.toUtf8Bytes(params.dealId + ':' + Date.now()));
        const dealIdHash = ethers.keccak256(ethers.toUtf8Bytes(params.dealId));
        const tx = await this.contract.createMilestone(dealIdHash, milestoneId, params.seller, params.amount);
        await tx.wait();
        return milestoneId;
    }
    /** Read milestone state */
    async getMilestone(milestoneId) {
        const m = await this.contract.milestones(milestoneId);
        const statuses = ['Funded', 'Accepted', 'Disputed', 'Resolved'];
        return {
            dealId: m.dealId,
            buyer: m.buyer,
            seller: m.seller,
            amount: m.amount,
            status: statuses[m.status],
            createdAt: Number(m.createdAt),
        };
    }
    /** Buyer accepts delivered work — releases funds to seller (minus platform fee) */
    async acceptMilestone(milestoneId) {
        const tx = await this.contract.acceptMilestone(milestoneId);
        await tx.wait();
    }
    /** Open a dispute on a funded milestone */
    async openDispute(milestoneId) {
        const tx = await this.contract.openDispute(milestoneId);
        await tx.wait();
    }
    /** Resolve a dispute (platform/admin only) */
    async resolveDispute(milestoneId, refundBuyer) {
        const tx = await this.contract.resolveDispute(milestoneId, refundBuyer);
        await tx.wait();
    }
    /** Seller claims timeout after 7 days with no buyer action */
    async claimTimeout(milestoneId) {
        const tx = await this.contract.claimTimeout(milestoneId);
        await tx.wait();
    }
    /** Get the platform fee percent (BPS) */
    async getPlatformFee() {
        return Number(await this.contract.platformFeePercent());
    }
}
export { ESCROW_ABI };
export default EscrowSDK;
