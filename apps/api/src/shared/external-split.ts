/**
 * Integrity guard + excluded-bucket vocabulary for /api/admin/metrics
 * economics (honest_0710: one definition of "external").
 *
 * The business number is `qualifying_deals.capital_at_risk AND completed`
 * (see computePaidSettledExternal). It is only as honest as agents.is_internal.
 * Flagging is per agent, so "at least one agent is flagged" says nothing about
 * whether the REST of a fleet owner's agents are flagged. The invariant this
 * guard enforces instead: one canonical owner wallet ⇒ one internal status.
 * Any wallet that owns both internal and unflagged agents is partial flagging
 * by construction, and the external split cannot be trusted until a human
 * resolves it (flag the agents, or unflag the others).
 */

/**
 * Completed deals that are NOT business, by the FIRST failing reason, in this
 * precedence order. `qualifying_unfunded` = qualifies but no money moved.
 */
export const EXCLUDED_BUCKETS = [
  "internal_party",
  "self_deal",
  "unpriced",
  "unknown_owner_wallet",
  "same_owner",
  "quarantined",
  "qualifying_unfunded",
] as const;

export type ExcludedBucket = (typeof EXCLUDED_BUCKETS)[number];

/** Routes an operator uses to resolve flagging (must exist — asserted in tests). */
export const MARK_INTERNAL_ROUTE = "PATCH /api/admin/agents/:id/mark-internal";
export const BULK_MARK_INTERNAL_ROUTE = "POST /api/admin/agents/bulk-mark-internal";

export type ExternalSplitStatus = "no_flags" | "partial_flagging" | "ok";

export interface WalletCoherenceCounts {
  internalAgentCount: number;
  /** Canonical owner wallets that own both internal and non-internal agents. */
  mixedOwnerWallets: number;
  /** Non-internal agents sitting on one of those wallets. */
  unflaggedAgentsOnInternalWallets: number;
  /** Completed capital-at-risk deals with a party on one of those wallets. */
  externalDealsOnMixedWallets: number;
}

export interface ExternalSplitIntegrity extends WalletCoherenceCounts {
  externalSplitStatus: ExternalSplitStatus;
  /** Back-compat boolean: true only when externalSplitStatus === "ok". */
  externalSplitTrustworthy: boolean;
  note: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const verb = (n: number, base: string) => (n === 1 ? `${base}${base.endsWith("h") ? "es" : "s"}` : base);

export function externalSplitStatus(c: WalletCoherenceCounts): ExternalSplitStatus {
  if (c.internalAgentCount === 0) return "no_flags";
  if (c.mixedOwnerWallets > 0) return "partial_flagging";
  return "ok";
}

export function externalSplitIntegrity(c: WalletCoherenceCounts): ExternalSplitIntegrity {
  const status = externalSplitStatus(c);
  let note: string;
  if (status === "no_flags") {
    note =
      "UNTRUSTWORTHY: zero agents flagged is_internal — fleet/test agents read as external. " +
      `Flag fleet agents via ${MARK_INTERNAL_ROUTE} (or ${BULK_MARK_INTERNAL_ROUTE}) before trusting business.externalGmv.`;
  } else if (status === "partial_flagging") {
    note =
      `UNTRUSTWORTHY: ${plural(c.mixedOwnerWallets, "owner wallet")} ${verb(c.mixedOwnerWallets, "own")} both internal and unflagged agents; ` +
      `${plural(c.unflaggedAgentsOnInternalWallets, "unflagged agent")} ${verb(c.unflaggedAgentsOnInternalWallets, "share")} an owner with the fleet and ` +
      `${plural(c.externalDealsOnMixedWallets, "external deal")} ${verb(c.externalDealsOnMixedWallets, "touch")} those wallets. ` +
      `Resolve each wallet (flag the agents via ${MARK_INTERNAL_ROUTE}, or unflag) before trusting business.*.`;
  } else {
    note = "External split active: every owner wallet is internally consistent.";
  }
  return { ...c, externalSplitStatus: status, externalSplitTrustworthy: status === "ok", note };
}
