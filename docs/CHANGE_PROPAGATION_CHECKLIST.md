# CHANGE_PROPAGATION_CHECKLIST.md

> **Purpose:** every time you change a load-bearing surface of AgentPact, a set
> of downstream surfaces MUST be updated in the same PR — otherwise docs,
> whitepaper, and the agent-facing skill silently drift and you get surprised
> later (e.g. "the whitepaper is not updated"). This is the human checklist.
> The automated enforcement layer (`scripts/check-docs-sync.ts`) is NOT yet
> built — see "Automation gap" at the bottom.

## How to use

Find the row matching what you changed. Update **every** surface in that row in
the same PR (or one immediately-chained PR). Tick the boxes in your PR body.

---

## Trigger → must-update matrix

### 1. You changed a contract (`contracts/*.sol`) — external function, event, invariant, or fee/burn logic
- [ ] `WHITEPAPER.md` — Class A/B/C semantics, fee split, burn destination
- [ ] `apps/web/src/index.ts` — `/whitepaper` renders from `docs/WHITEPAPER.md`; home-page "How it works" + settlement-class explainer; the BaseScan escrow address shown on the page
- [ ] `docs/CONTRACT_INTERACTION_DIRECT.md` — BaseScan walkthrough
- [ ] `docs/adr/` — new ADR if it's an architectural decision
- [ ] Redeploy + verify on BaseScan; update the deployed address everywhere it is hardcoded (grep `0x5881` / `0x588168712bF758aFD747bF46471afa53f9599A64`)
- [ ] `apps/api/src/chain.ts` ABI if the function signature changed
- [ ] Hardhat tests green; `slither` clean

### 2. You changed an API route (`apps/api/src/routes/*.ts`)
- [ ] `apps/web/src/index.ts` `/api-docs` endpoint table (the `endpoints` array)
- [ ] `WHITEPAPER.md` if the conceptual flow changed
- [ ] `apps/api/src/index.ts:~1259` public-prefix allowlist if the route is public
- [ ] `scripts/route-inventory.ts` (run `npm run api:routes`)
- [ ] `bash scripts/lint-routes.sh` (route-dedup guard — see AGENTS.md post-mortem)
- [ ] In-repo SDK (`packages/sdk`) method + TSDoc if the route is agent-facing
- [ ] `docs/agentpact-skill/SKILL.md` if an agent would call it

### 3. You changed an MCP tool (`apps/mcp/src/index.ts`)
- [ ] `apps/web/src/index.ts` `/mcp-setup` page (tool list / config block)
- [ ] `docs/agentpact-skill/SKILL.md` tool inventory (THIS is what an agent installs)
- [ ] `business/agentpact-protocol-operations` skill tool inventory (internal ops skill)
- [ ] `npm run build -w @agentpact/mcp` green

### 4. You changed settlement-class behavior (new predicate, stake formula, timeout)
- [ ] `WHITEPAPER.md` Class A/B/C section
- [ ] `apps/web/src/index.ts` home-page settlement-class explainer cards
- [ ] `docs/agentpact-skill/SKILL.md`
- [ ] Relayer/sweeper logic in `apps/relayer-daemon/` if a new timeout/round is introduced

### 5. You changed the fee structure, burn destination, or any USDC flow
- [ ] `WHITEPAPER.md` (fee math, 90/10 split)
- [ ] `apps/web/src/index.ts` pricing / fee mentions
- [ ] Public Discord `#announcements` post at deploy time
- [ ] `docs/CHANGE_PROPAGATION_CHECKLIST.md` (this file) if the rule itself changed

### 6. You changed agent-facing DB schema (`migrations/*.sql` exposed via API)
- [ ] `apps/web/src/index.ts` `/api-docs` request/response shapes
- [ ] In-repo SDK types + TSDoc
- [ ] `docs/agentpact-skill/SKILL.md` if it changes a request body an agent sends

### 7. You deployed a NEW contract address (Phase G or any redeploy)
- [ ] `.env.production` on the api + relayer services (Railway)
- [ ] `apps/web/src/index.ts` (hardcoded escrow BaseScan links — grep `basescan.org/address`)
- [ ] `WHITEPAPER.md` + `README.md` deployed-addresses section
- [ ] `~/obsidian-vault/projects/agentpact/00-index.md` + `log.md`
- [ ] `docs/BUS_FACTOR.md` wallet/address table
- [ ] BaseScan source verification for each new contract

---

## The "always re-verify after any deploy" smoke set
```bash
curl -s https://api.agentpact.xyz/api/health            # 200
curl -s https://mcp.agentpact.xyz                       # 200
curl -s https://agentpact.xyz/skill?raw=1 | head -1     # raw SKILL.md markdown
curl -s https://agentpact.xyz/ | grep -c install-banner # hero install block present
```

## Automation gap (NOT yet built — the real fix)
The settlement_2705 plan (§3.7) specified three scripts that would make this
checklist self-enforcing. They do not exist yet:
- `scripts/check-docs-sync.ts` — CI gate: fail the build if any `contracts/*.sol`
  or `apps/api/src/routes/*.ts` changed in a PR without a matching
  `WHITEPAPER.md` (or generated-doc) diff. Emits `WHITEPAPER_OUT_OF_SYNC`.
- `scripts/generate-mcp-docs.ts` — regenerate the MCP doc surface from
  `apps/mcp/src/index.ts` tool definitions (source of truth = the code).
- `scripts/generate-api-docs.ts` — regenerate the API doc surface from route
  handlers + schemas.

Until these ship, this checklist is enforced by humans/PR review only. Building
them is the permanent fix for "the docs drifted again."
