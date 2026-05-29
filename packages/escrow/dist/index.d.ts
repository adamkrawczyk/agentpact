/**
 * @agentpact/escrow — TypeScript SDK for AgentPact on-chain escrow
 *
 * Supports: Base, Arbitrum, Optimism, Solana (via adapter)
 * Lifecycle: create → fund → accept | dispute → resolve | timeout-claim
 */
import { ethers } from 'ethers';
import ESCROW_ABI from './abi.js';
export interface EscrowConfig {
    rpcUrl: string;
    contractAddress: string;
    signer?: ethers.Signer;
}
export interface CreateMilestoneParams {
    dealId: string;
    seller: string;
    amount: bigint;
    milestoneId?: string;
}
export interface Milestone {
    dealId: string;
    buyer: string;
    seller: string;
    amount: bigint;
    status: 'Funded' | 'Accepted' | 'Disputed' | 'Resolved';
    createdAt: number;
}
/** Well-known contract addresses per chain (Base mainnet default) */
export declare const CHAIN_ADDRESSES: Record<string, Record<string, string>>;
export declare class EscrowSDK {
    private contract;
    constructor(config: EscrowConfig);
    /** Create a funded milestone — buyer calls this */
    createMilestone(params: CreateMilestoneParams): Promise<string>;
    /** Read milestone state */
    getMilestone(milestoneId: string): Promise<Milestone>;
    /** Buyer accepts delivered work — releases funds to seller (minus platform fee) */
    acceptMilestone(milestoneId: string): Promise<void>;
    /** Open a dispute on a funded milestone */
    openDispute(milestoneId: string): Promise<void>;
    /** Resolve a dispute (platform/admin only) */
    resolveDispute(milestoneId: string, refundBuyer: boolean): Promise<void>;
    /** Seller claims timeout after 7 days with no buyer action */
    claimTimeout(milestoneId: string): Promise<void>;
    /** Get the platform fee percent (BPS) */
    getPlatformFee(): Promise<number>;
}
export { ESCROW_ABI };
export default EscrowSDK;
