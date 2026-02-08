# AgentPact Build Plan - TDD Approach

## Overview

This document outlines the complete build plan for AgentPact using Test-Driven Development (TDD). Each step is designed to be executed by Codex independently.

## Current Status

✅ **Phase 0: TypeScript Fixes** - COMPLETE
- All TypeScript errors fixed
- Build passes for all apps
- Core functionality validated

## Build Steps

### Step 1: Smart Contracts (3-4 hours)
**File:** `CODEX_STEP_1.md`

**What it does:**
- Creates USDC escrow smart contracts
- Implements milestone-based payments
- Adds 10% platform fee distribution
- Implements dispute resolution
- 7-day auto-release timeout

**TDD Approach:**
1. Write comprehensive Hardhat tests FIRST
2. Implement AgentPactEscrow.sol to pass tests
3. Create MockUSDC for testing
4. Deploy to Base testnet
5. All tests must pass before completion

**Deliverables:**
- `contracts/AgentPactEscrow.sol`
- `contracts/MockUSDC.sol`
- `contracts/test/AgentPactEscrow.test.ts`
- Deploy script for Base network
- All Hardhat tests passing ✅

---

### Step 2: Authentication & Security (2 hours)
**File:** `CODEX_STEP_2.md`

**What it does:**
- Implements API key authentication
- Adds JWT support
- Implements rate limiting (100 req/min)
- Protects all /api routes
- Adds CORS whitelist

**TDD Approach:**
1. Write auth tests FIRST (register, verify, revoke)
2. Implement auth.ts to pass tests
3. Add database migration for agent_credentials
4. Integrate with main API
5. Test rate limiting behavior

**Deliverables:**
- `apps/api/src/auth.ts`
- `apps/api/src/__tests__/auth.test.ts`
- `apps/api/migrations/002_auth.sql`
- Updated main API with authentication
- All auth tests passing ✅

---

### Step 3: Test Suite (2-3 hours)
**File:** `CODEX_STEP_3.md`

**What it does:**
- Creates comprehensive API test suite
- Achieves 70%+ code coverage
- Tests all major endpoints
- Tests validation and error cases

**TDD Approach:**
1. Set up Vitest with coverage reporting
2. Create test helpers (testApp, generators)
3. Write tests for agents, offers, needs, deals
4. Run coverage report
5. Add tests until 70%+ coverage achieved

**Deliverables:**
- `apps/api/vitest.config.ts`
- `apps/api/src/__tests__/agents.test.ts`
- `apps/api/src/__tests__/offers.test.ts`
- `apps/api/src/__tests__/deals.test.ts`
- `apps/api/src/__tests__/helpers/testApp.ts`
- Coverage report showing 70%+ ✅

---

### Step 4: Deployment Preparation (1 hour)
**File:** `CODEX_STEP_4.md`

**What it does:**
- Creates production Dockerfile
- Configures Docker Compose for production
- Creates deployment scripts
- Implements health checks
- Adds backup scripts
- Writes deployment documentation

**Deliverables:**
- `Dockerfile` (multi-stage for API + MCP)
- `docker-compose.yml` (production config)
- `scripts/deploy.sh` (automated deployment)
- `scripts/backup-db.sh` (database backups)
- `scripts/preflight-check.sh` (pre-deploy validation)
- `.env.production.example` (configuration template)
- `docs/DEPLOYMENT.md` (deployment guide)
- Health checks implemented ✅

---

## How to Execute

### Manual Execution (User Runs Codex)

For each step:

1. **Open the step file:**
   ```bash
   cd ~/repos/agentpact
   cat CODEX_STEP_1.md
   ```

2. **Start Codex:**
   ```bash
   codex
   ```

3. **Paste this command:**
   ```
   Read CODEX_STEP_X.md and follow all instructions exactly.
   Use TDD approach: write tests first, then implementation.
   Run all tests and verify they pass before marking complete.
   When done: openclaw gateway wake --text "Step X complete!" --mode now
   ```

4. **Wait for notification** - You'll get WhatsApp message when done

5. **Verify completion:**
   ```bash
   # For Step 1 (Smart Contracts)
   npx hardhat test
   
   # For Step 2 (Auth)
   cd apps/api && npm test -- auth.test.ts
   
   # For Step 3 (Tests)
   cd apps/api && npm run test:coverage
   
   # For Step 4 (Deployment)
   ./scripts/preflight-check.sh
   ```

6. **Move to next step** when current step passes all tests

---

## Time Estimates

| Step | Task | Time | Status |
|------|------|------|--------|
| 0 | TypeScript fixes | 1h | ✅ DONE |
| 1 | Smart contracts | 3-4h | ✅ DONE |
| 2 | Authentication | 2h | ✅ DONE |
| 3 | Test suite | 2-3h | ✅ DONE |
| 4 | Deployment prep | 1h | ✅ DONE |
| **Total** | | **9-11h** | **100% complete** |

---

## Success Criteria

### Overall Project

- ✅ TypeScript compiles with zero errors
- ⏳ Smart contracts deployed to Base testnet
- ⏳ All Hardhat tests pass (contracts)
- ⏳ All Vitest tests pass (API)
- ⏳ 70%+ test coverage
- ⏳ Authentication working
- ⏳ Rate limiting active
- ⏳ Health checks responding
- ⏳ Deployment scripts validated
- ⏳ Documentation complete

### Per-Step Criteria

Each step has specific success criteria in its file. Codex should verify all criteria before marking step complete.

---

## After All Steps Complete

### User Provides Credentials

Required for production deployment:
- DATABASE_URL (Postgres connection)
- PLATFORM_WALLET (Base network address)
- PLATFORM_PRIVATE_KEY (for withdrawals)
- RPC_URL (Alchemy/Infura)
- JWT_SECRET (generated via `openssl rand -hex 32`)

### Deploy to Production

```bash
# Load production environment
source .env.production

# Run preflight checks
./scripts/preflight-check.sh

# Deploy smart contracts to Base mainnet
cd contracts
npx hardhat run scripts/deploy-escrow.ts --network base

# Deploy backend services
./scripts/deploy.sh

# Verify deployment
curl https://api.yourdomain.com/health
```

### Post-Deployment

- Set up monitoring (Sentry, etc.)
- Configure automated backups (cron)
- Set up DNS and SSL certificates
- Test end-to-end flows
- Monitor error logs
- Announce launch! 🎉

---

## Notes

- **TDD is mandatory** - Tests must be written before implementation
- **Each step is independent** - Can be executed in order by Codex
- **Codex notifications** - Will ping you via OpenClaw when done
- **Verify before proceeding** - Run tests to confirm step completion
- **Token efficient** - Each step is focused and specific

---

## Questions?

If Codex gets stuck or needs clarification:
1. Check the step file for detailed instructions
2. Review the success criteria
3. Ask Codex to show current test output
4. If needed, ask me for help!

Ready to start? Begin with **CODEX_STEP_1.md** 🚀
