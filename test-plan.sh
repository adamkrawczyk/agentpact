#!/bin/bash
# AgentPact Test & Quality Automation Script
# Tests code quality, dependencies, security, and deployment readiness

set -e
cd /home/adam/repos/agentpact

echo "🔍 AgentPact Quality Check"
echo "=========================="
echo ""

# 1. Check dependencies
echo "📦 Checking dependencies..."
if [ ! -d "node_modules" ]; then
  echo "❌ node_modules missing - run 'npm install' first"
  exit 1
fi
echo "✅ Dependencies installed"
echo ""

# 2. Check TypeScript compilation
echo "🔨 Type-checking..."
npm run build 2>&1 | tee build.log || {
  echo "❌ Build failed - check build.log"
  exit 1
}
echo "✅ TypeScript compilation passed"
echo ""

# 3. Check for missing env files
echo "🔐 Checking environment configuration..."
missing_env=()
[ ! -f "apps/api/.env.example" ] && missing_env+=("apps/api/.env.example")
[ ! -f "apps/mcp/.env.example" ] && missing_env+=("apps/mcp/.env.example")
[ ! -f "apps/web/.env.example" ] && missing_env+=("apps/web/.env.example")

if [ ${#missing_env[@]} -gt 0 ]; then
  echo "⚠️  Missing .env.example files:"
  printf '   %s\n' "${missing_env[@]}"
else
  echo "✅ Environment examples present"
fi
echo ""

# 4. Check Docker setup
echo "🐳 Checking Docker configuration..."
if [ ! -f "docker-compose.yml" ]; then
  echo "❌ docker-compose.yml missing"
  exit 1
fi
echo "✅ Docker config present"
echo ""

# 5. Check documentation
echo "📚 Checking documentation..."
missing_docs=()
[ ! -f "README.md" ] && missing_docs+=("README.md")
[ ! -f "docs/DEPLOYMENT.md" ] && missing_docs+=("docs/DEPLOYMENT.md")
[ ! -f "docs/WHITEPAPER.md" ] && missing_docs+=("docs/WHITEPAPER.md")
[ ! -f "docs/MCP_SKILL_README.md" ] && missing_docs+=("docs/MCP_SKILL_README.md")

if [ ${#missing_docs[@]} -gt 0 ]; then
  echo "❌ Missing documentation:"
  printf '   %s\n' "${missing_docs[@]}"
else
  echo "✅ Core documentation present"
fi
echo ""

# 6. Check API structure
echo "🌐 Checking API structure..."
api_issues=()
[ ! -f "apps/api/src/index.ts" ] && api_issues+=("apps/api/src/index.ts missing")
[ ! -d "apps/api/src/routes" ] && api_issues+=("apps/api/src/routes/ missing")
[ ! -d "apps/api/src/db" ] && api_issues+=("apps/api/src/db/ missing")

if [ ${#api_issues[@]} -gt 0 ]; then
  echo "❌ API structure issues:"
  printf '   %s\n' "${api_issues[@]}"
else
  echo "✅ API structure looks good"
fi
echo ""

# 7. Check MCP server
echo "🤖 Checking MCP server..."
mcp_issues=()
[ ! -f "apps/mcp/src/index.ts" ] && mcp_issues+=("apps/mcp/src/index.ts missing")
[ ! -f "apps/mcp/src/tools.ts" ] && mcp_issues+=("apps/mcp/src/tools.ts missing")

if [ ${#mcp_issues[@]} -gt 0 ]; then
  echo "❌ MCP structure issues:"
  printf '   %s\n' "${mcp_issues[@]}"
else
  echo "✅ MCP structure looks good"
fi
echo ""

# 8. Check web UI
echo "🎨 Checking web UI..."
web_issues=()
[ ! -f "apps/web/src/index.html" ] && web_issues+=("apps/web/src/index.html missing")
[ ! -f "apps/web/src/app.ts" ] && web_issues+=("apps/web/src/app.ts missing")

if [ ${#web_issues[@]} -gt 0 ]; then
  echo "❌ Web structure issues:"
  printf '   %s\n' "${web_issues[@]}"
else
  echo "✅ Web structure looks good"
fi
echo ""

# 9. Security checks
echo "🔒 Security scan..."
echo "   Checking for exposed secrets..."
if grep -r "PRIVATE_KEY\|SECRET\|PASSWORD" apps/ --include="*.ts" --include="*.js" | grep -v ".env" | grep -v "example" | grep -v "TODO" | head -5; then
  echo "⚠️  Potential hardcoded secrets found above"
else
  echo "✅ No obvious hardcoded secrets"
fi
echo ""

# 10. Check smart contract presence
echo "📜 Checking smart contracts..."
if [ ! -d "contracts" ]; then
  echo "⚠️  No contracts/ directory - smart contracts missing?"
else
  echo "✅ Smart contracts directory present"
fi
echo ""

# Summary
echo "=========================="
echo "✅ Quality check complete!"
echo ""
echo "Next steps for deployment:"
echo "1. Set up environment variables (.env files)"
echo "2. Configure Postgres connection"
echo "3. Deploy smart contracts (if present)"
echo "4. Run migrations: npm run migrate"
echo "5. Seed test data: npm run seed"
echo "6. Deploy to Netlify (frontend) + Docker (backend)"
echo ""
echo "See docs/DEPLOYMENT.md for detailed instructions"
