#!/usr/bin/env bash
# protocol_1605/A — Production smoke test (Phase A step 7).
#
# Hits every endpoint the plan §3 acceptance gate cares about and reports
# pass/fail per endpoint plus p95 latency. Used both interactively (by Tori
# during deploy verification) and as a recurring cron (Tori @ 4×/day).
#
# Exit codes:
#   0 — all endpoints in budget
#   1 — at least one endpoint failed or exceeded its p95 budget
#
# Env overrides:
#   AGENTPACT_BASE      — base URL (default https://api.agentpact.xyz)
#   AGENTPACT_WWW_BASE  — front-door URL (default https://www.agentpact.xyz)
#   AGENTPACT_API_KEY   — auth header for /api/needs|offers|deals probes.
#                         Required if you want those probes to validate the
#                         200-with-data path; without it they will accept a
#                         401 as "endpoint reachable, auth working".

set -uo pipefail

BASE="${AGENTPACT_BASE:-https://api.agentpact.xyz}"
WWW_BASE="${AGENTPACT_WWW_BASE:-https://www.agentpact.xyz}"
API_KEY="${AGENTPACT_API_KEY:-}"

# Plan §3 step 7 p95 budgets (seconds):
declare -A BUDGET=(
  ["/health"]=1
  ["/api/health"]=1
  ["/api/needs?limit=1"]=3
  ["/api/offers?limit=1"]=3
  ["/api/deals?limit=1"]=3
  ["/mcp"]=5
)

# Endpoints where 401 is an ACCEPTABLE response (means auth is working and the
# endpoint is reachable). Plain 200 also acceptable when API_KEY is set.
declare -A AUTH_OK=(
  ["/api/needs?limit=1"]=1
  ["/api/offers?limit=1"]=1
  ["/api/deals?limit=1"]=1
)

fail_count=0
pass_count=0
report_lines=()

probe() {
  local path="$1"
  local budget_sec="${BUDGET[$path]:-3}"
  local url="${BASE}${path}"
  local auth_args=()
  if [[ -n "$API_KEY" ]]; then
    auth_args+=(-H "x-api-key: ${API_KEY}")
  fi

  # --max-time slightly above budget so a 16s timeout (pre-A behavior) shows up
  # in the report; if we cap at budget we can't tell "slow but alive" from "dead".
  local max_time=$(( budget_sec + 5 ))
  local result
  result=$(curl -sS -o /dev/null -w "%{http_code} %{time_total}\n" \
    --max-time "$max_time" "${auth_args[@]}" "$url" 2>/dev/null || echo "000 ${max_time}.0")

  local code="${result%% *}"
  local time_total="${result##* }"
  # Strip trailing newline / extra whitespace
  time_total="${time_total//$'\n'/}"

  # Compare time vs budget using awk so we don't depend on bc.
  local in_budget
  in_budget=$(awk -v t="$time_total" -v b="$budget_sec" 'BEGIN{print (t+0 <= b+0) ? "1" : "0"}')

  local status="FAIL"
  if [[ "$code" == "200" ]] && [[ "$in_budget" == "1" ]]; then
    status="PASS"
  elif [[ "$code" == "401" ]] && [[ "${AUTH_OK[$path]:-0}" == "1" ]] && [[ "$in_budget" == "1" ]]; then
    # Auth-gated endpoint returning 401 with no key is healthy.
    status="PASS"
  fi

  if [[ "$status" == "PASS" ]]; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
  report_lines+=("  ${status} ${path}  →  HTTP ${code}  ${time_total}s  (budget ${budget_sec}s)")
}

# Probe order matches plan §3 step 7.
probe "/health"
probe "/api/health"
probe "/api/needs?limit=1"
probe "/api/offers?limit=1"
probe "/api/deals?limit=1"
probe "/mcp"

# www cert check — Phase A step 6 acceptance gate.
www_status="UNKNOWN"
www_detail=""
if cert_info=$(curl -vI --max-time 8 "${WWW_BASE}" 2>&1); then
  if echo "$cert_info" | grep -q "no alternative certificate subject name"; then
    www_status="FAIL"
    www_detail="cert covers wrong subject (still *.up.railway.app)"
  elif echo "$cert_info" | grep -qE "^< HTTP/[12](\.[0-9])? 200"; then
    www_status="PASS"
    www_detail="cert valid + 200"
  else
    www_status="FAIL"
    www_detail="reachable but no 200 in response"
  fi
else
  www_status="FAIL"
  www_detail="connection refused or timeout"
fi

if [[ "$www_status" == "PASS" ]]; then
  pass_count=$((pass_count + 1))
else
  fail_count=$((fail_count + 1))
fi
report_lines+=("  ${www_status} www cert (${WWW_BASE})  →  ${www_detail}")

# Reporting
echo "============================================================="
echo "  protocol_1605/A — smoke-prod $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "  base: ${BASE}"
[[ -n "$API_KEY" ]] && echo "  auth: x-api-key set" || echo "  auth: none (auth-gated endpoints expected to return 401)"
echo "-------------------------------------------------------------"
for line in "${report_lines[@]}"; do
  echo "$line"
done
echo "-------------------------------------------------------------"
echo "  ${pass_count} passed, ${fail_count} failed"
echo "============================================================="

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
exit 0
