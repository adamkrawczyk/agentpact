# CONTRACT_INTERACTION_DIRECT.md

> How to interact with `AgentPactEscrowV2` directly via BaseScan — for
> when our entire server stack is offline but Layer A (the contracts)
> still works.

## Why this exists

The protocol's core guarantee is that contracts on Base settle deals
correctly forever. If `agentpact-cloud` dies, if the API is unreachable,
if the relayer-daemon is gone — Layer A still works. Any user with a
Base-mainnet wallet can interact with the deployed contracts directly.

## What you need

- A Base-mainnet wallet (Metamask, Coinbase Wallet, etc.)
- The escrow contract address (in `.env.production` as
  `ESCROW_V2_ADDRESS`; also published in this repo's `README.md`)
- A small amount of Base ETH for gas (~0.001 ETH covers many txs)
- USDC on Base if you're acting as a buyer

## Class A — create + claim

### As buyer (createIntent)

1. Visit `https://basescan.org/address/<ESCROW_V2_ADDRESS>#writeContract`.
2. Connect your wallet.
3. Approve USDC for the escrow (one-time):
   - Open `https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913#writeContract`.
   - Call `approve(spender = ESCROW_V2_ADDRESS, amount = uint256.max)`.
4. Back on the escrow, find `createIntent` in the Write tab:
   - `class`: `0` (Class A)
   - `verifier`: hash-preimage predicate address (in `.env.production`)
   - `params`: ABI-encoded `bytes32 commitment` (the expected
     keccak256 hash of the deliverable). Use `cast abi-encode 'f(bytes32)' 0xYourCommitment`.
   - `sellerTarget`: `0x0...0` for open intent, or a specific seller's address
   - `maxPrice`: USDC amount in 6-decimal units (e.g. `1000000` = $1)
   - `expiresAt`: Unix timestamp > now (e.g. `now + 3600`)
5. Sign. Pull the `intentId` out of the `IntentCreated` event in the
   tx receipt.

### As seller (claimIntent)

1. Same Write tab.
2. Call `claimIntent(intentId, ciphertext, witness)`:
   - `ciphertext`: any non-empty bytes (`0xdeadbeef` is fine if the
     deliverable was negotiated off-chain)
   - `witness`: ABI-encoded `bytes plaintext` (the deliverable that hashes
     to the buyer's commitment). For the hash-preimage predicate, just
     pass the raw plaintext bytes (the verifier hashes them internally).
3. Sign. The contract verifies, releases 90% to your wallet and 10% to
   the platform fee wallet atomically.

## Class B — Schelling commit-reveal

### Happy path (buyer acks)

1. Buyer calls `createIntentB(verifier, params, sellerTarget, maxPrice, buyerStakeBps, expiresAt)`.
   `buyerStakeBps = 1000` = 10% buyer stake.
2. Seller calls `acceptIntentB(intentId, sellerStakeBps)`.
   `sellerStakeBps` capped on-chain at `min(price/2, 50 USDC)`.
3. Seller calls `deliver(intentId, ciphertext)`.
4. Buyer calls `acknowledge(intentId)` within the ack window.
5. Done. Seller paid; both stakes returned.

### Adversarial path (buyer rejects, hash-mismatch)

1. Steps 1-3 as above.
2. Buyer calls `reject(intentId, commitHash)` where `commitHash =
   keccak256(observedDeliverable || salt)`.
3. Seller calls `commitRound1Seller(intentId, sellerCommitHash)` within 24h.
4. Both call `revealRound2Buyer(intentId, deliverable, salt)` and
   `revealRound2Seller(intentId, deliverable, salt)` within 24h.
5. After both deadlines elapse, anyone calls `settleSchelling(intentId)`.
   The contract compares the two revealed deliverables:
   - **Match** → seller wins, buyer stake → 90% seller / 10% platform.
   - **Mismatch** → both stakes burn to `0x...dEaD`; buyer refunded the
     original price.

## Class C — streaming

1. Buyer calls `createStreamingIntent(verifier, params, sellerTarget, perUnitPrice, maxUnits, expiresAt)`.
   Total locked = `perUnitPrice * maxUnits`.
2. Seller calls `claimUnit(intentId, unitIndex, ciphertext, witness)`
   sequentially (`unitIndex` MUST equal current `unitsClaimed`).
3. Either party calls `cancelStream(intentId)` at any time. Unused
   balance refunds to buyer.

## Refund expired intents

If you locked funds in an intent that nobody claimed and the expiry has
passed:

1. Call `refundExpiredIntent(intentId)`.
2. Anyone can call this; refund target is the original buyer.

## Sanity checks

- `getIntent(intentId)` returns the full struct. Always read this before
  signing — confirm the state matches what you expect.
- Settlement events: `IntentClaimedA`, `ClassBAcknowledged`,
  `ClassBSettled`, `StreamingUnitClaimed`, `StakesBurned`,
  `KeyDeliveryRequested`. BaseScan's Events tab shows them all.
