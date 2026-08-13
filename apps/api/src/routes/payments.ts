import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import { Request as MppRequest } from "mppx/server";
import type { Hex, Address } from "viem";
import type { Deps } from "./types.js";
import { createPaymentIntentSchema, confirmFundingSchema } from "./schemas.js";
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
  constructWebhookEvent,
  isStripeEnabled,
} from "../stripe.js";
import { chargeDeal, getAvailableDealPaymentMethods, getMppConfigurationError, type DealPaymentMethod } from "../mpp.js";

function getDealPaymentMethodFromReceipt(method: string): DealPaymentMethod {
  return method === "tempo" ? "mpp-crypto" : "mpp-fiat";
}

export async function registerRoutes(
  app: FastifyInstance,
  sql: Sql<Record<string, unknown>>,
  deps: Deps,
  releaseMilestonePayment: (milestoneId: string) => Promise<void>,
): Promise<void> {
  const { notifyAgents } = deps;

  async function audit(actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
    await sql`
      INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
      VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
    `;
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

      const [intent] = await sql`
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
      `;

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
    if (!isPayableWalletAddress(milestone.seller_wallet_address)) {
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

      const [intent] = await sql`
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
      `;

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
    const [intent] = await sql`
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
    `;

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

    await sql.begin(async (txn) => {
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
    });

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

    await sql.begin(async (txn) => {
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
    });

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

    await releaseMilestonePayment(body.milestoneId);
    return { ok: true, mode };
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
          const { txHash } = await resolveDisputeOnChain(intent.milestone_id, true);
          await sql`
            UPDATE payment_intents
            SET status = 'refunded', updated_at = NOW(), tx_hash = ${txHash}
            WHERE id = ${body.paymentIntentId}
          `;
          await sql`UPDATE milestones SET status = 'cancelled' WHERE id = ${intent.milestone_id}`;
          return { ok: true, mode, txHash, action: "refunded_on_chain" };
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

        if (intent && intent.status === "created") {
          await sql`
            UPDATE payment_intents
            SET status = 'funded', updated_at = NOW()
            WHERE id = ${intent.id}
          `;
          await sql`
            UPDATE milestones SET status = 'funded' WHERE id = ${intent.milestone_id}
          `;

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
