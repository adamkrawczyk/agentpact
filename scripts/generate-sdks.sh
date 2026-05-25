#!/usr/bin/env bash
set -euo pipefail

# Generate AgentPact SDK clients from API source.
# Environment:
#   SDK_TS_DIR     — path to TypeScript SDK repo (default: ../agentpact-sdk)
#   SDK_PYTHON_DIR — path to Python SDK repo     (default: ../agentpact-python-sdk)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_ROOT="$SCRIPT_DIR/../apps/api/src"

SDK_TS="${SDK_TS_DIR:-$SCRIPT_DIR/../../agentpact-sdk}"
SDK_PY="${SDK_PYTHON_DIR:-$SCRIPT_DIR/../../agentpact-python-sdk}"

if [ ! -d "$API_ROOT" ]; then
  echo "ERROR: API source root not found at $API_ROOT" >&2
  exit 1
fi

# ── Extract routes ────────────────────────────────────────────────────
# History (2026-03 WIS-82): routes were split out of index.ts into routes/*.ts
# modules. The old script only grepped index.ts and silently produced 0 routes,
# which broke the Publish SDKs CI workflow on every push to main from then on
# (run 26394464226 etc.). We now scan every .ts file under apps/api/src/ —
# index.ts still holds a few legacy routes, health.ts has /health/pool, and
# routes/*.ts holds the bulk. Both " and ' quoted route paths are accepted.
#
# Produces lines like: POST /api/agents
ROUTES=$(grep -rhoE "app\.(get|post|put|patch|delete)\([\"']([^\"']+)[\"']" "$API_ROOT" \
  --include='*.ts' \
  | sed -E "s/app\\.([a-z]+)\\([\"']([^\"']+)[\"']/\\U\\1\\E \\2/" \
  | sort -u)

ROUTE_COUNT=$(echo "$ROUTES" | grep -c . || true)
echo "Found $ROUTE_COUNT routes"

if [ "$ROUTE_COUNT" -lt 1 ]; then
  echo "ERROR: route discovery returned 0 entries — refusing to publish empty SDKs." >&2
  echo "       Check that apps/api/src/**/*.ts still uses the app.METHOD(\"path\", …) shape." >&2
  exit 1
fi

# ── Bump patch version in TS SDK ──────────────────────────────────────
if [ -f "$SDK_TS/package.json" ]; then
  cd "$SDK_TS"
  OLD_VER=$(node -p "require('./package.json').version")
  NEW_VER=$(echo "$OLD_VER" | awk -F. '{print $1"."$2"."$3+1}')
  # Use node for cross-platform JSON editing
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
    pkg.version = '$NEW_VER';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "TS SDK: $OLD_VER → $NEW_VER"
  cd - > /dev/null
fi

# ── Generate Python SDK ──────────────────────────────────────────────
mkdir -p "$SDK_PY/src/agentpact"

# Generate pyproject.toml if missing
if [ ! -f "$SDK_PY/pyproject.toml" ]; then
  PY_VER="0.1.0"
else
  PY_VER=$(grep -oP 'version\s*=\s*"\K[^"]+' "$SDK_PY/pyproject.toml" || echo "0.1.0")
fi
NEW_PY_VER=$(echo "$PY_VER" | awk -F. '{print $1"."$2"."$3+1}')

cat > "$SDK_PY/pyproject.toml" << TOML
[build-system]
requires = ["setuptools>=68.0", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "agentpact"
version = "$NEW_PY_VER"
description = "Python client for the AgentPact API"
readme = "README.md"
license = {text = "MIT"}
requires-python = ">=3.9"
dependencies = ["httpx>=0.25"]

[tool.setuptools.packages.find]
where = ["src"]
TOML

# Generate the Python client from routes
cat > "$SDK_PY/src/agentpact/__init__.py" << 'PYEOF'
"""AgentPact Python SDK — auto-generated client."""

from .client import AgentPactClient

__all__ = ["AgentPactClient"]
PYEOF

# Build method definitions from routes
python3 - "$ROUTES" "$SDK_PY/src/agentpact/client.py" << 'PYGEN'
import sys, re

routes_text = sys.argv[1]
out_path = sys.argv[2]

lines = [l.strip() for l in routes_text.strip().split('\n') if l.strip()]

methods = []
seen = set()

for line in lines:
    parts = line.split(None, 1)
    if len(parts) != 2:
        continue
    http_method, path = parts[0].lower(), parts[1]

    # Build method name from path: /api/agents/:id → agents_get_by_id
    clean = path.replace('/api/', '').strip('/')
    segments = clean.split('/')
    name_parts = []
    has_param = False
    for seg in segments:
        if seg.startswith(':'):
            has_param = True
        else:
            name_parts.append(seg.replace('-', '_'))

    method_name = '_'.join(name_parts)
    if http_method != 'get' and http_method != 'post':
        method_name = f"{method_name}_{http_method}"
    if has_param and http_method == 'get' and len([s for s in segments if s.startswith(':')]) > 0:
        if not method_name.endswith('_by_id'):
            pass  # keep as-is

    # Deduplicate
    base = method_name
    if method_name in seen:
        method_name = f"{method_name}_{http_method}"
    seen.add(method_name)

    # Params
    params = re.findall(r':(\w+)', path)
    param_str = ', '.join(f'{p}: str' for p in params)
    path_fmt = re.sub(r':(\w+)', r'{\1}', path)

    if http_method in ('post', 'put', 'patch'):
        if param_str:
            sig = f"self, {param_str}, data: dict | None = None"
        else:
            sig = "self, data: dict | None = None"
        body = f'return self._request("{http_method.upper()}", f"{path_fmt}", json=data)'
    else:
        if param_str:
            sig = f"self, {param_str}, params: dict | None = None"
        else:
            sig = "self, params: dict | None = None"
        body = f'return self._request("{http_method.upper()}", f"{path_fmt}", params=params)'

    methods.append(f"    def {method_name}({sig}):\n        {body}\n")

code = '''"""Auto-generated AgentPact API client."""

from __future__ import annotations
import httpx


class AgentPactClient:
    """Lightweight sync/async client for the AgentPact API."""

    def __init__(self, base_url: str = "https://api.agentpact.xyz", api_key: str | None = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._http = httpx.Client(base_url=self.base_url, headers=headers, timeout=timeout)

    def _request(self, method: str, path: str, **kwargs):
        resp = self._http.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json()

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

''' + '\n'.join(methods)

with open(out_path, 'w') as f:
    f.write(code)

print(f"Generated {len(methods)} methods → {out_path}")
PYGEN

# README for Python SDK
if [ ! -f "$SDK_PY/README.md" ]; then
  cat > "$SDK_PY/README.md" << 'MD'
# AgentPact Python SDK

Auto-generated Python client for the [AgentPact](https://agentpact.xyz) API.

```python
from agentpact import AgentPactClient

client = AgentPactClient(api_key="your-key")
agents = client.agents(params={"limit": "10"})
```

## Install

```bash
pip install agentpact
```
MD
fi

echo "Python SDK: $PY_VER → $NEW_PY_VER"
echo "Done! SDKs updated."
