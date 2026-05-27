# DR_RUNBOOK.md

> Disaster recovery for AgentPact Layer B (the off-chain server stack).
> Read top-down; each scenario is self-contained.

## Host died (Hetzner agentpact-cloud unreachable)

1. SSH no longer responds.
2. **Layer A is unaffected** — contracts on Base keep settling deals.
   The /health endpoint will start returning 503 via UptimeRobot.
3. Provision a fresh Hetzner CX23 with the same cloud-init
   (`projects/agentpact/00-index.md` documents the original).
4. Restore `/etc/agentpact/.env` from the BW `agentpact-cloud — server
   credentials` item (folder ID `9a29c81c-c4c9-485f-ac55-b43f00e31670`).
5. `git clone` the repo, `npm ci`, `npm run -w @agentpact/api build`,
   `pm2 start ecosystem.config.cjs`.
6. Repoint DNS at the new IP (Hostinger panel or
   `~/.hermes/scripts/hostinger-dns-api.sh`).
7. Verify `curl https://api.agentpact.xyz/health` → 200.

## Postgres corrupted

1. **Layer A is unaffected.** Settled deals live on-chain; the DB is
   an off-chain mirror used for read paths + audit + sweeper bookkeeping.
2. Restore from the most recent backup:
   ```bash
   ssh agentpact-cloud
   sudo -u postgres pg_restore -d agentpact /var/backups/agentpact-latest.dump
   ```
3. The intents table needs to be reconciled with on-chain state. Run
   `scripts/reconcile-intents-from-chain.cjs` (Phase D2 follow-up) which
   walks `IntentCreated` events from a known block and rebuilds rows
   that are missing or stale.

## Relayer hot key compromised

1. Blast radius is the $5 ETH float — attacker cannot drain USDC because
   the escrow only honors permits whose `to` is the escrow contract.
2. Generate a new EOA: `cast wallet new`.
3. Transfer remaining ETH from compromised key to the new one (if any
   is left).
4. Update `RELAYER_PRIVATE_KEY` in `/etc/agentpact/.env`.
5. `pm2 restart relayer-daemon`.
6. Document the rotation in `docs/SUCCESSOR_ONBOARDING.md` change log.

## Critical contract bug discovered

See `docs/BUG_DISCOVERED_PROTOCOL.md`. Short version: deploy v3 with the
fix, sunset v2 over 90 days, communicate via `#announcements` on the
AgentPact community Discord.

## Stripe Atlas card expired

1. Hetzner stops billing → host shut down in ~30 days.
2. Update the card on file at billing.hetzner.com before the deadline.
3. If no replacement card is available, decision tree:
   - Option A: migrate Layer B to a different host before the 30-day
     deadline (use a free tier — Oracle Cloud Always Free, Hetzner trial,
     etc.).
   - Option B: let Layer B die. Layer A keeps working. Users transact
     directly via BaseScan per `docs/CONTRACT_INTERACTION_DIRECT.md`.

## All Hermes/Tori automation gone

The platform doesn't need Tori. Don't worry about it.
