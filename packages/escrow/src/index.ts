/**
 * @agentpact/escrow — TypeScript SDK for AgentPact on-chain escrow
 *
 * Supports: Base, Arbitrum, Optimism, Solana (via adapter)
 * Lifecycle: create → fund → accept | dispute → resolve | timeout-claim
 */
import { Contract, ethers } from 'ethers';
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
export const CHAIN_ADDRESSES: Record<string, Record<string, string>> = {
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
  private contract: Contract;

  constructor(config: EscrowConfig) {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.contract = new Contract(
      config.contractAddress,
      ESCROW_ABI,
      config.signer ?? provider,
    );
  }

  /** Create a funded milestone — buyer calls this */
  async createMilestone(params: CreateMilestoneParams): Promise<string> {
    const milestoneId = params.milestoneId ?? ethers.keccak256(
      ethers.toUtf8Bytes(params.dealId + ':' + Date.now())
    );
    const dealIdHash = ethers.keccak256(ethers.toUtf8Bytes(params.dealId));
    const tx = await this.contract.createMilestone(
      dealIdHash,
      milestoneId,
      params.seller,
      params.amount,
    );
    await tx.wait();
    return milestoneId;
  }

  /** Read milestone state */
  async getMilestone(milestoneId: string): Promise<Milestone> {
    const m = await this.contract.milestones(milestoneId);
    const statuses = ['Funded', 'Accepted', 'Disputed', 'Resolved'] as const;
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
  async acceptMilestone(milestoneId: string): Promise<void> {
    const tx = await this.contract.acceptMilestone(milestoneId);
    await tx.wait();
  }

  /** Open a dispute on a funded milestone */
  async openDispute(milestoneId: string): Promise<void> {
    const tx = await this.contract.openDispute(milestoneId);
    await tx.wait();
  }

  /** Resolve a dispute (platform/admin only) */
  async resolveDispute(milestoneId: string, refundBuyer: boolean): Promise<void> {
    const tx = await this.contract.resolveDispute(milestoneId, refundBuyer);
    await tx.wait();
  }

  /**
   * Seller claims after the 7-day no-action timeout. Matches the v1 escrow
   * ABI exactly — the on-chain function is named `claimAfterTimeout`.
   *
   * Naming history: the SDK shipped under the wrong name `claimTimeout`
   * (the ABI had `claimAfterTimeout` all along, so the old method reverted
   * at the contract boundary). settlement_2705 Phase E corrects the name
   * and keeps `claimTimeout` as a deprecated alias for backward-compat.
   */
  async claimAfterTimeout(milestoneId: string): Promise<void> {
    const tx = await this.contract.claimAfterTimeout(milestoneId);
    await tx.wait();
  }

  /**
   * @deprecated Use {@link claimAfterTimeout} — the old name called the
   * wrong contract function name and reverted. Remove in v2.1.
   */
  async claimTimeout(milestoneId: string): Promise<void> {
    return this.claimAfterTimeout(milestoneId);
  }

  /** Get the platform fee percent (BPS) */
  async getPlatformFee(): Promise<number> {
    return Number(await this.contract.platformFeePercent());
  }
}

export { ESCROW_ABI };
export default EscrowSDK;
