#!/bin/bash

echo "✈️  AgentPact Preflight Check"
echo "============================"
echo ""

checks_passed=0
checks_failed=0

if command -v docker > /dev/null 2>&1; then
  echo "✅ Docker installed"
  ((checks_passed++))
else
  echo "❌ Docker not installed"
  ((checks_failed++))
fi

if docker compose version > /dev/null 2>&1; then
  echo "✅ Docker Compose installed"
  ((checks_passed++))
else
  echo "❌ Docker Compose not installed"
  ((checks_failed++))
fi

if [ -f ".env.production" ]; then
  echo "✅ .env.production exists"
  ((checks_passed++))

  set -a
  source .env.production
  set +a

  if [ -n "$DATABASE_URL" ]; then
    echo "✅ DATABASE_URL configured"
    ((checks_passed++))
  else
    echo "❌ DATABASE_URL missing"
    ((checks_failed++))
  fi

  if [ -n "$JWT_SECRET" ] && [ ${#JWT_SECRET} -ge 32 ]; then
    echo "✅ JWT_SECRET configured (${#JWT_SECRET} chars)"
    ((checks_passed++))
  else
    echo "❌ JWT_SECRET missing or too short"
    ((checks_failed++))
  fi

  if [ -n "$PLATFORM_WALLET" ]; then
    echo "✅ PLATFORM_WALLET configured"
    ((checks_passed++))
  else
    echo "❌ PLATFORM_WALLET missing"
    ((checks_failed++))
  fi
else
  echo "❌ .env.production not found"
  ((checks_failed++))
fi

if [ -d "apps/api/dist" ]; then
  echo "✅ API built"
  ((checks_passed++))
else
  echo "⚠️  API not built (will build during deploy)"
fi

echo ""
echo "Summary: $checks_passed passed, $checks_failed failed"

if [ $checks_failed -gt 0 ]; then
  echo "❌ Preflight check failed"
  exit 1
else
  echo "✅ Ready for deployment!"
  exit 0
fi
