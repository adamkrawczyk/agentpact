# Verifying AgentPactEscrow on BaseScan

This document captures the exact recipe used to verify the deployed
`AgentPactEscrow` contract on BaseScan, so future redeploys can be verified
without re-deriving every step.

## Quick recipe (deployed contract)

```bash
# 1. Set up env
export BASESCAN_API_KEY=<key from BW item `basescan-api-key(etherscan)`>

# 2. Pin OpenZeppelin to the version that was in `node_modules` at deploy time
#    (current deploy: OZ 5.4.0). If your local `node_modules/@openzeppelin/contracts`
#    is on a different patch, the bytecode WILL mismatch even though the source is
#    byte-identical. Verify with:
#       cat node_modules/@openzeppelin/contracts/package.json | grep version
#    If you need to pin temporarily:
#       npm install --no-save @openzeppelin/contracts@5.4.0
#    Then `npm install` afterwards to restore the lockfile state.

# 3. Check out the contract source from the deploy commit
#    (current deploy commit: f433f07c, but PR #21 shipped a CEI-fix patch
#    AFTER deploy. Verify against the source that was on-chain at deploy time.)
git checkout f433f07c -- contracts/AgentPactEscrow.sol
rm -rf cache artifacts

# 4. Run hardhat verify against Base mainnet
npx hardhat verify --network base \
  0x588168712bF758aFD747bF46471afa53f9599A64 \
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" \
  "0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4" \
  10

# 5. Restore working tree
git checkout main -- contracts/AgentPactEscrow.sol
```

Expected success: `Successfully verified contract AgentPactEscrow on the block explorer.`

## Constructor arguments

The escrow constructor takes three arguments in this order:

| # | Name | Value (live) | Notes |
|---|---|---|---|
| 1 | `_usdc` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Base mainnet USDC contract |
| 2 | `_platformWallet` | `0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4` | Receives platform fees |
| 3 | `_platformFeePercent` | `10` | 10 → 10% (uint256) |

These values can be re-derived from the deploy transaction if ever lost:

```bash
TXHASH=0xdea40a709b38d461e30e3e34d47ffff950128fd5cb0268ff67274cff33e2e67f
curl -s -X POST "$RPC_URL" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$TXHASH\"]}" \
  | jq -r .result.input \
  | tail -c 384   # last 3x 32-byte words = constructor args
```

The deploy transaction hash is also visible on BaseScan under "Contract Creator"
on the contract's address page.

## After a redeploy (new contract address)

After PR #21's CEI fix lands on-chain via redeploy, repeat the recipe with the
new address. Steps:

1. Get the new deployment tx hash from the deploy script output, or via
   BaseScan "Contract Creator" link.
2. Verify constructor args match what `scripts/deploy-escrow.cjs` was invoked with.
3. The source to verify against is the current `main` (post-PR-#21) — no need
   to checkout an older commit.
4. Update `apps/api/src/chain.ts` `ESCROW_ADDRESS` AND the
   `ESCROW_CONTRACT_ADDRESS` env var on Railway, then redeploy the API.
5. The symmetry contract test in
   `apps/api/src/__tests__/config-addresses.test.ts` will catch any drift
   between SDK consumers and the API's notion of the live address.

## hardhat.config.cjs etherscan block

The `etherscan` config is wired against the Etherscan v2 unified API. A single
BaseScan-issued API key (which IS an Etherscan-account key under the hood)
works for all supported chains. Per-network keys are still supported via the
v1 API but were deprecated effective 2025-05-31 — do not rely on them.

## Verified contract page

https://basescan.org/address/0x588168712bF758aFD747bF46471afa53f9599A64#code

Verified 2026-05-25. Hardhat-verify confirmation:
`Successfully verified contract AgentPactEscrow on the block explorer.`
