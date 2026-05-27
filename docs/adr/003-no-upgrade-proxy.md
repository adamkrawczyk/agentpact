# ADR-003 — No upgrade proxy on the escrow contract

**Status:** Accepted (2026-05-27)
**Codename:** `settlement_2705`

## Context

OpenZeppelin's TransparentUpgradeableProxy and similar patterns let a
contract be upgraded post-deploy without changing the address users
interact with. The trade-off is a privileged "upgrader" — usually a
multisig or DAO.

## Decision

**Do not deploy behind an upgrade proxy. The escrow is immutable.**

Bugs are fixed by deploying a new escrow (v3, v4, …) and sunsetting
the old one over a 90-day window. Same versioned-series pattern as
Uniswap.

## Why no proxy

A proxy is an attack vector:
- The upgrader role becomes a bus-factor problem (who has the keys?).
- The upgrader can be coerced (legal pressure, social engineering,
  compromised wallet).
- The proxy adds storage layout constraints that complicate the
  contract code.
- The proxy adds an external `delegatecall` boundary that every audit
  has to reason about.

For a settlement protocol with the multi-year-unattended posture, the
permanence-over-flexibility tradeoff is correct. Users prefer "the
contract is what it is and always will be" over "the contract might
change tomorrow if Adam decides to."

## Consequences

- The escrow address is permanent. We commit to it in the README, the
  whitepaper, and downstream SDK / MCP / Discord-announcement copy.
- Critical bugs trigger a v3 deploy (see `BUG_DISCOVERED_PROTOCOL.md`).
- The DeadMansSwitch contract has no proxy either; same reasoning.
