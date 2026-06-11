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
  local mode="$1"  # "ok" | "slow" | "fail" | "garbage"
  python3 - "$PORT" "$mode" <<'PYEOF' &
import http.server, json, sys, time
port = int(sys.argv[1])
mode = sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **kw): pass
    def do_GET(self):
        if mode == "slow":
            time.sleep(4)
        if mode == "fail":
            self.send_response(503); self.end_headers(); self.wfile.write(b'{"error":"down"}'); return
        if mode == "garbage":
            self.send_response(200); self.end_headers(); self.wfile.write(b"not json"); return
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
  API_BASE="http://127.0.0.1:${PORT}" HEALTH_BUDGET_MS=2000 DATA_BUDGET_MS=2000 \
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
HEALTH_BUDGET_MS=500 DATA_BUDGET_MS=500 API_BASE="http://127.0.0.1:${PORT}" \
  bash "${SCRIPT_DIR}/smoke-prod.sh" >/dev/null 2>&1 || out_rc=$?
assert "exit code 1 on budget breach" "$out_rc" "1"
stop_mock

echo ""
echo "Results: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
