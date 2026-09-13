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

---

## Pre-commit gate: `ocr` review (alibaba/open-code-review)

**Before you commit code, review the diff with `ocr`.** Not a suggestion — it is
the step between "tests pass" and `git commit`. Tests prove the code does what
you told it to; this catches what you didn't think to tell it.

`ocr` is Alibaba's open-source hybrid reviewer: a deterministic pipeline
(file selection, rule resolution, line mapping) with an LLM agent on top. It
reports **line-accurate** findings with `severity` and `category`, and it is
tuned for precision over recall — it stays silent rather than guessing, so a
finding is worth reading.

Binary: `~/bin/ocr` (v1.12.0, Apache-2.0). `ocr --version` to confirm.

### Default: delegate mode (no LLM endpoint, no cost, always available)

You already have an LLM — you are one. Delegate mode uses `ocr` for the
deterministic half only and hands the actual reviewing to you:

```bash
ocr delegate preview --format json          # what would be reviewed + refs
ocr delegate rule <file> [<file>...]        # the resolved rule set for those files
```

Then read the diff and apply those rules yourself. This path needs **no API
key, no provider, no credits** — it is the fleet default and it cannot be
blocked by an exhausted quota.

### Full mode (when a funded endpoint is configured)

```bash
ocr review --audience agent --background "<why this change exists>"   # workspace
ocr review --audience agent -c <sha>                                  # one commit
ocr review --audience agent --from main --to <branch>                 # a PR
ocr review --preview                                                  # dry-run, no LLM
```

Always pass `--background` — the reviewer's precision depends on knowing what
the change is *for*. Always pass `--audience agent` (summary only, no progress
UI). For big diffs write to a file (`--output /tmp/ocr.txt`) and read it whole;
piping through `head`/`tail` silently drops earlier findings.

### Provider state (verify before trusting, do not assume)

Configured provider lives in `~/.config/opencodereview/`. `ocr llm test` is the
one-second truth check — run it before blaming the tool.

| lane | status |
|---|---|
| `qwen-local` (`http://100.106.27.136:8000/v1`, qwen3.8-27b-heretic) | free + unlimited, **slow** on large diffs — current default |
| `z-ai-coding` (glm-5.1) | weekly cap exhausted, resets 2026-09-15 10:00 |
| `openrouter` / `openai` | credit exhausted (HTTP 402 / `credit_balance_exhausted`) |

A `402`/`429` from `ocr review` is a **billing** fact, not a broken tool — fall
back to `ocr delegate`, never skip the review.

### Rules

1. **A finding at `critical` or `high` blocks the commit.** Fix it or write down
   why it is a false positive — in the commit body, not in your head.
2. **`low` severity is advisory.** Discard nitpicks; do not burn a cycle on style.
3. **Never let a failed `ocr` invocation become a skipped review.** The delegate
   path has no dependency that can fail. If `ocr review` errors, degrade to
   `ocr delegate` — do not commit unreviewed.
4. **This does not replace CI, tests, or human review.** It is the cheapest gate
   in the chain and it runs first, before the expensive ones have to.
