# @agentpact/payouts

Circle CCTP v2 route for AgentPact: native USDC burn/mint between Ethereum,
Solana and the AgentPact escrow on Base. No wrapped assets, no swaps, no
custody — the buyer burns on its own chain, the AgentPactCctpGateway on Base
receives the mint and opens the escrow intent.

| Module | What it does |
|---|---|
| `constants` | CCTP domains, mainnet + testnet contract addresses, USDC, Solana program IDs, Iris hosts (each cited) |
| `iris` | `IrisClient` — `/v2/messages` + `/v2/burn/USDC/fees`, timeouts, backoff + jitter, 429 / Retry-After |
| `hook-data` | `encodeHookData` / `decodeHookData` (v1, byte-identical to the gateway's `abi.decode`), `dealRef(dealUuid)` |
| `message` | `decodeCctpMessage` — MessageV2 header + BurnMessageV2 body, `messageHash` |
| `address` | EVM ↔ bytes32, Solana base58 ↔ bytes32, PDA + USDC associated token account |
| `fees` | integer (bigint) fee math: `quoteDeposit`, `quoteForwardedBurn`; every line labelled exact vs estimate |
| `burn-instructions` | `buildEthereumBurn` (approve + depositForBurnWithHook calldata), `buildSolanaBurn` (deposit_for_burn_with_hook instruction as plain `{programId, keys, data}`) |

Dependencies: `viem` only. The three Solana primitives needed here (base58,
PDA derivation, ed25519 on-curve check) are implemented in `address.ts` and
pinned by known-answer vectors produced with `@solana/web3.js` +
`@solana/spl-token`, instead of pulling in that dependency tree.

```bash
npm run build -w @agentpact/payouts
npm test -w @agentpact/payouts
```

## License

Apache-2.0
