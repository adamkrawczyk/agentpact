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
| `CCTP_ENABLED` | Cross-chain relay on/off. Only the literal `true` enables it (default off). |
| `CCTP_NETWORK` | `testnet` (default) or `mainnet`; must match the chain behind `BASE_RPC_URL` (checked at boot). |
| `CCTP_GATEWAY_ADDRESS` | Deployed `AgentPactCctpGateway` on Base. Required when enabled. |
| `CCTP_IRIS_BASE_URL` | Override the Iris host (defaults per network). |
| `CCTP_ATTESTATION_TIMEOUT_MIN` / `CCTP_BIND_TIMEOUT_MIN` / `CCTP_FORWARD_TIMEOUT_MIN` | Watchdog thresholds (45 / 30 / 60). |
| `CCTP_MAX_ATTEMPTS`, `CCTP_RETRY_BASE_MS`, `CCTP_RETRY_MAX_MS` | Broadcast retries before `stuck` (5, 60s doubling, 30 min cap). |
| `CCTP_PAYOUT_SPEED` | `standard` (default, 0 bps) or `fast` for refund/payout burns. |

## CCTP relay (M1)

`src/cctp-sweeper.ts` moves `cctp_transfers` rows (migrations 053 + 057)
through their states. The relayer only broadcasts calls anyone may make on the
`AgentPactCctpGateway` — it never holds user funds.

- **Deposit** (buyer burned on Ethereum/Solana): `submitted → attestation_pending
  → attested → relayed → bound`. Iris gives the attested message,
  `gateway.relayDeposit` mints into the gateway, and the API's binding check
  (not the relayer) decides the deal is funded.
- **Refund / payout**: an expired bound deposit gets a `refund` row, a revealed
  intent with a non-Base payout route gets a `payout` row
  (`gateway.refund` / `gateway.claimAndForward`, Circle Forwarding Service on
  the destination). The autoclose claim phase skips those intents.
- **Idempotent**: per-row lease, tx hash persisted before waiting,
  `usedNonces` checked before relaying, landed refunds/payouts found from
  gateway events before any re-send.
- **Watchdogs**: stuck attestation, failed/reverted relay, mint without a bound
  intent, retry exhaustion → status `stuck`, one `cctp.alert` error log line,
  and `/health` → 503 with `cctp.stuckCount` / `cctp.oldestStuckAgeMs`.

The gateway ABI is hand-written in `src/cctp-gateway-abi.ts` until
`packages/escrow/abi/AgentPactCctpGateway.json` lands. The relayer depends on
`@agentpact/payouts` (built first by `prebuild` / `pretest`).

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
