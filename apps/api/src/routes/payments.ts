import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Hex, Address } from "viem";
import type { Deps } from "./types.js";
import { createPaymentIntentSchema, confirmFundingSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, isZeroPrice, PLATFORM_FEE_PCT, PLATFORM_WALLET, toNumber } from "./utils.js";
import {
  isOnChainMode,
  generateFundingTransaction,
  generateAcceptTransaction,
  verifyFunding,
  resolveDisputeOnChain,
  getMilestoneStatus,
  resolveChainFromAddress,
  validateWalletAddress,
  CHAIN_CONFIG,
  ESCROW_ADDRESS,
  USDC_ADDRESS,
} from "../chain.js";
import {
  createPaymentIntent as stripeCreatePaymentIntent,
  constructWebhookEvent,
  isStripeEnabled,
} from "../stripe.js";

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
    const q = request.query as { milestoneId?: string; paymentIntentId?: string };
    if (!q.milestoneId && !q.paymentIntentId) {
      return reply.code(400).send({ error: "Provide milestoneId or paymentIntentId" });
    }
    const rows = await sql`
      SELECT * FROM payment_intents
      WHERE (${q.milestoneId ?? null}::uuid IS NULL OR milestone_id = ${q.milestoneId ?? null}::uuid)
        AND (${q.paymentIntentId ?? null}::uuid IS NULL OR id = ${q.paymentIntentId ?? null}::uuid)
      ORDER BY created_at DESC
    `;
    return rows.map((r: Record<string, unknown>) => ({ ...r, mode: isOnChainMode() ? "on-chain" : "simulation" }));
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

    const verification = await verifyFunding(body.txHash as Hex);

    if (!verification.verified) {
      return reply.code(400).send({ error: "Transaction not verified on-chain — failed or not confirmed" });
    }

    await sql.begin(async (txn) => {
      await txn.unsafe(
        `UPDATE payment_intents SET status = 'funded', tx_hash = $1, updated_at = NOW() WHERE id = $2`,
        [body.txHash, body.paymentIntentId]
      );
      await txn.unsafe(
        `UPDATE milestones SET status = 'funded' WHERE id = $1`,
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
