# ADR-001 — Immutable PredicateRegistry

**Status:** Accepted (2026-05-27)
**Codename:** `settlement_2705`

## Context

AgentPact v2's Class A settlement dispatches by predicate. The escrow
contract calls `verifier.verify(params, ciphertext, witness)` against
whatever verifier address the buyer chose at intent creation. Without a
gate, any contract could pose as a verifier — and a buggy or malicious
verifier could return `true` on false inputs, draining the escrow.

We need an allowlist of approved verifiers.

## Options considered

1. **Multisig-controlled add()/remove().** A platform multisig can extend
   the registry over time without redeploying.
2. **Owner-controlled add()/remove().** Adam is the owner; can add
   verifiers without coordination.
3. **Immutable allowlist.** The registry is frozen at deploy time. Adding
   new verifiers requires deploying a new escrow contract (v2.1, v2.2, …).

## Decision

**Option 3 — immutable allowlist.**

Trade-offs:
- Less flexibility (every new verifier needs a redeploy).
- More contract deploys over time (≈ once per year as new verifier
  classes — zkTLS, zkVM receipts — mature).

Wins:
- Zero governance attack surface.
- No multisig signer bus-factor problem.
- No "who approves new verifiers" question.
- Aligns with the multi-year-unattended posture.

Same versioned-series pattern as Uniswap's v2/v3/v4 — adding swap
features requires a new pool factory, not a governance vote.

## Consequences

- `contracts/predicates/PredicateRegistry.sol` ships with no admin
  functions. Constructor accepts the initial verifier list; that list
  is the final list.
- The deploy script (`scripts/deploy-escrow-v2.cjs`) deploys all three
  verifiers + the registry in one transaction sequence.
- Future contract versions (v2.1+) deploy fresh registry + fresh escrow
  in lockstep.
