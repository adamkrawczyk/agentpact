# Wedge Sellers — Lead Research Concierge Recruit (WIS-259)

> **Status:** 🟡 In Progress — 1/10 candidates surfaced (platform-scan only)
> **Owner:** Tori
> **Target:** 10 verified lead-research seller agents live with valid offers, ≥1 vetted sample each
> **Budget:** up to $25 USDC from Adam's $50 for vetting sample outputs
> **Related:** WIS-257 (wedge playbook), WIS-260 (buyer needs), WIS-261 (first 5 deals)

---

## Verification Rubric

Per `WEDGE_PLAYBOOK.md §4`, a seller is "verified" when:

1. Agent registered on AgentPact with `lead-research` / `scrape` / `enrich` tag
2. Offer live matching Starter Pack template (50 leads / $25 / 4h) or an accepted variant
3. Passed test ICP sample: "B2B SaaS, 10–50 employees, US-based, decision-maker in growth/sales"
4. Returned 10 sample leads within 1h
5. ≥8/10 leads pass: email validity (zero-bounce), company fit, data freshness

Vetting cost per seller: ≤ $2.50 (pay sample as a $2.50 micro-deal in USDC).

---

## Platform Scan (auto, refreshed each cron cycle)

| Date (UTC) | Total live offers | `lead\|scrape\|enrich`-tagged | New adjacent agents |
|---|---:|---:|---|
| 2026-04-19 (cycle 1) | 25 | 1 | `bfbaa446` — "Web Scraping and Data Extraction Service" ($25, offer `47ed1d10`) |
| 2026-04-19 (cycle 2, cron 17:08) | 25 | 1 | none new — same adjacent agent, no new `lead-research` tags yet |

> _Tori scans `GET /api/offers?limit=200` each poll cycle and diffs tag matches. This row appends one entry per meaningful change._

---

## Candidate Pipeline

| # | Source | Candidate | Agent ID / Handle | Outreach Status | Sample Status | Offer Live | Score (x/10) | Notes |
|---|--------|-----------|-------------------|-----------------|----------------|------------|--------------|-------|
| 1 | AgentPact platform scan | `Agent bfbaa446` (Web Scraping & Data Extraction Service, $25) | `bfbaa446-8d53-4a99-92ed-a0fc724afb51` | Not yet contacted — agent offline, no wallet set | Pending | Adjacent offer only (scrape, not lead-research template) | — | Only existing platform agent with scraping tag. Needs DM + pitch to adopt Starter Pack template. |
| 2 | Kraków AI Slack | _pending Adam_ | — | Not started | — | — | — | Needs Adam: Slack auth / DM access |
| 3 | PolishAI Discord | _pending Adam_ | — | Not started | — | — | — | Needs Adam: Discord DM access |
| 4 | X search (`agent lead generation scraper` bios) | _pending_ | — | Not started | — | — | — | Blocked this cycle: `x-cli` missing `X_API_KEY` in cron env — needs key provisioning |
| 5 | WiseChef referrals (Mariusz) | _pending Adam_ | — | Not started | — | — | — | Needs Adam to ask for referrals |
| 6 | WiseChef referrals (Olek) | _pending Adam_ | — | Not started | — | — | — | Needs Adam to ask for referrals |
| 7 | — | — | — | — | — | — | — | — |
| 8 | — | — | — | — | — | — | — | — |
| 9 | — | — | — | — | — | — | — | — |
| 10 | — | — | — | — | — | — | — | — |

---

## Outreach Pitch Template (WiseChef-branded)

```
Hey — I'm with AgentPact (spin-out of WiseChef). We're standing up a curated
lead-research marketplace with real money flow: buyers fund USDC escrow on
Base, agents deliver, T+1 release. You keep 95%, we take 5%.

Looking for 10 founding seller agents for the "50-Lead Starter Pack" tier:
  • 50 verified leads / $25 USDC / 4-hour SLA
  • Free listing + first deal fee waived for top 5 quality sellers
  • We pay $2.50 for a vetting sample (test ICP below)

Test ICP: B2B SaaS, 10–50 employees, US-based, decision-maker in
growth/sales. Return 10 sample leads within 1h.

Onboarding doc (paste-friendly): docs/WEDGE_SELLER_ONBOARDING.md
One-shot offer-creation script: scripts/create-starter-pack-offer.sh

Reply if interested — I'll send the onboarding doc and escrow wallet.
— Tori (AgentPact/WiseChef)
```

---

## Onboarding Artifacts Shipped (for Adam's DMs)

- **`docs/WEDGE_SELLER_ONBOARDING.md`** — full paste-friendly onboarding doc. Covers economics, registration, offer creation, sample-ICP gate, deal lifecycle, guardrails, and founding-5 perks.
- **`scripts/create-starter-pack-offer.sh`** — one-command offer creation for a recruit. Requires `AGENTPACT_AGENT_ID` + `AGENTPACT_API_KEY` envs. Idempotent; handles 409 gracefully.
- **Pitch template** (above) — short form for Slack/Discord/X DMs.

Adam can copy the pitch, include the onboarding doc link, and point recruits at the script. Zero bespoke work per seller until vetting.

---

## Blockers (as of 2026-04-19, cycle 2)

1. **Slack / Discord DM access** — Tori has no creds for Kraków AI Slack or PolishAI Discord. Adam must run outreach on those channels or grant access.
2. **X DM capacity** — `x-cli` exists but cron env lacks `X_API_KEY`. Even with it, cold DMs require the recipient to follow back or open DMs. Need key provisioned + human-in-loop for sends.
3. **WiseChef network referrals (Mariusz, Olek)** — human relationship asks; Adam owns these.
4. **Seller supply on platform today is 1** — concierge recruit is the whole point of this issue; can't be fully automated.
5. **$25 vetting budget** — Tori has pre-authorization per ticket but still needs Adam to top up the AgentPact buyer wallet on Base before first sample deal can be funded.

---

## What Tori CAN Do Autonomously (Next Poll Cycles)

- [x] Scan AgentPact offers/agents feed; log `scrape|lead|enrich` matches (cycle 1, cycle 2 done)
- [x] Draft the WiseChef-branded pitch template (cycle 1)
- [x] Ship the paste-friendly onboarding doc `docs/WEDGE_SELLER_ONBOARDING.md` (cycle 2)
- [x] Ship one-click offer-creation script `scripts/create-starter-pack-offer.sh` (cycle 2)
- [ ] Draft a ZeroBounce-based sample-verification script so Tori can auto-score samples when they arrive
- [ ] Draft the $2.50 vetting-deal seed script (POST /api/deals) so Adam approves, Tori funds, seller delivers
- [ ] Once `X_API_KEY` is provisioned to cron env: surface ≥20 X handles matching `agent lead generation scraper` bios into the pipeline table (surface only — no DM)
- [ ] Daily diff of AgentPact registrations; alert if any new `lead|scrape|enrich` agent appears

## What Needs Adam (Human Loop)

- [ ] Run DMs on Kraków AI Slack / PolishAI Discord using the pitch template above
- [ ] Ask Mariusz + Olek (WiseChef) for referrals
- [ ] Open X DMs or use personal account to reach shortlisted handles Tori surfaces
- [ ] Approve + top up the $25 vetting budget on the AgentPact buyer wallet (Base)
- [ ] Provision `X_API_KEY` / `X_BEARER_TOKEN` into the cron env so Tori can surface X handles autonomously

---

_Last updated: 2026-04-19 (cycle 2) by Tori (cron)_
