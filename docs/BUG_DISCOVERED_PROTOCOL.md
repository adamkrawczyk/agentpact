# BUG_DISCOVERED_PROTOCOL.md

> What to do when you find a bug in a deployed contract.

## Severity ladder

### Critical (funds at risk)

A bug that allows draining the contract, bypassing the predicate check,
double-spending, or otherwise violating one of the six contract
invariants from `WHITEPAPER.md` (I1-I6).

**Immediate action:**

1. Do NOT publish the bug publicly. Coordinate disclosure with any
   active partners first.
2. Disable new intent creation at the API layer: set
   `INTENT_CREATION_DISABLED=true` in `/etc/agentpact/.env` and
   `pm2 restart api`. (This requires a Phase D2 follow-up that adds the
   env-gate to `routes/intents.ts`; until then, the manual mitigation
   is `iptables -A INPUT -p tcp --dport 4000 -j DROP` to block the API
   port outright.)
3. Inventory in-flight deals. Anything that can be settled normally
   should be settled before the v3 deploy.
4. Deploy `AgentPactEscrowV3` with the fix. Same versioned-series
   pattern as v1→v2 (PR #33 + #34): new contract, new predicate
   registry, new escrow address.
5. Sunset v2 over 90 days. Sunset headers on the v2 routes; new intents
   route to v3.
6. Communicate via `#announcements` on the AgentPact community Discord.

### Non-critical (funds not at risk)

A bug that produces incorrect output but doesn't lose money — e.g. a
verifier that returns false when it should return true. Document as a
known issue; v3 deploy when accumulated value justifies the audit cost.

## Versioned-series pattern

AgentPact follows the same model as Uniswap (v2 → v3 → v4):

- v2 is immutable. There is no upgrade proxy, no admin function, no
  pause switch beyond the API-layer gate above.
- v3 is a fresh deploy with no migration of in-flight v2 deals.
- v2 routes stay live in the API for 90 days post-v3 deploy. After that,
  v2 routes return 410 Gone with a migration JSON pointing at v3.
- The SDK exposes both v2 and v3 clients for the overlap period.

## Audit budget

External audit can be retroactively commissioned per Q4 in the plan-doc.
If you want to fund one without Adam's approval, document the decision
in `docs/adr/N-audit-funding.md` and proceed. The Code4rena contest
costs ~$15k and takes ~3 weeks elapsed; Trail of Bits "lite" is ~$15-20k
in 2-3 weeks; OpenZeppelin is ~$30-50k in 4-6 weeks (highest
confidence).
