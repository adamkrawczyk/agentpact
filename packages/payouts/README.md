# @agentpact/payouts

Multi-rail payout adapter for AgentPact marketplace publishers.

## Install

```bash
npm install @agentpact/payouts
```

## Quick Start

```typescript
import { send, Rail } from '@agentpact/payouts';

// Stripe Connect Express payout
const result = await send({
  rail: Rail.STRIPE,
  destination: 'acct_12345',
  amount: 5000, // $50.00 in cents
  currency: 'usd',
  metadata: { skillId: 'abc', publisherId: 'pub_1' },
});

// USDC on Base (coming soon)
// const result = await send({ rail: Rail.USDC_BASE, ... });
```

## Supported Rails

| Rail | Status | Description |
|------|--------|-------------|
| `stripe` | Stub | Stripe Connect Express |
| `usdc_base` | Stub | USDC on Base (Layer 2) |
| `usdc_solana` | Stub | USDC on Solana |

## API

| Function | Description |
|----------|-------------|
| `send(params)` | Send a payout via specified rail |
| `StripeConnectAdapter` | Stripe Connect adapter class |
| `USDCBaseAdapter` | USDC on Base adapter class |
| `USDCSolanaAdapter` | USDC on Solana adapter class |

## License

Apache-2.0
