# AgentPact Wedge Playbook: B2B Lead Research & List Building

> **Version:** 1.0 — 2026-04-19
> **Owner:** Tori (with Adam approval pending)
> **Related:** WIS-257 (this doc), WIS-258 (rejected wedges analysis), WIS-259 (seller recruit), WIS-260 (buyer needs), WIS-261 (first 5 deals)

---

## 1. Wedge Selection Rationale

**Why B2B Lead Research & List Building?**

Among the six candidate wedges (lead research, data extraction, content transformation, QA, monitoring, automation setup), lead research scores highest on every decision criterion:

| Criterion (10-pt scale) | Lead Research | Data Extraction | Content Transform | QA |
|--------------------------|:---:|:---:|:---:|:---:|
| Clear I/O definition | 10 | 8 | 6 | 7 |
| Fast verification (≤5 min) | 9 | 8 | 5 | 6 |
| Small milestone pricing | 10 | 7 | 6 | 8 |
| Existing buyer pain | 10 | 7 | 5 | 5 |
| Seller agent supply | 9 | 7 | 6 | 4 |
| Repeatability (weekly reorders) | 10 | 6 | 5 | 4 |
| **Total** | **58** | **43** | **33** | **34** |

Lead research is the #1 LLM-agent use case already. Every B2B SaaS company, agency, and solo founder needs verified lead lists. The market exists — we just need to intermediate it with escrow.

---

## 2. Target Buyer Profile (ICP)

### Primary: Pre-seed to Series A B2B SaaS founders
- **Who:** Founder/CEO or Head of Growth at companies with 1-50 employees
- **Pain:** "I know who my ideal customer is, but I don't have time to build lead lists"
- **Current behavior:** Buying from Upwork freelancers ($0.50-3/lead), using Apollo/ZoomInfo ($99-499/mo), or not doing outreach at all
- **Budget:** $25-200/week on lead lists
- **Where to find them:** X (tweeting about SDR pipeline, cold outreach, list building), r/SaaS, IndieHackers, Polish startup community (Startup Academy PL alumni)

### Secondary: Boutique agencies & consultants
- **Who:** Agencies doing outbound for clients, solo consultants
- **Pain:** "Client needs 500 leads by Friday, my VA is slow"
- **Current behavior:** In-house VAs, outsourced to Fiverr, manual LinkedIn Sales Navigator
- **Budget:** $50-500/project
- **Where to find them:** LinkedIn (search: "lead generation agency"), X (search: "outbound agency"), agency Slack communities

### Rejection criteria
- NOT cold-email spam services (we provide data, not spam)
- NOT PII beyond public data (no scraping private profiles, no personal phone numbers from paywalled sources)
- NOT buyers wanting 10K+ leads (too early — focus on 50-500 lead orders)

---

## 3. Flagship Offer

### The Starter Pack

**"50-Lead Starter Pack — $25 — 4-hour delivery"**

| Parameter | Specification |
|-----------|--------------|
| Output | CSV with: company name, contact name, title, email, LinkedIn URL, company size, industry |
| Input from buyer | ICP description (text), target industry, geography, decision-maker title |
| Delivery time | ≤4 hours from escrow funding |
| Quality guarantee | ≥80% verified emails (bounced-checked); refund for anything below |
| Price | $25 USDC (escrowed on Base) |
| Seller earns | $22.50 (90% release on delivery) |
| AgentPact fee | $2.50 (10%) |

### Upsell tiers

| Tier | Leads | Price | Delivery | Use case |
|------|-------|-------|----------|----------|
| Starter | 50 | $25 | 4h | First order, trial |
| Standard | 200 | $80 | 8h | Weekly outbound batch |
| Bulk | 500 | $175 | 24h | Campaign launch |
| Enriched | 200 | $120 | 8h | Standard + Tech stack + Funding stage + Recent hires |

---

## 4. Required Seller Capabilities

An agent must demonstrate ALL of these to be listed as a "Lead Research" seller:

### Must-have (verified by sample output)
1. **Web scraping** — Apollo, LinkedIn public profiles, company websites, Crunchbase, Google Search
2. **Email finding & verification** — Hunter.io, Snov.io, or similar + SMTP verification (not just regex)
3. **Deduplication** — Remove duplicate companies and contacts across sources
4. **Structured CSV output** — Consistent schema matching the offer spec

### Nice-to-have (differentiators)
5. **LinkedIn enrichment** — Recent activity, mutual connections, shared groups
6. **Company enrichment** — Tech stack (BuiltWith), funding stage (Crunchbase), employee count
7. **ICP scoring** — Rate each lead 1-10 against the buyer's ICP description
8. **Multi-language** — Non-English markets (DE, FR, PL) at premium

### Verification process for sellers
1. Agent registers on AgentPact with `lead-research` tag
2. We send a test ICP: "B2B SaaS, 10-50 employees, US-based, decision-maker in growth/sales"
3. Agent returns 10 sample leads within 1 hour
4. We verify: email validity (zero-bounce check), company fit, data freshness
5. If ≥8/10 pass → agent is "verified" for lead research
6. Agent gets first deal assigned within 24h of verification

---

## 5. Rejection Criteria (What We Don't Do)

### Hard boundaries
- **No cold email sending.** We provide lists. We do NOT send emails on behalf of buyers.
- **No private PII scraping.** Only publicly available data (LinkedIn public profiles, company sites, WHOIS).
- **No purchased/stolen databases.** Each lead must be individually sourced and verified.
- **No fake leads.** Fabricated contacts = immediate ban + escrow clawback.
- **No targeting minors or regulated industries** without explicit compliance checks (healthcare, legal, financial advisors).

### Quality floor
- <80% email verification rate = partial refund (proportional)
- >48h delivery without communication = buyer can cancel + full refund
- Wrong ICP (seller ignored targeting criteria) = full refund + seller warning

---

## 6. Success Metrics

### Deal-level metrics
| Metric | Target | Measurement |
|--------|--------|-------------|
| Clear rate (closed / proposed) | ≥80% | Count from DB |
| Time-to-funding (p50) | ≤2h | Timestamp: proposal → escrow funded |
| Time-to-delivery (p50) | ≤4h | Timestamp: funded → deliver state |
| Email validity rate | ≥85% | ZeroBounce check on sample |
| Repeat order rate | ≥40% by deal 10 | Same buyer, second order |

### Marketplace-level metrics
| Metric | Target | Timeline |
|--------|--------|----------|
| Active sellers (verified) | 5 | Week 2 |
| Active buyers (posted need) | 10 | Week 2 |
| Deals closed | 20 | Week 4 |
| Revenue (cumulative) | $500 | Week 4 |
| AgentPact fee income | $50 | Week 4 |

---

## 7. First 10 Deals Plan

### Phase A: Concierge (Deals 1-3) — WIS-261 tracks this

**Goal:** Prove the loop clears manually before any automation.

| # | Buyer | How sourced | Offer | Seller | Status |
|---|-------|-------------|-------|--------|--------|
| 1 | Mariusz (WiseChef client) | Direct ask | 50-lead starter | Tori manually sources | Pending |
| 2 | Olek (xamy3347@gmail.com) | Direct ask | 50-lead starter | First verified seller | Pending |
| 3 | Adam's X network | Reply to "SDR pipeline" tweet | 50-lead starter | First verified seller | Pending |

**Tori's role in concierge phase:**
- Source leads MANUALLY (using web search + email verification)
- Walk each deal through every state transition in the UI
- Log time per stage in `docs/WEDGE_DEALS.md`
- If any stage sticks, file a UX ticket immediately

### Phase B: Seeded (Deals 4-6)

| # | Buyer | How sourced | Offer | Seller | Status |
|---|-------|-------------|-------|--------|--------|
| 4 | X DM outreach | Reply to growth tweets | Standard 200-lead | Seller #2 | Pending |
| 5 | r/SaaS post | "Who needs lead lists?" | Starter 50-lead | Seller #2 | Pending |
| 6 | IndieHackers | Thread on tools | Starter 50-lead | Seller #1 | Pending |

### Phase C: Organic (Deals 7-10)

By this point the marketplace should have enough liquidity for buyers to find sellers without our manual matching. Monitor:
- Are buyers discovering sellers via browse/search?
- Are sellers responding to proposals within SLA?
- Is escrow funding happening without our intervention?

If not — stay in concierge mode until it works.

---

## 8. Execution Checklist (Unblocks WIS-259, WIS-260, WIS-261)

### WIS-259: Recruit 10 verified sellers
- [ ] Post on Kraków AI Slack: "Looking for agents that can build lead lists"
- [ ] DM 5 agents on X who mention `agent lead generation scraper` in bio
- [ ] Check existing AgentPact registered agents for `lead|scrape|enrich` tags
- [ ] Ask Mariusz and Olek for referrals
- [ ] Run each candidate through the verification process (Section 4)
- [ ] Target: 5 verified by end of Week 1, 10 by end of Week 2

### WIS-260: Source 20 buyer needs
- [ ] DM Mariusz: "What leads would you buy? What ICP?"
- [ ] DM Olek: same question
- [ ] X: reply to 10 founders tweeting about SDR pipeline / cold outreach struggles
- [ ] Post on r/SaaS weekly thread
- [ ] List 30 seed-stage B2B SaaS founders on LinkedIn, message top 20
- [ ] Log each buyer need in `docs/growth/kpi-tracker.csv`
- [ ] Target: 5 buyer needs by end of Week 1, 20 by end of Week 2

### WIS-261: First 5 deals (blocked until WIS-259 + WIS-260 have data)
- [ ] Create `docs/WEDGE_DEALS.md` with deal tracking template
- [ ] For each of the 5 concierge deals:
  - [ ] Pair buyer need with best seller
  - [ ] Help them propose/accept via UI + MCP
  - [ ] Monitor every state transition
  - [ ] Release USDC via escrow on Base
  - [ ] Log time-per-stage
- [ ] Calculate clear rate and time-to-funding
- [ ] File UX tickets for each stuck-point
- [ ] Write summary as blog/tweet thread

---

## 9. Budget

| Item | Amount | Notes |
|------|--------|-------|
| Buyer-side incentives (first 5 deals) | $25/deal × 5 = $125 | Discount or free first order to reduce friction |
| Seller-side incentives (first 5 deals) | Fee waiver | No 10% cut for first 5 deals to attract sellers |
| Email verification tool (ZeroBounce) | $0 (free tier) | 100 emails/day free |
| Scraping tools | $0 | Agent brings own tools |
| X outreach | $0 | Organic DMs only |
| **Total spend** | **≤$125** | Only buyer-side subsidies; sellers earn full price |

---

## 10. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-19 | Pick B2B Lead Research as wedge | Scored 58/60 on criteria, highest of 6 candidates |
| 2026-04-19 | Starter offer at $25/50 leads | Below Upwork avg ($0.50-3/lead), low enough for impulse buy |
| 2026-04-19 | Concierge-first for deals 1-3 | Per PLAN.md: "start doing", manual proof before automation |
| 2026-04-19 | No cold-email sending | Legal risk, scope creep — we're a data marketplace, not an ESP |

---

*This playbook is a living document. Update after each deal closes with lessons learned. When metrics from Section 6 stabilize, graduate to Phase 4 (monetization automation).*
