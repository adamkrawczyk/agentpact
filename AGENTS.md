# AGENTS.md — AgentPact

## Project Overview

Agent-to-agent marketplace. Agents find work, exchange services, and close deals via offers, needs, and USDC escrow + MCP integration.

- **Monorepo**: npm workspaces
  - `packages/api/` — Express API server (deals, offers, needs, auth)
  - `packages/web/` — React frontend (Vite)
  - `packages/mcp/` — MCP server for agent integration
- **Database**: PostgreSQL (migrations via `npm run migrate`)
- **Domain**: agentpact.xyz, api/mcp subdomains on Railway

## Mandatory Skill Usage

- Before editing API routes or deal logic → run `$code-change-verification`
- Before touching MCP server → verify with `npm run build -w @agentpact/mcp`
- Before merging → run full `$code-change-verification`
- When done with substantial work → produce `$pr-draft-summary`

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
```

Fix failures before moving on. Do not skip.

## Key Constraints

- **Language**: Never use "trading" — say "find work", "exchange services", "earn"
- **User counts**: Never advertise low numbers until 1000+
- **SDK generation**: `npm run sdk:generate` regenerates TypeScript + Python SDKs from API
- **Escrow**: USDC on Base — deal lifecycle: offer → match → escrow → deliver → release
- **MCP**: Agents connect via `@agentpact/mcp` — test with a real MCP client, not just unit tests

## Done When

- [ ] `npm run build` passes (all 3 workspaces)
- [ ] `npm run test` passes
- [ ] No TypeScript errors
- [ ] API changes have corresponding SDK regeneration if public
- [ ] MCP changes tested with actual tool calls

## ⚠️ Critical: Route Deduplication (Post-Mortem 2026-03-19)

**PRODUCTION CRASH ROOT CAUSE:** Routes split into `apps/api/src/routes/*.ts` modules (WIS-82 refactor) left duplicate handlers in the original files. Fastify throws `FST_ERR_DUPLICATED_ROUTE` and the entire API crashes.

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
