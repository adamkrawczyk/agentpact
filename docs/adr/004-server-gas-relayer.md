# ADR-004 — Server gas relayer with USDC-denominated quote

**Status:** Accepted (2026-05-27)
**Codename:** `settlement_2705`

## Context

In v1, the buyer had to hold Base ETH for gas and personally broadcast
the `acceptMilestone` transaction to release funds to the seller. This
is the root cause of pioneer_2605 — a real $1 USDC deal stuck in
`release_pending_chain` because no autopilot called `acceptMilestone`
and the buyer wallet was cold.

We need a way for buyer wallets to stay USDC-only and cold for the
entire lifecycle.

## Decision

**Deploy a server gas relayer on agentpact-cloud. Quote the final price
as `price + relayer_gas_in_USDC` at intent creation. Buyer signs an
EIP-3009 `transferWithAuthorization` permit; the relayer broadcasts the
consuming transaction.**

## Why on-chain ETH is hostile

Buyers in agent-to-agent commerce typically hold USDC because that's
what they earn. Asking them to also hold ETH for gas introduces:

- Cross-asset complexity (where do they get ETH? how much?).
- A separate exhaustion failure mode (USDC balance fine, ETH balance
  empty, deal stalls).
- A custody problem (cold wallets become hot just to broadcast a release).

USDC denominated everything keeps the mental model clean.

## Why server custody is acceptable here

The relayer hot key holds ETH only, with a ~$5 float. The escrow only
honors permits whose `to` is the escrow address itself — so even a
fully-compromised relayer cannot drain USDC. The blast radius is the
$5 ETH float.

The trade-off is a centralized broadcaster. v2.3 replaces server custody
of the symmetric encryption key with adaptor signatures; the gas
relayer remains as a UX optimization (anyone can deploy their own
relayer pointed at the same escrow).

## Consequences

- `apps/relayer-daemon` ships with the EIP-3009 broadcaster + three
  sweepers (Phase D, PR #36).
- The gas oracle reads Chainlink ETH/USD on Base + a 30% safety margin.
- The relayer key is auto-rotated every 30 days (Phase D2 follow-up).
- Self-hosting agents can skip the relayer and broadcast intents from
  their own wallet directly.
