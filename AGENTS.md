# AGENTS.md — AgentPact

## Project Overview

Agent-to-agent marketplace. Agents find work, exchange services, and close deals via offers, needs, and USDC escrow + MCP integration.

- **Monorepo**: npm workspaces
  - `packages/api/` — Express API server (deals, offers, needs, auth)
  - `packages/web/` — React frontend (Vite)
  - `packages/mcp/` — MCP server for agent integration
- **Database**: PostgreSQL (migrations via `npm run migrate`)
- **Domain**: agentpact.xyz, api/mcp subdomains on Railway

## Public Skill (how agents consume AgentPact)

The consumer-facing install skill lives at **`docs/agentpact-skill/SKILL.md`** and is served live at **`agentpact.xyz/skill`** (the `/skill` route in `apps/web/src/index.ts` reads it at runtime; `Dockerfile.web` `COPY`s `docs/` into the image). Agent User-Agents / `?raw=1` / `Accept: text/markdown` get raw markdown for fetch-and-install; browsers get the rendered page.

**When you change the customer-facing API/MCP surface, fee split, trust-tier rules, or the settlement flow, update `docs/agentpact-skill/SKILL.md` in the same PR.** It is a public claim surface — every fact in it (tool names, fee %, trust tiers, escrow address, the buyer-signed release) must match the live code, exactly like the whitepaper (`docs/WHITEPAPER.md`, served at `/whitepaper` via the same pattern). A skill that drifts from the code is a broken install for every agent that reads it.


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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **agentpact** (3072 symbols, 4618 relationships, 102 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/agentpact/context` | Codebase overview, check index freshness |
| `gitnexus://repo/agentpact/clusters` | All functional areas |
| `gitnexus://repo/agentpact/processes` | All execution flows |
| `gitnexus://repo/agentpact/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
<!-- Workspace discipline rules — appended to agentpact repo AGENTS.md by Tori 2026-04-19 -->

## 🛡️ Workspace Discipline (Codex + Paperclip, mandatory)

### Branch per ticket
- ALWAYS create a branch `fix/WIS-NNN-short-slug` or `feat/WIS-NNN-short-slug` from `origin/main` at task start.
- NEVER reuse an existing branch for a new ticket.
- NEVER commit directly to `main`.

### Push or it didn't happen
- Before marking a Paperclip issue `done`, you MUST:
  1. `git push origin $BRANCH`
  2. `gh pr create` with `[WIS-NNN]` in the title and body
  3. Post the PR URL as a Paperclip comment on the ticket
- No exceptions. No "local commit is done" — it isn't.

### Workspace starts clean
- Every task begins with:
  ```bash
  git fetch origin --prune
  git checkout main && git pull --ff-only
  git checkout -b fix/WIS-NNN-slug
  ```
- If the workspace is dirty, stash with a named message before switching: `git stash push -m "preserve-pre-WIS-NNN"`.
- NEVER start a new ticket on a branch that is not `main` + new branch.

### Verification before "done"
- `npm run build` passes (all 3 workspaces)
- `npm run test` passes (no new failures)
- Paste the tail of both commands as Paperclip ticket evidence.
- If any fail, do NOT mark done — post a `[BLOCKED]` comment with the error.

### Done criteria in the ticket description
Every ticket spec must end with a "Done when" checklist. If it doesn't, ask in `#agent-sync` with `[CONTEXT_NEEDED]` before coding.

### Retrospective rule (from OpenAI best practices)
If you make the same mistake twice, write a retrospective entry in this AGENTS.md under "Lessons" with:
- what was tried
- what failed
- the fix / new rule
- date

### Subagent usage
Available subagents in `~/.codex/agents/` for self-delegation:
- `code-reviewer` — adversarial PR review (read-only, gpt-5.4, high reasoning)
- `typescript-pro` — TS-specific fixes
- `backend-developer` — API layer work
- `database-optimizer` — query/index work
- `debugger` — root cause analysis
- `security-auditor` — security review
- `performance-engineer` — latency/throughput
- `critic`, `architect`, `executor`, `verifier`, `test-engineer`, etc.

Use `@subagent-name` or delegate explicitly when:
- Code change touches security or auth → invoke `security-auditor` read-only first
- New DB query or index → `database-optimizer`
- Before marking any PR ready → `code-reviewer` self-review pass

### No silent failures
If you cannot proceed, post `[BLOCKED]` with reason in the Paperclip ticket. Never:
- leave uncommitted work
- skip the push step
- mark `done` without PR URL evidence
- delete files outside the ticket scope

## Lessons (retrospectives)

### 2026-04-19 — Unpushed work accumulated on stale branch
- **What happened:** 4 commits (WIS-244..247) sat on local branch `WIS-244-concierge-relay` on wisechef-agents for days, never pushed. Each subsequent Codex run dirtied the same branch with new ticket work. Downstream WIS-249 ran on top of contaminated worktree.
- **Root cause:** Codex adapter on wisechef-agents had no `git push` step after commit. Paperclip `done` status was set without push evidence.
- **Fix:** Branch-per-ticket rule (above) + push-or-die rule + nightly workspace-reset cron + Tori PR-URL verification before ACK.
