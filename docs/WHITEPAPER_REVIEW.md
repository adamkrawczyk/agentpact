# AgentPact Whitepaper Technical Review

Review target: `docs/WHITEPAPER.md`, Version 0.4, May 2026.

Reviewer posture: skeptical technical reader evaluating whether the paper is accurate, clear, honest about shipped vs designed scope, and persuasive to an engineer/investor/agent developer.

## Overall Score: 6.8 / 10

This is a strong narrative whitepaper with unusually concrete implementation hooks, but it is not yet top-1%-of-class because several claims collapse under code-level scrutiny. The most serious problems are not the existence of unfinished work; they are overprecise statements that are only partly true: v1 is not fully non-custodial in disputes, fulfillment auto-verification is described as async/verified when the route awaits it and still stores `provided`, Class A verifiers do not actually prove ciphertext decryption, and the Class B game theory is overstated. Section 11 is a good trust-building move, but it does not fully cure earlier sections that mark capabilities as shipped or trustless more strongly than the implementation supports.

## Scores

| Axis | Score | Rationale |
|---|---:|---|
| Technical accuracy | 6.0 | Many core components exist, but several exact claims are wrong or materially overstated. |
| Clarity and structure | 8.0 | The sequence from market loop to settlement classes is readable and compelling. Some terminology drifts between v1/v2 and shipped/designed. |
| Intellectual honesty | 6.5 | Section 11 is unusually candid, but earlier roadmap/state claims still oversell and there is an internal contradiction on governance tokens. |
| Technical depth | 7.0 | The three-class settlement architecture is directionally sound, but the current predicates and Schelling mechanism have unresolved security/game-theory holes. |
| Persuasiveness | 6.5 | It would impress a casual technical reader; a sharp integrator will find enough mismatches to slow down or demand a tighter spec. |

## High-Confidence Matches To Code

- The v1 escrow really has buyer-funded milestones, buyer acceptance, buyer-only dispute opening, seller timeout claim, and a 90/10-style payout if deployed with a 10% constructor fee. See `AgentPactEscrow.sol` lines 43-85 and 119-133.
- Reputation math is accurately described: average four-axis feedback is computed in `apps/api/src/shared/utils.ts` lines 85-96, trust tiers match `apps/api/src/routes/utils.ts` lines 25-30, and the 40/30/20/10 RaaS score matches `apps/api/src/shared/utils.ts` lines 122-150.
- The fulfillment vault is real: AES-256-GCM, per-field IV/tag, separate `credential_vault`, rotation count, and access log exist in `apps/api/src/credential-vault.ts` lines 4-14, 43-63, 72-100, and 175-194.
- The daemon exists and does heartbeat/watch/autopropose: `apps/daemon/src/index.ts` lines 35-115 and `apps/daemon/src/autopilot.ts` lines 22-89. The README accurately calls it “auto-propose,” not auto-settle, at `apps/daemon/README.md` lines 56-65.
- v2 contracts and tests are present. `AgentPactEscrowV2.sol` implements Class A/B/C flows, and `contracts/test/AgentPactEscrowV2.test.cjs` contains 30 `it(...)` cases, matching the paper’s broad “30-case Hardhat suite” claim.
- MCP is real and larger than claimed: `apps/mcp/src/index.ts` defines 54 `agentpact.*` tools, so the “~40 tools” claim is conservative.

## Major Accuracy Issues

### 1. v1 escrow is not as non-custodial as the paper implies

Whitepaper lines 176 and 532 say the contract has “no owner, no withdraw, no rescue” and imply the platform cannot move funds. That is only true for the happy-path release. In disputes, `resolveDispute` is callable only by `platformWallet` and can either refund the buyer or pay the seller plus platform fee (`contracts/AgentPactEscrow.sol` lines 97-116). That is a privileged settlement path, even if not named `owner`.

The paper should say: “happy-path release requires buyer signature; disputed funds are resolved by the platform wallet in v1.”

### 2. “Hardcoded 90/10 split” is inaccurate in source

The paper repeatedly says the split is hardcoded: lines 176 and 532. The source makes `platformFeePercent` an immutable constructor parameter, not a literal 10 (`contracts/AgentPactEscrow.sol` lines 8-10 and 33-40). That may be hardcoded in the deployed constructor arguments, but it is not hardcoded by the contract source. Same pattern in v2: `platformFeeBps` is constructor-set (`contracts/AgentPactEscrowV2.sol` lines 171-187).

### 3. Fulfillment auto-verification is described incorrectly

Line 156 says auto-verification is async and “never blocks the API response.” The route directly awaits `autoVerify(...)` before inserting/updating fulfillment (`apps/api/src/routes/fulfillment.ts` lines 167-175). Line 168 says status moves to `verified`; the route stores status `provided` regardless of `autoVerifyResult` (`fulfillment.ts` lines 171-186). Buyer verification later moves accepted fulfillment to `active`, not `verified` (`fulfillment.ts` lines 514-523), and confirmation finally sets `verified` (`fulfillment.ts` lines 578-584).

This is a concrete implementation mismatch, not wording polish.

### 4. “Buyer confirmation is always required” is false

Line 156 says buyer confirmation is always required for non-auto-verify types, but the fulfillment route has instant auto-complete when `acceptance_timeout_days = 0` (`fulfillment.ts` lines 214-232), and there is an auto-complete endpoint for timed-out deals (`fulfillment.ts` lines 634 onward). Those may be good product choices, but the paper should not claim buyer confirmation is always required.

### 5. Fulfillment type count and schema names are inconsistent

Section 4.1 lists 7 fulfillment types at lines 136-144. Section 11.1 says 8 fulfillment types at line 533. Code has 8, including `consultation`, in `apps/api/src/routes/utils.ts` lines 32-199. The example also uses `endpoint` at line 167, while the actual `api-access` schema requires `endpoint_url` (`routes/utils.ts` lines 36-55).

### 6. API security is overstated

Line 265 says “API key per agent, required on all endpoints.” There are intentionally public endpoints: public overview (`apps/api/src/routes/feedback.ts` lines 86-98), online agents (`apps/api/src/routes/agents.ts` lines 204-243), fulfillment types (`fulfillment.ts` lines 124-132), and v2 intent reads/discovery (`apps/api/src/routes/intents.ts` lines 212-246). The claim should be narrowed to state-changing or agent-private endpoints.

### 7. Roadmap/checkmark language overstates zero-touch deals

Line 428 marks “Zero-Touch Deals (autopilot matching + deal proposal)” as shipped. That phrasing is mostly fine. But section 7.3 says the daemon can “auto-proposes and auto-accepts,” then deal moves directly to “funded/active” and settlement completes (lines 384-385). The daemon implementation auto-proposes via `/api/deals/propose` (`apps/daemon/src/autopilot.ts` lines 69-89); it does not auto-accept as the seller, fund escrow, deliver, or settle. The server autopilot route likewise creates proposals (`apps/api/src/routes/matching.ts` lines 441-603), not fully funded deals.

### 8. Governance-token claims contradict each other

Line 124 says “A governance token for dispute resolution is on the roadmap.” Line 436 says “there is no governance token and none is planned.” This is a direct contradiction in a high-trust section. Pick one.

### 9. Class A predicates are weaker than the paper’s table says

Lines 466-468 describe predicates over `decrypt(C, K)`. The shipped verifiers do not decrypt or bind ciphertext to the witness. `HashPreimagePredicate` ignores `ciphertext` and checks `keccak256(witness)` (`contracts/predicates/HashPreimagePredicate.sol` lines 37-49). `SignedBlobPredicate` ignores `ciphertext` and verifies a signature over plaintext from the witness (`contracts/predicates/SignedBlobPredicate.sol` lines 101-118). `MerkleMembershipPredicate` also ignores `ciphertext` and verifies plaintext/proof from the witness (`contracts/predicates/MerkleMembershipPredicate.sol` lines 167-181).

The contract comments admit this dependency on off-chain key custody (`HashPreimagePredicate.sol` lines 18-23), and `AgentPactEscrowV2` only emits `KeyDeliveryRequested` for an off-chain custodian (`AgentPactEscrowV2.sol` lines 163-165, 290-291). So Class A is not purely “EVM checks decrypt(C,K)” in v2.0; it is “EVM checks seller-supplied witness, while off-chain custody is expected to make ciphertext match witness.” That is a much weaker trust model.

### 10. Schelling game theory is oversold

Lines 476-489 claim “honesty is the dominant strategy” and “nobody is paid to be wrong.” The implemented payouts do not fully support that:

- On hash match, the buyer stake is not burned to `0x…dEaD`; 90% goes to seller and 10% to platform (`AgentPactEscrowV2.sol` lines 560-581). The paper line 483 says “buyer stake burned.”
- On buyer default, the buyer stake is burned, seller gets price less platform fee and own stake back (`AgentPactEscrowV2.sol` lines 597-619). That is “made whole” only if “whole” excludes receiving the buyer stake; in the hash-match branch seller does receive most of it.
- Seller stake is capped at `min(maxPrice / 2, 50 USDC)` (`AgentPactEscrowV2.sol` lines 371-373 and `SchellingCommitReveal.sol` lines 250-260), so the paper’s “seller who delivers garbage expects to lose 50% of price” is false for deals above 100 USDC.
- The mechanism cannot tell “buyer lied” from “both parties observed identical garbage” or “seller revealed the same bytes the buyer received but the deliverable is subjectively bad.” It adjudicates equality of bytes, not quality or spec compliance.

The architecture is interesting, but the game-theory language should be weakened to “creates bounded penalties for reject/default paths,” not “honesty is dominant.”

### 11. v2 API surface is DB-state tracking, not settlement enforcement

Line 519 says “API surface (13 endpoints) + DB migration ... PR merged.” The route exists, but its own header says “No on-chain calls in this PR” and that the relayer owns broadcasting (`apps/api/src/routes/intents.ts` lines 16-22). Many endpoints update DB state without verifying chain state or enforcing contract semantics themselves: `claim` just sets `claimed_a` (`intents.ts` lines 429-467), `acknowledge` just sets `acknowledged` (`lines 338-365`), and `reveal` only audit-logs (`lines 402-425`). Section 11.2 partly says migration pending, but a reader could still infer that the API enforces v2 settlement. It does not.

Also, `register_encryption_pubkey` currently trusts the submitted pubkey/signature and explicitly defers signature verification (`intents.ts` lines 575-580). That matters because §10.4C relies on buyer encryption pubkeys for key delivery.

## Clarity And Structure

The paper is well sequenced. The strongest parts are the market-loop diagram, the worked API-access example, and the current-state section. A developer can quickly understand the intended transaction lifecycle.

The main clarity problem is that the document mixes four layers without consistently labeling them:

- v1 deployed escrow
- live API/daemon product behavior
- v2 contracts merged but undeployed
- v2 relayer/key-release designs not implemented

This causes avoidable confusion. For example, line 176 points readers to “v2 settlement redesign in §11,” but v2 is actually §10 and limitations are §11. More importantly, §10 often uses production-sounding language for a contract suite that §11 later says is not deployed.

## Intellectual Honesty

Section 11 is the best part of the paper from a trust perspective. It clearly states that v2 contracts are not deployed, that the intents endpoint can fail if migration is missing, that gas relaying is not implemented, and that adaptor-signature key release is deferred (lines 539-543).

But the section does not fully hold up because it omits or softens several limitations:

- v1 dispute resolution has a privileged platform resolver.
- v1 timeout claim lets seller release after 7 days from funding status, not after objective delivery proof.
- v2 Class A depends on server-held key custody to make witness/ciphertext equivalence meaningful.
- v2 pubkey registration does not verify signatures yet.
- “USDC escrow on Base verified on BaseScan” and “agents are transacting today” are not verifiable from this repo. I attempted to inspect the contract address externally, but did not obtain reliable BaseScan code/transaction evidence from the available search path; treat that as unverified in this review.

## Technical Depth

The three-class settlement split is the right direction. It recognizes that API keys, subjective work, and streaming consumption should not share one settlement primitive. Class C’s strict monotonic unit claims and seller binding are sensible (`AgentPactEscrowV2.sol` lines 697-723). The immutable predicate registry is also a defensible conservative choice.

The weakest technical layer is Class A key/ciphertext binding. In v2.0, seller payout is based on witness validity, while actual buyer usability depends on an off-chain custodian releasing a key for ciphertext that matches that witness. That is not fatal if the server is explicitly trusted in v2.0, but it should be stated as a trust assumption, not hidden behind “cryptographically verifiable deliverables.”

Class B is clever but not as game-theoretically clean as claimed. It resolves disputes about whether both parties can reveal the same bytes, not whether the work satisfies subjective quality. It also has griefing/withholding edges: a malicious seller can deliver low-quality but consistently revealed bytes; a buyer who genuinely dislikes the deliverable can still be punished if they reveal the same bytes; a seller stake capped at 50 USDC weakens high-value deterrence.

## Persuasiveness

For a skeptical technical reader, the paper is persuasive enough to continue diligence but not enough to integrate without a tighter spec. The repo contains real code across escrow, API, MCP, daemon, fulfillment, and v2 contracts. That is much stronger than a concept paper.

The problem is that the whitepaper chooses absolute phrasing too often: “without human intermediation,” “never blocks,” “hardcoded,” “dominant strategy,” “all endpoints,” “single block,” “no arbiter.” Those phrases invite adversarial verification, and several fail. Replacing absolutes with exact trust boundaries would make the document more credible, not less.

## Recommended Fixes Before Publishing

1. Rewrite v1 escrow mechanics to explicitly mention platform-wallet dispute resolution and seller timeout release.
2. Replace “hardcoded 90/10” with “constructor-set immutable fee; deployed instance configured to 10%” unless BaseScan constructor args are cited.
3. Correct fulfillment lifecycle: auto-verification is currently awaited, stored as result metadata, and does not itself set `verified`.
4. Reconcile fulfillment type count and field names with `FULFILLMENT_TYPES`.
5. Narrow API security language to authenticated private/state-changing endpoints.
6. Change daemon zero-touch section to “auto-propose” unless funding/accept/delivery automation is actually implemented.
7. Fix the governance-token contradiction.
8. Rewrite Class A as “witness-verifiable with off-chain key-custody binding in v2.0,” not EVM decryption.
9. Rewrite Class B game-theory claims around bounded incentives and known limitations; do not claim dominant strategy.
10. Add a compact shipped/designed badge to each subsection, not only §11.

## Final Judgment

This is real work and a promising protocol direction, but the whitepaper currently reads about one maturity level ahead of the implementation. I would not call it top-1%-of-class yet. With the above corrections, especially around v2 trust assumptions and v1 dispute custody, it could become a highly credible technical whitepaper rather than a strong marketing paper with avoidable precision errors.

## Re-Review (Round 2)

Review target: current `docs/WHITEPAPER.md`, Version 0.4, May 2026, after the author's revisions.

Reviewer posture: adversarial technical re-review against the same implementation surface as Round 1: `contracts/AgentPactEscrow.sol`, `contracts/AgentPactEscrowV2.sol`, `contracts/predicates/*`, `apps/api/src/routes/*`, `apps/api/src/shared/utils.ts`, and `apps/daemon/*`.

## Overall Score: 8.1 / 10

This revision is materially more honest and much closer to code. It fixes the biggest trust-boundary problems around v1 dispute custody, constructor-configured fees, fulfillment auto-verification, Class A predicate limits, and v2 API scope. It is still not top-1%-of-class because a few old overstatements remain in nearby summary text, one new v1 dispute-timeout inaccuracy was introduced, and some fulfillment schema/daemon wording still reads ahead of the actual code.

## Scores

| Axis | Score | Rationale |
|---|---:|---|
| Technical accuracy | 8.0 | Most prior mismatches are fixed, but unresolved-dispute timeout, fulfillment schema fields, daemon "initiate execution", and Schelling "dominant strategy" summary language still conflict with code or with the paper's own caveats. |
| Clarity and structure | 8.6 | The current-state section and explicit caveats make the shipped/designed boundaries much easier to follow. Some summary sections still use broad marketing phrasing before the later caveats. |
| Intellectual honesty | 8.4 | Section 11 is now unusually candid, especially on v2 API, relayer, pubkey verification, and Class A key custody. The honesty is weakened by residual absolutist lines elsewhere. |
| Technical depth | 8.2 | The paper now names the actual v2 trust model and payout branches. Remaining depth gaps are mostly around exact API/daemon lifecycle and the limits of Class B incentives. |
| Persuasiveness | 8.0 | Much more credible to an engineer or investor than Round 1. It still needs tighter summary language before I would call it top-1%-of-class. |

## Prior Issues Rechecked

| # | Prior issue | Status | Current document evidence | Implementation evidence / adversarial note |
|---:|---|---|---|---|
| 1 | v1 dispute custody/non-custodial overstatement | PARTIALLY FIXED | Fixed in the worked example caveat: lines 179-181 state that `resolveDispute` is platform-wallet-only and that non-custodial holds only for uncontested releases. Lines 232-239 also describe the privileged dispute path and narrow the guarantee. Line 550 repeats this in current-state. | The code matches the caveat: `resolveDispute` requires `msg.sender == platformWallet` and can refund buyer or pay seller, `contracts/AgentPactEscrow.sol` lines 97-116. New problem: lines 226-228 now imply a "7-day dispute timeout" and say unresolved disputes automatically release. In v1, `claimAfterTimeout` only works while status is `Funded`, not `Disputed`, lines 119-123. Disputed milestones have no timeout release path in `AgentPactEscrow.sol`. |
| 2 | Hardcoded 90/10 split | FIXED | Lines 179-180 explicitly say the fee is an immutable constructor parameter, configured to 10% on the deployed instance, not literally hardcoded. Line 550 repeats "immutable constructor parameter configured to 10%". | `AgentPactEscrow.sol` has `platformFeePercent` as constructor-set immutable, lines 8-10 and 33-40. V2 likewise uses constructor-set `platformFeeBps`, `AgentPactEscrowV2.sol` lines 62-63 and 171-187. The remaining 90/10 wording in lines 65, 115-119, 174, 414, and 517 is acceptable as product/deployed-instance shorthand after the explicit caveat. |
| 3 | Fulfillment auto-verify lifecycle | FIXED | Lines 151-159 now describe the actual lifecycle: seller provision runs inline auto-verify where supported, stores the result as metadata, writes `provided` regardless, buyer acceptance moves to `active`, final confirmation moves to `verified`, and auto-complete paths can close deals. Lines 170-174 in the worked example repeat this accurately. | Code matches: route awaits `autoVerify`, lines 167-169; stores status `provided`, lines 171-185; buyer verify sets `active`, lines 514-523; confirmation sets `verified`, lines 578-584; instant and timed auto-complete paths are lines 214-232 and 727-760. |
| 4 | Buyer confirmation always required | PARTIALLY FIXED | Line 159 correctly says buyer confirmation is the default, not universal, and names `acceptance_timeout_days = 0` plus elapsed-window auto-complete. | The implementation matches those exceptions, `fulfillment.ts` lines 214-232 and 727-760. Residual issue: line 63 still says "Buyer confirmation is required for types without auto-verify" without mentioning timeout auto-complete. That repeats the old absolute in a summary section. |
| 5 | Fulfillment type count and schema names | PARTIALLY FIXED | The count is fixed: lines 136-145 list eight types, and line 147 says eight. The `api-access` example now uses `endpoint_url`, `auth_type`, and `auth_value`, lines 170-171. | The count matches `FULFILLMENT_TYPES`, `apps/api/src/routes/utils.ts` lines 32-199. But several table field names are still wrong: line 141 says `compute-access` requires `host`, `port`, `credentials`, while code requires `access_type` and `endpoint` with optional `credentials`, lines 102-123. Line 142 says `consulting` uses `deliverable_type`, `format`, while code uses `delivery_format`, `content_url`, `content_text`, `summary`, lines 125-140. Line 143 says `consultation` uses `session_type`, `scheduled_at`, while code is `summary`, `instructions`, passthrough, lines 142-153. |
| 6 | API security overstatement | FIXED | Line 277 narrows the claim to "state-changing and agent-private endpoints" and explicitly lists public read-only endpoints. | This matches the global auth hook: public exact/prefix GETs are carved out in `apps/api/src/index.ts` lines 1272-1309, admin/cron/webhook exceptions are lines 1311-1343, and other `/api/` routes call `app.authenticate` at lines 1345-1347. Route-local requester checks also reject missing API keys, `apps/api/src/routes/utils.ts` lines 308-315 and `apps/api/src/shared/utils.ts` lines 61-70. |
| 7 | Daemon auto-accept / zero-touch overstatement | PARTIALLY FIXED | Lines 394-397 now correctly say the daemon auto-proposes only and does not auto-accept, auto-fund, auto-deliver, or auto-settle. Line 554 repeats "auto-proposal" in current-state. | Code confirms auto-proposal only: `buildDealProposal` creates a proposal, `apps/daemon/src/autopilot.ts` lines 49-67; `proposeDeal` calls `/api/deals/propose`, lines 69-89; daemon loop only calls that proposal path, `apps/daemon/src/index.ts` lines 66-95. Residual issue: line 387 still says the daemon can "skip interactive negotiation and initiate execution directly", and the loop diagram lines 352-358 implies deliver/verify/settle as daemon loop output. That still overstates today's daemon. |
| 8 | Governance-token contradiction | FIXED | Lines 122-125 say no governance token exists or is planned. Lines 446-447 repeat no governance token and none planned. The earlier contradiction is gone. | No contradictory governance-token roadmap language remains in the current document. |
| 9 | Class A `decrypt(C,K)` predicate overstatement | FIXED | Lines 472-480 now say verifiers check witnesses only, do not decrypt ciphertext, do not prove ciphertext decrypts to the witnessed value, and rely on trusted key custody in v2.0 until adaptor-signature key release. | Code matches: `HashPreimagePredicate` ignores ciphertext and hashes witness, lines 37-49; `SignedBlobPredicate` ignores ciphertext and recovers signer over witness plaintext, lines 50-68; `MerkleMembershipPredicate` ignores ciphertext and checks witness membership, lines 47-61. `AgentPactEscrowV2` only emits `KeyDeliveryRequested`, lines 163-165 and 290-291. |
| 10 | Schelling game-theory overstatement | PARTIALLY FIXED | The detailed Class B section is now much more accurate: seller stake cap is stated at lines 490-492; payout branches are corrected at lines 494-497; byte-equality limits and seller-stake cap are acknowledged at lines 499-505. | Code supports the corrected detail: ack timeout exists at `AgentPactEscrowV2.sol` lines 410-416; hash match sends 90% of buyer stake to seller and 10% to platform, lines 560-581; mismatch burns both stakes, lines 584-595; buyer/seller default branches are lines 597-635. Residual issue: line 446 still says "honesty is the dominant strategy", directly contradicting the nuanced "bounded, asymmetric penalties" framing at line 505. Line 124 also says v2 "makes honesty the better-paying strategy" without the byte-equality limitation. |
| 11 | v2 API as settlement enforcement | FIXED | Lines 560-561 explicitly say the v2 routes track Postgres lifecycle state, the header says no on-chain calls, and the contract enforces settlement once the relayer is wired. Lines 562-564 also disclose unverified pubkey registration and missing relayer. | This matches `apps/api/src/routes/intents.ts`: header says no on-chain calls and relayer owns broadcasting, lines 16-22; `claim` just sets `claimed_a`, lines 457-466; `acknowledge` sets DB status, lines 359-364; `reveal` audit-logs only, lines 420-425; pubkey registration trusts submitted pubkey/signature for now, lines 575-580. |

## New Or Remaining Issues

1. **New v1 dispute-timeout inaccuracy.** Lines 226-228 say the 7-day dispute timeout ensures funds are not locked and unresolved disputes auto-release. That is not true for `AgentPactEscrow.sol`: `claimAfterTimeout` requires `Funded`, not `Disputed`, and `resolveDispute` has no timeout branch. This should be corrected before publishing because it appears in the threat model, not just a footnote.

2. **Daemon wording still oversells "zero-touch".** The detailed bullet at lines 394-397 is accurate, but line 387 and the diagram lines 352-358 still imply execution/delivery/settlement automation. Replace "initiate execution directly" with "create a deal proposal directly" unless the daemon grows those steps.

3. **Fulfillment schema table still needs exact field names.** The type count is fixed, but table rows for `compute-access`, `consulting`, and `consultation` do not match `FULFILLMENT_TYPES`. This is easy to fix and would prevent integrators from coding against wrong field names.

4. **Schelling honesty language remains too strong in summaries.** The detailed section is good. The roadmap/current-state summary should not say "dominant strategy"; the contract enforces byte-equality incentives with bounded stakes, not general subjective honesty.

## Top-1%-of-Class Judgment

Not yet. Round 2 is a credible technical whitepaper and a large improvement over Round 1, but top-1%-of-class papers do not leave contradictory claims between summary and detail on dispute timeouts, daemon autonomy, and dominant-strategy game theory. Tightening those remaining lines and correcting the fulfillment field table would move this into the high-8s or low-9s.

## Re-Review (Round 3)

Review target: current `docs/WHITEPAPER.md` after the author's latest revisions.

Implementation checked: `contracts/AgentPactEscrow.sol` (`resolveDispute`, `claimAfterTimeout`), `apps/daemon/src/*`, `apps/api/src/routes/utils.ts` (`FULFILLMENT_TYPES`), and `contracts/AgentPactEscrowV2.sol` plus `contracts/schelling/SchellingCommitReveal.sol`.

## Overall Score: 8.7 / 10

The latest revision fixes most of the Round 2 precision problems and is now much closer to the code. I still would not call it top-1%-of-class because it leaves one contract-state diagram wrong, the daemon architecture diagram still implies more automation than exists, and a new Proof-of-Skill status claim is inverted relative to the API.

## Four Round 2 Issues

| # | Issue | Status | Current whitepaper evidence | Code evidence / note |
|---:|---|---|---|---|
| 1 | v1 dispute-timeout inaccuracy in threat model | PARTIALLY FIXED | The threat model is fixed: line 228 now says a v1 dispute does not auto-resolve on a timer and requires the platform resolver. Escrow mechanics are also precise at lines 232-239. However, the state-machine diagram still shows `disputed -> timeout (7d) -> resolved` at lines 89-96, which remains false for v1. | `resolveDispute` is platform-wallet-only and requires `Disputed`, `contracts/AgentPactEscrow.sol` lines 97-116. `claimAfterTimeout` requires `Funded`, not `Disputed`, lines 119-123. There is no disputed-state timeout release branch. |
| 2 | Daemon wording oversells zero-touch / execution | PARTIALLY FIXED | The prior line-387 problem is fixed: lines 385-397 now say the daemon creates a deal proposal directly and explicitly does not auto-accept, auto-fund, auto-deliver, or auto-settle. Remaining overstatement: line 314 says the daemon can "execute deals with minimal latency," and the loop diagram still has `Deliver + Verify + Settle` inside the daemon loop at lines 352-358. | The daemon watches matches and posts proposals only: `selectAutopilotMatches` filters candidates and `buildDealProposal` creates a proposal, `apps/daemon/src/autopilot.ts` lines 22-67; `proposeDeal` calls `/api/deals/propose`, lines 69-89; the runtime loop only calls that proposal path, `apps/daemon/src/index.ts` lines 66-95. |
| 3 | Fulfillment schema table field names for `compute-access`, `consulting`, `consultation` | PARTIALLY FIXED | The field names are now aligned at lines 141-143: `compute-access` uses `access_type`, `endpoint`, `credentials`; `consulting` uses `delivery_format`, `content_url`/`content_text`; `consultation` uses `summary`, `instructions`. Remaining accuracy issue: the table column is titled "Required Fields" at line 136, but several listed fields are optional. | Code requires only `access_type` and `endpoint` for `compute-access`; `credentials` is optional, `apps/api/src/routes/utils.ts` lines 102-123. `consulting` requires only `delivery_format`; `content_url`, `content_text`, and `summary` are optional, lines 125-140. `consultation` has optional `summary` and `instructions` and `.passthrough()`, lines 142-153. |
| 4 | Schelling "dominant strategy" language in summaries | FIXED | The problematic summary language is gone. Line 124 now limits the claim to false-rejection/default being negative-expected-value and points to byte-equality limits; line 446 says the mechanism adjudicates byte-equality with bounded stakes, not subjective quality; line 505 explicitly rejects "honesty is the strictly dominant strategy." | This matches the contract better: hash match pays seller plus 90% of buyer stake, `AgentPactEscrowV2.sol` lines 560-581; hash mismatch burns both stakes, lines 584-595; defaults burn the defaulting stake, lines 597-635; byte equality is the only comparison in `SchellingCommitReveal.revealsMatch`, lines 84-100. |

## New Or Remaining Inaccuracies

1. **State-machine diagram still shows a disputed timeout.** Lines 89-96 are the main remaining v1 escrow inaccuracy. It should show disputed milestones resolving only through `resolveDispute`, not through a 7-day timeout.

2. **Proof-of-Skill is now mislabeled as not implemented.** Line 243 says Proof-of-Skill is "Planned - not yet implemented." The API has live routes for listing, starting, submitting, and reading skill challenges: `apps/api/src/routes/agents.ts` lines 265-351, 354-447, and 449-480. The precise caveat is not "not implemented"; it is that deterministic pass/fail updates `agents.skills_verified` and `skill_verification_count`, not the 0-5 `reputation_score`, lines 409-424.

3. **Fulfillment table still conflates schema fields with required fields.** This is smaller than the Round 2 issue because the names are now right, but integrators could still treat optional fields as mandatory from line 136.

## Top-1%-of-Class Judgment

Not yet. This is now a strong technical whitepaper with unusually good trust-boundary caveats, but top-1%-of-class requires the summary diagrams and shipped/planned labels to be as exact as the detailed sections.
