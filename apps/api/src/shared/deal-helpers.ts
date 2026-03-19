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

export async function releaseMilestonePayment(milestoneId: string): Promise<void> {
  const [payment] = await sql`
    SELECT pi.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id
    FROM payment_intents pi
    JOIN milestones m ON m.id = pi.milestone_id
    JOIN deals d ON d.id = m.deal_id
    WHERE pi.milestone_id = ${milestoneId} AND pi.status = 'funded'
    ORDER BY pi.created_at DESC LIMIT 1
  `;

  if (!payment) return;

  const gross = toNumber(payment.amount);
  const sellerAmount = Number((gross * (100 - PLATFORM_FEE_PCT)) / 100).toFixed(6);
  const feeAmount = Number((gross - Number(sellerAmount)).toFixed(6));

  await sql.begin(async (txn) => {
    await txn.unsafe(
      `UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW(), tx_hash = $1 WHERE id = $2`,
      [`sim_release_${randomUUID().slice(0, 8)}`, payment.id]
    );
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
      [milestoneId, JSON.stringify({ gross, sellerAmount, feeAmount, platformWallet: PLATFORM_WALLET })]
    );
  });

  notifyAgents(sql, [payment.seller_agent_id], "payment.released", {
    dealId: payment.deal_id,
    milestoneId,
    gross,
    sellerAmount,
    feeAmount,
  });
}

export async function completeDealMilestones(
  dealId: string,
  opts: { skipOnChainRelease?: boolean; skipPaymentRelease?: boolean } = {},
): Promise<{
  mode: "simulation" | "on-chain";
  action:
    | "released"
    | "buyer_sign_required"
    | "completed_without_onchain_release";
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
      const releaseResults: Array<{ milestoneId: string; txHash?: string; error?: string }> = [];
      for (const milestone of milestones) {
        try {
          const result = await resolveDisputeOnChain(String(milestone.id), false);
          releaseResults.push({ milestoneId: String(milestone.id), txHash: result.txHash });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[completeDealMilestones] On-chain release failed for ${milestone.id}: ${message}`);
          releaseResults.push({ milestoneId: String(milestone.id), error: message });
        }
      }

      await sql`UPDATE deals SET status = 'completed', updated_at = NOW() WHERE id = ${dealId}`;
      await sql`UPDATE milestones SET status = 'accepted', accepted_at = NOW() WHERE deal_id = ${dealId} AND status != 'accepted'`;
      await sql`UPDATE payment_intents SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE milestone_id = ANY(${milestones.map((m) => String(m.id))}) AND status = 'funded'`;

      const allReleased = releaseResults.every((r) => r.txHash);
      return {
        mode,
        action: allReleased ? "released" : "buyer_sign_required",
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

  for (const milestone of milestones) {
    await releaseMilestonePayment(String(milestone.id));
  }

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
