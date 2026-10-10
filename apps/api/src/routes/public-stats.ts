/**
 * GET /api/stats/public — the honest public numbers (honest_0710 phase B).
 *
 * Every deal count reads the `qualifying_deals` / `deal_integrity` views
 * (migration 052): "paid settled" = capital_at_risk AND completed. Self,
 * same-owner, internal, unknown-owner, quarantined, unfunded and $0 deals
 * never count as paid. $0 deals between distinct external agents are shown
 * separately as practice. Listings by internal (fleet) agents are excluded.
 *
 * The response is cached in-process for PUBLIC_STATS_TTL_MS so the homepage
 * cannot turn into a query storm.
 */
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { MIN_EVIDENCE_USDC } from "../shared/qualifying.js";

export const PUBLIC_STATS_TTL_MS = 60_000;

export const PUBLIC_STATS_METHOD =
  "Paid deals settled (external) = completed deals with real USDC in escrow between agents with different, known owner wallets, " +
  "excluding self-deals, our own fleet agents and quarantined deals. Practice deals = completed $0 deals between different external agents. " +
  "Volume = USDC actually escrowed for those deals (never more than the agreed price), in US cents, rounded down. " +
  `Rankings and trust tiers additionally need at least $${MIN_EVIDENCE_USDC.toFixed(2)} escrowed per deal. Agent count is rounded down.`;

export type PublicStats = {
  paidDealsSettledExternal: number;
  /** Integer US cents as a decimal string (USDC is 1:1 USD), floored. */
  paidVolumeSettledExternalUsd: string;
  practiceDeals: number;
  /** Floored to a round number, e.g. "1,000+"; exact below 10. */
  agentsListed: string;
  openNeeds: number;
  activeOffers: number;
  generatedAt: string;
  method: string;
};

/** Floor to one significant digit with a "+" (87 → "80+", 1999 → "1,000+"); exact below 10. */
export function formatFlooredCount(n: number): string {
  const whole = Math.max(0, Math.floor(n));
  if (whole < 10) return String(whole);
  const magnitude = 10 ** Math.floor(Math.log10(whole));
  const floored = Math.floor(whole / magnitude) * magnitude;
  return `${floored.toLocaleString("en-US")}+`;
}

// Holds the in-flight promise too, so concurrent misses share ONE query.
let cache: { at: number; value: Promise<PublicStats> } | null = null;

/** Test hook: drop the in-process snapshot. */
export function resetPublicStatsCache(): void {
  cache = null;
}

export async function computePublicStats(sql: Sql<Record<string, unknown>>): Promise<PublicStats> {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM qualifying_deals
        WHERE capital_at_risk AND status = 'completed') AS paid_settled,
      -- R1-06: volume is the USDC actually escrowed for each deal, capped at
      -- the agreed price — never the quote (ap_deal_escrowed_usdc, 054).
      (SELECT floor(coalesce(sum(LEAST(negotiated_total, ap_deal_escrowed_usdc(deal_id))), 0) * 100)::bigint::text
         FROM qualifying_deals
        WHERE capital_at_risk AND status = 'completed') AS paid_volume_cents,
      (SELECT count(*)::int
         FROM deal_integrity di
         JOIN agents b ON b.id = di.buyer_agent_id
         JOIN agents s ON s.id = di.seller_agent_id
        WHERE di.status = 'completed'
          AND di.negotiated_total = 0
          AND di.integrity_class IS NULL
          AND di.buyer_agent_id <> di.seller_agent_id
          AND NOT b.is_internal AND NOT s.is_internal
          AND ap_wallet_key(b.owner_wallet_address) IS DISTINCT FROM ap_wallet_key(s.owner_wallet_address)
          ) AS practice,
      (SELECT count(*)::int FROM agents WHERE NOT is_internal) AS agents,
      (SELECT count(*)::int FROM needs n JOIN agents a ON a.id = n.agent_id
        WHERE n.status = 'open' AND NOT a.is_internal) AS open_needs,
      (SELECT count(*)::int FROM offers o JOIN agents a ON a.id = o.agent_id
        WHERE o.status = 'active' AND NOT a.is_internal) AS active_offers
  `;
  return {
    paidDealsSettledExternal: Number(row.paid_settled),
    paidVolumeSettledExternalUsd: String(row.paid_volume_cents),
    practiceDeals: Number(row.practice),
    agentsListed: formatFlooredCount(Number(row.agents)),
    openNeeds: Number(row.open_needs),
    activeOffers: Number(row.active_offers),
    generatedAt: new Date().toISOString(),
    method: PUBLIC_STATS_METHOD,
  };
}

export async function registerPublicStatsRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>): Promise<void> {
  app.get("/api/stats/public", async (_request, reply) => {
    const now = Date.now();
    if (!cache || now - cache.at >= PUBLIC_STATS_TTL_MS) {
      const value = computePublicStats(sql);
      cache = { at: now, value };
      // A failed query must not be served from cache for the next minute.
      value.catch(() => {
        if (cache?.value === value) cache = null;
      });
    }
    const stats = await cache.value;
    reply.header("cache-control", `public, max-age=${Math.floor(PUBLIC_STATS_TTL_MS / 1000)}`);
    return stats;
  });
}
