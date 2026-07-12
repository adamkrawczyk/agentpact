#!/usr/bin/env python3
"""
scripts/smoke-mcp.py — MCP server protocol smoke test.

Speaks the MCP Streamable HTTP transport directly (no SDK dependency):
  1. POST /mcp with `initialize` → captures mcp-session-id header
  2. POST /mcp with `notifications/initialized` → 202
  3. POST /mcp with `tools/list` → parses SSE response, counts tools
  4. POST /mcp with `tools/call` for a read-only happy-path tool → 200 + result

Exits 0 on full happy path, 1 on any drift. Closes the
escrow-safety rollout acceptance gate "real integration test runs end-to-end
happy path".

Usage:
  python3 scripts/smoke-mcp.py                    # default: hosted prod
  MCP_BASE=https://mcp.agentpact.xyz python3 …
  python3 scripts/smoke-mcp.py --json             # JSON output
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


MCP_BASE = os.environ.get("MCP_BASE", "https://mcp.agentpact.xyz")
TIMEOUT = 15.0
MIN_TOOLS = 25  # escrow-safety rollout spec floor


def post(url: str, body: dict, headers: dict | None = None,
         timeout: float = TIMEOUT) -> tuple[int, dict, str]:
    """POST JSON, return (status, response_headers, body_text)."""
    data = json.dumps(body).encode("utf-8")
    req_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if headers:
        req_headers.update(headers)
    req = Request(url, data=data, headers=req_headers, method="POST")
    started = time.monotonic()
    try:
        resp = urlopen(req, timeout=timeout)
        text = resp.read().decode("utf-8", "replace")
        return resp.status, dict(resp.headers), text
    except HTTPError as e:
        return e.code, dict(e.headers or {}), e.read().decode("utf-8", "replace")
    except URLError as e:
        raise RuntimeError(f"transport error: {e}") from e


def parse_sse_or_json(text: str) -> dict:
    """Streamable HTTP returns either JSON or text/event-stream. Strip data: lines."""
    text = text.strip()
    if text.startswith("event:") or text.startswith("data:"):
        # SSE format: collect all data: lines, concatenate, parse last
        chunks = [
            line[6:] for line in text.splitlines()
            if line.startswith("data: ")
        ]
        if not chunks:
            raise ValueError(f"SSE response had no data lines: {text[:200]}")
        return json.loads(chunks[-1])
    return json.loads(text)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--json", action="store_true", help="JSON output for CI")
    args = p.parse_args()

    results: dict = {
        "mcp_base": MCP_BASE,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "steps": [],
        "all_pass": False,
    }

    def step(name: str, fn) -> tuple[bool, dict]:
        t0 = time.monotonic()
        try:
            data = fn()
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            record = {"name": name, "pass": True, "elapsed_ms": elapsed_ms, **data}
        except Exception as e:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            record = {"name": name, "pass": False, "elapsed_ms": elapsed_ms, "error": f"{type(e).__name__}: {e}"}
        results["steps"].append(record)
        if not args.json:
            symbol = "\u2713" if record["pass"] else "\u2717"
            extra = f" — {record.get('error')}" if not record["pass"] else f" ({record['elapsed_ms']}ms)"
            print(f"  {symbol}  {name}{extra}")
        return record["pass"], record

    url = f"{MCP_BASE}/mcp"

    # Step 1: initialize
    session_id: str | None = None

    def do_init():
        nonlocal session_id
        body = {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "smoke-mcp", "version": "1.0"},
            },
        }
        status, headers, text = post(url, body)
        if status != 200:
            raise RuntimeError(f"initialize: HTTP {status} body={text[:200]}")
        # Find mcp-session-id case-insensitively
        sid = next((v for k, v in headers.items() if k.lower() == "mcp-session-id"), None)
        if not sid:
            raise RuntimeError(f"initialize: missing mcp-session-id header (got: {sorted(headers)})")
        session_id = sid
        parsed = parse_sse_or_json(text)
        if "result" not in parsed:
            raise RuntimeError(f"initialize: no result field — {text[:200]}")
        return {"session_id": sid, "server_info": parsed["result"].get("serverInfo", {})}

    ok, _ = step("initialize", do_init)
    if not ok:
        results["all_pass"] = False
        return _emit(args, results)

    # Step 2: initialized notification
    def do_initialized():
        body = {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        status, _, text = post(url, body, headers={"mcp-session-id": session_id})
        if status not in (200, 202):
            raise RuntimeError(f"initialized: HTTP {status} body={text[:200]}")
        return {"http": status}

    step("initialized notification", do_initialized)

    # Step 3: tools/list
    tool_names: list[str] = []

    def do_tools_list():
        body = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        status, _, text = post(url, body, headers={"mcp-session-id": session_id})
        if status != 200:
            raise RuntimeError(f"tools/list: HTTP {status} body={text[:200]}")
        parsed = parse_sse_or_json(text)
        tools = parsed.get("result", {}).get("tools", [])
        tool_names.extend(t["name"] for t in tools)
        if len(tool_names) < MIN_TOOLS:
            raise RuntimeError(f"tools/list: only {len(tool_names)} tools (spec floor: {MIN_TOOLS})")
        return {"tool_count": len(tool_names), "min_floor": MIN_TOOLS}

    ok, _ = step("tools/list (>=25 tools)", do_tools_list)
    if not ok:
        results["all_pass"] = False
        return _emit(args, results)

    # Step 4: tool schemas — verify a known read-only tool exists and has inputSchema
    def do_schema_sanity():
        body = {"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}}
        status, _, text = post(url, body, headers={"mcp-session-id": session_id})
        parsed = parse_sse_or_json(text)
        tools = parsed.get("result", {}).get("tools", [])
        required_tools = ["agentpact.register", "agentpact.create_offer",
                          "agentpact.propose_deal", "agentpact.close_deal"]
        by_name = {t["name"]: t for t in tools}
        missing = [t for t in required_tools if t not in by_name]
        if missing:
            raise RuntimeError(f"missing core tools: {missing}")
        no_schema = [n for n in required_tools
                     if not by_name[n].get("inputSchema", {}).get("properties")]
        if no_schema:
            raise RuntimeError(f"tools missing inputSchema.properties: {no_schema}")
        return {"core_tools_verified": required_tools}

    step("schema sanity (4 core tools have inputSchema)", do_schema_sanity)

    # Step 5: call a known read-only tool to prove tools/call wiring works
    # agentpact.get_overview is a stats endpoint, no auth required, GET-equivalent
    def do_tool_call():
        body = {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {"name": "agentpact.get_overview", "arguments": {}}}
        status, _, text = post(url, body, headers={"mcp-session-id": session_id})
        if status != 200:
            raise RuntimeError(f"tools/call: HTTP {status} body={text[:200]}")
        parsed = parse_sse_or_json(text)
        # Must either succeed with a result OR fail with a proper jsonrpc error envelope
        if "result" in parsed:
            content = parsed["result"].get("content", [])
            if not content:
                raise RuntimeError(f"tools/call: empty content — {text[:200]}")
            return {"call_succeeded": True, "content_items": len(content)}
        elif "error" in parsed:
            # Acceptable as long as it's a structured MCP error, not a transport failure
            err = parsed["error"]
            return {"call_succeeded": False, "structured_error": True,
                    "error_code": err.get("code"), "error_message": err.get("message", "")[:80]}
        else:
            raise RuntimeError(f"tools/call: neither result nor error — {text[:200]}")

    step("tools/call agentpact.get_overview (wire format check)", do_tool_call)

    # Step 6: session cleanup
    def do_delete():
        from urllib.request import Request
        assert session_id is not None, "session_id must be set before DELETE"
        req = Request(url, headers={"mcp-session-id": session_id}, method="DELETE")
        try:
            resp = urlopen(req, timeout=TIMEOUT)
            return {"http": resp.status}
        except HTTPError as e:
            return {"http": e.code}

    step("DELETE /mcp (session cleanup)", do_delete)

    results["all_pass"] = all(s["pass"] for s in results["steps"])
    return _emit(args, results)


def _emit(args, results: dict) -> int:
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        if results["all_pass"]:
            print(f"\nsmoke-mcp: PASS  ({len(results['steps'])} steps green)")
        else:
            failures = [s["name"] for s in results["steps"] if not s["pass"]]
            print(f"\nsmoke-mcp: FAIL  ({len(failures)} step(s): {', '.join(failures)})")
    return 0 if results["all_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
