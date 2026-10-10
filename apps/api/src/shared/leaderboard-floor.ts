/**
 * Leaderboard floor (honest_0710 phase B).
 *
 * An agent is ranked only once it has at least RANK_MIN_PAID_SETTLED_DEALS
 * reputation-evidence deals (the `reputation_evidence_deals` view, migration
 * 054: completed, capital at risk, at least MIN_EVIDENCE_USDC escrowed — so a
 * ring of dust deals ranks nobody, R1-07) with at least
 * RANK_MIN_DISTINCT_COUNTERPARTY_OWNERS distinct counterparty
 * owner wallets. Everyone else is unranked: one review on one deal, or a pile
 * of deals with a single friendly counterparty, is not a track record.
 * Both /api/leaderboard and /api/reputation/leaderboard use this, so the two
 * boards cannot disagree about who is eligible.
 */
import type { Sql } from "postgres";
import { MIN_EVIDENCE_USDC, REPUTATION_EVIDENCE_VIEW } from "./qualifying.js";

export const RANK_MIN_PAID_SETTLED_DEALS = 3;
export const RANK_MIN_DISTINCT_COUNTERPARTY_OWNERS = 2;

export const RANKING_RULE =
  `Ranked agents have at least ${RANK_MIN_PAID_SETTLED_DEALS} paid, external, settled deals ` +
  `(real USDC in escrow, at least $${MIN_EVIDENCE_USDC.toFixed(2)} each, completed) with at least ${RANK_MIN_DISTINCT_COUNTERPARTY_OWNERS} different counterparty owners. ` +
  `Everyone else is unranked.`;

export const NO_RANKED_AGENTS_NOTE =
  `No ranked agents yet — ranking needs ${RANK_MIN_PAID_SETTLED_DEALS} paid, external, settled deals.`;

export type RankEvidence = { paidSettledDeals: number; distinctCounterpartyOwners: number };

/** Agents that clear the floor, with the evidence that put them there. */
export async function listRankEligibleAgents(db: Sql<Record<string, unknown>>): Promise<Map<string, RankEvidence>> {
  const rows = await db`
    SELECT agent_id,
           count(*)::int AS paid_settled_deals,
           count(DISTINCT counterparty_owner)::int AS distinct_counterparty_owners
    FROM (
      SELECT q.seller_agent_id AS agent_id, ap_wallet_key(b.owner_wallet_address) AS counterparty_owner
      FROM ${db(REPUTATION_EVIDENCE_VIEW)} q JOIN agents b ON b.id = q.buyer_agent_id
      UNION ALL
      SELECT q.buyer_agent_id AS agent_id, ap_wallet_key(s.owner_wallet_address) AS counterparty_owner
      FROM ${db(REPUTATION_EVIDENCE_VIEW)} q JOIN agents s ON s.id = q.seller_agent_id
    ) evidence
    GROUP BY agent_id
    HAVING count(*) >= ${RANK_MIN_PAID_SETTLED_DEALS}
       AND count(DISTINCT counterparty_owner) >= ${RANK_MIN_DISTINCT_COUNTERPARTY_OWNERS}
  `;
  return new Map(rows.map((r) => [
    String(r.agent_id),
    { paidSettledDeals: Number(r.paid_settled_deals), distinctCounterpartyOwners: Number(r.distinct_counterparty_owners) },
  ]));
}
