# AgentPactCctpGateway — deposit binding threat model

Scope: `contracts/cctp/AgentPactCctpGateway.sol`, the Base contract that turns a Circle CCTP v2 burn on another chain into an `AgentPactEscrowV3` Class-A intent, refunds it after expiry, and forwards seller payouts cross-chain. The design is described in WHITEPAPER §10.6. Tests: `contracts/test/AgentPactCctpGateway.test.cjs` (unit + invariant) and `contracts/test/AgentPactCctpGateway.fork.test.cjs` (Base mainnet fork).

## Assets and actors

- **Asset:** USDC minted to the gateway, USDC locked in the escrow under the gateway as buyer of record, and seller shares routed through the gateway.
- **Buyer (remote chain):** writes `hookData` inside its own burn, which sets the deal binding, the price, the expiry and the refund address.
- **Relayer / anyone:** may call `relayDeposit`, `refund`, `claimAndForward`, `retryRejectedRefund` and `setPayoutRouteWithSig`. Assume this party is hostile.
- **Pauser (optional, immutable):** can pause and unpause new deposits, and nothing else.
- **Circle:** the attestation service and the CCTP contracts. They are trusted for message authenticity, replay protection and minting.

## Red-team cases

| # | Attack / failure | Outcome | Test |
|---|---|---|---|
| 1 | Replay an already-received message to mint twice or bind a second intent | `MessageTransmitterV2` rejects the nonce ("Nonce already used"); no second intent | `replayed message reverts in the transmitter…` |
| 2 | Relay a message whose `mintRecipient` is someone else, so the gateway binds funds it never received | Reverts **before** `receiveMessage` (`MintRecipientNotGateway`); the message stays receivable by its real recipient | `mint to a different recipient reverts before the mint` |
| 3 | Burn a token that is not USDC on the source chain, or claim USDC from a domain where that token maps to nothing | Pre-mint revert `BurnTokenNotUsdc` (checked with `TokenMinterV2.getLocalToken(sourceDomain, burnToken) == usdc`) | `burn token that is not local USDC's remote counterpart…`; fork: `getLocalToken(0, ETH USDC) == Base USDC` |
| 4 | A non-burn CCTP message (header `recipient` ≠ TokenMessengerV2), a wrong destination domain, or an unknown message or body version | Pre-mint revert | `non-burn message, wrong destination domain…` |
| 5 | Forged or tampered message | `receiveMessage` attestation check fails | `a tampered message fails attestation`; fork: real transmitter rejects a forged attestation |
| 6 | Hook data that makes `abi.decode` revert after the mint (truncated, trailing bytes, dirty address bits, non-canonical offset), which would brick a caller-locked message | A strict canonical-encoding check runs before decoding; the deposit is rejected (`MalformedHookData`) and refunded to `messageSender` | `malformed / empty / Forwarding-Service hookData…` |
| 7 | Underpay: price met by `amount` but not by `amount − feeExecuted` | Net is measured as a balance delta, never read from the message; `Underfunded` → refund of the net | `price met by amount but not by net…` |
| 8 | Unapproved verifier, expired intent, zero price, zero dealRef, unknown hook version, or an inconsistent payout route | Rejected with a reason code and refunded in the same transaction; never reverted after the mint | `relayDeposit — business-invalid deposits…` |
| 8b | A valid deposit with `refundRecipient = 0`; a later refund burn to a zero recipient would revert forever | The `messageSender` fallback is resolved before binding: the stored and emitted `refundRecipient` is never zero | `a valid deposit with zero refundRecipient binds messageSender…` |
| 9 | Two identical deposits in the same block collide on the escrow's intent id; the second `createIntent` would revert after the mint | The gateway derives the escrow's id first; the duplicate is rejected (`DuplicateIntent`) and refunded | `duplicate intent id (same hook, same net, same block)…` |
| 10 | The refund burn itself reverts after the mint (CCTP paused, burn limit, or a caller supplying just enough gas for the inner burn to run out) | No revert; the amount is parked in `pendingRejectRefunds[messageHash]` and anyone can re-send it to the same recipient | `a failing refund burn parks the funds…` |
| 11 | Relayer sets a huge `maxFee` to drain a refund or payout as fees | `maxFee ≤ max(amount·feeCapBps/10⁴, feeCapFlat)` and `< amount`; caps are immutable with hard limits of 1% and 1 USDC. The finality threshold must be between 1000 and 2000 | `fee caps` |
| 12 | Redirect a payout: set a route on someone else's intent, overwrite an existing route, or replay or modify a signature | Only the intent's buyer (`msg.sender` or EIP-712 / ERC-1271 signature over `intentId, domain, recipient, deadline`); set once; gateway-funded intents take their route from hook data | `payout routes` |
| 12b | Buyer waits until the seller's share has been claimed into the gateway (directly at the escrow), then sets the route to itself | A route can only be set while the intent is still `Open`; after a claim it is rejected (`NotClaimable`) | `route can only be set while the intent is Open…` |
| 13 | Forward more than the seller earned | `claimAndForward` burns exactly the measured seller-share delta; the burn must consume the exact allowance | `forwards exactly the seller-share delta…` |
| 14 | A third party calls `escrow.refundExpiredIntent` or `escrow.claimIntentForSeller` directly so that funds land in the gateway outside its own entry points | The next `refund` / `claimAndForward` for that intent forwards the amount already present; refund and payout each run once per intent | `forwards a refund that a third party already pulled…`; `forwards a share a third party already claimed…` |
| 15 | Re-entrancy through the transmitter, the messenger or the escrow | `nonReentrant` on every state-changing entry point; effects before interactions | `reentrancy` |
| 16 | Pause used to trap funds | Pause blocks only `relayDeposit` (pre-mint, so the message stays receivable); `refund`, `claimAndForward` and `retryRejectedRefund` keep working | `pause` |
| 17 | Owner or admin drains the gateway | No owner, no withdraw, no upgrade path | invariant test (balance always 0) |

## Invariant

After every transaction, `usdc.balanceOf(gateway) == 0` and the gateway's allowances to the escrow and to TokenMessengerV2 are 0. Case 10 is the one exception: the parked amount is recorded and anyone can re-send it. The invariant test drives seeded random sequences of these operations and asserts the invariant after each one:

- valid same-chain and cross-chain deposits
- rejected deposits
- Base-funded intents
- claims, both through the gateway and directly at the escrow
- refunds, both through the gateway and directly at the escrow
- time warps
- pause toggles

## Residual risks and trust assumptions

- **Circle is trusted.** A compromised attester could mint unbacked USDC. Circle can also pause CCTP or blacklist addresses. AgentPact adds no trust beyond Circle's.
- **Burns must set `destinationCaller` to the gateway.** If the buyer leaves it unset, anyone may call `MessageTransmitterV2.receiveMessage` directly. The mint then lands without a binding, and the gateway has no admin path to return it. The quote API therefore always sets `destinationCaller` to the gateway.
- **The seller must check the payout route before delivering.** The buyer writes the route: in the hook data for cross-chain deposits, or through `setPayoutRoute` for Base-funded intents that target the gateway. The API binds the route to the seller's registered payout route, and a seller should not deliver against an intent whose route is not its own. If an intent with no route is claimed directly at the escrow, its share stays in the gateway, because no route can be set after a claim.
- **The `messageSender` fallback only works for EVM sources.** When the hook data does not decode, the refund goes to `messageSender`. On Solana that is the burner's wallet, not a USDC token account, so the refund cannot be minted there. The hook data the API builds always carries an explicit `refundRecipient` (the ATA).
- **USDC sent straight to the gateway is stuck.** A plain ERC-20 transfer, outside any CCTP message or escrow flow, cannot be recovered, because there is no withdraw function.
- **An unreachable payout domain blocks only that payout.** If the payout domain has no remote TokenMessenger, `claimAndForward` reverts with no state change. The intent then expires and is refunded to the buyer.
- **Solana payout and refund recipients must be USDC token accounts (ATAs).** CCTP mints to the token account named in `mintRecipient`. The API must supply the ATA, not the wallet's owner address.
- **The Forwarding Service fee comes out of `maxFee`.** If `maxFee` is below the fee, the destination mint may not be forwarded automatically. The message stays receivable by anyone, because outbound burns use `destinationCaller = 0`.
