// apps/relayer-daemon/src/cctp-binding.ts — M1 (lane m1-relay)
//
// A relayed CCTP deposit only means "USDC was minted into the gateway". It
// does NOT mean the deal is funded. Funded is set exclusively by the binding
// check owned by lane m1-api (apps/api/src/shared/cctp-binding.ts): decode
// CctpDepositBound + EscrowV3 IntentCreated from the gateway and bind every
// field (dealRef ↔ deal, net ≥ price, sourceDomain ↔ quoted chain), then
// write deals.funding_chain.
//
// The relayer cannot import apps/api (tsconfig rootDir is src, and a copied
// money path drifts — see settlement-sweeper.ts). So the relayer depends on
// this INTERFACE, and production wires the HTTP adapter below, which calls the
// API's own binding check. Until m1-api ships that route the adapter answers
// "not bound, retryable" — the row then ages into the `mint_without_bound_intent`
// watchdog instead of being silently marked funded.

import type { Hex } from "viem";

export interface CctpBindingInput {
  transferId: string;
  dealId: string | null;
  dealRef: Hex | null;
  sourceDomain: number;
  /** Base tx that ran gateway.relayDeposit (ours or a third party's). */
  relayTxHash: Hex;
  messageHash: Hex;
  nonce: Hex;
}

export type CctpBindingResult =
  | { bound: true; intentId: string | null; onchainIntentId: Hex }
  | { bound: false; reason: string; retryable: boolean };

export type CctpBindingVerifier = (input: CctpBindingInput) => Promise<CctpBindingResult>;

export interface HttpBindingVerifierConfig {
  apiBaseUrl: string;
  adminApiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Production verifier: POST {api}/api/admin/cctp/transfers/:id/bind with the
 * admin key. Contract (m1-api implements it on top of cctp-binding.ts):
 *   200 {bound:true, intent_id, onchain_intent_id}
 *   200 {bound:false, reason, retryable}
 * Anything else is "not bound, retryable" — never an assumption of success.
 */
export function httpBindingVerifier(cfg: HttpBindingVerifierConfig): CctpBindingVerifier {
  const doFetch = cfg.fetchImpl ?? fetch;
  return async (input) => {
    if (!cfg.adminApiKey) return { bound: false, reason: "ADMIN_API_KEY unset", retryable: true };
    const url = `${cfg.apiBaseUrl.replace(/\/$/, "")}/api/admin/cctp/transfers/${input.transferId}/bind`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20_000);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": cfg.adminApiKey },
        body: JSON.stringify({ relay_tx_hash: input.relayTxHash, message_hash: input.messageHash, nonce: input.nonce }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) return { bound: false, reason: `bind HTTP ${res.status}: ${text.slice(0, 160)}`, retryable: true };
      const body = JSON.parse(text) as Record<string, unknown>;
      if (body.bound === true && typeof body.onchain_intent_id === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.onchain_intent_id)) {
        return {
          bound: true,
          intentId: typeof body.intent_id === "string" ? body.intent_id : null,
          onchainIntentId: body.onchain_intent_id as Hex,
        };
      }
      return {
        bound: false,
        reason: typeof body.reason === "string" ? body.reason : "binding check answered without bound=true",
        retryable: body.retryable !== false,
      };
    } catch (err) {
      return { bound: false, reason: `bind call failed: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  };
}
