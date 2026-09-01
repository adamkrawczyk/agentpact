# Prod hot-fix residue — rescued 2026-09-01

Files that existed ONLY on the production host (`/opt/agentpact-app`, pm2 box
`agentpact-cloud`) and in no commit on `origin/main`. Preserved here before
issue #118 step 4 reconciled that host to `main`, so nothing was lost.

Source: git bundle of the divergent prod fork, HEAD `13c06136d1fb2aeac6504f7a5b57251156b2f774`.
Backup: `~/backups/agentpact-prod-20260901/` (bundle sha256 `1bc70657ee923c54af59d5925dbacf8a41d1ba29bd4d3108e9e935f9c1901845`).

## finalize-release.ts

A one-off operator script, hot-edited directly on prod, used to manually finalize
a single escrow release. NOT wired into the API: `git grep finalize-release` at
prod HEAD returned zero references — nothing imported or invoked it.

It is archived, **not restored to `apps/api/src/`**, deliberately:

- it hardcodes one specific seller address (`0xcB43c996CbaDC3AC2FADab0449297890F727e9F9`);
- it reads `PLATFORM_PRIVATE_KEY` and signs a real Base-mainnet USDC transaction;
- shipping it inside the API build surface would put a manual money-moving
  script one accidental import away from production code.

It contains no literal private key (env-only). Kept for forensic reference; if the
capability is ever needed again it should be rebuilt as a guarded, tested admin
route, not resurrected as-is.
