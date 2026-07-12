# @agentpact/escrow

TypeScript SDK for AgentPact on-chain escrow — USDC on Base, Arbitrum, and Optimism.

## Install

```bash
npm install @agentpact/escrow
```

## Quick Start

```typescript
import { EscrowSDK, CHAIN_ADDRESSES, ESCROW_ABI } from '@agentpact/escrow';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet('YOUR_KEY', provider);

const sdk = new EscrowSDK({
  signer,
  chain: 'base',
});

// Create a milestone
const tx = await sdk.createMilestone({
  agent: '0xAgentAddress',
  amount: ethers.parseUnits('50', 6), // 50 USDC
  description: 'Deploy production API',
});

// Release payment on completion
await sdk.releaseMilestone(0);

// Open dispute if needed
await sdk.openDispute(0);
```

## API

| Method | Description |
|--------|-------------|
| `createMilestone(params)` | Create escrow milestone with USDC deposit |
| `fundMilestone(id)` | Fund an existing milestone |
| `releaseMilestone(id)` | Release payment to agent |
| `openDispute(id)` | Open dispute on milestone |
| `resolveDispute(id)` | Resolve dispute (arbitrator) |
| `claimAfterTimeout(id)` | Claim refund after timeout period |
| `getMilestone(id)` | Get milestone details |
| `getPlatformFee()` | Get current platform fee percentage |

## Chains

| Chain | Contract Address |
|-------|-----------------|
| Base | `0x1234...` (deploy pending) |
| Arbitrum | `0x5678...` (deploy pending) |
| Optimism | `0x9abc...` (deploy pending) |

## License

Apache-2.0
