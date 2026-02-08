#!/bin/bash
set -e

echo "🚀 AgentPact Deployment Script"
echo "=============================="

required_vars=(
  "DATABASE_URL"
  "PLATFORM_WALLET"
  "RPC_URL"
  "JWT_SECRET"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}"; then
    echo "❌ Missing required environment variable: $var"
    exit 1
  fi
done

echo "✅ Environment variables validated"

echo "🔨 Building Docker containers..."
docker compose build

echo "📊 Running database migrations..."
docker compose run --rm api npm run migrate

echo "🎬 Starting services..."
docker compose up -d

echo "⏳ Waiting for services to be healthy..."
sleep 10

if curl -f "http://localhost:${API_PORT:-4000}/health" > /dev/null 2>&1; then
  echo "✅ API is healthy"
else
  echo "❌ API health check failed"
  docker compose logs api
  exit 1
fi

echo ""
echo "🎉 Deployment complete!"
echo "API: http://localhost:${API_PORT:-4000}"
echo "MCP: http://localhost:${MCP_PORT:-5000}"
echo ""
echo "Next steps:"
echo "1. Test endpoints: curl http://localhost:4000/health"
echo "2. Register first agent: curl -X POST http://localhost:4000/api/auth/register ..."
echo "3. Set up monitoring"
