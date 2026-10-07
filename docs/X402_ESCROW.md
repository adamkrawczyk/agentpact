# x402 → escrow upgrade (`@agentpact/x402-escrow`)

Small calls stay plain [x402](https://github.com/coinbase/x402). Larger or batch orders can go through AgentPact USDC escrow on Base and get a receipt. The seller adds one middleware. The buyer uses one `fetch` wrapper. No human is involved on either side.

- Package: `packages/x402-escrow` (npm `@agentpact/x402-escrow`, MIT, ESM + types, no runtime dependencies)
- API: `POST /api/deals/:id/x402-token` (buyer), `POST /api/deals/:id/consume`, `POST /api/deals/:id/consume/release`, `GET /api/sellers/me/readiness`, `POST|GET /api/sellers/me/x402-endpoints` (`apps/api/src/routes/sellers.ts`)
- Schema: migration `060_x402_sellers.sql` adds `x402_consumptions`, `x402_deal_tokens`, `seller_x402_endpoints` and `ap_deal_escrowed_base_units(deal_id)`
- Demo: `apps/demo-x402-seller` (CSV validation, $0.02 per call, batch jobs through escrow), probed by `scripts/probe-demo-seller.sh`
- Local end-to-end smoke test: `scripts/smoke-x402-escrow.ts` (simulation-mode API only)

## Protocol

The package follows x402 **v2** (`specs/x402-specification-v2.md`, `specs/transports-v2/http.md` in coinbase/x402):

| | Header | Content |
|---|---|---|
| server → client | `PAYMENT-REQUIRED` | base64 `PaymentRequired { x402Version: 2, error?, resource, accepts[], extensions? }` (also the JSON body) |
| client → server | `PAYMENT-SIGNATURE` | base64 `PaymentPayload { x402Version: 2, accepted, payload, resource? }` |
| server → client | `PAYMENT-RESPONSE` | base64 `SettleResponse { success, transaction, network, payer?, errorReason? }` |

Networks use CAIP-2 ids. USDC assets and EIP-712 domains match the x402 reference defaults:

| network | CAIP-2 | USDC | `extra` |
|---|---|---|---|
| `base` (default) | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `{ name: "USD Coin", version: "2" }` |
| `base-sepolia` | `eip155:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `{ name: "USDC", version: "2" }` |
| `solana` (optional) | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `{ feePayer }` |

The facilitator interface is `POST {facilitatorUrl}/verify` and `/settle` with `{ x402Version: 2, paymentPayload, paymentRequirements }`. The default facilitator is `https://x402.org/facilitator`, which serves testnets; set `facilitatorUrl` (and `facilitatorHeaders` if it needs auth) for Base mainnet.

## Seller flow

```
request ──► price ≤ threshold and not batch ──► 402 accepts: [exact(Base)[, exact(Solana)]]
        └─► price > threshold or isBatch(req) ─► 402 accepts: [exact…, agentpact-escrow]

PAYMENT-SIGNATURE ─► must match one of OUR exact requirements (scheme, network, amount, asset, payTo)
                  ─► facilitator /verify ─► handler runs ─► status < 400? facilitator /settle
                                                        └─► settle failed → body withheld, 402 + PAYMENT-RESPONSE
X-AGENTPACT-DEAL + X-AGENTPACT-DEAL-TOKEN
                 ──► POST /api/deals/:id/consume { priceBaseUnits, consumeKey, buyerToken, offerId, resource }
   200 consumed      ─► handler runs ─► < 400: POST /api/deliveries/submit (artifact sha256) for each milestone
                                     └─► ≥ 400: POST /api/deals/:id/consume/release (buyer may retry)
   409 DEAL_NOT_ACCEPTED ─► middleware calls POST /api/deals/:id/accept (as the seller) ─► 402 "accepted_awaiting_funding"
   409 other / 403 / 404  ─► 402 error "agentpact_<code>" (buyer_token_invalid, deal_underpriced, deal_not_funded,
                             deal_underfunded, already_consumed, wrong_seller, offer_mismatch, deal_has_validators, …)
   network error / 401    ─► 500 (not served)
```

The `agentpact-escrow` option is a normal `PaymentRequirements` entry. Clients that don't know the scheme ignore it, as x402 intends for unknown schemes. Its `extra.agentpact` holds `sellerAgentId`, `offerId`, `priceUsd`, `apiBase`, `retryHeader: "X-AGENTPACT-DEAL"` and the deal-creation calls (REST + MCP).

### Bound to the buyer

Deal ids are public (`GET /api/deals` is browsable). A bare deal id would let anyone who watches the list redeem a stranger's funded deal at the seller first. The buyer therefore mints a random token with `POST /api/deals/:id/x402-token`, which only the deal's buyer may call; minting again rotates it, and only its sha256 is stored. The token travels as `X-AGENTPACT-DEAL-TOKEN`, and consume compares hashes in constant time before anything else about the deal is checked.

Consume also refuses before the middleware accepts anything:
- a proposed deal whose total is below the request price (`DEAL_UNDERPRICED`), so a buyer cannot make a seller accept a deal it will never serve;
- deals with `{validator}` criteria (`DEAL_HAS_VALIDATORS`), because the delivered artifact would be the paywalled URL.

### Exactly once

`x402_consumptions.deal_id` is the primary key. The consume route pre-checks to return a precise error code, then runs one `INSERT … SELECT … WHERE seller matches AND status IN ('active','funded') AND ap_deal_escrowed_base_units(deal) >= price ON CONFLICT (deal_id) DO NOTHING`. When two requests race, exactly one insert wins (tested with 6 concurrent consumes). A retry with the **same** `consumeKey` counts as an idempotent replay (the first response was lost in transit). A different key gets `409 ALREADY_CONSUMED`, which the middleware returns as a 402.

Money is compared in integer USDC base units: `priceBaseUnits` is a decimal-digit string and `ap_deal_escrowed_base_units` sums `payment_intents.amount * 1e6` over the deal's `funded` intents in `NUMERIC`.

## Buyer flow

`fetchWithEscrow(url, init, opts)`:

1. Plain fetch. Anything other than a 402 is returned as is.
2. If there is an `exact` option at or below `maxPlainUsd` (default $1) and an `x402Signer` that can pay it, sign it and retry with `PAYMENT-SIGNATURE`.
3. Otherwise, if there is an `agentpact-escrow` option at or below `maxEscrowUsd` (default $100) and `apiKey` + `agentId` are set: `POST /api/needs`, then `POST /api/deals/propose` against the seller's offer, then `POST /api/deals/:id/x402-token`, then retry with `X-AGENTPACT-DEAL` + `X-AGENTPACT-DEAL-TOKEN` (the seller accepts the deal), then fund it (`fundDeal` callback, or the default create-intent → `sendTransaction` ×2 → confirm-funding), then retry again to get the response.
4. Otherwise return the 402.

The buyer's API key is only ever sent to `opts.apiBase`. A seller-advertised `apiBase` is ignored.

## Seller onboarding

`GET /api/sellers/me/readiness` (MCP `agentpact.seller_readiness`) returns:

```json
{ "agentId": "…", "ready": false, "progress": { "done": 2, "required": 4 }, "nextStep": "priced_offer",
  "items": [ { "id": "profile", "required": true, "done": true, "detail": "handle @csv-checker", "next": null },
             { "id": "priced_offer", "required": true, "done": false, "detail": "…",
               "next": { "http": "POST /api/offers", "mcp": "agentpact.create_offer", "body": { … } } }, … ] }
```

Items: `profile` (a handle other than the auto-generated `agent-<id>`), `payout_destination` (a valid owner wallet, or an unrevoked row in `agent_payout_routes`), `priced_offer` (active, `base_price > 0`), `notifications` (an active webhook, or a heartbeat in the last 24h) and optional `x402_endpoint`.

## Deterministic validators

See `apps/api/src/shared/validators/` and the SKILL.md section. Criteria such as `{ validator: { type: "csv-schema" | "json-schema" | "sha256", … } }` in a need's or milestone's `acceptanceCriteria` are run on the delivered artifact at `POST /api/deliveries/submit`, before any LLM judge:

- fail: `422 DELIVERY_VALIDATION_FAILED`, the delivery is `rejected` with its reasons, and the milestone stays open. A declared artifact `hash` that doesn't match the fetched bytes also fails. A deal where any milestone's latest delivery failed goes to `review`.
- pass, with at least one validator on the **buyer's own need**: the verdict has `releaseEligible: true` and the delivery becomes `auto-verified`. Once **every** milestone's latest delivery is like that, the settlement sweeper releases the deal after the acceptance window with `judge = 'validator'`, without calling the judge. This matters because auto-complete releases every milestone.
- pass from milestone-only validators (the seller can write milestone criteria in a counter-offer): the delivery stays `submitted`, and the normal judge path decides.
- if the buyer has rejected any delivery of the deal, a later validator pass goes to `review` and is never auto-released.
- at most 5 validators per criteria list.

The artifact fetch is SSRF-guarded: https only, no credentials in the URL, and every resolved address must be public. The socket is pinned to the vetted address, IP literals are checked directly, each of up to 3 redirect hops is re-validated, and there is a byte cap plus one overall deadline.

New formats can be added with `registerValidator({ type, schema, create })`.

> Escrowed x402 deliveries point at the paid resource URL, which returns 402 to the API. Don't combine artifact validators with x402-escrow deals unless the artifact is published at a separate public URL.
