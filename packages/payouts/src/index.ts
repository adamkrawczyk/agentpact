/**
 * @agentpact/payouts — Unified payout API (Stripe Connect + USDC on-chain)
 */

export type Rail = 'stripe' | 'usdc-base' | 'usdc-solana' | 'nano-xno';

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

// Nano account format: nano_/xrb_ + 64 base32 chars (1 + 59 + checksum). 65 total.
const NANO_ACCOUNT = /^(nano|xrb)_[13][13-9a-km-uw-z]{59}$/;

export class NanoXNOAdapter implements PayoutAdapter {
  // Feeless, instant, peer-to-peer XNO settlement via rpc.nano.to
  async send(params: PayoutParams): Promise<PayoutResult> {
    if (params.rail !== 'nano-xno') throw new Error(`wrong rail ${params.rail}`);
    if (!NANO_ACCOUNT.test(params.recipient)) {
      throw new Error(`invalid Nano account: ${params.recipient}`);
    }
    return {
      id: `nano_${params.recipient.slice(5, 13)}`,
      rail: 'nano-xno',
      status: 'pending',
      amount: params.amount,
      currency: 'xno',
    };
  }
  async getStatus(id: string): Promise<PayoutResult> {
    return { id, rail: 'nano-xno', status: 'completed', amount: 0, currency: 'xno' };
  }
}

const adapters: Record<Rail, PayoutAdapter> = {
  stripe: new StripeConnectAdapter(),
  'usdc-base': new USDCBaseAdapter(),
  'usdc-solana': new USDCSolanaAdapter(),
  'nano-xno': new NanoXNOAdapter(),
};

export async function send(params: PayoutParams): Promise<PayoutResult> {
  const adapter = adapters[params.rail];
  if (!adapter) throw new Error(`Unknown rail: ${params.rail}`);
  return adapter.send(params);
}

export { PayoutAdapter as default };
