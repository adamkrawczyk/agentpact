# AGENTS.md — AgentPact

Guidance for AI coding agents (and humans) working in this repository.

## Project Overview

Agent-to-agent marketplace. Agents find work, exchange services, and close deals via offers, needs, and USDC escrow + MCP integration.

- **Monorepo**: npm workspaces
  - `apps/api/` — Fastify API server (deals, offers, needs, auth, payments, disputes)
  - `apps/web/` — web frontend
  - `apps/mcp/` — MCP server for agent integration
  - `apps/daemon/`, `apps/fulfillment-daemon/`, `apps/relayer-daemon/` — background workers
  - `packages/` — escrow, identity, payouts, sdk (TypeScript SDK)
  - `contracts/` — Solidity escrow on Base
- **Database**: PostgreSQL (migrations via `npm run migrate`)
- **Domain**: agentpact.xyz, api/mcp subdomains

## Public Claim Surfaces

The consumer-facing install skill lives at **`docs/agentpact-skill/SKILL.md`** and is served live at **`agentpact.xyz/skill`** (the `/skill` route in `apps/web/src/index.ts` reads it at runtime; `Dockerfile.web` `COPY`s `docs/` into the image). Agent User-Agents / `?raw=1` / `Accept: text/markdown` get raw markdown for fetch-and-install; browsers get the rendered page.

**When you change the customer-facing API/MCP surface, fee split, trust-tier rules, or the settlement flow, update `docs/agentpact-skill/SKILL.md` in the same PR.** It is a public claim surface — every fact in it (tool names, fee %, trust tiers, escrow address, the buyer-signed release) must match the live code, exactly like the whitepaper (`docs/WHITEPAPER.md`, served at `/whitepaper` via the same pattern). A skill that drifts from the code is a broken install for every agent that reads it.

## Build & Test Commands

```bash
# Full build (all workspaces)
npm run build

# Dev mode (all workspaces concurrent)
npm run dev

# Tests (API only currently)
npm run test

# E2E onchain test
npm run e2e:onchain

# Database
npm run migrate
npm run seed
```

## Code Change Verification (run before every PR)

```bash
npm run build          # All workspaces must compile
npm run test           # API tests must pass
bash scripts/lint-routes.sh   # Route dedup lint
```

Fix failures before moving on. Do not skip.

## Key Constraints

- **Language**: Never use "trading" — say "find work", "exchange services", "earn"
- **SDK generation**: `npm run sdk:generate` regenerates TypeScript + Python SDKs from API
- **Escrow**: USDC on Base — deal lifecycle: offer → match → escrow → deliver → release
- **MCP**: Agents connect via the MCP server — test with a real MCP client, not just unit tests

## Done When

- [ ] `npm run build` passes (all workspaces)
- [ ] `npm run test` passes
- [ ] No TypeScript errors
- [ ] API changes have corresponding SDK regeneration if public
- [ ] MCP changes tested with actual tool calls
- [ ] `bash scripts/lint-routes.sh` passes

## Critical: Route Deduplication

**Production crash class:** routes split into `apps/api/src/routes/*.ts` modules can leave duplicate handlers in the original files. Fastify throws `FST_ERR_DUPLICATED_ROUTE` and the entire API crashes at boot.

### Rules for Route Files

1. **Each method+path combo MUST exist in exactly ONE file.** No exceptions.
2. **After ANY route change**, run: `bash scripts/lint-routes.sh`
3. **Admin routes** → `routes/admin.ts` ONLY
4. **Fulfillment routes** → `routes/fulfillment.ts` ONLY (no admin routes here)
5. **Dispute routes** → `routes/disputes.ts` ONLY (no admin routes here)
6. **Pre-push hook** runs the lint automatically. If it fails, FIX before pushing.

### If you add a new route
- `grep -r "your-new-route-path" apps/api/src/` to check it doesn't exist elsewhere
- Add it to the ONE correct file based on its domain

### If you refactor/move routes
- DELETE the route from the old location (don't just copy)
- Run `bash scripts/lint-routes.sh` before committing

## Workspace Discipline

- Branch per change: `fix/short-slug` or `feat/short-slug` from `origin/main`. Never commit directly to `main`.
- Push + PR before calling anything done. A local commit is not done.
- Start every task from a clean `main`:
  ```bash
  git fetch origin --prune
  git checkout main && git pull --ff-only
  git checkout -b feat/short-slug
  ```
- Verification before "done": `npm run build` + `npm run test` pass, paste evidence in the PR.
