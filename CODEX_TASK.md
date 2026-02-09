# Codex Task: AgentPact Web UI Overhaul + Docs

## Context
AgentPact is an AI agent marketplace with USDC escrow payments. It's deployed on Railway:
- API: https://agentpactapi-production.up.railway.app
- Web: https://agentpactweb-production.up.railway.app  
- MCP: https://agentpactmcp-production.up.railway.app

The web UI serves bot/agent users, not humans with browsers. Design accordingly.

## Task 1: Terminal-style Web UI Redesign

Redesign `apps/web/src/index.ts` with a terminal/hacker aesthetic:
- Dark background (#0a0a0a or similar), green/amber monospace text
- No fancy cards or gradients — think terminal output, ASCII art logo
- Use a monospace font (JetBrains Mono from Google Fonts, or system monospace)
- Content should look like terminal output with `$` prompts, `>` markers
- Navigation should look like commands: `[offers]  [needs]  [deals]  [docs]  [mcp-setup]`
- The homepage should show:
  - ASCII art AgentPact logo
  - Live stats from /api/public/overview (formatted like `$ agentpact status`)
  - Quick install snippet for MCP
  - Link to whitepaper and docs

Pages to implement:
1. **/** - Homepage with stats + quick start
2. **/offers** - List offers in terminal table format
3. **/needs** - List needs in terminal table format  
4. **/deals** - Match recommendations
5. **/whitepaper** - Render the whitepaper content inline (from docs/WHITEPAPER.md — read and embed it at build time or just hardcode the content)
6. **/mcp-setup** - MCP installation instructions for agents (Claude, OpenClaw, etc.)
7. **/skill** - An OpenClaw skill YAML + instructions for agents to use AgentPact
8. **/api-docs** - Brief API reference (list all endpoints with methods)

All pages should return `text/html` by default but support `.json` suffix for raw data.

## Task 2: Update docs/WHITEPAPER.md
Update the whitepaper to mention:
- Base network deployment (low gas fees ~$0.01)
- Contract address: 0x588168712bF758aFD747bF46471afa53f9599A64
- The MCP-first approach for agent integration
- Railway hosting for reliability
- The terminal-first web UI philosophy

## Task 3: Create OpenClaw Skill
Create `docs/OPENCLAW_SKILL.md` — a skill file that an OpenClaw agent can use:
```yaml
---
name: agentpact
description: Buy and sell AI agent services on AgentPact marketplace with USDC escrow payments.
---
```
Include:
- MCP server config (URL + auth header)
- Quick start flow (register → create offer → browse needs → propose deal)
- API key registration via curl
- Example tool calls
- Tips for autonomous operation

## Task 4: API endpoint reference on /api-docs page
List all API endpoints with method, path, and brief description. These are the routes:
- POST /api/auth/register
- GET /api/offers, POST /api/offers, GET /api/offers/:id, POST /api/offers/:id/archive
- GET /api/needs, POST /api/needs, GET /api/needs/:id, POST /api/needs/:id/archive
- POST /api/deals/propose, POST /api/deals/:id/counter, POST /api/deals/:id/accept, POST /api/deals/:id/cancel, GET /api/deals/:id
- POST /api/payments/create-intent, GET /api/payments/status, POST /api/payments/release, POST /api/payments/refund
- POST /api/deliveries/submit, POST /api/deliveries/verify
- POST /api/disputes/open, POST /api/disputes/resolve-timeouts
- POST /api/feedback, GET /api/agents/:id/reputation
- GET /api/matches/recommendations, POST /api/matches/recompute
- POST /api/alerts/subscribe
- GET /api/public/overview, GET /health, GET /health/detailed

## Important constraints
- ALL changes go in `apps/web/src/index.ts` (it's a single-file Fastify server)
- Keep the existing API proxy pattern (fetching from API_BASE)
- Keep `.json` suffix support for all list endpoints
- The web app must still listen on process.env.PORT
- Do NOT touch the API or MCP code
- Commit when done with message: "Terminal UI overhaul + docs + OpenClaw skill"
