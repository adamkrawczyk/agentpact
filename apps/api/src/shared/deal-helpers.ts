import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "../db.js";
import {
  decrypt,
  ensureCredentialVaultSchema,
  encrypt,
  getSensitiveFields,
} from "../credential-vault.js";
import { notifyAgents } from "../webhooks.js";
import {
  isOnChainMode,
  generateAcceptTransaction,
  resolveDisputeOnChain,
} from "../chain.js";
import { isZeroPrice, toNumber } from "./utils.js";
import { proposeDealSchema } from "./schemas.js";
import { audit } from "./utils.js";
import type { z } from "zod";

export const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 10);
export const PLATFORM_WALLET = process.env.PLATFORM_WALLET ?? "0xAgentPactPlatformUSDC";

const BUYER_VAULT_PREFIX = "buyer__";

let _credentialEncryptionKey: string | null = null;
function getCredentialEncryptionKeyLazy(): string {
  if (!_credentialEncryptionKey) {
    const { getCredentialEncryptionKey } = require("../credential-vault.js");
    _credentialEncryptionKey = getCredentialEncryptionKey() as string;
  }
  return _credentialEncryptionKey!;
}

export async function storeBuyerContext(
  fulfillmentId: string,
  fulfillmentType: string,
  data: Record<string, unknown>,
  credentialEncryptionKey: Buffer,
): Promise<Record<string, unknown>> {
  const vaultSql = sql as unknown as Parameters<typeof ensureCredentialVaultSchema>[0];
  await ensureCredentialVaultSchema(vaultSql);

  const redacted: Record<string, unknown> = { ...data };
  const configured = new Set(getSensitiveFields(fulfillmentType));
  const prefixed = Object.keys(data).filter((field) => field.startsWith("secret_"));
  const sensitiveFields = new Set([...configured, ...prefixed]);

  for (const fieldName of sensitiveFields) {
    if (!(fieldName in data)) continue;
    const value = data[fieldName];
    if (value === undefined || value === null) continue;

    const plaintext = typeof value === "string" ? value : JSON.stringify(value);
    const { encrypted, iv, authTag } = encrypt(plaintext, credentialEncryptionKey);

    await sql`
      INSERT INTO credential_vault (fulfillment_id, field_name, encrypted_value, iv, auth_tag)
      VALUES (${fulfillmentId}, ${`${BUYER_VAULT_PREFIX}${fieldName}`}, ${encrypted}, ${iv}, ${authTag})
      ON CONFLICT (fulfillment_id, field_name) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        last_rotated_at = NOW()
    `;

    redacted[fieldName] = "[encrypted]";
  }

  return redacted;
}

export async function retrieveBuyerContext(
  fulfillmentId: string,
  data: Record<string, unknown>,
  credentialEncryptionKey: Buffer,
): Promise<Record<string, unknown>> {
  const vaultSql = sql as unknown as Parameters<typeof ensureCredentialVaultSchema>[0];
  await ensureCredentialVaultSchema(vaultSql);
  const merged: Record<string, unknown> = { ...data };
  const rows = await sql`
    SELECT field_name, encrypted_value, iv, auth_tag
    FROM credential_vault
    WHERE fulfillment_id = ${fulfillmentId}
      AND field_name LIKE ${`${BUYER_VAULT_PREFIX}%`}
  `;

  for (const row of rows) {
    const fieldName = String(row.field_name).slice(BUYER_VAULT_PREFIX.length);
    merged[fieldName] = decrypt(
      String(row.encrypted_value),
      String(row.iv),
      String(row.auth_tag),
      credentialEncryptionKey,
    );
  }

  return merged;
}

export async function logCredentialAccess(
  fulfillmentId: string,
  agentId: string,
  action: "decrypt" | "rotate" | "request_rotation" | "revoke",
  ipAddress?: string,
): Promise<void> {
  const vaultSql = sql as unknown as Parameters<typeof ensureCredentialVaultSchema>[0];
  await ensureCredentialVaultSchema(vaultSql);
  await sql`
    INSERT INTO credential_access_log (fulfillment_id, agent_id, action, ip_address)
    VALUES (${fulfillmentId}, ${agentId}, ${action}, ${ipAddress ?? null})
  `;
}

export async function applyFulfillmentExpiryChecks(
  deal: { id: string; buyer_agent_id: string; seller_agent_id: string },
  fulfillment: {
    id: string;
    status: string;
    expires_at: string | Date | null;
    last_expiry_warning_at: string | Date | null;
  } & Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!fulfillment.expires_at) return fulfillment;

  const expiresAt = new Date(String(fulfillment.expires_at));
  if (Number.isNaN(expiresAt.getTime())) return fulfillment;

  const now = new Date();
  const status = String(fulfillment.status);
  const expiresInMs = expiresAt.getTime() - now.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (expiresInMs <= 0 && status !== "expired" && status !== "revoked") {
    const [expired] = await sql`
      UPDATE deal_fulfillment
      SET status = 'expired', updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;
    if (expired) {
      notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.fulfillment_expired", {
        dealId: deal.id,
        fulfillmentId: String(fulfillment.id),
        expiresAt: fulfillment.expires_at,
        status: "expired",
      });
      return expired as Record<string, unknown>;
    }
  }

  if (expiresInMs > 0 && expiresInMs <= oneDayMs && !fulfillment.last_expiry_warning_at) {
    const [warned] = await sql`
      UPDATE deal_fulfillment
      SET last_expiry_warning_at = NOW(), updated_at = NOW()
      WHERE id = ${fulfillment.id}
      RETURNING *
    `;
    if (warned) {
      notifyAgents(
        sql,
        [deal.buyer_agent_id, deal.seller_agent_id],
        "deal.fulfillment_expiring",
        {
          dealId: deal.id,
          fulfillmentId: String(fulfillment.id),
          expiresAt: fulfillment.expires_at,
          hoursRemaining: Number((expiresInMs / (60 * 60 * 1000)).toFixed(2)),
        },
      );
      return warned as Record<string, unknown>;
    }
  }

  return fulfillment;
}

export async function enforceDealDelta(dealId: string, negotiatedTotal: number): Promise<void> {
  if (isZeroPrice(negotiatedTotal)) {
    return;
  }
  const [deal] = await sql`
    SELECT d.id, o.base_price, d.max_price_delta_pct
    FROM deals d
    JOIN offers o ON d.offer_id = o.id
    WHERE d.id = ${dealId}
  `;
  if (!deal) {
    throw new Error("Deal not found");
  }
  const maxDelta = toNumber(deal.max_price_delta_pct) / 100;
  const base = toNumber(deal.base_price);
  if (base === 0) {
    return;
  }
  const delta = Math.abs(negotiatedTotal - base) / base;
  if (delta > maxDelta) {
    throw new Error("Counter exceeds max negotiation delta");
  }
}

// Discriminated result for a single-milestone release. Mirrors the action
// vocabulary already established by completeDealMilestones() below
// ("released" | "buyer_sign_required" | ...) rather than inventing a
// competing one — callers that already branch on completeDealMilestones()'s
// action strings can treat this the same way.
export type ReleaseMilestonePaymentResult = {
  mode: "simulation" | "on-chain";
  action: "released" | "buyer_sign_required" | "not_released";
  paymentIntentId?: string;
  txHash?: string;
  gross?: number;
  sellerAmount?: number;
  feeAmount?: number;
  // Present when action === "not_released": the payment intent's actual
  // status when this call determined it did NOT perform (or lose a race to)
  // a release — e.g. "refunded", "pending_refund". Callers must not treat
  // "not_released" as a success path; it means this call moved no money and
  // the intent is not settled in the seller's favor.
  currentStatus?: string;
};

export async function releaseMilestonePayment(
  milestoneId: string,
  opts: {
    releaseTxHash?: string;
    // TEST-ONLY instrumentation. Invoked exactly once, right after the
    // initial `WHERE status = 'funded'` SELECT succeeds and before the CAS
    // UPDATE transaction begins, so tests can deterministically land a
    // concurrent write (another release, a refund, ...) in that window
    // instead of relying on real network/DB timing jitter. Never set by any
    // production caller.
    __raceTestHook?: () => Promise<void>;
  } = {},
): Promise<ReleaseMilestonePaymentResult> {
  const mode = isOnChainMode() ? "on-chain" : "simulation";
  const [payment] = await sql`
    SELECT pi.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id
    FROM payment_intents pi
    JOIN milestones m ON m.id = pi.milestone_id
    JOIN deals d ON d.id = m.deal_id
    WHERE pi.milestone_id = ${milestoneId} AND pi.status = 'funded'
    ORDER BY pi.created_at DESC LIMIT 1
  `;

  if (!payment) {
    // The initial SELECT found no *funded* intent for this milestone. That is
    // NOT the same fact as "there is no money to (mis)represent" — a payment
    // intent may exist and simply be in a non-funded, non-released state
    // (e.g. 'refunded', 'pending_refund') because a concurrent refund landed
    // before this SELECT ran. Completing the milestone/deal in that case
    // would tell the same lie defect 1 fixes below, just one step earlier.
    // Distinguish "genuinely nothing was ever funded / it's already
    // released" (safe to complete) from "an intent exists in some other
    // non-terminal-for-us state" (must NOT be reported as released).
    const [existingIntent] = await sql`
      SELECT status FROM payment_intents WHERE milestone_id = ${milestoneId}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (existingIntent && existingIntent.status !== "released") {
      console.warn(
        `[releaseMilestonePayment] not_released for milestone ${milestoneId}: a payment_intent exists but is '${existingIntent.status}' (not 'funded', not 'released') — refusing to complete the milestone/deal as if a release happened.`,
      );
      return { mode, action: "not_released", currentStatus: existingIntent.status };
    }
    // Either no intent ever existed (free/unfunded milestone) or it's
    // already 'released' — nothing to fabricate either way.
    await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = ${milestoneId} AND status != 'accepted'`;
    await sql`
      UPDATE deals SET status = 'completed', updated_at = NOW()
      WHERE id = (SELECT deal_id FROM milestones WHERE id = ${milestoneId})
        AND status != 'completed'
    `;
    return { mode, action: "released" };
  }

  // ── settlement-integrity gate ────────────────────────────────────────────
  // payment_provider != 'stripe' means this intent is a USDC on-chain escrow
  // funding — real USDC is sitting in the escrow contract. In on-chain mode
  // the ONLY honest way to mark it released is a real on-chain release
  // transaction: either one a caller already performed and passed in via
  // opts.releaseTxHash, or none. We must NEVER synthesize a `sim_release_*`
  // hash here and flip payment_intents/milestones/deals to
  // released/accepted/completed while the contract still holds the funds —
  // that is the exact "DB says paid, chain says otherwise" defect this test
  // suite exists to prevent (see silent-zero-complete-guard.test.ts).
  // Stripe-funded intents have no on-chain escrow to fake-release from (the
  // fiat capture already moved real money at create-intent time), so they
  // are exempt from this gate in both modes.
  const isOnChainEscrowFunded = payment.payment_provider !== "stripe";
  const hasRealReleaseTx = Boolean(opts.releaseTxHash) && !opts.releaseTxHash!.startsWith("sim_");

  if (mode === "on-chain" && isOnChainEscrowFunded && !hasRealReleaseTx) {
    console.warn(
      `[releaseMilestonePayment] buyer_sign_required: milestone ${milestoneId} has a funded on-chain USDC escrow intent but no real on-chain release tx was provided. Refusing to fabricate a sim_release_* hash — payment_intents stays 'funded', milestone/deal state is untouched.`,
    );
    return { mode, action: "buyer_sign_required", paymentIntentId: String(payment.id) };
  }

  const gross = toNumber(payment.amount);
  const sellerAmount = Number((gross * (100 - PLATFORM_FEE_PCT)) / 100).toFixed(6);
  const feeAmount = Number((gross - Number(sellerAmount)).toFixed(6));
  const txHash = hasRealReleaseTx ? opts.releaseTxHash! : `sim_release_${randomUUID().slice(0, 8)}`;

  // TEST-ONLY: lets a test force a concurrent write (release or refund) to
  // land here, between the funded-SELECT above and the CAS UPDATE below,
  // deterministically instead of hoping Promise.all() timing does it.
  if (opts.__raceTestHook) {
    await opts.__raceTestHook();
  }

  // ── idempotency / race guard ─────────────────────────────────────────────
  // The initial SELECT above (`WHERE pi.status = 'funded'`) and this UPDATE
  // are two separate statements — classic TOCTOU. Two concurrent callers for
  // the SAME milestone (a buyer double-submitting POST /api/deliveries/verify,
  // or a buyer's manual verify racing the admin dispute-timeout sweep /
  // auto-complete sweep — both of which call this exact function; OR a buyer
  // refund racing a release) can both pass the SELECT before either commits.
  // Re-assert the status predicate INSIDE the UPDATE and check RETURNING: if
  // zero rows come back, we must not touch milestones/deals/offers or write a
  // second 'payment.release' audit row. Mirrors the existing guarded-UPDATE +
  // zero-rows-means-lost-race pattern already used by routes/admin.ts's
  // expire-stale-proposals sweep.
  const released = await sql.begin(async (txn) => {
    const updatedIntent = await txn.unsafe(
      `UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW(), tx_hash = $1 WHERE id = $2 AND status = 'funded' RETURNING id`,
      [txHash, payment.id]
    );
    if (updatedIntent.length === 0) {
      return false;
    }
    await txn.unsafe(`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE id = $1`, [milestoneId]);
    await txn.unsafe(
      `UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = (SELECT deal_id FROM milestones WHERE id = $1)`,
      [milestoneId]
    );
    await txn.unsafe(
      `UPDATE offers SET status = 'archived', updated_at = NOW()
       WHERE id = (SELECT offer_id FROM deals WHERE id = (SELECT deal_id FROM milestones WHERE id = $1)) AND status = 'active'`,
      [milestoneId]
    );
    await txn.unsafe(
      `INSERT INTO audit_log (action, object_type, object_id, payload_json)
       VALUES ('payment.release', 'milestone', $1, $2::jsonb)`,
      [milestoneId, JSON.stringify({ gross, sellerAmount, feeAmount, platformWallet: PLATFORM_WALLET, txHash })]
    );
    // ── platform fee ledger ────────────────────────────────────────────────
    // Mirrors routes/audit-orders.ts's completion-path INSERT exactly: same
    // table, same 10%-at-close convention (fee_pct_at_close records the rate
    // that actually applied, not a live env lookup, so historical rows stay
    // correct if PLATFORM_FEE_PCT is ever changed), same source-tagging
    // ('stripe' for a fiat-funded intent, 'usdc' for an on-chain escrow
    // intent — audit-orders is Stripe-only, so this is the first 'usdc' row
    // this table has ever produced). Idempotency does NOT rely on this
    // ON CONFLICT alone: platform_fee_ledger_unique_deal (migration 038)
    // is a real UNIQUE constraint on deal_id, so even a caller that skips
    // this helper entirely cannot double-insert for the same deal, and a
    // retried releaseMilestonePayment() call for an already-released
    // milestone never reaches this line at all (it returns early via the
    // CAS-lost / already-'released' branches above).
    const feeAmountMinor = Math.round(feeAmount * 1_000_000);
    if (feeAmountMinor > 0) {
      await txn.unsafe(
        `INSERT INTO platform_fee_ledger
          (deal_id, amount_minor, currency, fee_pct_at_close, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (deal_id) DO NOTHING`,
        [
          payment.deal_id,
          feeAmountMinor,
          (payment.currency as string) ?? "USDC",
          PLATFORM_FEE_PCT,
          isOnChainEscrowFunded ? "usdc" : "stripe",
        ],
      );
    }
    return true;
  });

  if (!released) {
    // We lost the CAS: someone else moved this payment_intent's status away
    // from 'funded' between our SELECT and our UPDATE. Zero rows proves ONLY
    // that fact — it does NOT prove "another caller released it". It could
    // just as easily be a refund (buyer-initiated 'pending_refund'/'refunded'
    // landing in the same window — see routes/payments.ts's refund route,
    // which writes those statuses with NO status guard on its own UPDATE).
    // Re-read the actual current status and report the truth instead of
    // assuming "released". Only report "released" here if the row genuinely
    // is released (the concurrent winner really was another release call);
    // anything else must come back as "not_released" so callers do not
    // fabricate payoutReleased:true / milestone.completed / releasedCount
    // for money that was not, in fact, released to the seller.
    const [current] = await sql`SELECT status FROM payment_intents WHERE id = ${payment.id}`;
    const currentStatus = current?.status ?? "unknown";
    if (currentStatus === "released") {
      console.warn(
        `[releaseMilestonePayment] lost race for milestone ${milestoneId}: payment_intents ${payment.id} was already released by a concurrent call. Skipping duplicate settlement.`,
      );
      return { mode, action: "released" };
    }
    console.warn(
      `[releaseMilestonePayment] not_released for milestone ${milestoneId}: lost the CAS on payment_intents ${payment.id}, and its current status is '${currentStatus}' (NOT 'released') — a concurrent refund or other status change won the race, not a release. Refusing to report action:'released'.`,
    );
    return { mode, action: "not_released", paymentIntentId: String(payment.id), currentStatus };
  }

  notifyAgents(sql, [payment.seller_agent_id], "payment.released", {
    dealId: payment.deal_id,
    milestoneId,
    gross,
    sellerAmount,
    feeAmount,
  });

  return {
    mode,
    action: "released",
    paymentIntentId: String(payment.id),
    txHash,
    gross,
    sellerAmount: Number(sellerAmount),
    feeAmount,
  };
}

export async function completeDealMilestones(
  dealId: string,
  opts: { skipOnChainRelease?: boolean; skipPaymentRelease?: boolean } = {},
): Promise<{
  mode: "simulation" | "on-chain";
  action:
    | "released"
    | "buyer_sign_required"
    | "completed_without_onchain_release"
    | "settlement_pending";
  txData?: Array<{
    milestoneId: string;
    to: string;
    data: string;
    value: string;
    description: string;
  }>;
  onChainReleaseResults?: Array<{
    milestoneId: string;
    txHash?: string;
    error?: string;
  }>;
}> {
  const mode = isOnChainMode() ? "on-chain" : "simulation";
  const [deal] = await sql`SELECT is_free_tier FROM deals WHERE id = ${dealId}`;
  const skipPaymentRelease = opts.skipPaymentRelease ?? Boolean(deal?.is_free_tier);
  const milestones = await sql`
    SELECT id FROM milestones WHERE deal_id = ${dealId} AND status != 'accepted' ORDER BY idx
  `;

  if (milestones.length === 0) {
    return { mode, action: "released" };
  }

  if (skipPaymentRelease) {
    await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
    await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
    return { mode, action: "released" };
  }

  if (mode === "on-chain") {
    if (opts.skipOnChainRelease) {
      await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
      await sql`UPDATE milestones SET status = 'accepted' WHERE deal_id = ${dealId} AND status != 'accepted'`;
      return { mode, action: "completed_without_onchain_release" };
    }

    const intents = await sql`
      SELECT pi.id, pi.tx_hash
      FROM payment_intents pi
      JOIN milestones m ON m.id = pi.milestone_id
      WHERE m.deal_id = ${dealId} AND pi.status = 'funded'
      ORDER BY pi.created_at DESC
    `;
    const hasOnChainFundedIntent = intents.some(
      (row) => row.tx_hash && !String(row.tx_hash).startsWith("sim_")
    );

    if (hasOnChainFundedIntent) {
      // escrow-safety rollout — DO NOT mark DB rows released until on-chain release
      // is confirmed. The previous version wrote `deals.status='completed'` and
      // `payment_intents.status='released'` UNCONDITIONALLY after the on-chain
      // call, even when the call threw. Result: DB says paid, contract still
      // holds the funds → latent money-loss event.
      //
      // ALLOW_ONCHAIN_RELEASE=false flips off on-chain release attempts entirely
      // (defers every release to the buyer-sign path) until the dedicated
      // release() function ships in Phase C.
      const allowOnChainRelease = (process.env.ALLOW_ONCHAIN_RELEASE ?? "true").toLowerCase() !== "false";

      const releaseResults: Array<{ milestoneId: string; txHash?: string; error?: string }> = [];
      for (const milestone of milestones) {
        if (!allowOnChainRelease) {
          releaseResults.push({
            milestoneId: String(milestone.id),
            error: "on-chain release disabled by ALLOW_ONCHAIN_RELEASE=false (A0 kill switch)",
          });
          continue;
        }
        try {
          const result = await resolveDisputeOnChain(String(milestone.id), false);
          releaseResults.push({ milestoneId: String(milestone.id), txHash: result.txHash });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[completeDealMilestones] On-chain release failed for ${milestone.id}: ${message}`);
          releaseResults.push({ milestoneId: String(milestone.id), error: message });
        }
      }

      const allReleased = releaseResults.every((r) => r.txHash);

      if (allReleased) {
        // Happy path — on-chain release succeeded for every milestone, safe to
        // converge DB state.
        await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
        await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
        await sql`UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ANY(${milestones.map((m) => String(m.id))}) AND status = 'funded'`;

        return {
          mode,
          action: "released",
          onChainReleaseResults: releaseResults,
        };
      }

      // Failure path — at least one milestone did NOT release on-chain. Keep
      // payment_intents at 'funded' (do NOT mark released), keep milestones at
      // their pre-release status, and put the deal in 'release_pending_chain'
      // so the buyer-sign or admin-retry path can converge later. Funds stay
      // in escrow on-chain; DB state matches.
      console.error(
        `[completeDealMilestones] On-chain release deferred for deal ${dealId}: ${
          releaseResults.filter((r) => !r.txHash).length
        }/${releaseResults.length} milestones failed on-chain. DB state held at release_pending_chain.`,
      );

      await sql`UPDATE deals SET status = 'release_pending_chain', updated_at = NOW() WHERE id = ${dealId}`;

      // Fire-and-forget audit row so monitors / agents see this state.
      try {
        await sql`
          INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
          VALUES (
            NULL,
            'chain.release_failed',
            'deal',
            ${dealId},
            ${`chain-release-failed-${dealId}-${Date.now()}`},
            ${JSON.stringify({ dealId, results: releaseResults, allowOnChainRelease })}::jsonb
          )
        `;
      } catch (auditErr) {
        // Audit logging is best-effort; if the schema differs we don't want to
        // mask the underlying release failure.
        console.error(
          `[completeDealMilestones] audit_log insert failed for ${dealId}: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`,
        );
      }

      return {
        mode,
        action: "buyer_sign_required",
        txData: releaseResults
          .filter((r) => !r.txHash)
          .map((r) => {
            const txData = generateAcceptTransaction(r.milestoneId);
            return {
              milestoneId: r.milestoneId,
              to: txData.to,
              data: txData.calldata,
              value: "0",
              description:
                "Accept milestone on-chain and release escrowed funds (platform release failed, buyer must sign)",
            };
          }),
        onChainReleaseResults: releaseResults,
      };
    }
  }

  // payment-methods rollout — silent-$0 phantom-complete guard. Mirror of the guard in
  // index.ts completeDealMilestones (admin force-complete path uses THIS copy).
  // COVERAGE, not existence (Codex MUST-FIX 2026-06-03): prove EVERY non-accepted
  // milestone is backed by real money (real on-chain non-sim tx_hash OR a real
  // Stripe intent). A LIMIT-1 existence check would let one funded milestone mask
  // unfunded tranches; the tail force-accepts all milestones. Hold the whole deal
  // at 'delivered' if any milestone is unbacked — no phantom complete, no fake fee
  // audit row. Mutates ONLY deals.status (milestones stay 'in_progress' →
  // fundable via /api/payments/create-intent), so a held deal is recoverable by
  // funding then re-closing.
  if (mode === "on-chain" && !skipPaymentRelease) {
    const [unbacked] = await sql`
      SELECT COUNT(*)::int AS n
      FROM milestones m
      WHERE m.deal_id = ${dealId}
        AND m.status != 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM payment_intents pi
          WHERE pi.milestone_id = m.id
            AND pi.status IN ('funded', 'released')
            AND (
              (pi.tx_hash IS NOT NULL AND pi.tx_hash NOT LIKE 'sim_%')
              OR (pi.payment_provider = 'stripe' AND pi.stripe_payment_intent_id IS NOT NULL)
            )
        )
    `;
    if (Number(unbacked?.n ?? 0) > 0) {
      console.warn(
        `[completeDealMilestones] settlement_pending: fee-bearing deal ${dealId} has ${unbacked.n} milestone(s) with no real-money funded intent in on-chain mode. Holding at 'delivered' (no phantom complete, no fake fee). Milestones stay fundable.`,
      );
      await sql`UPDATE deals SET status = 'delivered', updated_at = NOW() WHERE id = ${dealId} AND status != 'completed'`;
      return { mode, action: "settlement_pending" };
    }
  }

  // Defensive: by construction, every milestone reaching this tail is either
  // unfunded (nothing to fabricate), stripe-backed (no on-chain escrow to
  // fake-release), or we're in simulation mode — the settlement-integrity
  // gate inside releaseMilestonePayment() only refuses on-chain USDC-escrow
  // releases, which are handled above via resolveDisputeOnChain(). Still,
  // never blindly force-complete if the gate ever DOES refuse here — that
  // would recreate the exact phantom-complete bug this guard exists to stop.
  let anyRefused = false;
  for (const milestone of milestones) {
    const result = await releaseMilestonePayment(String(milestone.id));
    if (result.action === "buyer_sign_required" || result.action === "not_released") {
      // Either the on-chain settlement-integrity gate refused, or this
      // milestone's payment intent lost a race to something other than a
      // release (e.g. a concurrent refund) and is NOT actually settled.
      // Neither case is a completion — do not force-complete the deal on
      // top of a milestone that did not really release.
      anyRefused = true;
    }
  }

  if (anyRefused) {
    console.warn(
      `[completeDealMilestones] settlement_pending: deal ${dealId} had a milestone refuse release (buyer_sign_required or not_released) in the fall-through tail. Holding, not force-completing.`,
    );
    await sql`UPDATE deals SET status = 'delivered', updated_at = NOW() WHERE id = ${dealId} AND status != 'completed'`;
    return { mode, action: "settlement_pending" };
  }

  // Ensure deal and milestones are always transitioned to completed/accepted,
  // even when no funded payment_intent exists (e.g. intent never created or already
  // released upstream). Without this explicit UPDATE the deal stays stuck at 'delivered'.
  await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId} AND status != 'completed'`;
  await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;

  return { mode, action: "released" };
}

export type ProposeDealInput = z.infer<typeof proposeDealSchema>;

export async function createDealProposal(
  proposal: ProposeDealInput,
  opts: {
    idempotencyKey: string;
    auditAction: string;
    auditActorAgentId: string | null;
    negotiationActorAgentId: string;
    auditPayload?: unknown;
  },
): Promise<Record<string, unknown>> {
  const isFreeTier = isZeroPrice(proposal.negotiatedTotal);
  const result = await sql.begin(async (txn) => {
    const [deal] = await txn.unsafe(
      `INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days, is_free_tier
        ) VALUES ($1, $2, $3, $4, $5, $6, 'USDC', $7, $8, $9)
        RETURNING *`,
      [
        proposal.buyerAgentId,
        proposal.sellerAgentId,
        proposal.offerId,
        proposal.needId,
        "proposed",
        proposal.negotiatedTotal,
        proposal.maxPriceDeltaPct,
        proposal.acceptanceTimeoutDays,
        isFreeTier,
      ]
    );

    const milestones = [];
    for (const milestone of proposal.milestones) {
      const dueAt = milestone.dueAt ?? null;
      const [ms] = await txn.unsafe(
        `INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at, status)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6, $7)
          RETURNING *`,
        [
          deal.id,
          milestone.idx,
          milestone.title,
          milestone.amount,
          JSON.stringify(milestone.acceptanceCriteria),
          dueAt,
          "pending",
        ]
      );
      milestones.push(ms);
    }

    await txn.unsafe(
      `INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)`,
      [deal.id, opts.negotiationActorAgentId, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    await audit(
      opts.auditActorAgentId,
      opts.auditAction,
      "deal",
      String(deal.id),
      opts.idempotencyKey,
      opts.auditPayload ?? proposal
    );

    return { ...deal, milestones };
  });

  return result as Record<string, unknown>;
}
