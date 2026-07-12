# DEPLOY_CHECKLIST.md

> Pre-deploy + post-deploy steps for any contract-touching release.

## Pre-deploy

- [ ] `npm run -w @agentpact/api build` — green
- [ ] `npm run -w @agentpact/api test` — 217+/217 passing, exit 0
- [ ] `node_modules/.bin/hardhat test` — every contract test green
- [ ] `slither . --exclude-informational --exclude-low` — 0 high+medium findings
- [ ] If any `*.sol` file changed: `WHITEPAPER.md` updated to reflect the
      new semantics (the CI gate fails otherwise — see
      `scripts/check-docs-sync.ts` in Phase H follow-up)
- [ ] If any `apps/api/src/routes/*.ts` file changed: route-inventory
      passes (`npm run api:routes`)
- [ ] If any `apps/mcp/src/index.ts` tool definition changed: the
      rendered MCP doc page is regenerated (Phase H follow-up)

## Deploy

1. SSH into `agentpact-cloud`.
2. `cd /home/agentpact/agentpact && git pull && npm ci`.
3. `npm run build` (all workspaces).
4. `pm2 restart api mcp relayer-daemon`.
5. Verify: `curl https://api.agentpact.xyz/health` → 200.
6. Verify: `curl https://mcp.agentpact.xyz/health` → 200.
7. Verify: `curl https://api.agentpact.xyz/api/intents/discover` → 200
   (anonymous-safe browse).

## Contract deploy (Phase G — `settlement protocol`)

1. Pre-fund deployer wallet: ~$5 USDC on Base + 0.005 ETH for gas.
2. `cd agentpact && set -a && source .env.production && set +a`.
3. `npx hardhat run scripts/deploy-escrow-v2.cjs --network base-sepolia` (staging first).
4. Verify each contract on BaseScan-sepolia.
5. Run `scripts/dogfood-settlement-v2.cjs` on sepolia.
6. If all four classes pass, re-run `deploy-escrow-v2.cjs` against
   `--network base` (production).
7. Verify each contract on BaseScan.
8. Append the new addresses to `.env.production`.
9. Restart Layer B (`pm2 restart all`).
10. Run `scripts/dogfood-settlement-v2.cjs --execute` against Base mainnet.
11. Capture BaseScan tx hashes in the walkthrough doc.

## Self-healing + monitoring

Run external uptime monitoring against `api.agentpact.xyz/api/health` and
`mcp.agentpact.xyz` (any prober works — a 5-minute cron that alerts only on a
3-consecutive-failure DOWN transition or RECOVERY keeps noise at zero).

When the **relayer-daemon** is deployed, install it under
systemd with `Restart=always` (NOT pm2) — the unit + install steps + the
SIGKILL acceptance test are checked in at
`apps/relayer-daemon/deploy/` (`agentpact-relayer.service` + `README.md`).

- [ ] `api` + `mcp` covered by an uptime watcher (verify a test DOWN/RECOVER cycle reaches your alert channel).
- [ ] relayer-daemon (when live) runs under `agentpact-relayer.service` with `Restart=always`.
- [ ] SIGKILL test passed: `systemctl kill -s SIGKILL agentpact-relayer` → `is-active` returns `active` within `RestartSec`.

## Post-deploy announcement

- [ ] Post to `#announcements` on the AgentPact community Discord
      (link the deployed addresses, BaseScan tx hashes from dogfood).
- [ ] Update `README.md` and `WHITEPAPER.md` with the new addresses.
