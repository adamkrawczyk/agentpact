# SUBAGENT_DAEMON_OUTPUT.md — fulfillment-daemon delivery

## Summary

`apps/fulfillment-daemon` workspace created and wired into the monorepo. All build and test gates green.

## Build output

```
> @agentpact/fulfillment-daemon@0.1.0 build
> tsc -p tsconfig.json
```
Exit 0.

## Test output

```
> @agentpact/fulfillment-daemon@0.1.0 test
> node --import tsx --test src/**/*.test.ts

✔ api-client: builds correct URL and header for listPaidOrders (163.623092ms)
✔ api-client: non-2xx throws ApiError with status (4.978094ms)
✔ api-client: claimOrder 409 throws OrderAlreadyClaimed (2.627624ms)
✔ api-client: reportOrder sends correct body (6.566576ms)
✔ config: loads valid env with defaults (15.78862ms)
✔ config: throws on missing ADMIN_API_KEY (8.387546ms)
✔ config: coerces booleanish DRY_RUN=true (1.856645ms)
✔ config: coerces booleanish DRY_RUN=1 (1.442729ms)
✔ config: respects custom AGENTPACT_API_URL (1.600016ms)
✔ loop: happy path (dry-run) — processes order and marks in state (9.579733ms)
✔ loop: 409 from claimOrder → skip, not processed (1.970947ms)
✔ loop: already-processed orders are skipped (idempotent) (1.344481ms)
✔ loop: runner fail (non-dry-run) → refundOrder is called (2089.875153ms)
✔ loop: listPaidOrders error → returns 0 processed, no crash (1.566947ms)
✔ runner: valid JSON stdout → returns parsed result (23.850193ms)
✔ runner: non-zero exit → throws RunnerError with stderr (21.241189ms)
✔ runner: invalid JSON stdout → throws RunnerError (12.023336ms)
✔ state: roundtrips processedOrderIds (7.284949ms)
✔ state: prunes to 100 entries (2.25786ms)
✔ state: markProcessed is idempotent (0.863864ms)
✔ state: loadState returns empty state on missing file (4.07693ms)
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ duration_ms 3309.354268
```
Exit 0.

## Files created

### Workspace scaffold
- `apps/fulfillment-daemon/package.json` — `@agentpact/fulfillment-daemon`, npm scripts (build/test/start/dev/self-check)
- `apps/fulfillment-daemon/tsconfig.json` — extends `../../tsconfig.base.json`, outDir=dist

### Source (src/)
- `src/config.ts` — `loadConfig()` with zod-validated env; `ADMIN_API_KEY` required; booleanish `DRY_RUN`
- `src/heartbeat.ts` — structured JSON log per tick
- `src/state.ts` — `loadState/saveState/markProcessed/isProcessed`; prunes to 100 IDs; idempotent
- `src/notifier.ts` — `createNotifier({webhookUrl, dryRun})`; `postDiscord()` non-fatal
- `src/api-client.ts` — `createApiClient()`; `listPaidOrders/claimOrder/reportOrder/refundOrder`; `OrderAlreadyClaimed` (409), `ApiError` (non-2xx)
- `src/runner.ts` — `runAuditRunner()` via `child_process.spawn`; 10-min timeout; `TimeoutError`/`RunnerError`
- `src/loop.ts` — `runTick()`: heartbeat → list → claim (409 skip) → runner → report (or fail+refund) → mark processed
- `src/self-check.ts` — checks ADMIN_API_KEY, /health reachability, runner CLI path exists
- `src/index.ts` — entrypoint; `setInterval` loop; SIGTERM/SIGINT graceful shutdown

### Tests (21 total)
- `src/config.test.ts` (5 tests)
- `src/state.test.ts` (4 tests)
- `src/api-client.test.ts` (4 tests)
- `src/runner.test.ts` (3 tests)
- `src/loop.test.ts` (5 tests)

### Deployment
- `Dockerfile` — multi-stage: builder (tsc), runtime (node:20-slim + slither-analyzer via pip)
- `nixpacks.toml` — Railway Nix-based build config
- `README.md` — env vars, local run, Railway deploy docs

### Root changes
- `package.json` — added `@agentpact/fulfillment-daemon` to `build` and `test` scripts

## Acceptance criteria

- [x] `npm run build -w @agentpact/fulfillment-daemon` — green (tsc 0 errors)
- [x] `npm run test -w @agentpact/fulfillment-daemon` — 21/21 pass
- [x] Polls `/api/audit/orders?status=paid&limit=10` with `x-admin-api-key`
- [x] Claims with PATCH `/api/audit/orders/:id/claim`; skips on 409
- [x] Runs `audit-runner-cli` via `child_process.spawn`; 10-min hard timeout
- [x] Reports via POST `/api/audit/orders/:id/report`; refunds via POST `/api/audit/orders/:id/refund` on failure
- [x] State file keeps last 100 processed IDs for idempotency
- [x] Structured JSON heartbeat every tick
- [x] SIGTERM/SIGINT graceful shutdown
- [x] Dockerfile with slither-analyzer pre-installed
- [x] nixpacks.toml for Railway
- [x] Branch pushed; PR opened

## Wire contract compliance

All endpoint paths, auth headers, body shapes, and error codes match `levels_2505_CONTRACT.md` exactly. No divergence.
