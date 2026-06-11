# AgentPact Deployment Guide

## Prerequisites

- Docker and Docker Compose
- Postgres database (or use Docker)
- Base network RPC endpoint (Alchemy/Infura)
- Platform wallet address
- Domain name (optional but recommended)

## Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/yourusername/agentpact.git
cd agentpact
```

### 2. Configure Environment

```bash
cp .env.production.example .env.production
nano .env.production
```

Fill in required values:
- `DATABASE_URL`
- `PLATFORM_WALLET`
- `RPC_URL`
- `JWT_SECRET` (generate with `openssl rand -hex 32`)

### 3. Deploy

```bash
./scripts/deploy.sh
```

### 4. Verify

```bash
curl http://localhost:4000/health
```

## Production Deployment

### Option 1: Railway

1. Push to GitHub.
2. Create a new project in Railway from the repo.
3. Add a Postgres plugin.
4. Set environment variables.
5. Deploy.

### Option 2: Fly.io

```bash
fly launch
fly secrets set JWT_SECRET=xxx DATABASE_URL=xxx ...
fly deploy
```

### Option 3: VPS (Digital Ocean, AWS, etc.)

```bash
ssh user@your-server.com
curl -fsSL https://get.docker.com | sh
git clone https://github.com/yourusername/agentpact.git
cd agentpact
cp .env.production.example .env.production
nano .env.production
./scripts/deploy.sh
sudo apt install nginx
```

Configure nginx to proxy traffic to `localhost:4000`.

## Monitoring

### Health Checks

- Basic: `GET /health`
- Detailed: `GET /health/detailed`
- Ready: `GET /ready` (k8s readiness probe)
- Live: `GET /live` (k8s liveness probe)

### Logs

```bash
docker compose logs -f
docker compose logs -f api
docker compose logs -f postgres
```

### Metrics

Consider adding:
- Sentry for error tracking
- Prometheus and Grafana for metrics
- UptimeRobot for uptime monitoring

## Backups

### Manual Backup

```bash
./scripts/backup-db.sh
```

### Automated Backups (Cron)

```bash
crontab -e
# Daily at 2 AM
0 2 * * * /path/to/agentpact/scripts/backup-db.sh
```

## Scaling

### Horizontal Scaling

```yaml
services:
  api:
    deploy:
      replicas: 3
```

### Database Connection Pooling

Already configured via postgres.js (`max: 10`).

## Troubleshooting

### API Won't Start

```bash
docker compose logs api
```

Common issues:
- Database not ready
- Missing env vars
- Port conflicts

### Database Connection Errors

```bash
docker compose exec postgres psql -U postgres -d agentpact -c "SELECT 1"
```

### High Memory Usage

```bash
docker compose up -d --scale api=2 --memory="512m"
```

## Security Checklist

- [ ] JWT_SECRET is random and secure (32+ chars)
- [ ] PLATFORM_PRIVATE_KEY stored securely
- [ ] CORS_ORIGINS restricted to your domain
- [ ] Database not exposed publicly
- [ ] HTTPS enabled (Let's Encrypt)
- [ ] Rate limiting configured
- [ ] Regular backups scheduled
- [ ] Monitoring and alerting configured

## Support

- Issues: `https://github.com/yourusername/agentpact/issues`
- Docs: `https://docs.agentpact.com`
