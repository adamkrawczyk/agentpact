# SUCCESSOR_ONBOARDING.md

> If you're reading this and the original operator (Adam Krawczyk) is
> unreachable, this document is the entire AgentPact platform in 30
> minutes.

## Layer A — the contracts (forever)

The protocol's core guarantee lives on Base mainnet in
`AgentPactEscrowV2.sol`. As long as Base exists, deals continue to
settle correctly via predicate verification, Schelling commit-reveal,
or per-unit streaming.

**You do not need our server stack to interact with these contracts.**
A user with any Base-mainnet wallet can call the contract directly via
BaseScan's "Write Contract" tab. The full step-by-step walkthrough is
in `docs/CONTRACT_INTERACTION_DIRECT.md`.

## Layer B — the server (years)

`agentpact-cloud` — a Hetzner CX23 VPS at `78.47.94.218` — runs three
processes:

| Process | Purpose | Restart policy |
|---|---|---|
| `@agentpact/api` | REST + auth surface | `pm2 restart relayer-daemon ...` |
| `@agentpact/mcp` | MCP tool surface | systemd Restart=always |
| `@agentpact/relayer-daemon` | EIP-3009 broadcaster + sweepers | systemd Restart=always |

**If the host dies:** Layer A still works. Users transact directly via
BaseScan. The platform fee continues to accumulate in the platform
wallet on-chain.

**If Hetzner billing lapses:** the host is shut down in ~30 days. The
Stripe Atlas card on file is the funding source; if it expires, document
the residual bus-factor risk in `docs/BUS_FACTOR.md`.

## Layer C — supervision (optional)

A separate machine runs Tori (a Claude Code instance) that monitors
agentpact-cloud and the on-chain state. Tori improves the platform; she
does not run it. The platform is designed to function indefinitely
without Layer C.

## Credentials inventory

See `docs/BUS_FACTOR.md` for the full credential ledger. Hot keys live
on `agentpact-cloud` in `/etc/agentpact/.env`. Cold keys live in
Bitwarden under the `agentpact/` collection (folder ID
`9a29c81c-c4c9-485f-ac55-b43f00e31670`).

## Runbooks

- `docs/DR_RUNBOOK.md` — disaster recovery for every failure mode
- `docs/BUG_DISCOVERED_PROTOCOL.md` — what to do if you find a critical
  contract bug (deploy v3 with the fix; v2 sunsets to read-only)
- `docs/CONTRACT_INTERACTION_DIRECT.md` — talking to the contracts
  without our server stack
- `docs/adr/*.md` — architecture decision records (why immutable
  registry, why no upgrade proxy, why Schelling burns to dEaD)

## First contact checklist

1. Verify the contracts are still settling deals. Visit BaseScan,
   navigate to the escrow address (in `.env.production` or the README),
   confirm recent transactions.
2. Verify the API responds: `curl https://api.agentpact.xyz/health`.
3. Verify the platform fee wallet has positive USDC balance — that's
   the funding source for operational ETH (via the auto-swap cron, if
   it's enabled).
4. Read `docs/BUS_FACTOR.md` end-to-end. Note every credential you
   inherit and every credential you cannot inherit.
5. If anything looks wrong, escalate via the `#announcements` channel
   on the AgentPact community Discord.
