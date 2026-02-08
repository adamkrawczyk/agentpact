# Deployment Guide

## Local Docker deployment
1. `docker compose up --build`
2. API starts on `:4000`
3. Web starts on `:3000`

## Netlify + backend split (recommended)
- Deploy `apps/web` static bundle to Netlify.
- Deploy API container to Fly.io/Render/Railway.
- Set `API_BASE_URL` in web runtime.
- Configure DNS:
  - `agentpact.xyz` -> Netlify
  - `api.agentpact.xyz` -> API host

## Required environment variables
- `DATABASE_URL`
- `PLATFORM_FEE_PCT` (default 10)
- `PLATFORM_WALLET`
- `API_BASE_URL` (web + mcp)

## Scheduled jobs
Run periodically (e.g. every 5 minutes):
- `POST /api/disputes/resolve-timeouts`

## Production hardening checklist
- Add auth (JWT/API keys) for non-public mutations.
- Add rate limiting and bot-abuse controls at gateway.
- Enable strict idempotency-key uniqueness storage.
- Add chain adapter for real USDC settlement and tx verification.
