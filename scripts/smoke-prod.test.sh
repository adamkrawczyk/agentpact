#!/usr/bin/env bash
# Unit-tests scripts/smoke-prod.sh using a local mock server.
# Run: bash scripts/smoke-prod.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=18837
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_mock() {
  local mode="$1"  # "ok" | "slow" | "fail" | "garbage" | "web_stale" | "web_unknown"
  python3 - "$PORT" "$mode" <<'PYEOF' &
import http.server, json, sys, time
port = int(sys.argv[1])
mode = sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **kw): pass
    def do_GET(self):
        # Web-freshness probe target. The same mock serves as both API_BASE and
        # WEB_BASE in these tests, so /health must answer the web shape.
        if self.path == "/health":
            if mode == "web_stale":
                # Pre-2026-08-28 web build: no `build` field at all.
                body = b'{"ok":true,"service":"web","ts":"2026-08-28T00:00:00Z"}'
            elif mode == "web_unknown":
                # Image built without --build-arg BUILD_SHA.
                body = b'{"ok":true,"service":"web","build":"unknown","ts":"2026-08-28T00:00:00Z"}'
            else:
                body = b'{"ok":true,"service":"web","build":"0bbea32deadbeef","ts":"2026-08-28T00:00:00Z"}'
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.end_headers(); self.wfile.write(body); return
        if mode == "slow":
            time.sleep(4)
        if mode == "fail":
            self.send_response(503); self.end_headers(); self.wfile.write(b'{"error":"down"}'); return
        if mode == "garbage":
            self.send_response(200); self.end_headers(); self.wfile.write(b"not json"); return
        # Link-header freshness probe target: GET /api/deals/<id> (non-settlement path).
        if self.path.startswith("/api/deals/") and not self.path.endswith("/settlement"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            if mode == "link_stale":
                self.send_header("Link", '</api/intents>; rel="successor-version"')
            elif mode == "link_absent":
                pass
            else:
                # default / "ok" / "link_fresh": current build's header.
                self.send_header("Link", '</api/intents/discover>; rel="successor-version"')
            self.end_headers()
            self.wfile.write(b'{"error":"Deal not found"}')
            return
        # ok
        payload = b'{"ok":true}' if self.path == "/api/health" else b'[{"id":"x"}]'
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(payload)

s = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
s.serve_forever()
PYEOF
  SERVER_PID=$!
  # wait for the port to accept TCP connections (works for slow mode too)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "mock server did not start" >&2
  exit 1
}

stop_mock() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  # wait for the port to be free
  for _ in 1 2 3 4 5; do
    if ! curl -sf -m 0.3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
}

run_smoke() {
  API_BASE="http://127.0.0.1:${PORT}" WEB_BASE="http://127.0.0.1:${PORT}" \
    HEALTH_BUDGET_MS=2000 DATA_BUDGET_MS=2000 SKIP_FRESHNESS=1 \
    bash "${SCRIPT_DIR}/smoke-prod.sh" "$@"
}

# Same mock, but WITH freshness evaluation enabled (API freshness probe is
# tolerant here — the mock returns a JSON body that is not Fastify's
# route-not-found shape, so it reads as fresh; the web probe is what we assert).
run_smoke_fresh() {
  API_BASE="http://127.0.0.1:${PORT}" WEB_BASE="http://127.0.0.1:${PORT}" \
    HEALTH_BUDGET_MS=2000 DATA_BUDGET_MS=2000 \
    bash "${SCRIPT_DIR}/smoke-prod.sh" "$@"
}

pass=0
fail=0
assert() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $name"; pass=$((pass+1))
  else
    echo "  ✗ $name (expected $expected, got $actual)"; fail=$((fail+1))
  fi
}

echo "▸ test 1: all endpoints healthy → exit 0"
start_mock ok
out_rc=0
out=$(run_smoke 2>&1) || out_rc=$?
assert "exit code 0" "$out_rc" "0"
echo "$out" | grep -q "PASS" && assert "PASS line present" "yes" "yes" || assert "PASS line present" "no" "yes"
stop_mock

echo "▸ test 2: --json output is valid JSON with all_pass=true"
start_mock ok
json_out=$(run_smoke --json)
all_pass=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['all_pass'])")
assert "JSON all_pass" "$all_pass" "True"
n_probes=$(echo "$json_out" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['probes']))")
assert "JSON 4 probes" "$n_probes" "4"
stop_mock

echo "▸ test 3: 503 backend → exit 1"
start_mock fail
out_rc=0
run_smoke >/dev/null 2>&1 || out_rc=$?
assert "exit code 1 on 503" "$out_rc" "1"
stop_mock

echo "▸ test 4: garbage body → exit 1 (json validation)"
start_mock garbage
out_rc=0
run_smoke >/dev/null 2>&1 || out_rc=$?
assert "exit code 1 on invalid JSON" "$out_rc" "1"
stop_mock

echo "▸ test 5: slow server (4s) breaches data budget → exit 1"
start_mock slow
out_rc=0
HEALTH_BUDGET_MS=500 DATA_BUDGET_MS=500 SKIP_FRESHNESS=1 \
  API_BASE="http://127.0.0.1:${PORT}" WEB_BASE="http://127.0.0.1:${PORT}" \
  bash "${SCRIPT_DIR}/smoke-prod.sh" >/dev/null 2>&1 || out_rc=$?
assert "exit code 1 on budget breach" "$out_rc" "1"
stop_mock

# ── Web-freshness regression suite (2026-08-28) ─────────────────────────────
# These are the RED proofs for the incident this probe exists to catch: PR #115
# merged and green, live web still serving an old build, every previous probe
# green. A stale web tier must now fail LOUDLY.

echo "▸ test 6: fresh web build (real BUILD_SHA) → exit 0 and pass reported"
start_mock ok
out_rc=0
json_out=$(run_smoke_fresh --json) || out_rc=$?
assert "exit code 0 with fresh web build" "$out_rc" "0"
wpass=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['web_freshness'][0]['pass'])")
assert "web_freshness pass" "$wpass" "True"
wbuild=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['web_freshness'][0]['build'])")
assert "web build sha surfaced" "$wbuild" "0bbea32deadbeef"
stop_mock

echo "▸ test 7: STALE web build (no build field) → exit 1"
start_mock web_stale
out_rc=0
out=$(run_smoke_fresh 2>&1) || out_rc=$?
assert "exit code 1 on stale web build" "$out_rc" "1"
echo "$out" | grep -q "STALE_WEB" \
  && assert "STALE_WEB named in failure summary" "yes" "yes" \
  || assert "STALE_WEB named in failure summary" "no" "yes"
stop_mock

echo "▸ test 8: web build='unknown' (no --build-arg BUILD_SHA) → exit 1"
start_mock web_unknown
out_rc=0
json_out=$(run_smoke_fresh --json) || out_rc=$?
assert "exit code 1 on placeholder build sha" "$out_rc" "1"
wpass=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['web_freshness'][0]['pass'])")
assert "web_freshness fail on unknown" "$wpass" "False"
stop_mock

echo "▸ test 9: SKIP_FRESHNESS=1 bypasses the web probe entirely (pre-deploy use)"
start_mock web_stale
out_rc=0
json_out=$(run_smoke --json) || out_rc=$?
assert "exit code 0 when freshness skipped" "$out_rc" "0"
n_web=$(echo "$json_out" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['web_freshness']))")
assert "web_freshness empty when skipped" "$n_web" "0"
stop_mock

# ── API Link-header freshness regression suite (incident 2026-08-30) ───────
# RED proofs for: PR #116 merged (101b1cd), CI green, route-presence freshness
# stayed green (the route never disappeared), yet prod served the OLD Link
# header value for hours because nothing deployed the API image. Route-exists
# checks cannot catch a header-VALUE regression; only a literal header
# comparison can.

echo "▸ test 10: fresh Link header (new successor route) → exit 0"
start_mock link_fresh
out_rc=0
json_out=$(run_smoke_fresh --json) || out_rc=$?
assert "exit code 0 with fresh Link header" "$out_rc" "0"
lpass=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['link_freshness'][0]['pass'])")
assert "link_freshness pass" "$lpass" "True"
lactual=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['link_freshness'][0]['actual'])")
assert "link actual value" "$lactual" '</api/intents/discover>; rel="successor-version"'
stop_mock

echo "▸ test 11: STALE Link header (old /api/intents successor) → exit 1"
start_mock link_stale
out_rc=0
out=$(run_smoke_fresh 2>&1) || out_rc=$?
assert "exit code 1 on stale Link header" "$out_rc" "1"
echo "$out" | grep -q "STALE_LINK" \
  && assert "STALE_LINK named in failure summary" "yes" "yes" \
  || assert "STALE_LINK named in failure summary" "no" "yes"
stop_mock

echo "▸ test 12: Link header entirely absent → exit 1"
start_mock link_absent
out_rc=0
json_out=$(run_smoke_fresh --json) || out_rc=$?
assert "exit code 1 when Link header absent" "$out_rc" "1"
lpass=$(echo "$json_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['link_freshness'][0]['pass'])")
assert "link_freshness fail on absent header" "$lpass" "False"
stop_mock

echo "▸ test 13: SKIP_FRESHNESS=1 bypasses the Link probe entirely (pre-deploy use)"
start_mock link_stale
out_rc=0
json_out=$(run_smoke --json) || out_rc=$?
assert "exit code 0 when freshness skipped (link)" "$out_rc" "0"
n_link=$(echo "$json_out" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['link_freshness']))")
assert "link_freshness empty when skipped" "$n_link" "0"
stop_mock

echo ""
echo "Results: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
