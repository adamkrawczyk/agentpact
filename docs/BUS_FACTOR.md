# BUS_FACTOR.md

> Credentials inventory. Every secret, who has access today, what
> changes when Adam is gone, and the documented residual risks.

## Per the plan-doc (settlement_2705)

| Decision | Status (Q6 default applied) |
|---|---|
| Q4 — external Code4rena audit | **Not commissioned.** Plan ships unaudited. No public marketing claim is made about audit status. |
| Q5 — 2nd Gnosis Safe signer | **Not designated.** Safe deploys 1-of-1, Adam-only. Future heirs handle Safe reconfiguration. |
| Q6 — dead-man's switch successor | **Not designated.** `AgentPactDeadMansSwitch.sol` deploys with `TIMER_DISABLED = true`. The contract is on-chain but dormant. |
| Q7 — heartbeat caller | **Moot** because Q6 disables the switch. If Q6 changes, option (a) hot EOA on agentpact-cloud + Tori cron is the wire-up path. |
| Q8 — Stripe Atlas card | **Assumed personal Stripe card.** Residual risk: if Adam's card expires, Hetzner billing fails after ~30 days and Layer B dies; Layer A keeps working. |

## On-chain identities

| Wallet | Custody | Rotation |
|---|---|---|
| Platform-hot (`0x4DDcf20a...a1f4`) | EOA on `agentpact-cloud`, `/etc/agentpact/.env`, AES-GCM-encrypted backup to mac01 every 15 min | Auto-rotate every 90 days via `apps/relayer-daemon` follow-up |
| Platform-cold | Gnosis Safe 1-of-1 (Adam) on Base; signer-2 / signer-3 slots open | Manual via Safe UI |
| Relayer hot | EOA on `agentpact-cloud`, ETH-only, $5 float max | Auto-rotate every 30 days |

## Service accounts

| Service | Owner | Recovery |
|---|---|---|
| Hetzner (agentpact-cloud) | Stripe Atlas card on Adam's account | Stripe Atlas card expires → host shut down in ~30 days. Migrate to alternate provider before then. |
| Cloudflare (agentpact.xyz, api.agentpact.xyz, mcp.agentpact.xyz) | Adam's CF account | Domain registrar is Hostinger; 5-year prepay recommended. |
| GitHub org (`wisechef-ai`) | Adam | Add a 2nd org admin before Adam becomes unreachable. |
| Anthropic API (Tori) | Adam | Acceptable to let lapse — Layer C is optional. |
| Resend (transactional email) | Adam | Optional. |
| UptimeRobot | Shared inbox `ops@wisechef.ai` (configured in Phase F2) | Shared inbox survives Adam's personal-email lapse. |

## What still requires Adam to be alive

| Dependency | Mitigation |
|---|---|
| Funding the external audit (\~$15-20k) | Decision recorded as N. Plan ships unaudited (no public claim). |
| Designating the 2nd Gnosis Safe signer | Default applied. Funds accumulate; future heirs handle. |
| Stripe Atlas card not auto-renewing | If Adam's card expires, Hetzner stops billing; Layer B dies in ~30 days. **Layer A still works.** |
| Domain registrar (Hostinger) | 5-year prepay recommended at deploy. |
