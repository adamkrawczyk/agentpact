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
| `nano-xno` | Stub (inert) | Nano (XNO), feeless. Not implemented, see below |

## API

| Function | Description |
|----------|-------------|
| `send(params)` | Send a payout via specified rail |
| `StripeConnectAdapter` | Stripe Connect adapter class |
| `USDCBaseAdapter` | USDC on Base adapter class |
| `USDCSolanaAdapter` | USDC on Solana adapter class |
| `NanoXNOAdapter` | Nano (XNO) adapter class (inert stub) |
| `isValidNanoAccount(account)` | Nano address check, including the blake2b checksum |
| `xnoToRaw(xno)` / `rawToXno(raw)` / `parseRaw(raw)` | Exact XNO/raw conversion (bigint) |

## Nano (XNO) rail: unimplemented stub

`nano-xno` is an explicitly inert stub. `NanoXNOAdapter.send()` never sends
anything and never returns a payout: it validates its input and then always
rejects with `NanoXNOAdapter not implemented`. `getStatus()` always rejects
with `Not implemented`. No caller can be told a Nano payout is pending or
completed.

What it does validate, in order:

- `rail` must be `nano-xno`.
- `recipient` must be a Nano account: `nano_` (or legacy `xrb_`) followed by
  60 base32 characters from `13456789abcdefghijkmnopqrstuwxyz`: 52 encode the
  32-byte public key, 8 encode a checksum. The checksum (the 5-byte blake2b
  digest of the public key, byte-reversed) is verified, so a typo'd address is
  refused.
- `amountRaw` must be present and greater than 0.

### Amount semantics

The shared `amount` field is a JS `number` (cents / micro-USDC). Nano amounts
are integers of **raw**, with 1 XNO = 10^30 raw and a 128-bit ceiling, which a
`number` cannot represent exactly. So this rail does not read `amount` at all:

- `amountRaw` is the amount in raw, as a decimal integer string
  (no sign, exponent, decimal point or leading zeros; at most 2^128 - 1).
- In code, raw is a `bigint`. `xnoToRaw('1.5')` gives `1500000000000000000000000000000n`
  and `rawToXno(1n)` gives `'0.000000000000000000000000000001'`.
- An XNO string with more than 30 decimals is refused, never rounded, and a
  JS `number` is refused rather than converted.

Before real sends could be added, a later change would also need key custody
and signing boundaries, replay-safe idempotency, and status reconciliation.

## License

Apache-2.0
