/**
 * Party guards for every path that creates or re-prices a deal
 * (propose, counter, accept) — honest_0710 phases A + H.
 *
 *  - buyer == seller                       → 403 self_deal (always, even at $0)
 *  - same owner wallet and price > 0       → 403 same_owner
 *    (decision D4: a $0 same-owner deal is allowed as a practice deal; it is
 *    never evidence because it does not qualify — see shared/qualifying.ts)
 *  - price > 0 and the seller has no known
 *    payout destination                    → 409 seller_payout_wallet_required
 *
 * Owner identity uses `walletKey` from shared/qualifying.ts, the same
 * canonicalisation the qualifying_deals view uses (EVM case-insensitive,
 * zero/placeholder addresses = unknown).
 */
import type { Sql } from "postgres";
import { walletKey } from "./qualifying.js";

type Db = Sql<Record<string, unknown>>;

export interface DealGuardRejection {
  status: 403 | 409;
  body: { error: string; code: "self_deal" | "same_owner" | "seller_payout_wallet_required"; hint: string };
}

export async function checkDealParties(
  sql: Db,
  deal: { buyerAgentId: string; sellerAgentId: string; negotiatedTotal: number | string | null | undefined },
): Promise<DealGuardRejection | null> {
  if (deal.buyerAgentId === deal.sellerAgentId) {
    return {
      status: 403,
      body: {
        error: "An agent cannot make a deal with itself",
        code: "self_deal",
        hint: "Pick an offer or need published by a different agent. Self deals are never accepted, not even at $0.",
      },
    };
  }

  const paid = Number(deal.negotiatedTotal ?? 0) > 0;
  if (!paid) return null;

  const [parties] = await sql`
    SELECT
      b.owner_wallet_address AS buyer_wallet,
      s.owner_wallet_address AS seller_wallet,
      EXISTS (
        SELECT 1 FROM agent_payout_routes r
        WHERE r.agent_id = s.id AND r.is_default AND r.revoked_at IS NULL AND r.verified_at IS NOT NULL
      ) AS seller_has_payout_route
    FROM agents b, agents s
    WHERE b.id = ${deal.buyerAgentId} AND s.id = ${deal.sellerAgentId}
  `;
  if (!parties) return null; // unknown agents: the caller's own existence checks answer this

  const buyerKey = walletKey(parties.buyer_wallet as string | null);
  const sellerKey = walletKey(parties.seller_wallet as string | null);
  if (buyerKey !== null && buyerKey === sellerKey) {
    return {
      status: 403,
      body: {
        error: "Buyer and seller belong to the same owner wallet",
        code: "same_owner",
        hint: "Paid deals need two different owners. Agents of the same owner may only run $0 practice deals, which never count toward reputation or trust tiers.",
      },
    };
  }

  if (sellerKey === null && !parties.seller_has_payout_route) {
    return {
      status: 409,
      body: {
        error: "The seller has no payout wallet, so a paid deal could not be paid out",
        code: "seller_payout_wallet_required",
        hint: "The seller must set a payout wallet first: PATCH /api/agents/:id/wallet {\"walletAddress\":\"0x…\"}. Then propose or accept again.",
      },
    };
  }

  return null;
}
