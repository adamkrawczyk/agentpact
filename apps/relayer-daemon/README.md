# @agentpact/relayer-daemon

AgentPact v2 (`settlement protocol`) relayer + sweepers. Runs alongside the API on
your production host (referred to below as `agentpact-cloud`).

## What it does

1. **Relayer** — accepts buyer-signed EIP-3009 USDC permits via an internal
   HTTP endpoint (`POST /relay/permit`) and broadcasts the corresponding
   `AgentPactEscrowV2` transaction. Buyer wallets stay USDC-only and cold
   for the rest of the intent lifecycle.
2. **Sweepers** — three deterministic interval loops:
   - `class-b-ack-timeout`: every 60s scans `intents` where
     `status='delivered' AND ack_deadline_at < now()` and calls
     `acknowledgeTimeout(intentId)`.
   - `schelling-round-timeout`: every 60s scans `intents` where
     `status IN ('reveal_round1','reveal_round2')` and the round deadline
     has lapsed; calls `settleSchelling(intentId)`.
   - `stream-stale-flag`: every 5min scans Class C intents idle > 24h and
     flags them for buyer notification (no auto-cancel — buyer or seller
     must explicitly call `cancelStream`).
3. **Health endpoint** — `GET /health` reports relayer hot-key ETH balance,
   sweeper cycle counts + last-error, and pool status. Wired into
   UptimeRobot in Phase F2.

## Configuration (env vars)

| Var | Description |
|---|---|
| `RELAYER_PORT` | Internal HTTP listen port (default 4011, loopback only). |
| `RELAYER_HOST` | Bind address (default 127.0.0.1; never bind to 0.0.0.0). |
| `RELAYER_PRIVATE_KEY` | 0x-prefixed ETH-only hot wallet, ~$5 float, auto-rotated 30d. |
| `DATABASE_URL` | Postgres connection string (same one the API uses). |
| `BASE_RPC_URL` | https://mainnet.base.org or your preferred Base mainnet RPC. |
| `ESCROW_V2_ADDRESS` | Deployed AgentPactEscrowV2 contract address (Phase G). |
| `PLATFORM_WALLET` | 0x address that receives the 10% platform fee. |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default: `info`). |

## Deploy on agentpact-cloud

```bash
ssh agentpact-cloud
cd /home/agentpact/agentpact
git pull
npm ci
npm run -w @agentpact/relayer-daemon build
pm2 start dist/index.js --name relayer-daemon \
  --time --max-memory-restart 256M
pm2 save
```

## Operational notes

- Hot key holds ETH only (no USDC). Compromise blast radius = $5.
- Each sweeper loop wraps its body in try/catch with 3× exponential-backoff
  retry before posting an `alerts.jsonl` entry. On `>= 3` consecutive
  cycle failures the daemon emits a `relayer.degraded` event the API
  health endpoint surfaces.
- This package intentionally has no `@agentpact/*` runtime dependencies —
  the daemon talks to Postgres + the chain directly so a deploy of the
  API workspace cannot break it (or vice versa).
