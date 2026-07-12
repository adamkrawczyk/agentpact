# @agentpact/fulfillment-daemon

Railway-deployable Node.js daemon that polls the AgentPact audit-order queue every 60 seconds, runs `audit-runner-cli` (Slither + Claude) for each paid order, and reports results back to the API.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_API_KEY` | ✅ | — | Shared secret for `x-admin-api-key` header on admin endpoints |
| `AGENTPACT_API_URL` | — | `https://api.agentpact.xyz` | Base URL of the AgentPact API |
| `AUDIT_RUNNER_CLI_PATH` | — | `/app/scripts/audit-runner-cli.ts` | Path to the audit runner CLI script |
| `FULFILLMENT_TICK_SECONDS` | — | `60` | Polling interval in seconds |
| `LOG_LEVEL` | — | `info` | One of: `debug`, `info`, `warn`, `error` |
| `DRY_RUN` | — | `false` | Skip actual runner execution and API writes |
| `DISCORD_WEBHOOK_URL` | — | — | Optional Discord webhook for completion notifications |
| `BASESCAN_API_KEY` | ✅ (runner) | — | BaseScan v2 API key for contract source fetching |
| `ANTHROPIC_API_KEY` | ✅ (runner) | — | Anthropic API key for Claude report generation |

## Running Locally

```bash
# Install deps from repo root
npm install

# Build
npm run build -w @agentpact/fulfillment-daemon

# Start (requires ADMIN_API_KEY)
ADMIN_API_KEY=your-key node apps/fulfillment-daemon/dist/index.js

# Dev mode (tsx watch)
cd apps/fulfillment-daemon && ADMIN_API_KEY=your-key npm run dev

# Self-check
ADMIN_API_KEY=your-key npm run self-check -w @agentpact/fulfillment-daemon

# Tests
npm run test -w @agentpact/fulfillment-daemon
```

## Dry Run

Set `DRY_RUN=true` to run the tick loop without executing the audit runner or writing results to the API. Useful for verifying connectivity.

## Railway Deployment

Railway uses `nixpacks.toml` at `apps/fulfillment-daemon/nixpacks.toml` to:

1. Install Node 20, Python 3.11, pip, and `solc` via Nix
2. Install `slither-analyzer` via pip
3. Build with `npm run build -w @agentpact/fulfillment-daemon`
4. Start with `node apps/fulfillment-daemon/dist/index.js`

Set all required environment variables in the Railway service's variable panel. The service name should be `agentpact-fulfillment`.

## Architecture

```
setInterval(60s)
  → GET /api/audit/orders?status=paid&limit=10   (x-admin-api-key)
  → for each order:
      PATCH /api/audit/orders/:id/claim           (idempotent, 409 = skip)
      npx tsx scripts/audit-runner-cli.ts         (10-min timeout)
      POST /api/audit/orders/:id/report           (result or failure body)
      POST /api/audit/orders/:id/refund           (on runner failure)
  → save state.json (~/.agentpact-fulfillment/state.json)
```

State file keeps last 100 processed order IDs to prevent double-processing on restart.
