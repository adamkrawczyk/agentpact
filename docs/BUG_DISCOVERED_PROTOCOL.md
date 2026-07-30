# BUG_DISCOVERED_PROTOCOL.md

> What to do when you find a bug in a deployed contract.
>
> **Scope note.** This document is the *public* disclosure and response policy:
> the severity ladder, what we commit to doing, and what clients can observe
> while we do it. Operator execution detail (where flags live, how services are
> restarted, how the brake is verified on the host) is deliberately **not** here
> — it belongs in the private operator runbook, not in a public repo.

## Reporting

Found something? Do **not** open a public GitHub issue — see `SECURITY.md` and
email `security@agentpact.xyz`. We acknowledge within 48 hours.

## Severity ladder

### Critical (funds at risk)

A bug that allows draining the contract, bypassing the predicate check,
double-spending, or otherwise violating one of the six contract
invariants from `WHITEPAPER.md` (I1-I6).

**Response sequence:**

1. **Coordinate disclosure.** Do not publish the bug publicly; notify any
   active partners first.
2. **Trip the intent-creation brake.** New intent creation is stopped at the
   API layer while in-flight settlement continues (see *The emergency brake*
   below for the exact guarantees). Both creation paths — the explicit
   `POST /api/intents` route and the deal-accept auto-mint — are covered by a
   single switch.
3. **Inventory in-flight deals.** Anything that can be settled normally should
   be settled before the v3 deploy.
4. **Deploy `AgentPactEscrowV3` with the fix.** Same versioned-series pattern as
   v1→v2 (PR #33 + #34): new contract, new predicate registry, new escrow
   address.
5. **Sunset v2 over 90 days.** Sunset headers on the v2 routes; new intents
   route to v3.
6. **Communicate** via `#announcements` on the AgentPact community Discord.

### Non-critical (funds not at risk)

A bug that produces incorrect output but doesn't lose money — e.g. a
verifier that returns false when it should return true. Document as a
known issue; v3 deploy when accumulated value justifies the audit cost.

## The emergency brake — what clients see

When the brake is engaged, **new intents cannot be minted, and everything
already in flight keeps settling.** Concretely:

| Attempted action | Behaviour while the brake is on |
|---|---|
| `POST /api/intents` | `503` with `code: "INTENT_CREATION_DISABLED"` |
| Accepting a deal that would auto-mint a Class-A intent | Deal **accepts normally**; it simply stays a manual-settlement deal (no intent minted) |
| Funding, revealing, claiming, acknowledging an existing intent | **Unaffected** |
| Cancelling an existing intent | **Unaffected** |
| Reading intents (`GET /api/intents/:id`) | **Unaffected** |

Two properties are deliberate and are covered by regression tests
(`apps/api/src/__tests__/intent-creation-killswitch.test.ts`):

- **The brake stops minting, not commerce.** Accepting a deal never fails
  because the brake is on.
- **The brake never traps escrowed value.** Every settlement and exit path for
  an existing intent stays open. A brake that stranded funds would be worse
  than the bug it is meant to contain.

Clients should branch on the machine-readable `code`, not the prose message. The
state is also reported on the API's detailed health output, so integrators can
distinguish "AgentPact is intentionally restricted" from "AgentPact is down."

## Versioned-series pattern

AgentPact follows the same model as Uniswap (v2 → v3 → v4):

- **v2 is immutable.** There is no upgrade proxy and no admin function — this is
  a deliberate design property, verifiable in the deployed bytecode, and the
  reason the emergency brake lives at the API layer rather than in the contract.
- v3 is a fresh deploy with no migration of in-flight v2 deals.
- v2 routes stay live in the API for 90 days post-v3 deploy. After that,
  v2 routes return 410 Gone with a migration JSON pointing at v3.
- The SDK exposes both v2 and v3 clients for the overlap period.

## Audit status

The contracts have **not** had an external third-party audit. We state this
plainly rather than leaving integrators to infer it: anyone deciding how much
USDC to route through AgentPact deserves to know. An audit will be commissioned
as accumulated value justifies the cost; budget and vendor selection are tracked
internally and recorded in `docs/adr/` when decided.
