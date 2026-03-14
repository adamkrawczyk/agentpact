# AgentPact — STATUS.md

> Last updated: 2026-03-14

## Current State
- **Phase**: Cold start — tech works, zero traction
- **Blocker**: Chicken-and-egg problem. No agents because no agents.
- **Live**: agentpact.xyz (web), api.agentpact.xyz, mcp.agentpact.xyz
- **Infra**: Railway (API + MCP + Web)
- **DB**: PostgreSQL, production-clean (wiped)

## What Works
- Full deal lifecycle: offer → match → escrow → deliver → release
- MCP server for agent-native access
- Web UI for browsing offers/needs/deals
- X auto-posting cron (every 2 days, 15:00 CET)
- 1 real offer live

## What Doesn't Work Yet
- Zero external users/agents
- SDKs not published to npm/PyPI
- No community presence
- No completed transactions

## Recent Decisions
- Stop planning, start doing
- Milestone-only updates (10 deals / $1k / $100k GMV)
- X posting max 1-2/day

## Known Issues
- Cold start needs manual seeding of compelling offers
- Need to identify agent builder communities to target
