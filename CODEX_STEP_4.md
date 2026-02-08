# Codex Step 4: Deployment Preparation

## Objective
Prepare AgentPact for production deployment with proper configuration, documentation, and deployment scripts.

## Tasks

### 1. Create Production Dockerfile

Create `Dockerfile` at repo root:

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/mcp/package*.json ./apps/mcp/
COPY apps/web/package*.json ./apps/web/

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build all apps
RUN npm run build

# Production stage (API)
FROM node:20-alpine AS api

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/index.js"]

# Production stage (MCP)
FROM node:20-alpine AS mcp

WORKDIR /app

COPY --from=builder /app/apps/mcp/dist ./dist
COPY --from=builder /app/apps/mcp/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "dist/index.js"]
```

Update `docker-compose.yml` for production:

```yaml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-agentpact}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backups:/backups
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: Dockerfile
      target: api
    environment:
      DATABASE_URL: ${DATABASE_URL}
      API_PORT: ${API_PORT:-4000}
      API_HOST: 0.0.0.0
      NODE_ENV: production
      PLATFORM_FEE_PCT: ${PLATFORM_FEE_PCT:-10}
      PLATFORM_WALLET: ${PLATFORM_WALLET}
      PLATFORM_PRIVATE_KEY: ${PLATFORM_PRIVATE_KEY}
      RPC_URL: ${RPC_URL}
      CHAIN_ID: ${CHAIN_ID:-8453}
      JWT_SECRET: ${JWT_SECRET}
      CORS_ORIGINS: ${CORS_ORIGINS}
      RATE_LIMIT_MAX: ${RATE_LIMIT_MAX:-100}
      ESCROW_CONTRACT_ADDRESS: ${ESCROW_CONTRACT_ADDRESS}
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "${API_PORT:-4000}:4000"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:4000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  mcp:
    build:
      context: .
      dockerfile: Dockerfile
      target: mcp
    environment:
      API_URL: http://api:4000
      MCP_PORT: ${MCP_PORT:-5000}
      NODE_ENV: production
    depends_on:
      - api
    ports:
      - "${MCP_PORT:-5000}:5000"
    restart: unless-stopped

volumes:
  pgdata:
```

### 2. Create Deployment Scripts

Create `scripts/deploy.sh`:

```bash
#!/bin/bash
set -e

echo "🚀 AgentPact Deployment Script"
echo "=============================="

# Check required env vars
required_vars=(
  "DATABASE_URL"
  "PLATFORM_WALLET"
  "RPC_URL"
  "JWT_SECRET"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "❌ Missing required environment variable: $var"
    exit 1
  fi
done

echo "✅ Environment variables validated"

# Build containers
echo "🔨 Building Docker containers..."
docker compose build

# Run migrations
echo "📊 Running database migrations..."
docker compose run --rm api npm run migrate

# Start services
echo "🎬 Starting services..."
docker compose up -d

# Wait for health checks
echo "⏳ Waiting for services to be healthy..."
sleep 10

# Check API health
if curl -f http://localhost:${API_PORT:-4000}/health > /dev/null 2>&1; then
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
```

Make it executable:
```bash
chmod +x scripts/deploy.sh
```

### 3. Create Environment Template

Create `.env.production.example`:

```bash
# Database (Required)
DATABASE_URL=postgres://user:password@host:5432/agentpact
POSTGRES_USER=postgres
POSTGRES_PASSWORD=
POSTGRES_DB=agentpact
POSTGRES_PORT=5432

# API Configuration
API_PORT=4000
API_HOST=0.0.0.0
NODE_ENV=production

# Blockchain (Required)
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN_ID=8453
ESCROW_CONTRACT_ADDRESS=

# Platform Wallet (Required)
PLATFORM_WALLET=0xYourPlatformWalletAddress
PLATFORM_PRIVATE_KEY=
PLATFORM_FEE_PCT=10

# Security (Required)
JWT_SECRET=
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000

# Logging
LOG_LEVEL=info

# MCP Server
MCP_PORT=5000

# Optional: Analytics
SENTRY_DSN=
ANALYTICS_ID=
```

### 4. Add Health Monitoring

Create `apps/api/src/health.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import postgres from "postgres";

export function registerHealthChecks(app: FastifyInstance, sql: any) {
  // Basic health check
  app.get("/health", async () => {
    return {
      ok: true,
      service: "agentpact-api",
      timestamp: new Date().toISOString()
    };
  });
  
  // Detailed health check
  app.get("/health/detailed", async () => {
    const checks: Record<string, any> = {
      api: { status: "healthy" },
      database: { status: "unknown" },
      timestamp: new Date().toISOString()
    };
    
    // Check database
    try {
      await sql`SELECT 1`;
      checks.database = { status: "healthy" };
    } catch (error) {
      checks.database = {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
    
    const allHealthy = Object.values(checks)
      .filter(v => typeof v === "object" && "status" in v)
      .every(v => v.status === "healthy");
    
    return {
      ok: allHealthy,
      checks
    };
  });
  
  // Readiness check (for k8s)
  app.get("/ready", async () => {
    try {
      await sql`SELECT 1`;
      return { ready: true };
    } catch {
      return { ready: false };
    }
  });
  
  // Liveness check (for k8s)
  app.get("/live", async () => {
    return { alive: true };
  });
}
```

### 5. Add Database Backup Script

Create `scripts/backup-db.sh`:

```bash
#!/bin/bash
set -e

BACKUP_DIR="/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agentpact_backup_$TIMESTAMP.sql"

echo "📦 Creating database backup..."

docker compose exec -T postgres pg_dump -U postgres agentpact > "$BACKUP_FILE"

# Compress
gzip "$BACKUP_FILE"

echo "✅ Backup created: ${BACKUP_FILE}.gz"

# Clean up old backups (keep last 7 days)
find "$BACKUP_DIR" -name "agentpact_backup_*.sql.gz" -mtime +7 -delete

echo "🧹 Cleaned up old backups"
```

Make it executable:
```bash
chmod +x scripts/backup-db.sh
```

### 6. Create README for Deployment

Create `docs/DEPLOYMENT.md`:

```markdown
# AgentPact Deployment Guide

## Prerequisites

- Docker & Docker Compose
- Postgres database (or use Docker)
- Base network RPC endpoint (Alchemy/Infura)
- Platform wallet address
- Domain name (optional but recommended)

## Quick Start

### 1. Clone Repository

\`\`\`bash
git clone https://github.com/yourusername/agentpact.git
cd agentpact
\`\`\`

### 2. Configure Environment

\`\`\`bash
cp .env.production.example .env.production
nano .env.production
\`\`\`

Fill in required values:
- DATABASE_URL
- PLATFORM_WALLET
- RPC_URL
- JWT_SECRET (generate with: openssl rand -hex 32)

### 3. Deploy

\`\`\`bash
./scripts/deploy.sh
\`\`\`

### 4. Verify

\`\`\`bash
curl http://localhost:4000/health
\`\`\`

## Production Deployment

### Option 1: Railway

1. Push to GitHub
2. Go to railway.app
3. New Project → Deploy from GitHub
4. Add Postgres plugin
5. Set environment variables
6. Deploy!

### Option 2: Fly.io

\`\`\`bash
fly launch
fly secrets set JWT_SECRET=xxx DATABASE_URL=xxx ...
fly deploy
\`\`\`

### Option 3: VPS (Digital Ocean, AWS, etc.)

\`\`\`bash
# SSH into server
ssh user@your-server.com

# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone repo
git clone https://github.com/yourusername/agentpact.git
cd agentpact

# Configure
cp .env.production.example .env.production
nano .env.production

# Deploy
./scripts/deploy.sh

# Set up reverse proxy (nginx)
sudo apt install nginx
# Configure nginx to proxy to localhost:4000
\`\`\`

## Monitoring

### Health Checks

- Basic: `GET /health`
- Detailed: `GET /health/detailed`
- Ready: `GET /ready` (k8s readiness probe)
- Live: `GET /live` (k8s liveness probe)

### Logs

\`\`\`bash
# All services
docker compose logs -f

# API only
docker compose logs -f api

# Database
docker compose logs -f postgres
\`\`\`

### Metrics

Consider adding:
- Sentry for error tracking
- Prometheus + Grafana for metrics
- Uptimerobot for uptime monitoring

## Backups

### Manual Backup

\`\`\`bash
./scripts/backup-db.sh
\`\`\`

### Automated Backups (Cron)

\`\`\`bash
crontab -e

# Add this line (daily at 2 AM)
0 2 * * * /path/to/agentpact/scripts/backup-db.sh
\`\`\`

## Scaling

### Horizontal Scaling (Multiple API Instances)

\`\`\`yaml
# docker-compose.yml
services:
  api:
    deploy:
      replicas: 3
\`\`\`

### Database Connection Pooling

Already configured via postgres.js (max: 10 connections)

## Troubleshooting

### API Won't Start

\`\`\`bash
# Check logs
docker compose logs api

# Common issues:
# - Database not ready → Wait for postgres health check
# - Missing env vars → Check .env.production
# - Port conflict → Change API_PORT
\`\`\`

### Database Connection Errors

\`\`\`bash
# Test connection
docker compose exec postgres psql -U postgres -d agentpact -c "SELECT 1"
\`\`\`

### High Memory Usage

\`\`\`bash
# Limit container memory
docker compose up -d --scale api=2 --memory="512m"
\`\`\`

## Security Checklist

- [ ] JWT_SECRET is random and secure (32+ chars)
- [ ] PLATFORM_PRIVATE_KEY stored securely (consider secrets manager)
- [ ] CORS_ORIGINS restricted to your domain
- [ ] Database not exposed publicly
- [ ] HTTPS enabled (use Let's Encrypt)
- [ ] Rate limiting configured
- [ ] Regular backups scheduled
- [ ] Monitoring and alerting set up

## Support

Issues: https://github.com/yourusername/agentpact/issues
Docs: https://docs.agentpact.com
\`\`\`

### 7. Final Checklist Script

Create `scripts/preflight-check.sh`:

```bash
#!/bin/bash

echo "✈️  AgentPact Preflight Check"
echo "============================"
echo ""

checks_passed=0
checks_failed=0

# Check Docker
if command -v docker &> /dev/null; then
  echo "✅ Docker installed"
  ((checks_passed++))
else
  echo "❌ Docker not installed"
  ((checks_failed++))
fi

# Check Docker Compose
if command -v docker compose &> /dev/null; then
  echo "✅ Docker Compose installed"
  ((checks_passed++))
else
  echo "❌ Docker Compose not installed"
  ((checks_failed++))
fi

# Check .env file
if [ -f ".env.production" ]; then
  echo "✅ .env.production exists"
  ((checks_passed++))
  
  # Check critical env vars
  source .env.production
  
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

# Check build
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
```

Make executable:
```bash
chmod +x scripts/preflight-check.sh
```

### When Complete

Run this command:
```bash
openclaw gateway wake --text "Deployment prep complete! Ready to ship 🚀" --mode now
```

## Success Criteria

- ✅ Production Dockerfile created
- ✅ Docker Compose configured for production
- ✅ Deployment script automated
- ✅ Environment template documented
- ✅ Health checks implemented
- ✅ Backup script created
- ✅ Deployment guide written
- ✅ Preflight check script ready
- ✅ Security checklist included

## Next Steps

After this step:
1. User provides production credentials
2. Deploy smart contracts to Base
3. Run deployment script
4. Test in production
5. Monitor and iterate
