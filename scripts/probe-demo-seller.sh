#!/usr/bin/env bash
# Monitor probe for the x402 demo seller (apps/demo-x402-seller).
#
# Exercises the 402 flow end-to-end WITHOUT paying anything:
#   1. GET  /health                       → 200, ok:true
#   2. POST /validate-csv (no payment)    → 402 + PAYMENT-REQUIRED (x402 v2, exact USDC option)
#   3. POST /validate-csv/batch           → 402 whose accepts ALSO list agentpact-escrow (offer id, retry header)
#   4. POST /validate-csv/batch + X-AGENTPACT-DEAL: <random uuid>
#                                         → 402 agentpact_deal_not_found: proves the seller's
#                                           middleware reached the AgentPact API with a valid key
# Exit 0 = healthy, 1 = a step failed (message on stderr). `--json` prints a summary line.
#
# Usage: scripts/probe-demo-seller.sh [BASE_URL] [--json]
#        DEMO_SELLER_URL=https://… scripts/probe-demo-seller.sh

set -euo pipefail

BASE="${DEMO_SELLER_URL:-http://localhost:4402}"
JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    http://*|https://*) BASE="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
BASE="${BASE%/}"

for bin in curl node; do
  command -v "$bin" >/dev/null || { echo "probe: $bin is required" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  if [ "$JSON" = 1 ]; then
    printf '{"ok":false,"base":"%s","step":"%s"}\n' "$BASE" "$1"
  fi
  echo "probe FAILED at $1: $2" >&2
  exit 1
}

JOB='{"csv":"id,email\n1,a@x.io\n","schema":{"columns":[{"name":"id","type":"integer","required":true},{"name":"email","required":true}]}}'

# request STEP METHOD PATH BODY [EXTRA_HEADER] → writes $TMP/STEP.{code,headers,body}
request() {
  local step="$1" method="$2" path="$3" body="$4" extra="${5:-}"
  local args=(-sS -X "$method" -o "$TMP/$step.body" -D "$TMP/$step.headers" -w '%{http_code}' --max-time 20)
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  if [ -n "$extra" ]; then args+=(-H "$extra"); fi
  curl "${args[@]}" "$BASE$path" > "$TMP/$step.code" || fail "$step" "request error"
}

# Decode the PAYMENT-REQUIRED header of a step and run a JS assertion on it.
check_pr() {
  local step="$1" js="$2"
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/)
      .find((l) => /^payment-required:/i.test(l));
    if (!raw) { console.error("no PAYMENT-REQUIRED header"); process.exit(1); }
    const pr = JSON.parse(Buffer.from(raw.split(":").slice(1).join(":").trim(), "base64").toString("utf8"));
    const ok = (new Function("pr", "return (" + process.argv[2] + ")"))(pr);
    if (!ok) { console.error(JSON.stringify(pr).slice(0, 400)); process.exit(1); }
  ' "$TMP/$step.headers" "$js" || fail "$step" "PAYMENT-REQUIRED check failed: $js"
}

request health GET /health ""
[ "$(cat "$TMP/health.code")" = 200 ] || fail health "HTTP $(cat "$TMP/health.code")"
grep -q '"ok":true' "$TMP/health.body" || fail health "body not ok"

request single POST /validate-csv "$JOB"
[ "$(cat "$TMP/single.code")" = 402 ] || fail single "expected 402, got $(cat "$TMP/single.code")"
check_pr single 'pr.x402Version === 2 && pr.accepts.some((a) => a.scheme === "exact" && /^eip155:/.test(a.network) && /^\d+$/.test(a.amount))'

request batch POST /validate-csv/batch "{\"jobs\":[$JOB,$JOB]}"
[ "$(cat "$TMP/batch.code")" = 402 ] || fail batch "expected 402, got $(cat "$TMP/batch.code")"
check_pr batch 'pr.accepts.some((a) => a.scheme === "agentpact-escrow" && a.extra && a.extra.agentpact && a.extra.agentpact.offerId && a.extra.agentpact.retryHeader === "X-AGENTPACT-DEAL")'

DEAL="$(node -e 'console.log(require("crypto").randomUUID())')"
request deal POST /validate-csv/batch "{\"jobs\":[$JOB]}" "X-AGENTPACT-DEAL: $DEAL"
[ "$(cat "$TMP/deal.code")" = 402 ] || fail deal "expected 402 for an unknown deal, got $(cat "$TMP/deal.code") (500 = seller cannot reach AgentPact or its API key is rejected)"
check_pr deal 'pr.error === "agentpact_deal_not_found"'

if [ "$JSON" = 1 ]; then
  printf '{"ok":true,"base":"%s","steps":["health","x402_402","escrow_offered","agentpact_roundtrip"]}\n' "$BASE"
else
  echo "probe OK: $BASE (health, x402 402, escrow option, AgentPact round-trip)"
fi
