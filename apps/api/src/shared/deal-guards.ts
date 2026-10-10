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

/**
 * The EVM address a Base escrow milestone pays out to (honest_0710 R1-02).
 *
 * The H guard above accepts a paid deal when the seller has EITHER a known
 * owner wallet OR a verified default payout route, so the funding path must
 * pay whichever of the two exists — never the raw `owner_wallet_address`,
 * which may be the zero address. Order:
 *   1. the owner wallet, when it is a known (non-zero, non-placeholder) EVM address;
 *   2. the verified, unrevoked default payout route, when it is an EVM address.
 * Returns null when neither exists: callers must refuse to fund (400), never
 * embed a zero/placeholder address in calldata. Returned lowercased (a valid
 * viem Address; `walletKey` canonical form).
 */
export async function resolveSellerPayoutAddress(sql: Db, sellerAgentId: string): Promise<string | null> {
  const [row] = await sql`
    SELECT
      a.owner_wallet_address AS owner_wallet,
      (SELECT r.address FROM agent_payout_routes r
        WHERE r.agent_id = a.id AND r.is_default AND r.revoked_at IS NULL AND r.verified_at IS NOT NULL
        LIMIT 1) AS route_address
    FROM agents a WHERE a.id = ${sellerAgentId}
  `;
  if (!row) return null;
  for (const candidate of [row.owner_wallet, row.route_address] as Array<string | null>) {
    const key = walletKey(candidate);
    if (key !== null && key.startsWith("0x")) return key;
  }
  return null;
}

/**
 * Money already moved for this deal? (honest_0710 R1-03.) True when any
 * milestone carries a payment intent (any status — even a `created` intent has
 * funding calldata in a buyer's hands), or a settlement intent bound to the
 * deal has left `awaiting_funding`. Re-pricing such a deal would orphan or
 * delete the funding record, so counter / decompose must refuse it.
 */
export async function dealHasFunding(sql: Db, dealId: string): Promise<boolean> {
  const [row] = await sql`
    SELECT
      EXISTS (SELECT 1 FROM milestones m JOIN payment_intents pi ON pi.milestone_id = m.id WHERE m.deal_id = ${dealId})
      OR EXISTS (
        SELECT 1 FROM intents i JOIN deals d ON d.id = ${dealId}
        WHERE (i.id = d.intent_id OR i.deal_id = d.id) AND i.status <> 'awaiting_funding'
      ) AS funded
  `;
  return Boolean(row?.funded);
}

export const DEAL_FUNDED_REJECTION = {
  error: "This deal already has funding, so it can no longer be re-priced or split",
  code: "deal_funded",
  hint: "Funded deals settle as agreed. To change scope, complete or dispute this deal and propose a new one.",
} as const;
