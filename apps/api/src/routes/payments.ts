import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Row, Sql } from "postgres";
import { z } from "zod";
import { Request as MppRequest } from "mppx/server";
import type { Hex, Address } from "viem";
import type { Deps } from "./types.js";
import { createPaymentIntentSchema, confirmFundingSchema } from "./schemas.js";
import { dealNotFundable, resolveSellerPayoutAddress } from "../shared/deal-guards.js";
import { getRequesterAgentId, idempotencyKey, isZeroPrice, PLATFORM_FEE_PCT, PLATFORM_WALLET, toNumber, sendFetchResponse, isPayableWalletAddress } from "./utils.js";
import {
  isOnChainMode,
  generateFundingTransaction,
  generateAcceptTransaction,
  verifyFunding,
  resolveDisputeOnChain,
  getMilestoneStatus,
  resolveChainFromAddress,
  validateWalletAddress,
  usdcToUnits,
  CHAIN_CONFIG,
  ESCROW_ADDRESS,
  USDC_ADDRESS,
} from "../chain.js";
import {
  createPaymentIntent as stripeCreatePaymentIntent,
  cancelPaymentIntent as stripeCancelPaymentIntent,
  constructWebhookEvent,
  isStripeEnabled,
} from "../stripe.js";
import { chargeDeal, getAvailableDealPaymentMethods, getMppConfigurationError, type DealPaymentMethod } from "../mpp.js";

// cancel-refund-guard §4.1: deals that must never take new money on confirm-funding.
const NOT_FUNDABLE_DEAL_STATUSES = new Set(["cancelled", "completed", "release_pending_chain"]);

// cancel-refund-guard §4.2: deals create-intent may fund. The spec says
// 'active' only; 'delivered' is kept because completeDealMilestones holds an
// unbacked paid deal at 'delivered' (settlement_pending) and documents it as
// "recoverable by funding then re-closing". A delivered deal can never be
// party-cancelled (409 deal_delivered), so this does not weaken the guard.
const FUNDABLE_DEAL_STATUSES = new Set(["active", "delivered"]);

/**
 * Insert a payment intent only while the deal is still fundable, under the
 * deal row lock (cancel-refund-guard §4.2). Serialises with deal cancel, so a
 * fundable row can never appear on a deal that cancel already closed.
 * Returns null when the deal is no longer fundable.
 */
async function insertIntentIfDealActive(
  sql: Sql<Record<string, unknown>>,
  dealId: string,
  insert: (txn: Sql<Record<string, unknown>>) => Promise<Row[]>,
): Promise<Row | null> {
  return sql.begin(async (txn) => {
    const [locked] = await txn`SELECT status FROM deals WHERE id = ${dealId} FOR UPDATE`;
    if (!FUNDABLE_DEAL_STATUSES.has(String(locked?.status))) return null;
    const [row] = await insert(txn as unknown as Sql<Record<string, unknown>>);
    return row ?? null;
  }) as Promise<Row | null>;
}

function getDealPaymentMethodFromReceipt(method: string): DealPaymentMethod {
  return method === "tempo" ? "mpp-crypto" : "mpp-fiat";
}

export async function registerRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  deps: Deps,
  releaseMilestonePayment: (
    milestoneId: string,
  ) => Promise<{ mode: "simulation" | "on-chain"; action: "released" | "buyer_sign_required" | "not_released"; paymentIntentId?: string; txHash?: string; currentStatus?: string }>,
): Promise<void> {
  const { notifyAgents } = deps;

  async function audit(actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
    await sql`
      INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
      VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
    `;
  }

  /**
   * confirm-funding refused because the deal can no longer take money. On-chain
   * the money may already be in escrow (legacy calldata cannot be revoked), so
   * leave a durable, operator-visible trace: audit row + error log.
   */
  async function recordRefusedFunding(
    intent: Row,
    dealStatus: string,
    txHash: string,
    idem: string,
    verifiedOnChain: boolean | null,
  ) {
    app.log.error(
      { paymentIntentId: intent.id, dealStatus, txHash, verifiedOnChain },
      "confirm-funding refused on a non-fundable deal — escrowed funds may need an operator refund",
    );
    await audit(intent.buyer_agent_id, "payment.confirm_funding.refused", "payment_intent", intent.id, idem, {
      txHash, dealStatus, verifiedOnChain,
    });
  }

  app.post("/api/payments/create-intent", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = createPaymentIntentSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.buyerAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [milestone] = await sql`
      SELECT m.*, d.seller_agent_id, d.buyer_agent_id, d.id AS deal_id, d.status AS deal_status, d.is_free_tier, a.owner_wallet_address AS seller_wallet_address
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      JOIN agents a ON a.id = d.seller_agent_id
      WHERE m.id = ${body.milestoneId}
    `;

    if (!milestone) return reply.code(404).send({ error: "Milestone not found" });
    if (milestone.buyer_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    // cancel-refund-guard §4.2: a cancelled / proposed / settled deal is never funded.
    if (!FUNDABLE_DEAL_STATUSES.has(String(milestone.deal_status))) {
      return reply.code(409).send(dealNotFundable(String(milestone.deal_status)));
    }
    if (!["in_progress", "pending"].includes(milestone.status)) {
      return reply.code(400).send({ error: `Milestone status ${milestone.status} cannot be funded` });
    }
    if (milestone.is_free_tier || isZeroPrice(milestone.amount)) {
      return reply.code(400).send({ error: "Free-tier milestones do not require payment funding" });
    }

    // ── Stripe / fiat path ────────────────────────────────────────────────────
    if (body.provider === "stripe") {
      if (!isStripeEnabled()) {
        return reply.code(400).send({ error: "Stripe payments are not configured on this platform" });
      }

      const fiatCurrency = body.fiatCurrency ?? "usd";
      // Convert USDC amount (6 dp) → cents for fiat.
      // 1 USDC ≈ 1 USD; multiply by 100 to get cents, round to integer.
      const amountCents = Math.round(toNumber(milestone.amount) * 100);
      if (amountCents < 50) {
        return reply.code(400).send({ error: "Amount too small for Stripe (minimum ~$0.50 USD)" });
      }

      let stripeIntent;
      try {
        stripeIntent = await stripeCreatePaymentIntent(amountCents, fiatCurrency, {
          milestoneId: body.milestoneId,
          dealId: String(milestone.deal_id),
          buyerAgentId: body.buyerAgentId,
          sellerAgentId: String(milestone.seller_agent_id),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Stripe error";
        return reply.code(502).send({ error: `Stripe payment intent creation failed: ${message}` });
      }

      const cancelOrphanStripePI = async () => {
        try {
          await stripeCancelPaymentIntent(stripeIntent.id);
        } catch (err) {
          app.log.error({ err, stripePaymentIntentId: stripeIntent.id }, "create-intent: orphan Stripe PI could not be cancelled — needs operator cancel at Stripe");
        }
      };
      let intent: Row | null;
      try {
        intent = await insertIntentIfDealActive(sql, String(milestone.deal_id), (txn) => txn`
          INSERT INTO payment_intents (
            milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
            buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
            payment_provider, stripe_payment_intent_id, stripe_client_secret, fiat_currency, fiat_amount_cents
          ) VALUES (
            ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id},
            ${milestone.amount}, 'USDC', 'fiat', 'created',
            null, null, null, ${PLATFORM_WALLET},
            'stripe', ${stripeIntent.id}, ${stripeIntent.client_secret},
            ${fiatCurrency}, ${amountCents}
          )
          RETURNING *
        `);
      } catch (err) {
        // The PI exists at Stripe but was never recorded: kill it, then fail.
        await cancelOrphanStripePI();
        throw err;
      }
      if (!intent) {
        // The deal left 'active' (e.g. cancelled) while we created the Stripe
        // PI: kill it at the provider so its client secret can never capture.
        await cancelOrphanStripePI();
        return reply.code(409).send(dealNotFundable("no longer fundable"));
      }

      await audit(body.buyerAgentId, "payment.create_intent.stripe", "payment_intent", intent.id, idem, {
        stripePaymentIntentId: stripeIntent.id,
        amountCents,
        fiatCurrency,
        milestoneId: body.milestoneId,
      });

      return reply.code(201).send({
        paymentIntentId: intent.id,
        status: "created",
        mode: "stripe",
        provider: "stripe",
        fiatCurrency,
        amountCents,
        clientSecret: stripeIntent.client_secret,
        stripePaymentIntentId: stripeIntent.id,
        feePct: PLATFORM_FEE_PCT,
        instructions: "Use the `clientSecret` with Stripe.js (confirmPayment) or the Stripe mobile SDK to complete payment. The platform will be notified via webhook and the milestone will be automatically funded.",
      });
    }

    // ── USDC / on-chain path (original logic) ────────────────────────────────
    const mode = isOnChainMode() ? "on-chain" : "simulation";

    // payment-methods rolloutc — fund guard (Layer 3, last resort). The seller MUST have
    // a valid payout wallet before any USDC funding intent is created. Closes the
    // confirmed latent bug where a NULL/invalid seller_wallet_address was cast
    // straight to viem's Address (and written into payment_intents) — a wallet-less
    // seller's deal would otherwise target a null address at createMilestone time.
    // R1-02: pay the destination the accept guard approved — the owner wallet,
    // or the verified payout route when the owner wallet is missing/zero. Never
    // the raw owner_wallet_address, which may be the zero address.
    const sellerPayoutAddress = await resolveSellerPayoutAddress(sql, String(milestone.seller_agent_id));
    milestone.seller_wallet_address = sellerPayoutAddress;
    if (!sellerPayoutAddress || !isPayableWalletAddress(sellerPayoutAddress)) {
      return reply.code(400).send({
        error:
          "Seller has no valid payout wallet — the 'usdc' rail cannot be funded. The seller must link a wallet address before this milestone can be funded.",
      });
    }

    // Resolve and validate the chain from wallet address + explicit hint
    const resolvedChain = resolveChainFromAddress(body.buyerWalletAddress, body.chain);
    const chainValidation = validateWalletAddress(body.buyerWalletAddress, resolvedChain);
    if (!chainValidation.valid) {
      return reply.code(400).send({ error: chainValidation.reason });
    }
    const chainCfg = CHAIN_CONFIG[resolvedChain] ?? CHAIN_CONFIG["base"];

    if (mode === "on-chain") {
      const txData = generateFundingTransaction(
        milestone.deal_id,
        body.milestoneId,
        Number(milestone.amount),
        milestone.seller_wallet_address as Address,
      );

      const intent = await insertIntentIfDealActive(sql, String(milestone.deal_id), (txn) => txn`
        INSERT INTO payment_intents (
          milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
          buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address,
          payment_provider
        ) VALUES (
          ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id}, ${milestone.amount}, 'USDC', ${resolvedChain}, 'created',
          ${body.walletProvider}, ${body.buyerWalletAddress}, ${milestone.seller_wallet_address}, ${PLATFORM_WALLET},
          'usdc'
        )
        RETURNING *
      `);
      if (!intent) return reply.code(409).send(dealNotFundable("no longer fundable"));

      // Record resolved chain on the deal for reference
      await sql`UPDATE deals SET chain = ${resolvedChain} WHERE id = ${milestone.deal_id}`;

      await audit(body.buyerAgentId, "payment.create_intent", "payment_intent", intent.id, idem, { ...body, resolvedChain });

      return reply.code(201).send({
        paymentIntentId: intent.id,
        status: "created",
        mode,
        chain: resolvedChain,
        chainName: chainCfg.name,
        amount: intent.amount,
        currency: "USDC",
        feePct: PLATFORM_FEE_PCT,
        platformWallet: PLATFORM_WALLET,
        provider: "usdc",
        usdcContract: chainCfg.usdcAddress,
        escrowContract: resolvedChain === "base" ? ESCROW_ADDRESS : null,
        txData: {
          step1_approve: {
            to: txData.approveTo,
            data: txData.approveCalldata,
            value: txData.value,
            description: "Approve USDC spending by escrow contract",
          },
          step2_fund: {
            to: txData.fundTo,
            data: txData.fundCalldata,
            value: txData.value,
            description: "Fund milestone via escrow contract (createMilestone)",
          },
          amountRaw: txData.amountRaw,
        },
      });
    }

    // Simulation mode — immediate funding (legacy behavior)
    const intent = await insertIntentIfDealActive(sql, String(milestone.deal_id), (txn) => txn`
      INSERT INTO payment_intents (
        milestone_id, buyer_agent_id, seller_agent_id, amount, currency, chain, status,
        buyer_wallet_provider, buyer_wallet_address, seller_wallet_address, platform_wallet_address, tx_hash,
        payment_provider
      ) VALUES (
        ${body.milestoneId}, ${body.buyerAgentId}, ${milestone.seller_agent_id}, ${milestone.amount}, 'USDC', ${resolvedChain}, 'funded',
        ${body.walletProvider}, ${body.buyerWalletAddress}, ${milestone.seller_wallet_address}, ${PLATFORM_WALLET}, ${`sim_fund_${randomUUID().slice(0, 8)}`},
        'usdc'
      )
      RETURNING *
    `);
    if (!intent) return reply.code(409).send(dealNotFundable("no longer fundable"));

    // Record resolved chain on the deal
    await sql`UPDATE deals SET chain = ${resolvedChain} WHERE id = ${milestone.deal_id}`;

    await sql`UPDATE milestones SET status = 'funded' WHERE id = ${body.milestoneId}`;
    await audit(body.buyerAgentId, "payment.create_intent", "payment_intent", intent.id, idem, { ...body, resolvedChain });

    notifyAgents(sql, [milestone.seller_agent_id], "payment.funded", {
      dealId: milestone.deal_id,
      milestoneId: body.milestoneId,
      amount: milestone.amount,
      buyerAgentId: body.buyerAgentId,
    });

    return reply.code(201).send({
      paymentIntentId: intent.id,
      status: intent.status,
      mode,
      chain: intent.chain,
      amount: intent.amount,
      currency: "USDC",
      feePct: PLATFORM_FEE_PCT,
      platformWallet: PLATFORM_WALLET,
      provider: "usdc",
    });
  });

  app.get("/api/payments/status", async (request, reply) => {
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const q = request.query as { milestoneId?: string; paymentIntentId?: string };
    if (!q.milestoneId && !q.paymentIntentId) {
      return reply.code(400).send({ error: "Provide milestoneId or paymentIntentId" });
    }
    const rows = await sql`
      SELECT pi.*, m.deal_id
      FROM payment_intents pi
      JOIN milestones m ON m.id = pi.milestone_id
      JOIN deals d ON d.id = m.deal_id
      WHERE (${q.milestoneId ?? null}::uuid IS NULL OR pi.milestone_id = ${q.milestoneId ?? null}::uuid)
        AND (${q.paymentIntentId ?? null}::uuid IS NULL OR pi.id = ${q.paymentIntentId ?? null}::uuid)
        AND (pi.buyer_agent_id = ${requesterAgentId} OR d.seller_agent_id = ${requesterAgentId})
      ORDER BY pi.created_at DESC
    `;
    // Strip sensitive fields — never expose Stripe client secret over the API
    return rows.map(({ stripe_client_secret, ...rest }: Record<string, unknown>) => ({
      ...rest,
      mode: isOnChainMode() ? "on-chain" : "simulation",
    }));
  });

  app.post("/api/payments/confirm-funding", async (request, reply) => {
    const body = confirmFundingSchema.parse(request.body);
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;

    const [intent] = await sql`
      SELECT * FROM payment_intents WHERE id = ${body.paymentIntentId}
    `;

    if (!intent) return reply.code(404).send({ error: "Payment intent not found" });
    if (intent.buyer_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    // cancel-refund-guard §4.1: a cancelled / settled deal never takes new
    // money. Checked before the intent status so the caller gets the real
    // reason (cancel flips the intent to 'failed').
    const [intentDeal] = await sql`
      SELECT d.id, d.status FROM deals d JOIN milestones m ON m.deal_id = d.id WHERE m.id = ${intent.milestone_id}
    `;
    if (intentDeal && NOT_FUNDABLE_DEAL_STATUSES.has(String(intentDeal.status))) {
      // The buyer may already have broadcast the escrow tx with the calldata
      // they hold — the DB cannot stop that. Keep the tx traceable so an
      // operator can drive the on-chain refund (dispute → force-refund).
      await recordRefusedFunding(intent, String(intentDeal.status), body.txHash, idem, null);
      return reply.code(409).send(dealNotFundable(String(intentDeal.status)));
    }
    if (intent.status !== "created") {
      return reply.code(400).send({ error: `Intent status is ${intent.status}, expected created` });
    }

    // CUSTODY BINDING: verifyFunding must confirm the on-chain MilestoneCreated
    // event actually names THIS milestone/buyer/seller/amount — not merely that
    // *some* successful transaction was once sent to the escrow contract. Without
    // this, a buyer could replay any old (their own or someone else's) escrow tx
    // hash against a different, unfunded payment intent and have it accepted.
    // buyer/seller wallet addresses were recorded on the intent itself at
    // create-intent time (see generateFundingTransaction / the INSERT above),
    // so no extra join is needed to source the expected binding.
    const verification = await verifyFunding(body.txHash as Hex, {
      milestoneId: intent.milestone_id,
      buyer: intent.buyer_wallet_address as Address,
      seller: intent.seller_wallet_address as Address,
      amountRaw: usdcToUnits(toNumber(intent.amount)),
    });

    if (!verification.verified) {
      return reply.code(400).send({
        error: `Transaction not verified on-chain: ${verification.reason ?? "failed or not confirmed"}`,
      });
    }

    const funded = await sql.begin(async (txn) => {
      // Lock the deal first: serialises with POST /api/deals/:id/cancel, which
      // closes 'created' intents under the same lock. Whichever commits first
      // wins; the other sees the result (never cancelled + funded).
      const [lockedDeal] = await txn`
        SELECT d.status FROM deals d JOIN milestones m ON m.deal_id = d.id WHERE m.id = ${intent.milestone_id} FOR UPDATE OF d
      `;
      if (lockedDeal && NOT_FUNDABLE_DEAL_STATUSES.has(String(lockedDeal.status))) {
        return { ok: false as const, dealStatus: String(lockedDeal.status) };
      }
      // Atomic CAS: only update if still 'created' — prevents TOCTOU double-fund
      const [updated] = await txn.unsafe(
        `UPDATE payment_intents SET status = 'funded', tx_hash = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'created'
         RETURNING id`,
        [body.txHash, body.paymentIntentId]
      );
      if (!updated) {
        throw new Error("CONFLICT: intent was already funded by a concurrent request");
      }
      await txn.unsafe(
        `UPDATE milestones SET status = 'funded' WHERE id = $1 AND status IN ('in_progress','pending')`,
        [intent.milestone_id]
      );
      return { ok: true as const };
    });
    if (!funded.ok) {
      // verifyFunding PROVED the USDC is in escrow: a cancel committed while
      // the buyer's tx was in flight. Record it for the operator refund path.
      await recordRefusedFunding(intent, funded.dealStatus, body.txHash, idem, true);
      return reply.code(409).send(dealNotFundable(funded.dealStatus));
    }

    await audit(intent.buyer_agent_id, "payment.confirm_funding", "payment_intent", intent.id, idem, { txHash: body.txHash });

    notifyAgents(sql, [intent.seller_agent_id], "payment.funded", {
      milestoneId: intent.milestone_id,
      amount: intent.amount,
      buyerAgentId: intent.buyer_agent_id,
      txHash: body.txHash,
    });

    return reply.code(200).send({
      paymentIntentId: intent.id,
      status: "funded",
      txHash: body.txHash,
      mode: "on-chain",
      verified: true,
    });
  });

  app.get("/api/payments/on-chain-status", async (request, reply) => {
    const q = request.query as { milestoneId?: string };
    if (!q.milestoneId) return reply.code(400).send({ error: "Provide milestoneId" });

    if (!isOnChainMode()) {
      return { mode: "simulation", message: "On-chain status not available in simulation mode" };
    }

    const status = await getMilestoneStatus(q.milestoneId);
    return { mode: "on-chain", ...status };
  });

  app.get("/api/deals/:id/payment-methods", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [deal] = await sql`SELECT id FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });

    return {
      dealId: id,
      methods: getAvailableDealPaymentMethods({ includeLegacyUsdc: isOnChainMode() }),
    };
  });

  app.post("/api/deals/:id/pay-mpp", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT id, status, buyer_agent_id, seller_agent_id, negotiated_total, currency, mpp_receipt
      FROM deals
      WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.actorAgentId !== deal.buyer_agent_id) {
      return reply.code(403).send({ error: "Only the buyer can fund a deal" });
    }
    if (isZeroPrice(deal.negotiated_total)) {
      return reply.code(400).send({ error: "Free-tier deals do not require MPP funding" });
    }
    if (deal.status === "funded") {
      return { ok: true, alreadyFunded: true, dealId: id };
    }
    // cancel-refund-guard (beyond spec §4, flagged): MPP has no refund path, so
    // charging a cancelled / proposed / settled deal would strand the buyer's
    // money with no way back. Refuse BEFORE the charge.
    if (deal.status !== "active") {
      return reply.code(409).send(dealNotFundable(String(deal.status)));
    }

    const mppConfigError = getMppConfigurationError();
    if (mppConfigError) {
      return reply.code(503).send({ error: mppConfigError });
    }

    const mppRequest = MppRequest.fromNodeListener(request.raw, reply.raw);
    const paymentResult = await chargeDeal(Number(deal.negotiated_total), String(deal.currency ?? "USDC"), mppRequest);

    if (paymentResult.status === 402) {
      return sendFetchResponse(reply, paymentResult.challenge);
    }

    const paymentMethod = getDealPaymentMethodFromReceipt(paymentResult.receipt.method);

    const recorded = await sql.begin(async (txn) => {
      // Re-check under the deal row lock: a cancel may have committed during
      // the (slow, external) charge. Never write 'funded' over 'cancelled'.
      const [locked] = await txn`SELECT status FROM deals WHERE id = ${id} FOR UPDATE`;
      if (locked?.status !== "active") return false;
      await txn.unsafe(
        `
          UPDATE deals
          SET
            status = 'funded',
            payment_method = $1,
            mpp_receipt = $2::jsonb,
            updated_at = NOW()
          WHERE id = $3
        `,
        [paymentMethod, JSON.stringify(paymentResult.receipt), id],
      );
      await txn.unsafe(
        `
          UPDATE milestones
          SET status = 'funded'
          WHERE deal_id = $1 AND status IN ('pending', 'in_progress')
        `,
        [id],
      );
      return true;
    });
    if (!recorded) {
      // MPP has no refund path: the charge succeeded on a deal that left
      // 'active' mid-charge. Do not touch the deal row; surface for operators.
      app.log.error({ dealId: id, receiptReference: (paymentResult.receipt as { reference?: unknown }).reference ?? null }, "pay-mpp: deal left active during the charge — charged money needs operator reconciliation");
      await audit(body.actorAgentId, "payment.mpp.refused_after_charge", "deal", id, randomUUID(), { receipt: paymentResult.receipt });
      return reply.code(409).send(dealNotFundable("no longer fundable"));
    }

    notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "payment.funded", {
      dealId: id,
      method: paymentMethod,
      receipt: paymentResult.receipt,
    });

    const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
    return {
      ok: true,
      deal: updatedDeal,
      receipt: paymentResult.receipt,
      paymentMethod,
    };
  });

  app.post("/api/payments/release", async (request, reply) => {
    const body = z.object({ milestoneId: z.string().uuid() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const [milestone] = await sql`
      SELECT d.buyer_agent_id
      FROM milestones m
      JOIN deals d ON d.id = m.deal_id
      WHERE m.id = ${body.milestoneId}
    `;
    if (!milestone) return reply.code(404).send({ error: "Milestone not found" });
    if (milestone.buyer_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const mode = isOnChainMode() ? "on-chain" : "simulation";

    if (mode === "on-chain") {
      const txData = generateAcceptTransaction(body.milestoneId);

      return reply.code(200).send({
        ok: true,
        mode,
        action: "buyer_sign_required",
        message: "Buyer must call acceptMilestone on-chain to release funds to seller",
        txData: {
          to: txData.to,
          data: txData.calldata,
          value: "0",
          description: "Accept milestone — releases USDC to seller (minus platform fee)",
        },
      });
    }

    const releaseResult = await releaseMilestonePayment(body.milestoneId);
    if (releaseResult.action === "buyer_sign_required") {
      // settlement-integrity: shared helper refused to fabricate a release —
      // there is a funded on-chain USDC escrow intent with no real release tx.
      // Tell the truth instead of returning {ok:true}. Response shape is a
      // breaking change from the prior unconditional {ok:true, mode} for this
      // (previously buggy) branch — see PR body.
      return reply.code(200).send({
        ok: false,
        mode: releaseResult.mode,
        action: "buyer_sign_required",
        message: "Milestone has a funded on-chain USDC escrow intent — release requires a real on-chain transaction. No settlement was recorded.",
      });
    }
    if (releaseResult.action === "not_released") {
      // settlement-integrity: this call did NOT release money — it lost a
      // race to something other than a release (e.g. a concurrent refund).
      // Tell the truth instead of falling through to the success response.
      return reply.code(200).send({
        ok: false,
        mode: releaseResult.mode,
        action: "not_released",
        currentStatus: releaseResult.currentStatus,
        message: `Payment intent was not released by this call — its current status is '${releaseResult.currentStatus}'.`,
      });
    }
    return { ok: true, mode: releaseResult.mode };
  });

  app.post("/api/payments/refund", async (request, reply) => {
    const body = z.object({ paymentIntentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    const mode = isOnChainMode() ? "on-chain" : "simulation";

    const [intent] = await sql`SELECT * FROM payment_intents WHERE id = ${body.paymentIntentId}`;
    if (!intent) return reply.code(404).send({ error: "Payment intent not found" });
    if (intent.buyer_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }

    if (mode === "on-chain") {
      try {
        const onChainStatus = await getMilestoneStatus(intent.milestone_id);
        if (onChainStatus.exists && onChainStatus.status === "Disputed") {
          // SECURITY: do NOT auto-adjudicate in the buyer's favor on the
          // buyer's own request. Previously this branch called
          // resolveDisputeOnChain(milestoneId, true) here, which meant an
          // authenticated buyer could open a dispute on themselves
          // (AgentPactEscrow.sol openDispute is buyer-callable) and
          // immediately have the PLATFORM key sign a refund with zero
          // seller consent, no evidence review, and no time window — the
          // buyer could take delivery and then claw the money back alone.
          //
          // A disputed milestone now falls into the SAME pending_refund
          // hold as the non-disputed case below: the payment intent is
          // marked pending_refund and an operator/admin resolves the
          // underlying dispute out-of-band (same mechanism as
          // /api/admin/force-release, which already signs
          // resolveDisputeOnChain(milestoneId, false) for the seller-favor
          // case). There is deliberately no automatic buyer-favor
          // resolution path here — that would require its own admin
          // adjudication endpoint, which is out of scope for this fix.
          await sql`
            UPDATE payment_intents
            SET status = 'pending_refund', updated_at = NOW()
            WHERE id = ${body.paymentIntentId}
          `;
          return {
            ok: true,
            mode,
            action: "pending_refund",
            message:
              "Milestone is disputed on-chain. A platform-signed refund requires admin/operator adjudication (seller consent / evidence review) — it is not granted automatically to the buyer who opened the dispute.",
          };
        }

        await sql`
          UPDATE payment_intents
          SET status = 'pending_refund', updated_at = NOW()
          WHERE id = ${body.paymentIntentId}
        `;
        return {
          ok: true,
          mode,
          action: "pending_refund",
          message: "Milestone must be disputed on-chain before platform can refund. Buyer should call openDispute first.",
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return reply.code(500).send({ error: `On-chain refund failed: ${message}` });
      }
    }

    await sql`
      UPDATE payment_intents
      SET status = 'refunded', updated_at = NOW(), tx_hash = ${`sim_refund_${randomUUID().slice(0, 8)}`}
      WHERE id = ${body.paymentIntentId}
    `;
    return { ok: true, mode };
  });

  // ── Stripe webhook endpoint ─────────────────────────────────────────────────
  // Stripe calls this when a PaymentIntent status changes (succeeded, failed, etc.).
  // Must be registered BEFORE Fastify body parsing hooks consume the raw body,
  // so we use addContentTypeParser (raw buffer) for this route only.
  //
  // The endpoint is intentionally public (no agent API key) — Stripe signs the
  // payload with STRIPE_WEBHOOK_SECRET instead.
  app.post(
    "/api/payments/stripe-webhook",
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      if (!isStripeEnabled()) {
        return reply.code(404).send({ error: "Stripe not configured" });
      }

      const sig = request.headers["stripe-signature"] as string | undefined;
      if (!sig) {
        return reply.code(400).send({ error: "Missing stripe-signature header" });
      }

      let event;
      try {
        // Fastify stores the raw body as request.rawBody when rawBody:true is set
        const rawBody = (request as unknown as { rawBody?: Buffer | string }).rawBody ?? JSON.stringify(request.body);
        event = constructWebhookEvent(rawBody, sig);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid webhook";
        return reply.code(400).send({ error: message });
      }

      // We only act on payment_intent.succeeded — all other events are acknowledged but ignored.
      if (event.type === "payment_intent.succeeded") {
        const stripePaymentIntentId = event.data.object.id;

        const [intent] = await sql`
          SELECT pi.*, m.deal_id, m.id AS milestone_id_col, d.seller_agent_id, d.buyer_agent_id
          FROM payment_intents pi
          JOIN milestones m ON m.id = pi.milestone_id
          JOIN deals d ON d.id = m.deal_id
          WHERE pi.stripe_payment_intent_id = ${stripePaymentIntentId}
          LIMIT 1
        `;

        if (intent && intent.status !== "created" && intent.status !== "funded") {
          // Stripe captured money for a PI we no longer consider open (e.g.
          // cancel failed it). Must never happen — cancel kills the PI at
          // Stripe first — so leave an operator-visible trace.
          app.log.error({ paymentIntentId: intent.id, status: intent.status, stripePaymentIntentId }, "stripe-webhook: succeeded event for a non-open payment intent — not marking funded, needs operator review");
        }

        if (intent && intent.status === "created") {
          // CAS on 'created', with the milestone write in the same
          // transaction (cancel-refund-guard R2): deal cancel flips a Stripe PI
          // to 'failed' only after cancelling it at Stripe, so a stale
          // succeeded event must not resurrect it.
          const cas = await sql.begin(async (txn) => {
            const [row] = await txn`
              UPDATE payment_intents
              SET status = 'funded', updated_at = NOW()
              WHERE id = ${intent.id} AND status = 'created'
              RETURNING id
            `;
            if (!row) return false;
            await txn`
              UPDATE milestones SET status = 'funded'
              WHERE id = ${intent.milestone_id} AND status IN ('in_progress', 'pending')
            `;
            return true;
          });
          if (!cas) {
            app.log.error({ paymentIntentId: intent.id, stripePaymentIntentId }, "stripe-webhook: payment intent left 'created' before the succeeded event was recorded — not marking funded, needs operator review");
            return reply.code(200).send({ received: true });
          }

          await audit(null, "payment.stripe.funded", "payment_intent", intent.id, randomUUID(), {
            stripePaymentIntentId,
            milestoneId: intent.milestone_id,
          });

          notifyAgents(sql, [intent.seller_agent_id], "payment.funded", {
            dealId: intent.deal_id,
            milestoneId: intent.milestone_id,
            provider: "stripe",
            stripePaymentIntentId,
            buyerAgentId: intent.buyer_agent_id,
          });
        }
      }

      // Always return 200 to Stripe to acknowledge receipt.
      return reply.code(200).send({ received: true });
    },
  );
}
