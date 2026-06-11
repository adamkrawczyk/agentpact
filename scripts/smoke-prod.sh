#!/usr/bin/env bash
# scripts/smoke-prod.sh — protocol_1605/A acceptance gate
#
# Post-deploy smoke contract. Exits 0 only when:
#   /api/health          → 200, <1s
#   /api/needs?limit=1   → 200, <3s, valid JSON
#   /api/offers?limit=1  → 200, <3s, valid JSON
#   /api/deals?limit=1   → 200, <3s, valid JSON
#
# Designed to run in CI post-deploy AND as a daily cron (durability clock).
# 7 consecutive green days closes the protocol_1605/A acceptance gate.
#
# Usage:
#   bash scripts/smoke-prod.sh                    # exits 0/1, human output
#   bash scripts/smoke-prod.sh --json             # JSON output, exits 0/1
#   API_BASE=https://api.agentpact.xyz bash …     # override base URL

set -euo pipefail

API_BASE="${API_BASE:-https://api.agentpact.xyz}"
HEALTH_BUDGET_MS="${HEALTH_BUDGET_MS:-1000}"
DATA_BUDGET_MS="${DATA_BUDGET_MS:-3000}"
JSON_OUTPUT=false
if [[ "${1:-}" == "--json" ]]; then
  JSON_OUTPUT=true
fi

# Each row: name|path|budget_ms
PROBES=(
  "health|/api/health|${HEALTH_BUDGET_MS}"
  "needs|/api/needs?limit=1|${DATA_BUDGET_MS}"
  "offers|/api/offers?limit=1|${DATA_BUDGET_MS}"
  "deals|/api/deals?limit=1|${DATA_BUDGET_MS}"
)

# Color (only if interactive)
if [[ -t 1 && "$JSON_OUTPUT" == "false" ]]; then
  C_OK="\033[32m"; C_FAIL="\033[31m"; C_DIM="\033[2m"; C_RST="\033[0m"
else
  C_OK=""; C_FAIL=""; C_DIM=""; C_RST=""
fi

results_json="["
first=true
all_pass=true
fail_summary=()

for probe in "${PROBES[@]}"; do
  name="${probe%%|*}"
  rest="${probe#*|}"
  path="${rest%%|*}"
  budget="${rest#*|}"
  url="${API_BASE}${path}"

  body_file=$(mktemp)
  status=0
  http_code=0
  elapsed_ms=0
  json_valid=false
  pass=false

  # curl with -w to capture timing + http_code, write body to file
  # NB: -w output has no trailing newline, so `read` returns 1 (EOF without delim)
  # even when it successfully populated the variables. We always look at variables
  # after the call and decide pass/fail from http_code, not from read's rc.
  read -r http_code time_total < <(curl -sS -o "$body_file" \
                -w "%{http_code} %{time_total}" \
                --max-time $(( (budget * 3) / 1000 + 5 )) \
                "$url" 2>/dev/null) || true
  if [[ -n "${time_total:-}" ]]; then
    elapsed_ms=$(awk -v t="$time_total" 'BEGIN{printf "%d", t*1000}')
    # validate JSON
    if python3 -c "import json,sys; json.load(open('$body_file'))" 2>/dev/null; then
      json_valid=true
    fi
    # pass = 200 + under budget + valid JSON
    if [[ "$http_code" == "200" && "$elapsed_ms" -le "$budget" && "$json_valid" == "true" ]]; then
      pass=true
    fi
  else
    elapsed_ms=0
    http_code=0
  fi

  if [[ "$pass" == "true" ]]; then
    "$JSON_OUTPUT" || printf "  ${C_OK}✓${C_RST}  %-8s  %s%4dms${C_RST}  http=%s\n" "$name" "$C_DIM" "$elapsed_ms" "$http_code"
  else
    all_pass=false
    fail_summary+=("$name(http=$http_code, ${elapsed_ms}ms, json=$json_valid, budget=${budget}ms)")
    "$JSON_OUTPUT" || printf "  ${C_FAIL}✗${C_RST}  %-8s  %s%4dms${C_RST}  http=%s json=%s budget=%sms\n" "$name" "$C_DIM" "$elapsed_ms" "$http_code" "$json_valid" "$budget"
  fi

  if [[ "$JSON_OUTPUT" == "true" ]]; then
    [[ "$first" == "false" ]] && results_json+=","
    first=false
    results_json+=$(printf '{"name":"%s","path":"%s","http":%s,"elapsed_ms":%s,"budget_ms":%s,"json_valid":%s,"pass":%s}' \
      "$name" "$path" "$http_code" "$elapsed_ms" "$budget" "$json_valid" "$pass")
  fi
  rm -f "$body_file"
done

results_json+="]"

if [[ "$JSON_OUTPUT" == "true" ]]; then
  printf '{"api_base":"%s","timestamp":"%s","all_pass":%s,"probes":%s}\n' \
    "$API_BASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$all_pass" "$results_json"
fi

if [[ "$all_pass" == "true" ]]; then
  $JSON_OUTPUT || echo -e "${C_OK}smoke-prod: PASS${C_RST}  (4/4 probes within budget)"
  exit 0
else
  $JSON_OUTPUT || echo -e "${C_FAIL}smoke-prod: FAIL${C_RST}  ${fail_summary[*]}"
  exit 1
fi
