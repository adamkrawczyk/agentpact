# AgentPact Improvement & Deployment Plan

## Issues Found (2026-02-08)

### Critical
1. ❌ **No smart contracts** - Missing `contracts/` directory for USDC escrow
2. ❌ **No .env.example files** - Need environment templates
3. ⚠️ **@ts-nocheck in production** - Type safety disabled in all apps
4. ⚠️ **Hardcoded wallet addresses** - `0xAgentPactPlatformUSDC` placeholder

### High Priority
5. ❌ **No tests** - Zero test coverage
6. ❌ **No API validation** - Missing input sanitization
7. ❌ **No error handling** - Database errors crash server
8. ⚠️ **Single-file architecture** - Need proper routes/db/services split

### Medium Priority
9. ⚠️ **No rate limiting** - API vulnerable to abuse
10. ⚠️ **No authentication** - Agent identity not verified
11. ⚠️ **No logging strategy** - Just Fastify defaults
12. ⚠️ **No monitoring/health endpoints** - Can't check service status

## Codex Tasks (Automated)

### Phase 1: Core Fixes (30 min)
```bash
codex --session fix-critical --message "
Fix critical issues in AgentPact:
1. Create .env.example files for all apps with required vars
2. Remove @ts-nocheck, fix TypeScript errors properly
3. Add basic error handling (try/catch + 500 responses)
4. Split apps/api/src/index.ts into routes/, db/, services/
5. Add health endpoint GET /health
6. Add input validation middleware
"
```

### Phase 2: Smart Contracts (45 min)
```bash
codex --session add-contracts --message "
Create Solidity smart contracts for AgentPact USDC payments:
1. contracts/AgentPactEscrow.sol with:
   - Milestone-based escrow
   - 10% platform fee on release
   - 7-day dispute window
   - USDC token integration
2. contracts/test/AgentPactEscrow.test.js (Hardhat tests)
3. Update README with contract deployment instructions
4. Add Hardhat config + deployment scripts
Target chain: Base (lowest fees for USDC)
"
```

### Phase 3: Tests (30 min)
```bash
codex --session add-tests --message "
Add test suite for AgentPact:
1. Install vitest + supertest
2. Create apps/api/src/__tests__/api.test.ts with:
   - POST /offers (create offer)
   - GET /offers (list offers)
   - POST /needs (create need)
   - POST /deals (match + create deal)
   - POST /deals/:id/delivery (submit delivery)
   - POST /deals/:id/accept (buyer acceptance)
3. Mock database with in-memory postgres
4. Add npm run test script
Target: 70%+ coverage
"
```

### Phase 4: Security (20 min)
```bash
codex --session security --message "
Harden AgentPact security:
1. Add rate limiting (@fastify/rate-limit)
2. Add helmet for security headers
3. Sanitize all markdown inputs (remove script tags)
4. Add agent authentication (JWT or API keys)
5. Add CORS whitelist configuration
6. Audit for SQL injection risks
"
```

## Manual Tasks (You Need to Configure)

### 1. Postgres Database
```bash
# Option A: Local Docker
docker run -d \
  --name agentpact-db \
  -e POSTGRES_PASSWORD=yourpassword \
  -e POSTGRES_DB=agentpact \
  -p 5432:5432 \
  postgres:16

# Option B: Hosted (Supabase/Neon/Railway)
# Get DATABASE_URL from provider
```

**Provide:** `DATABASE_URL` connection string

### 2. Platform Wallet (USDC Receiver)
You need a wallet address to receive 10% platform fees:

```bash
# Option A: Create new wallet
# Use MetaMask/Coinbase Wallet, save private key SECURELY

# Option B: Use existing wallet
# Ensure it's on Base network
```

**Provide:** 
- `PLATFORM_WALLET` address (public)
- `PLATFORM_PRIVATE_KEY` (secret - for auto-withdrawals)

### 3. Blockchain RPC
For Base network:

```bash
# Option A: Public RPC (rate limited)
RPC_URL=https://mainnet.base.org

# Option B: Alchemy/Infura (recommended)
# Sign up at alchemy.com or infura.io
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

**Provide:** `RPC_URL` for Base network

### 4. Frontend Deployment (Netlify)
```bash
cd apps/web
netlify deploy --prod
```

**Provide:**
- Netlify account login
- Set env vars in Netlify dashboard: `VITE_API_URL`

### 5. Backend Deployment (Docker)
```bash
# Build and push Docker image
docker build -t agentpact-api -f apps/api/Dockerfile .
docker tag agentpact-api your-registry/agentpact-api
docker push your-registry/agentpact-api

# Deploy to your server/Railway/Fly.io
```

**Provide:**
- Docker registry credentials
- Server/hosting choice

## Deployment Checklist

- [ ] Postgres database provisioned
- [ ] Platform wallet created (Base network)
- [ ] RPC URL configured (Alchemy/Infura)
- [ ] Smart contracts deployed to Base
- [ ] Environment variables set:
  ```
  DATABASE_URL=
  PLATFORM_WALLET=
  PLATFORM_PRIVATE_KEY=
  RPC_URL=
  JWT_SECRET=
  ```
- [ ] Migrations run: `npm run migrate`
- [ ] Seed data: `npm run seed`
- [ ] Tests pass: `npm run test`
- [ ] Backend deployed (Docker)
- [ ] Frontend deployed (Netlify)
- [ ] DNS configured
- [ ] Monitoring/alerting set up

## Cost Estimates

### Infrastructure (Monthly)
- Postgres: $5-20 (Supabase/Neon free tier or Railway)
- RPC: $0-50 (Alchemy free tier → $50/month)
- Backend: $5-10 (Railway/Fly.io)
- Frontend: $0 (Netlify free tier)

### Blockchain (Per Transaction)
- Base network gas: ~$0.01-0.05 per transaction
- Contract deployment: ~$5-10 one-time

**Total:** ~$10-80/month + $0.01-0.05/tx

## Next Steps

1. **Run Codex fixes** (I'll do this via coding-agent skill)
2. **You provide credentials** (database, wallet, RPC)
3. **Deploy smart contracts** (I'll guide you)
4. **Deploy services** (I'll automate with scripts)
5. **Test end-to-end** (Create test agent deals)

Ready to start? Let me know if you want me to:
- Run Codex automation now
- Help you set up Postgres/wallet first
- Create deployment scripts
