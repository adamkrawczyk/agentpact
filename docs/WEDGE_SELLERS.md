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

## Candidate Pipeline

| # | Source | Candidate | Agent ID / Handle | Outreach Status | Sample Status | Offer Live | Score (x/10) | Notes |
|---|--------|-----------|-------------------|-----------------|----------------|------------|--------------|-------|
| 1 | AgentPact platform scan | `Agent bfbaa446` (Web Scraping & Data Extraction Service, $25) | `bfbaa446-8d53-4a99-92ed-a0fc724afb51` | Not yet contacted — agent offline, no wallet set | Pending | Adjacent offer only (scrape, not lead-research template) | — | Only existing platform agent with scraping tag. Needs DM + pitch to adopt Starter Pack template. |
| 2 | Kraków AI Slack | _pending Adam_ | — | Not started | — | — | — | Needs Adam: Slack auth / DM access |
| 3 | PolishAI Discord | _pending Adam_ | — | Not started | — | — | — | Needs Adam: Discord DM access |
| 4 | X search (`agent lead generation scraper` bios) | _pending_ | — | Not started | — | — | — | Tori can surface handles, cannot DM from cron |
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

Reply if interested — I'll send the onboarding doc and escrow wallet.
— Tori (AgentPact/WiseChef)
```

---

## Blockers (as of 2026-04-19)

1. **Slack / Discord DM access** — Tori has no creds for Kraków AI Slack or PolishAI Discord. Adam must run outreach on those channels or grant access.
2. **X DM capacity** — `xitter` skill exists for posting/reading, but cold DMs to unfollowed accounts typically require the recipient to follow back or open DMs. Need target handles + human-in-loop for DM sends.
3. **WiseChef network referrals (Mariusz, Olek)** — human relationship asks; Adam owns these.
4. **Seller supply on platform today is 1** — concierge recruit is the whole point of this issue; can't be fully automated.

---

## What Tori CAN Do Autonomously (Next Poll Cycles)

- [ ] Use `xitter` skill to surface X handles matching `agent lead generation scraper` bios — draft candidate list only (no DMs)
- [ ] Scan AgentPact offers/agents feed daily; log any new `scrape|lead|enrich` registrations here
- [ ] Draft the onboarding doc (Starter Pack offer template JSON + sample ICP test) so Adam can paste directly into DMs
- [ ] Prepare a one-click "create Starter Pack offer" API call script sellers can run to self-list

## What Needs Adam (Human Loop)

- [ ] Run DMs on Kraków AI Slack / PolishAI Discord using the pitch template above
- [ ] Ask Mariusz + Olek (WiseChef) for referrals
- [ ] Open X DMs or use personal account to reach shortlisted handles Tori surfaces
- [ ] Approve the $25 vetting budget spend as sample deals are paid out

---

_Last updated: 2026-04-19 by Tori (cron)_
