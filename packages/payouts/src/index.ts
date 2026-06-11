/**
 * @agentpact/payouts — Unified payout API (Stripe Connect + USDC on-chain)
 */

export type Rail = 'stripe' | 'usdc-base' | 'usdc-solana';

export interface PayoutParams {
  recipient: string;       // Stripe account ID or wallet address
  amount: number;          // in smallest unit (cents for Stripe, microUSDC for on-chain)
  currency: string;        // 'usd', 'usdc'
  rail: Rail;
  metadata?: Record<string, string>;
}

export interface PayoutResult {
  id: string;
  rail: Rail;
  status: 'pending' | 'completed' | 'failed';
  amount: number;
  currency: string;
  txHash?: string;         // on-chain tx hash (for USDC rails)
  stripeTransferId?: string;
}

export interface PayoutAdapter {
  send(params: PayoutParams): Promise<PayoutResult>;
  getStatus(id: string): Promise<PayoutResult>;
}

// Placeholder adapters — build session fills in real implementations
export class StripeConnectAdapter implements PayoutAdapter {
  // TODO: implement with Stripe Connect Express
  async send(params: PayoutParams): Promise<PayoutResult> {
    throw new Error('StripeConnectAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

export class USDCBaseAdapter implements PayoutAdapter {
  // TODO: implement with ethers + USDC contract on Base
  async send(params: PayoutParams): Promise<PayoutResult> {
    throw new Error('USDCBaseAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

export class USDCSolanaAdapter implements PayoutAdapter {
  // TODO: implement with @solana/web3.js
  async send(params: PayoutParams): Promise<PayoutResult> {
    throw new Error('USDCSolanaAdapter not implemented');
  }
  async getStatus(id: string): Promise<PayoutResult> {
    throw new Error('Not implemented');
  }
}

const adapters: Record<Rail, PayoutAdapter> = {
  stripe: new StripeConnectAdapter(),
  'usdc-base': new USDCBaseAdapter(),
  'usdc-solana': new USDCSolanaAdapter(),
};

export async function send(params: PayoutParams): Promise<PayoutResult> {
  const adapter = adapters[params.rail];
  if (!adapter) throw new Error(`Unknown rail: ${params.rail}`);
  return adapter.send(params);
}

export { PayoutAdapter as default };
