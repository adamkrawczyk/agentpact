# ADR-002 — Schelling burn-to-dEaD on hash-mismatch

**Status:** Accepted (2026-05-27)
**Codename:** `settlement_2705`

## Context

Class B handles subjective deliverables — anything that can't be
expressed as a Solidity predicate. The classical solution is an LLM
arbiter, a juror multisig, or a UMA-style optimistic oracle. Each one
introduces an external trust dependency the protocol then has to defend
against, audit, and pay for.

We need an arbitration mechanism that doesn't introduce a third party.

## Decision

**Dual-stake Schelling commit-reveal. On hash-mismatch, both stakes burn
to `0x...dEaD`; buyer is refunded the original price; seller is paid
nothing.**

The protocol refuses to take a side when the parties cannot agree.

## Why this works

The Schelling-point game theory: if a seller honestly delivers the right
thing and the buyer falsely rejects, the buyer's commit hash and the
seller's commit hash will match (both observed the same deliverable).
Match → seller wins, buyer's stake redistributed. The buyer is
disincentivized from false-rejecting.

If the seller actually delivered the wrong thing and the buyer
legitimately rejects, the buyer's commit and the seller's commit will
NOT match — they observed different deliverables. Mismatch → both
stakes burn. The seller is disincentivized from delivering garbage.

The burn outcome is the protocol-level Schelling enforcement:
**dishonesty by either party loses money irrevocably.** No arbiter
needs to evaluate the truth.

## Why burn, not redistribute

We considered three burn-target options:

1. **Send both stakes to the buyer** (buyer-friendly).
2. **Send both stakes to the platform** (treasury-friendly).
3. **Burn to `0x...dEaD`** (protocol-neutral).

Option 1 lets the buyer profit from a rejection-spam attack. Option 2
gives the platform a perverse incentive to design rules that surface
more disagreements. Option 3 — burning — eliminates both incentive
problems and makes the rule trustless.

The burn destination is configurable via the constructor (`BURN_TO`
arg) so future versions could redirect to a community-controlled grants
treasury without changing the contract bytecode that handles the burn.

## Consequences

- `SchellingCommitReveal.sol` library implements the round logic.
- `AgentPactEscrowV2._settleHashMismatchBothBurn` is the on-chain branch.
- Tests assert: buyer's USDC balance increases by `price` only; the burn
  address's USDC balance increases by both stakes; seller's balance does
  not change.
- The Q1 frontmatter answer (`B`) in the plan-doc binds the default burn
  target to `0x...dEaD`.
