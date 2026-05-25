#!/usr/bin/env python3
"""Self-tests for scripts/smoke-mcp.py — spins a local mock MCP server."""
from __future__ import annotations

import http.server
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

PORT = 18838
SCRIPT_DIR = Path(__file__).resolve().parent


def make_handler(mode: str):
    """Mock MCP handler.

    mode='ok':   full happy path
    mode='no_session': initialize returns 200 but no mcp-session-id header
    mode='few_tools':  tools/list returns 5 tools (below floor of 25)
    """
    sessions: dict[str, bool] = {}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a, **kw): pass

        def _read_body(self) -> dict:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw) if raw else {}

        def _write_json(self, body: dict, status: int = 200,
                        session_id: str | None = None) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if session_id:
                self.send_header("mcp-session-id", session_id)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            req = self._read_body()
            method = req.get("method", "")

            if method == "initialize":
                sid = str(uuid.uuid4()) if mode != "no_session" else None
                if sid:
                    sessions[sid] = True
                self._write_json(
                    {"jsonrpc": "2.0", "id": req.get("id"),
                     "result": {"protocolVersion": "2025-06-18",
                                "capabilities": {},
                                "serverInfo": {"name": "mock", "version": "1.0"}}},
                    session_id=sid,
                )
                return

            if method == "notifications/initialized":
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            if method == "tools/list":
                if mode == "few_tools":
                    tools = [
                        {"name": f"agentpact.fake_{i}",
                         "description": "x",
                         "inputSchema": {"type": "object", "properties": {}}}
                        for i in range(5)
                    ]
                else:
                    tools = []
                    # 30 tools, all 4 core ones present
                    core = ["register", "create_offer", "propose_deal", "close_deal"]
                    for n in core + [f"extra_{i}" for i in range(26)]:
                        tools.append({
                            "name": f"agentpact.{n}",
                            "description": "x",
                            "inputSchema": {"type": "object",
                                            "properties": {"foo": {"type": "string"}}},
                        })
                self._write_json({"jsonrpc": "2.0", "id": req.get("id"),
                                  "result": {"tools": tools}})
                return

            if method == "tools/call":
                self._write_json({"jsonrpc": "2.0", "id": req.get("id"),
                                  "result": {"content": [{"type": "text", "text": "ok"}]}})
                return

            self._write_json({"jsonrpc": "2.0", "id": req.get("id"),
                              "error": {"code": -32601, "message": "method not found"}})

        def do_DELETE(self):
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return H


def run_server(mode: str) -> http.server.ThreadingHTTPServer:
    handler = make_handler(mode)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    # wait for the port to accept
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            import socket
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
                return srv
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("mock MCP did not bind")


def call_smoke(*args: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "smoke-mcp.py"), *args],
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "MCP_BASE": f"http://127.0.0.1:{PORT}"},
    )
    return proc.returncode, proc.stdout, proc.stderr


def main() -> int:
    tests = [
        ("happy path → exit 0",        "ok",         0),
        ("no session id → exit 1",     "no_session", 1),
        ("only 5 tools → exit 1",      "few_tools",  1),
    ]
    pass_ct, fail_ct = 0, 0
    for name, mode, expected_rc in tests:
        print(f"\u25b8 test: {name}")
        srv = run_server(mode)
        try:
            rc, _stdout, _stderr = call_smoke()
            ok = rc == expected_rc
            mark = "\u2713" if ok else "\u2717"
            print(f"  {mark} exit code {rc} (expected {expected_rc})")
            if ok:
                pass_ct += 1
            else:
                fail_ct += 1
        finally:
            srv.shutdown()
            srv.server_close()

    # JSON output validity test
    print("\u25b8 test: --json output is valid JSON")
    srv = run_server("ok")
    try:
        rc, stdout, _stderr = call_smoke("--json")
        try:
            data = json.loads(stdout)
            ok = data.get("all_pass") is True and len(data.get("steps", [])) >= 6
            mark = "\u2713" if ok else "\u2717"
            print(f"  {mark} JSON valid + all_pass=true + >=6 steps")
            if ok:
                pass_ct += 1
            else:
                fail_ct += 1
        except json.JSONDecodeError as e:
            print(f"  \u2717 JSON parse error: {e}")
            fail_ct += 1
    finally:
        srv.shutdown()
        srv.server_close()

    print(f"\nResults: {pass_ct} passed, {fail_ct} failed")
    return 0 if fail_ct == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
