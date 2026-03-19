#!/bin/bash
# Lint: detect duplicate Fastify route declarations across all route files
# Run before commit/push to prevent FST_ERR_DUPLICATED_ROUTE crashes
set -euo pipefail

DUPES=$(grep -rn 'app\.\(post\|get\|patch\|delete\|put\)(' apps/api/src/routes/ apps/api/src/index.ts 2>/dev/null \
  | sed 's/.*app\.\(post\|get\|patch\|delete\|put\)("\([^"]*\)".*/\1 \2/' \
  | sort | uniq -c | sort -rn | grep -v '^ *1 ' || true)

if [ -n "$DUPES" ]; then
  echo "❌ DUPLICATE ROUTES DETECTED:"
  echo "$DUPES"
  echo ""
  echo "Each method+path must exist in exactly ONE route file."
  echo "Check routes/ directory for copies left after refactoring."
  exit 1
fi

echo "✅ No duplicate routes found"
