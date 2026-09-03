#!/usr/bin/env bash
# scripts/smoke-prod.sh — escrow-safety rollout acceptance gate
#
# Post-deploy smoke contract. Exits 0 only when:
#   /api/health          → 200, <1s
#   /api/needs?limit=1   → 200, <3s, valid JSON
#   /api/offers?limit=1  → 200, <3s, valid JSON
#   /api/deals?limit=1   → 200, <3s, valid JSON
#   FRESHNESS            → prod actually serves the newest shipped routes
#
# Designed to run in CI post-deploy AND as a daily cron (durability clock).
# 7 consecutive green days closes the escrow-safety rollout acceptance gate.
#
# ── Why the freshness probe exists (incident 2026-08-20) ────────────────────
# The four probes above are LIVENESS probes: they only touch routes that have
# existed since the project's early days. Production ran a build from 2026-07-30
# for 21 days — missing six merged PRs including a funding-verification security
# fix (#97) — and these probes stayed green the entire time, because "the API
# answers" and "the API is running the code we merged" are different questions.
# Nothing in CI deploys this project, so a merged PR ships only when a human
# copies it to the box; without a freshness check, that omission is invisible.
#
# A freshness probe asserts a route that exists ONLY in a recent build. When it
# 404s while the liveness probes are green, the diagnosis is unambiguous:
# production is serving a stale build. Add a new entry here whenever a PR adds a
# durable, cheaply-probeable route — that is what keeps this gate honest.
#
# Usage:
#   bash scripts/smoke-prod.sh                    # exits 0/1, human output
#   bash scripts/smoke-prod.sh --json             # JSON output, exits 0/1
#   API_BASE=https://api.agentpact.xyz bash …     # override base URL
#   WEB_BASE=https://agentpact.xyz bash …         # override web base URL
#   SKIP_FRESHNESS=1 bash …                       # liveness only (pre-deploy)

set -euo pipefail

API_BASE="${API_BASE:-https://api.agentpact.xyz}"
WEB_BASE="${WEB_BASE:-https://agentpact.xyz}"
HEALTH_BUDGET_MS="${HEALTH_BUDGET_MS:-1000}"
DATA_BUDGET_MS="${DATA_BUDGET_MS:-3000}"
SKIP_FRESHNESS="${SKIP_FRESHNESS:-0}"
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

# ── Freshness probes ────────────────────────────────────────────────────────
# Each row: name|path|shipped_in|expected_http
# `expected_http` is what a CURRENT build returns for a deliberately absent id.
# 404 with a JSON error body = route exists and rejected the id (fresh).
# 404 with Fastify's "Route GET:… not found" = route absent (STALE BUILD).
# The two are distinguished by body inspection below, not by status code.
FRESHNESS_PROBES=(
  "settlement_audit|/api/deals/00000000-0000-0000-0000-000000000000/settlement|PR#106 (2026-08-17)|404"
)

# ── API Link-header freshness probe (incident 2026-08-30) ──────────────────
# Route-presence freshness (above) cannot see a HEADER VALUE change: PR #116
# repointed the v1-sunset `Link: rel="successor-version"` header from
# `/api/intents` to `/api/intents/discover`, merged as 101b1cd, CI green
# (Docker Build/E2E/Lint all success) — and prod kept serving the OLD header
# for hours because nothing deploys the API on a green merge. The route-exists
# probes above stayed green throughout (the route never disappeared, only the
# header value changed), so this needs its own assertion of the literal header.
#
# Each row: name|path|header_name|expected_value|shipped_in
API_LINK_FRESHNESS_PROBES=(
  "sunset_successor_link|/api/deals/00000000-0000-0000-0000-000000000000|Link|</api/intents/discover>; rel=\"successor-version\"|PR#116 (2026-08-30)"
)

# ── WEB freshness probes ────────────────────────────────────────────────────
# The API probes above cannot see the WEB tier at all — they only touch
# api.agentpact.xyz. That blind spot is why PR #115 (merged 2026-08-23, renders
# the settlement proof-of-delivery section on the deal detail page) sat undeployed
# for five days with every smoke run green: liveness on one host says nothing
# about the freshness of another.
#
# Each row: name|path|marker|shipped_in
#   marker  — a string that a CURRENT web build MUST emit on that path.
#   absent  → STALE WEB BUILD (or the route regressed). Either way: fail loudly.
# Add a row whenever a web PR adds a durable, cheaply-probeable surface string.
WEB_FRESHNESS_PROBES=(
  "web_build_sha|/health|\"build\"|BUILD_SHA provenance (2026-08-28)"
)

# The web /health `build` field must ALSO not be the placeholder: an image built
# without --build-arg BUILD_SHA reports "unknown", which is itself a CD defect.
WEB_BUILD_PLACEHOLDER="unknown"


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

# ── Freshness evaluation ────────────────────────────────────────────────────
# Fastify's built-in not-found handler emits {"message":"Route GET:/… not
# found","error":"Not Found"}. A route that EXISTS but rejects an unknown id
# emits the handler's own body ({"error":"Deal not found"}). Both are HTTP 404,
# so the status code alone cannot tell them apart — we must read the body.
freshness_json="["
fresh_first=true
if [[ "$SKIP_FRESHNESS" != "1" ]]; then
  for probe in "${FRESHNESS_PROBES[@]}"; do
    IFS='|' read -r fname fpath fshipped _fexpected <<< "$probe"
    furl="${API_BASE}${fpath}"
    fbody=$(mktemp)
    fcode=$(curl -sS -o "$fbody" -w "%{http_code}" --max-time 15 "$furl" 2>/dev/null || echo 0)

    # Stale iff the body is Fastify's route-not-found shape.
    stale=false
    if grep -qE '"message"[[:space:]]*:[[:space:]]*"Route [A-Z]+:[^"]*not found"' "$fbody" 2>/dev/null; then
      stale=true
    fi

    fpass=true
    if [[ "$stale" == "true" ]]; then
      fpass=false
      all_pass=false
      fail_summary+=("STALE_BUILD:${fname} (route from ${fshipped} absent in production)")
    elif [[ "$fcode" == "000" || "$fcode" == "0" ]]; then
      fpass=false
      all_pass=false
      fail_summary+=("freshness:${fname} unreachable")
    fi

    if [[ "$JSON_OUTPUT" == "false" ]]; then
      if [[ "$fpass" == "true" ]]; then
        printf "  ${C_OK}✓${C_RST}  %-8s  %sroute present${C_RST}  http=%s  %s\n" \
          "fresh" "$C_DIM" "$fcode" "$fshipped"
      else
        printf "  ${C_FAIL}✗${C_RST}  %-8s  %sSTALE BUILD${C_RST}  http=%s  %s missing from prod\n" \
          "fresh" "$C_DIM" "$fcode" "$fshipped"
      fi
    else
      [[ "$fresh_first" == "false" ]] && freshness_json+=","
      fresh_first=false
      freshness_json+=$(printf '{"name":"%s","path":"%s","shipped_in":"%s","http":%s,"stale_build":%s,"pass":%s}' \
        "$fname" "$fpath" "$fshipped" "${fcode:-0}" "$stale" "$fpass")
    fi
    rm -f "$fbody"
  done
fi
freshness_json+="]"

# ── API Link-header freshness evaluation ────────────────────────────────────
# Uses `curl -D-` to capture RESPONSE HEADERS (not just body) and compares the
# literal Link header value. Case-insensitive header name match (HTTP headers
# are case-insensitive; curl -D- preserves server casing).
link_json="["
link_first=true
if [[ "$SKIP_FRESHNESS" != "1" ]]; then
  for probe in "${API_LINK_FRESHNESS_PROBES[@]}"; do
    IFS='|' read -r lname lpath lheader lexpected lshipped <<< "$probe"
    lurl="${API_BASE}${lpath}"
    lheaders_file=$(mktemp)
    lcode=$(curl -sS -o /dev/null -D "$lheaders_file" -w "%{http_code}" --max-time 15 "$lurl" 2>/dev/null || echo 0)

    lactual=$(grep -i "^${lheader}:" "$lheaders_file" 2>/dev/null | tail -1 | sed -E "s/^[A-Za-z-]+:[[:space:]]*//" | tr -d '\r\n' || true)
    lpass=false
    lreason="ok"
    if [[ "$lcode" == "000" || "$lcode" == "0" ]]; then
      lreason="unreachable"
    elif [[ -z "$lactual" ]]; then
      lreason="header absent (STALE BUILD: ${lshipped})"
    elif [[ "$lactual" != "$lexpected" ]]; then
      lreason="value mismatch: got '${lactual}' want '${lexpected}' (STALE BUILD: ${lshipped})"
    else
      lpass=true
    fi

    if [[ "$lpass" != "true" ]]; then
      all_pass=false
      fail_summary+=("STALE_LINK:${lname} (${lreason})")
    fi

    if [[ "$JSON_OUTPUT" == "false" ]]; then
      if [[ "$lpass" == "true" ]]; then
        printf "  ${C_OK}✓${C_RST}  %-8s  %s${lheader}: %s${C_RST}  http=%s\n" \
          "link" "$C_DIM" "$lactual" "$lcode"
      else
        printf "  ${C_FAIL}✗${C_RST}  %-8s  %sSTALE LINK HEADER${C_RST}  %s\n" \
          "link" "$C_DIM" "$lreason"
      fi
    else
      [[ "$link_first" == "false" ]] && link_json+=","
      link_first=false
      # Escape embedded double-quotes in header values (e.g. rel="successor-version")
      # so the emitted JSON stays valid.
      lexpected_esc="${lexpected//\"/\\\"}"
      lactual_esc="${lactual//\"/\\\"}"
      lreason_esc="${lreason//\"/\\\"}"
      link_json+=$(printf '{"name":"%s","path":"%s","header":"%s","expected":"%s","actual":"%s","shipped_in":"%s","http":%s,"pass":%s,"reason":"%s"}' \
        "$lname" "$lpath" "$lheader" "$lexpected_esc" "$lactual_esc" "$lshipped" "${lcode:-0}" "$lpass" "$lreason_esc")
    fi
    rm -f "$lheaders_file"
  done
fi
link_json+="]"

# ── WEB freshness evaluation ────────────────────────────────────────────────
web_json="["
web_first=true
if [[ "$SKIP_FRESHNESS" != "1" ]]; then
  for probe in "${WEB_FRESHNESS_PROBES[@]}"; do
    IFS='|' read -r wname wpath wmarker wshipped <<< "$probe"
    wurl="${WEB_BASE}${wpath}"
    wbody=$(mktemp)
    wcode=$(curl -sS -o "$wbody" -w "%{http_code}" --max-time 15 "$wurl" 2>/dev/null || echo 0)

    wpass=false
    wreason="ok"
    wbuild=""
    if [[ "$wcode" != "200" ]]; then
      wreason="http=${wcode}"
    elif ! grep -qF -- "$wmarker" "$wbody" 2>/dev/null; then
      wreason="marker absent (STALE WEB BUILD: ${wshipped})"
    else
      wbuild=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('build',''))" "$wbody" 2>/dev/null || echo "")
      if [[ "$wname" == "web_build_sha" && "$wbuild" == "$WEB_BUILD_PLACEHOLDER" ]]; then
        wreason="build=unknown (image built without --build-arg BUILD_SHA)"
      else
        wpass=true
      fi
    fi

    if [[ "$wpass" != "true" ]]; then
      all_pass=false
      fail_summary+=("STALE_WEB:${wname} (${wreason})")
    fi

    if [[ "$JSON_OUTPUT" == "false" ]]; then
      if [[ "$wpass" == "true" ]]; then
        printf "  ${C_OK}✓${C_RST}  %-8s  %sweb build %s${C_RST}  http=%s\n" \
          "web" "$C_DIM" "${wbuild:0:12}" "$wcode"
      else
        printf "  ${C_FAIL}✗${C_RST}  %-8s  %sSTALE WEB BUILD${C_RST}  %s\n" \
          "web" "$C_DIM" "$wreason"
      fi
    else
      [[ "$web_first" == "false" ]] && web_json+=","
      web_first=false
      web_json+=$(printf '{"name":"%s","path":"%s","shipped_in":"%s","http":%s,"build":"%s","pass":%s,"reason":"%s"}' \
        "$wname" "$wpath" "$wshipped" "${wcode:-0}" "$wbuild" "$wpass" "$wreason")
    fi
    rm -f "$wbody"
  done
fi
web_json+="]"

if [[ "$JSON_OUTPUT" == "true" ]]; then
  printf '{"api_base":"%s","web_base":"%s","timestamp":"%s","all_pass":%s,"probes":%s,"freshness":%s,"link_freshness":%s,"web_freshness":%s}\n' \
    "$API_BASE" "$WEB_BASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$all_pass" "$results_json" "$freshness_json" "$link_json" "$web_json"
fi

if [[ "$all_pass" == "true" ]]; then
  $JSON_OUTPUT || echo -e "${C_OK}smoke-prod: PASS${C_RST}  (4/4 probes within budget, api+web builds fresh)"
  exit 0
else
  $JSON_OUTPUT || echo -e "${C_FAIL}smoke-prod: FAIL${C_RST}  ${fail_summary[*]}"
  exit 1
fi
