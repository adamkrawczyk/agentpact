/**
 * Reputation + trust-tier inputs (honest_0710 phase A).
 *
 * Reputation is evidence, so it only ever moves for a deal that is
 * capital_at_risk in the `qualifying_deals` view (migration 052): priced,
 * distinct agents with distinct known owner wallets, no internal party, not
 * quarantined, and funded. Self deals, same-owner deals and $0 practice deals
 * never change anyone's score.
 *
 * The score itself is computed by ONE SQL function, `ap_reputation_score()`
 * (migrations/054_reputation_recompute.sql, which documents the formula), so
 * the runtime and the one-off recompute can never disagree. Never write
 * `agents.reputation_score` anywhere else.
 *
 * Deals that complete outside these API routes (buyer-signed on-chain release,
 * relayer sweepers) are covered by the 054 trigger on deals.status /
 * deals.integrity_class, which calls the same function.
 */
import type { Sql } from "postgres";
import { QUALIFYING_DEALS_VIEW, REPUTATION_EVIDENCE_VIEW } from "./qualifying.js";

type Db = Sql<Record<string, unknown>>;

/** Why reputation is being (re)credited — the event that may have changed the evidence. */
export type ReputationEvent =
  | "completion"      // the deal completed (settled) with no buyer rating
  | "buyer_rating"    // the buyer confirmed delivery / closed the deal with a rating
  | "feedback";       // a feedback row was written on the deal

export interface ReputationCredit {
  credited: boolean;
  kind: ReputationEvent;
  sellerAgentId?: string;
  reputationScore?: number;
}

/**
 * Recompute the seller's reputation after `kind` happened on `dealId`.
 * No-op unless the deal is capital_at_risk.
 */
export async function creditReputation(sql: Db, dealId: string, kind: ReputationEvent): Promise<ReputationCredit> {
  const [deal] = await sql`
    SELECT seller_agent_id FROM ${sql(QUALIFYING_DEALS_VIEW)}
    WHERE deal_id = ${dealId} AND capital_at_risk
  `;
  if (!deal) return { credited: false, kind };
  const [agent] = await sql`
    UPDATE agents SET reputation_score = ap_reputation_score(id)
    WHERE id = ${deal.seller_agent_id as string}
    RETURNING reputation_score
  `;
  return {
    credited: true,
    kind,
    sellerAgentId: String(deal.seller_agent_id),
    reputationScore: Number(agent?.reputation_score ?? 0),
  };
}

/**
 * The ONE trust-tier input. `completedDeals` counts reputation-evidence deals
 * (completed, capital_at_risk, >= MIN_EVIDENCE_USDC escrowed) on either side;
 * `reputationScore` is the mean 1–5 rating the agent received in feedback on
 * such deals (0 when none).
 */
export async function getAgentStats(db: Db, agentId: string): Promise<{ completedDeals: number; reputationScore: number }> {
  const [stats] = await db`
    SELECT
      (SELECT COUNT(*)::int FROM ${db(REPUTATION_EVIDENCE_VIEW)} q
        WHERE (q.buyer_agent_id = ${agentId} OR q.seller_agent_id = ${agentId})) AS completed_deals,
      COALESCE((
        SELECT AVG((f.rating_quality + f.rating_timeliness + f.rating_communication + f.rating_accuracy) / 4.0)
        FROM feedback f
        JOIN ${db(REPUTATION_EVIDENCE_VIEW)} q ON q.deal_id = f.deal_id
        WHERE f.to_agent_id = ${agentId}
      ), 0) AS reputation_score
  `;
  return { completedDeals: Number(stats.completed_deals), reputationScore: Number(stats.reputation_score) };
}
