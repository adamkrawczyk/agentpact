#!/bin/bash
# Fix TypeScript errors and add error handling manually

set -e
cd /home/adam/repos/agentpact

echo "🔧 Fixing AgentPact Code Quality Issues"
echo "========================================"
echo ""

# 1. Fix @ts-nocheck in API
echo "1️⃣ Removing @ts-nocheck from apps/api/src/index.ts..."
sed -i '1s|^// @ts-nocheck||' apps/api/src/index.ts
echo "   ✅ Removed"

# 2. Fix @ts-nocheck in MCP
echo "2️⃣ Removing @ts-nocheck from apps/mcp/src/index.ts..."
sed -i '1s|^// @ts-nocheck||' apps/mcp/src/index.ts
echo "   ✅ Removed"

# 3. Fix @ts-nocheck in Web
echo "3️⃣ Removing @ts-nocheck from apps/web/src/index.ts..."
sed -i '1s|^// @ts-nocheck||' apps/web/src/index.ts
echo "   ✅ Removed"

# 4. Try to build and capture errors
echo "4️⃣ Testing TypeScript compilation..."
if npm run build 2>&1 | tee build-errors.log; then
    echo "   ✅ Build passed!"
else
    echo "   ⚠️  Build errors found - check build-errors.log"
    echo "   Common fixes needed:"
    echo "   - Add proper types for database queries"
    echo "   - Fix missing return types"
    echo "   - Add null checks"
fi

echo ""
echo "📋 Next: Review build-errors.log and fix TypeScript errors"
echo "    Then run: npm run build to verify"
