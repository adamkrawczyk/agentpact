import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import { encodeAbiParameters } from "viem";
import type { Deps } from "./types.js";
import { proposeDealSchema, counterDealSchema, consultationResponseSchema, decomposeDealSchema } from "./schemas.js";
import { getRequesterAgentId, idempotencyKey, isZeroPrice, toNumber, expandPaymentRails, STRIPE_RAIL_ENABLED, isPayableWalletAddress, isIntentCreationDisabled } from "./utils.js";

async function audit(sql: Sql<Record<string, unknown>>, actorId: string | null, action: string, objectType: string, objectId: string | null, idem: string, payload: unknown) {
  await sql`
    INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
    VALUES (${actorId}, ${action}, ${objectType}, ${objectId}, ${idem}, ${JSON.stringify(payload)}::jsonb)
  `;
}

// DEFECT B fix (issue #90) — proposals never expire.
// deals.expires_at already exists in the schema (migration 001) but nothing
// ever wrote to it, so every proposal sat with expires_at = NULL forever and
// the only way out of 'proposed' was a manual accept/counter/cancel. Give
// every new proposal a concrete acceptance deadline so the sweeper added
// below (POST /api/admin/expire-stale-proposals) has something to act on.
// Configurable so ops can tune it without a redeploy; 14 days is a generous
// default that will not surprise slow-moving negotiations.
const DEAL_PROPOSAL_EXPIRY_DAYS = Number(process.env.DEAL_PROPOSAL_EXPIRY_DAYS ?? 14);

// DEFECT C fix (issue #91) — shared with the defensive check at the mint site
// below. index.ts has its own copy for the boot-time assertion (separate
// module, no shared import surface for this one constant).
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function createDealProposal(
  sql: Sql<Record<string, unknown>>,
  proposal: z.infer<typeof proposeDealSchema>,
  opts: {
    idempotencyKey: string;
    auditAction: string;
    auditActorAgentId: string | null;
    negotiationActorAgentId: string;
    auditPayload?: unknown;
  },
): Promise<Record<string, unknown>> {
  const isFreeTier = isZeroPrice(proposal.negotiatedTotal);
  const taskContract = (proposal as any).task_contract ?? null;
  const deliverableHashHex = (proposal as any).deliverableHash ?? null;
  // deals.deliverable_hash is BYTEA; decode the 0x hex string to a Buffer so the
  // accept-deal auto-mint guard (deal.deliverable_hash != null) fires for gasless deals.
  const deliverableHashBuf = deliverableHashHex
    ? Buffer.from((deliverableHashHex as string).slice(2), "hex")
    : null;
  // DEFECT B fix (issue #90) — always set a concrete expires_at. Explicit
  // override via the propose payload wins; otherwise default out
  // DEAL_PROPOSAL_EXPIRY_DAYS from now. Never leave it NULL — a NULL expiry
  // is exactly the state that let ≥200 deals sit in 'proposed' forever.
  const explicitExpiresAt = (proposal as any).expiresAt ?? null;
  const expiresAt = explicitExpiresAt
    ? new Date(explicitExpiresAt)
    : new Date(Date.now() + DEAL_PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const result = await sql.begin(async (txn) => {
    const [deal] = await txn.unsafe(
      `
        INSERT INTO deals (
          buyer_agent_id, seller_agent_id, offer_id, need_id, status, negotiated_total, currency, max_price_delta_pct, acceptance_timeout_days, is_free_tier, task_contract, max_revisions, parent_deal_id, deliverable_hash, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'USDC', $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
        RETURNING *
      `,
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
        taskContract ? JSON.stringify(taskContract) : null,
        proposal.maxRevisions ?? null,
        (proposal as any).parentDealId ?? null,
        deliverableHashBuf,
        expiresAt,
      ]
    );

    const milestones = [];
    for (const milestone of proposal.milestones) {
      const dueAt = milestone.dueAt ?? null;
      const [ms] = await txn.unsafe(
        `
          INSERT INTO milestones (deal_id, idx, title, amount, currency, acceptance_criteria, due_at, status)
          VALUES ($1, $2, $3, $4, 'USDC', $5::jsonb, $6, $7)
          RETURNING *
        `,
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
      `
        INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
        VALUES ($1, $2, 'propose', $3::jsonb)
      `,
      [deal.id, opts.negotiationActorAgentId, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    await txn.unsafe(
      `INSERT INTO audit_log (actor_agent_id, action, object_type, object_id, idempotency_key, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [opts.auditActorAgentId, opts.auditAction, "deal", String(deal.id), opts.idempotencyKey, JSON.stringify(opts.auditPayload ?? proposal)]
    );

    return { ...deal, milestones };
  });

  return result as Record<string, unknown>;
}

async function enforceDealDelta(sql: Sql<Record<string, unknown>>, dealId: string, negotiatedTotal: number): Promise<void> {
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

type ConsultationDealContext = {
  id: string;
  status: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  offer_id: string | null;
  fulfillment_type: string;
  max_respondents: number | null;
  time_limit_minutes: number | null;
  accepted_at: Date | string | null;
  is_free_tier: boolean;
};

async function getConsultationDealContext(
  sql: Sql<Record<string, unknown>>,
  dealId: string,
): Promise<ConsultationDealContext | null> {
  const [deal] = await sql`
    SELECT
      d.id,
      d.status,
      d.buyer_agent_id,
      d.seller_agent_id,
      d.offer_id,
      d.is_free_tier,
      COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type,
      o.max_respondents,
      o.time_limit_minutes,
      accept_event.created_at AS accepted_at
    FROM deals d
    LEFT JOIN offers o ON o.id = d.offer_id
    LEFT JOIN LATERAL (
      SELECT created_at
      FROM negotiation_events
      WHERE deal_id = d.id AND event_type = 'accept'
      ORDER BY created_at ASC
      LIMIT 1
    ) accept_event ON true
    WHERE d.id = ${dealId}
  `;

  if (!deal) return null;
  return {
    id: String(deal.id),
    status: String(deal.status),
    buyer_agent_id: String(deal.buyer_agent_id),
    seller_agent_id: String(deal.seller_agent_id),
    offer_id: deal.offer_id ? String(deal.offer_id) : null,
    fulfillment_type: String(deal.fulfillment_type),
    max_respondents: deal.max_respondents === null ? null : Number(deal.max_respondents),
    time_limit_minutes: deal.time_limit_minutes === null ? null : Number(deal.time_limit_minutes),
    accepted_at: (deal.accepted_at as Date | string | null) ?? null,
    is_free_tier: Boolean(deal.is_free_tier),
  };
}

async function maybeAutoCompleteConsultationDeal(
  sql: Sql<Record<string, unknown>>,
  deps: Deps,
  dealId: string,
): Promise<{ completed: boolean; reason: "max_respondents" | "time_limit" | null }> {
  const deal = await getConsultationDealContext(sql, dealId);
  if (!deal || deal.fulfillment_type !== "consultation") {
    return { completed: false, reason: null };
  }
  if (!["active", "delivered", "funded"].includes(deal.status)) {
    return { completed: deal.status === "completed", reason: null };
  }

  const [responseStats] = await sql`
    SELECT COUNT(*)::int AS response_count
    FROM consultation_responses
    WHERE deal_id = ${dealId}
  `;
  const responseCount = Number(responseStats.response_count ?? 0);

  const startedAt = deal.accepted_at ? new Date(String(deal.accepted_at)) : new Date();
  const deadline = deal.time_limit_minutes
    ? new Date(startedAt.getTime() + deal.time_limit_minutes * 60 * 1000)
    : null;
  const limitReached = deal.max_respondents !== null && responseCount >= deal.max_respondents;
  const timedOut = deadline !== null && Date.now() >= deadline.getTime();

  if (!limitReached && !timedOut) {
    return { completed: false, reason: null };
  }

  await sql.begin(async (txn) => {
    const [locked] = await txn.unsafe(
      `
        SELECT status
        FROM deals
        WHERE id = $1
        FOR UPDATE
      `,
      [dealId],
    );
    if (!locked || !["active", "delivered", "funded"].includes(String(locked.status))) {
      return;
    }

    await txn.unsafe(
      `
        INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status, updated_at, verified_at)
        VALUES ($1, 'consultation', 'verified', NOW(), NOW())
        ON CONFLICT (deal_id) DO UPDATE SET
          fulfillment_type = EXCLUDED.fulfillment_type,
          status = 'verified',
          verified_at = NOW(),
          updated_at = NOW()
      `,
      [dealId],
    );
  });

  const [paymentStats] = await sql`
    SELECT COUNT(*)::int AS funded_intents
    FROM payment_intents pi
    JOIN milestones m ON m.id = pi.milestone_id
    WHERE m.deal_id = ${dealId}
      AND pi.status = 'funded'
  `;
  await deps.completeDealMilestones(dealId, {
    skipPaymentRelease: deal.is_free_tier || Number(paymentStats.funded_intents ?? 0) === 0,
  });
  if (deal.offer_id) {
    await sql`UPDATE offers SET status = 'archived', updated_at = NOW() WHERE id = ${deal.offer_id} AND status = 'active'`;
  }

  const respondentRows = await sql`
    SELECT respondent_agent_id
    FROM consultation_responses
    WHERE deal_id = ${dealId}
  `;
  const respondentIds = respondentRows.map((row) => String(row.respondent_agent_id));

  deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id, ...respondentIds], "deal.consultation_completed", {
    dealId,
    reason: limitReached ? "max_respondents" : "time_limit",
    respondentCount: responseCount,
    maxRespondents: deal.max_respondents,
    timeLimitMinutes: deal.time_limit_minutes,
  });

  return {
    completed: true,
    reason: limitReached ? "max_respondents" : "time_limit",
  };
}

export async function registerRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>, deps: Deps): Promise<void> {
  app.post("/api/deals/propose", async (request, reply) => {
    const idem = idempotencyKey(request.headers as Record<string, unknown>);
    const body = proposeDealSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.buyerAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }
    const [offerOwner] = await sql`SELECT o.agent_id, o.accepted_payment_methods, a.owner_wallet_address FROM offers o JOIN agents a ON a.id = o.agent_id WHERE o.id = ${body.offerId}`;
    if (!offerOwner || offerOwner.agent_id !== body.sellerAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    const [needOwner] = await sql`SELECT n.agent_id, n.accepted_payment_methods, a.owner_wallet_address FROM needs n JOIN agents a ON a.id = n.agent_id WHERE n.id = ${body.needId}`;
    if (!needOwner || needOwner.agent_id !== body.buyerAgentId) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    // payment-methods rolloutc — payability propose gate (Layer 2). The deal will fund
    // on the EFFECTIVE rail = the intersection of what both parties accept AND
    // can actually service. Stripe is gated off (P1d), so today the only fundable
    // rail is usdc → both parties need a valid wallet. This re-checks live at
    // propose (catches capability drift after listing creation, e.g. a wallet
    // cleared via PATCH) and uses the same primitives as the create + fund gates.
    const fundableRails = expandPaymentRails(offerOwner.accepted_payment_methods as string);
    const needRails = expandPaymentRails(needOwner.accepted_payment_methods as string);
    // Intersect the two accepted-rail sets, then drop rails that are not live.
    const liveRails = new Set<"usdc" | "stripe">();
    for (const rail of fundableRails) {
      if (!needRails.has(rail)) continue;            // must be mutually accepted
      if (rail === "stripe" && !STRIPE_RAIL_ENABLED) continue; // stripe not live yet
      liveRails.add(rail);
    }
    if (liveRails.size === 0) {
      return reply.code(400).send({
        error: "Payment rail mismatch",
        detail: `Offer accepts '${offerOwner.accepted_payment_methods}' and need accepts '${needOwner.accepted_payment_methods}', but they share no LIVE settlement rail. Only 'usdc' is live right now (Stripe is coming soon).`,
      });
    }
    // For the usdc rail (the only live one today) both parties need a wallet.
    if (liveRails.has("usdc") && liveRails.size === 1) {
      if (!isPayableWalletAddress(offerOwner.owner_wallet_address)) {
        return reply.code(400).send({ error: "Seller has no valid wallet to settle the 'usdc' rail this deal would fund on." });
      }
      if (!isPayableWalletAddress(needOwner.owner_wallet_address)) {
        return reply.code(400).send({ error: "Buyer has no valid wallet to fund the 'usdc' rail this deal would settle on." });
      }
    }
    if (isZeroPrice(body.negotiatedTotal) && body.milestones.some((milestone) => !isZeroPrice(milestone.amount))) {
      return reply.code(400).send({ error: "Free-tier deals must use zero-value milestones" });
    }

    const result = await createDealProposal(sql, body, {
      idempotencyKey: idem,
      auditAction: "deal.propose",
      auditActorAgentId: body.buyerAgentId,
      negotiationActorAgentId: body.buyerAgentId,
      auditPayload: body,
    });

    deps.notifyAgents(sql, [body.sellerAgentId], "deal.proposed", {
      dealId: (result as Record<string, unknown>).id as string,
      buyerAgentId: body.buyerAgentId,
      sellerAgentId: body.sellerAgentId,
      negotiatedTotal: body.negotiatedTotal,
    });

    return reply.code(201).send(result);
  });

  app.post("/api/deals/:id/counter", async (request, reply) => {
    const { id } = request.params as { id: string };
    const requestBody = request.body && typeof request.body === "object" ? request.body : {};
    const body = counterDealSchema.parse({ ...requestBody, dealId: id });
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`SELECT buyer_agent_id, seller_agent_id FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (body.actorAgentId !== deal.buyer_agent_id && body.actorAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    if (isZeroPrice(body.negotiatedTotal) && body.milestones.some((milestone) => !isZeroPrice(milestone.amount))) {
      return reply.code(400).send({ error: "Free-tier deals must use zero-value milestones" });
    }

    await enforceDealDelta(sql, id, body.negotiatedTotal);
    const isFreeTier = isZeroPrice(body.negotiatedTotal);

    await sql.begin(async (txn) => {
      await txn.unsafe("DELETE FROM milestones WHERE deal_id = $1", [id]);
      for (const milestone of body.milestones) {
        const dueAt = milestone.dueAt ?? null;
        await txn.unsafe(
          `
            INSERT INTO milestones (deal_id, idx, title, amount, acceptance_criteria, due_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          `,
          [id, milestone.idx, milestone.title, milestone.amount, JSON.stringify(milestone.acceptanceCriteria), dueAt]
        );
      }

      await txn.unsafe(
        `
          UPDATE deals
          SET status = 'countered', negotiated_total = $1, is_free_tier = $2, updated_at = NOW()
          WHERE id = $3
        `,
        [body.negotiatedTotal, isFreeTier, id]
      );

      await txn.unsafe(
        `
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'counter', $3::jsonb)
        `,
        [id, body.actorAgentId, JSON.stringify(body)]
      );
    });

    return { ok: true };
  });

  app.post("/api/deals/:id/accept", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ actorAgentId: z.string().uuid() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT d.buyer_agent_id, d.seller_agent_id, d.status,
             d.negotiated_total, d.currency, d.deliverable_hash, d.intent_id,
             COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type,
             buyer.owner_wallet_address AS buyer_wallet,
             seller.owner_wallet_address AS seller_wallet
      FROM deals d
      LEFT JOIN offers o ON o.id = d.offer_id
      LEFT JOIN agents buyer ON buyer.id = d.buyer_agent_id
      LEFT JOIN agents seller ON seller.id = d.seller_agent_id
      WHERE d.id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (!["proposed", "countered"].includes(String(deal.status))) {
      return reply.code(409).send({ error: `Cannot accept deal in status '${deal.status}'` });
    }
    if (body.actorAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }

    try {
      await sql.begin(async (txn) => {
        const [updated] = await txn.unsafe(
          "UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1 AND status IN ('proposed', 'countered') RETURNING id",
          [id]
        );
        if (!updated) {
          const conflictError = new Error(`Deal ${id} status changed concurrently — accept aborted`);
          conflictError.name = "DealAcceptConflictError";
          throw conflictError;
        }
        await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
        await txn.unsafe(
          `
            INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (deal_id) DO NOTHING
          `,
          [id, deal.fulfillment_type],
        );
        await txn.unsafe(
          `
            INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
            VALUES ($1, $2, 'accept', $3::jsonb)
          `,
          [id, body.actorAgentId, JSON.stringify(body)]
        );

        // ── autoclose rollout Change 1: auto-mint a Class-A intent ───────────────
        // When an accepted deal is paid (negotiated_total > 0), settled in USDC,
        // both parties hold a wallet, and the deal carries a deliverable_hash
        // commitment, mint a hash-preimage Class-A intent in 'awaiting_funding'.
        // The relayer daemon broadcasts createIntentWithAuthorization (assigning
        // on_chain_id) once the buyer queues an EIP-3009 funding authorization.
        // Idempotent: skip if the deal already has an intent_id.
        const negotiatedTotal = Number(deal.negotiated_total ?? 0);
        const dealCurrency = String(deal.currency ?? "USDC");
        // Kill switch: when the brake is on, the deal still ACCEPTS normally — it
        // simply stays a manual-settlement deal (no auto-minted intent), exactly
        // as if it carried no deliverable_hash. Failing the whole accept here
        // would halt ordinary commerce, which the brake is not meant to do.
        const intentCreationDisabled = isIntentCreationDisabled();
        const eligible =
          !intentCreationDisabled &&
          !deal.intent_id &&
          negotiatedTotal > 0 &&
          dealCurrency === "USDC" &&
          deal.deliverable_hash != null &&
          deal.buyer_wallet != null &&
          deal.seller_wallet != null;
        if (eligible) {
          const hashHex = ("0x" + Buffer.from(deal.deliverable_hash as Buffer).toString("hex")) as `0x${string}`;
          // The relayer broadcasts createIntentWithAuthorization with these fields,
          // so predicate_params must carry everything the on-chain call needs:
          //  - verifier: the deployed HashPreimagePredicate address (chain config)
          //  - params:   abi.encode(["bytes32"], [commitment]) — the predicate's
          //              verify() strictly decodes exactly one bytes32
          //  - seller_target: the seller's wallet (intent is targeted to them)
          //  - hash: retained for human/debug inspection
          //
          // DEFECT C fix (issue #91) — never silently default to the zero
          // address. It used to be `?? "0x000…0"`, which minted an intent
          // AgentPactEscrowV3.sol:280 will ALWAYS reject (unapproved verifier,
          // checked before funds move) — confirmed live on two intents
          // (3d786cd7-b49a-49f9-8048-61a42736e1c7, dec204fb-f359-489d-adfd-
          // 6de04b8b761b), both expired with no on-chain id, parent deal stuck
          // 'active'. Boot-time refuses to start in production without a real
          // address (index.ts); this is the defense-in-depth twin for any
          // environment that boots anyway (dev/test with NODE_ENV unset) —
          // refuse to MINT, not to accept. Same shape as the intent-creation
          // kill switch: the deal still accepts and degrades to manual
          // settlement instead of accept failing or a dead intent being minted.
          const rawPredicateAddress = process.env.HASH_PREIMAGE_PREDICATE_ADDRESS;
          const isZeroOrMissingPredicate =
            !rawPredicateAddress || rawPredicateAddress.toLowerCase() === ZERO_ADDRESS;
          if (isZeroOrMissingPredicate) {
            app.log.error(
              { dealId: id },
              "gasless auto-mint refused: HASH_PREIMAGE_PREDICATE_ADDRESS is unset or the zero address — " +
                "minting would produce an intent AgentPactEscrowV3 can never fund. Deal accepted normally " +
                "as a manual-settlement deal instead.",
            );
          } else {
            const HASH_PREIMAGE_PREDICATE = rawPredicateAddress as `0x${string}`;
            const encodedParams = encodeAbiParameters([{ type: "bytes32" }], [hashHex]);
            const predicateParams = JSON.stringify({
              hash: hashHex,
              verifier: HASH_PREIMAGE_PREDICATE,
              params: encodedParams,
              seller_target: deal.seller_wallet,
            });
            // Class-A intents auto-expire 7 days out if never funded/claimed.
            //
            // NOTE the `$3::text::jsonb` double cast — do NOT "simplify" it to
            // `$3::jsonb`. `predicateParams` is a JS string from JSON.stringify,
            // and a bare `::jsonb` lets Postgres infer $3's type FROM the cast,
            // which diverges between a direct connection and a transaction-mode
            // pooler (Supavisor / PgBouncer). Declaring text first, then casting,
            // pins the parameter type so both paths agree. This exact double cast
            // ran in production for 6 days before reaching git; our test DB is a
            // DIRECT Postgres, so the pooler-only failure mode is invisible to the
            // suite — the tests passing is not evidence that `::jsonb` is safe.
            // See skill `postgres-transaction-pooler-compat`.
            const [mintedIntent] = await txn.unsafe(
              `
                INSERT INTO intents (
                  on_chain_id, buyer_agent_id, seller_agent_id, seller_target_agent_id,
                  settlement_class, predicate_type, predicate_params,
                  max_price_usdc, status, expires_at, deal_id
                ) VALUES (
                  NULL, $1, $2, $2,
                  'A', 'hash-preimage-v1', $3::text::jsonb,
                  $4, 'awaiting_funding', NOW() + INTERVAL '7 days', $5
                )
                RETURNING id
              `,
              [deal.buyer_agent_id, deal.seller_agent_id, predicateParams, negotiatedTotal, id]
            );
            await txn.unsafe("UPDATE deals SET intent_id = $1 WHERE id = $2", [mintedIntent.id, id]);
          }
        }
      });
    } catch (err) {
      app.log.error({ err, dealId: id }, "deal.accept transaction failed — deal status NOT changed");
      if (err instanceof Error && err.name === "DealAcceptConflictError") {
        return reply.code(409).send({ error: "Deal status changed concurrently; retry with the current deal state" });
      }
      return reply.code(500).send({ error: "Failed to accept deal — please retry" });
    }

    deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.accepted", {
      dealId: id,
      acceptedBy: body.actorAgentId,
      fulfillmentType: deal.fulfillment_type,
      sellerActionRequired: "Provide fulfillment details via /api/deals/:id/fulfillment",
    });

    const [updatedDeal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
    return { ok: true, ...updatedDeal };
  });

  // ── autoclose rollout Change 2: buyer queues an EIP-3009 funding authorization ──
  // The buyer signs USDC's receiveWithAuthorization off-chain and POSTs the
  // signature components here. The relayer daemon's FUND sweep consumes the
  // 'queued' row and broadcasts createIntentWithAuthorization on EscrowV3,
  // pulling the buyer's USDC into escrow with zero buyer-side gas.
  app.post("/api/deals/:id/funding-authorization", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        actorAgentId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        value: z.number().positive(),
        validAfter: z.number().int().nonnegative(),
        validBefore: z.number().int().positive(),
        nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        v: z.number().int(),
        r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      })
      .parse(request.body);
    const actorAgentId = body.actorAgentId ?? body.agentId;
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (actorAgentId && actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`
      SELECT buyer_agent_id, intent_id FROM deals WHERE id = ${id}
    `;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (requesterAgentId !== deal.buyer_agent_id) {
      return reply.code(403).send({ error: "Only the buyer may authorize funding" });
    }
    if (!deal.intent_id) {
      return reply
        .code(409)
        .send({ error: "Deal has no auto-minted intent to fund", code: "NO_INTENT" });
    }

    const [intent] = await sql`
      SELECT max_price_usdc, status FROM intents WHERE id = ${deal.intent_id}
    `;
    if (!intent) {
      return reply.code(409).send({ error: "Linked intent not found", code: "NO_INTENT" });
    }
    if (Number(body.value) !== Number(intent.max_price_usdc)) {
      return reply.code(400).send({
        error: `Authorization value ${body.value} does not match intent price ${intent.max_price_usdc}`,
        code: "VALUE_MISMATCH",
      });
    }

    const nonceBuf = Buffer.from(body.nonce.slice(2), "hex");
    const rBuf = Buffer.from(body.r.slice(2), "hex");
    const sBuf = Buffer.from(body.s.slice(2), "hex");
    await sql`
      INSERT INTO intent_funding_authorizations (
        intent_id, value_usdc, valid_after, valid_before, nonce, sig_v, sig_r, sig_s, status
      ) VALUES (
        ${deal.intent_id}, ${body.value}, ${body.validAfter}, ${body.validBefore},
        ${nonceBuf}, ${body.v}, ${rBuf}, ${sBuf}, 'queued'
      )
      ON CONFLICT (intent_id) DO UPDATE SET
        value_usdc = EXCLUDED.value_usdc, valid_after = EXCLUDED.valid_after,
        valid_before = EXCLUDED.valid_before, nonce = EXCLUDED.nonce,
        sig_v = EXCLUDED.sig_v, sig_r = EXCLUDED.sig_r, sig_s = EXCLUDED.sig_s,
        status = 'queued', created_at = now()
    `;
    return reply.code(201).send({ ok: true, intent_id: deal.intent_id, status: "queued" });
  });

  app.post("/api/deals/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ actorAgentId: z.string().uuid(), reason: z.string().optional() }).parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.actorAgentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const [deal] = await sql`SELECT buyer_agent_id, seller_agent_id, status FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (requesterAgentId !== deal.buyer_agent_id && requesterAgentId !== deal.seller_agent_id) {
      return reply.code(403).send({ error: "Not authorized" });
    }
    if (!["proposed", "countered", "accepted", "active", "funded", "delivered", "disputed"].includes(String(deal.status))) {
      return reply.code(400).send({ error: `Deal status ${deal.status} cannot be cancelled` });
    }

    await sql.begin(async (txn) => {
      await txn.unsafe("UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
      await txn.unsafe("UPDATE milestones SET status = 'cancelled' WHERE deal_id = $1", [id]);
      await txn.unsafe(
        `
          INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
          VALUES ($1, $2, 'cancel', $3::jsonb)
        `,
        [id, body.actorAgentId, JSON.stringify(body)]
      );
    });

    if (deal) {
      deps.notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.cancelled", {
        dealId: id,
        cancelledBy: body.actorAgentId,
        reason: body.reason,
      });
    }

    return { ok: true };
  });

  app.get("/api/deals", async (request) => {
    const q = request.query as {
      buyerAgentId?: string;
      sellerAgentId?: string;
      status?: string;
      limit?: string | number;
      offset?: string | number;
    };
    // DEFECT A fix: limit/offset were parsed off the query but never wired
    // into the SQL — every caller silently got the newest 200 rows regardless
    // of what they asked for, making /api/deals un-auditable beyond the first
    // page. Now actually applied, with a clamp so an unbounded `?limit=` can't
    // turn this into an unpaginated full-table scan. Default (200) unchanged
    // so existing callers who never passed limit see identical behavior.
    const DEFAULT_LIMIT = 200;
    const MAX_LIMIT = 200;
    const requestedLimit = Number(q.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const requestedOffset = Number(q.offset);
    // Issue #104 — clamp the offset too. An unbounded OFFSET lets a public
    // caller request an arbitrarily deep skip (Postgres still walks every
    // skipped row), and a value beyond BIGINT range errors outright. 100k rows
    // at the 200/page cap is 500 pages — far past any legitimate browse.
    const MAX_OFFSET = 100_000;
    const offset =
      Number.isFinite(requestedOffset) && requestedOffset > 0
        ? Math.min(Math.floor(requestedOffset), MAX_OFFSET)
        : 0;

    const rows = await sql`
      SELECT d.*,
        (SELECT json_agg(m ORDER BY m.idx) FROM milestones m WHERE m.deal_id = d.id) AS milestones
      FROM deals d
      WHERE (${q.buyerAgentId ?? null}::uuid IS NULL OR d.buyer_agent_id = ${q.buyerAgentId ?? null}::uuid)
        AND (${q.sellerAgentId ?? null}::uuid IS NULL OR d.seller_agent_id = ${q.sellerAgentId ?? null}::uuid)
        AND (${q.status ?? null}::text IS NULL OR d.status = ${q.status ?? null}::text)
      ORDER BY d.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
    return rows;
  });

  app.get("/api/deals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await maybeAutoCompleteConsultationDeal(sql, deps, id);
    const [deal] = await sql`SELECT * FROM deals WHERE id = ${id}`;
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    const milestones = await sql`SELECT * FROM milestones WHERE deal_id = ${id} ORDER BY idx`;
    const events = await sql`SELECT * FROM negotiation_events WHERE deal_id = ${id} ORDER BY created_at`;
    return { ...deal, milestones, events };
  });

  app.post("/api/deals/:id/consultation-response", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = consultationResponseSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (body.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const deal = await getConsultationDealContext(sql, id);
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (deal.fulfillment_type !== "consultation") {
      return reply.code(400).send({ error: "Deal is not a consultation deal" });
    }
    if (!["active", "delivered", "funded"].includes(deal.status)) {
      return reply.code(400).send({ error: `Deal status ${deal.status} cannot accept consultation responses` });
    }
    if (body.agentId === deal.buyer_agent_id || body.agentId === deal.seller_agent_id) {
      return reply.code(400).send({ error: "Deal participants cannot submit consultation responses" });
    }

    const autoCompleteBeforeInsert = await maybeAutoCompleteConsultationDeal(sql, deps, id);
    if (autoCompleteBeforeInsert.completed) {
      return reply.code(409).send({ error: `Consultation already completed via ${autoCompleteBeforeInsert.reason}` });
    }

    const [existing] = await sql`
      SELECT id
      FROM consultation_responses
      WHERE deal_id = ${id} AND respondent_agent_id = ${body.agentId}
    `;
    if (existing) {
      return reply.code(409).send({ error: "Agent has already submitted a consultation response" });
    }

    const [response] = await sql`
      INSERT INTO consultation_responses (deal_id, respondent_agent_id, response_md)
      VALUES (${id}, ${body.agentId}, ${body.responseMd})
      RETURNING *
    `;

    const autoCompleteAfterInsert = await maybeAutoCompleteConsultationDeal(sql, deps, id);
    const [updatedDeal] = await sql`SELECT status FROM deals WHERE id = ${id}`;

    return reply.code(201).send({
      ...response,
      deal_status: updatedDeal?.status ?? deal.status,
      auto_completed: autoCompleteAfterInsert.completed,
      completion_reason: autoCompleteAfterInsert.reason,
    });
  });

  app.get("/api/deals/:id/consultation-responses", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ agentId: z.string().uuid() }).parse(request.query ?? {});
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;
    if (query.agentId !== requesterAgentId) {
      return reply.code(403).send({ error: "Not authorized to act as this agent" });
    }

    const deal = await getConsultationDealContext(sql, id);
    if (!deal) return reply.code(404).send({ error: "Deal not found" });
    if (deal.fulfillment_type !== "consultation") {
      return reply.code(400).send({ error: "Deal is not a consultation deal" });
    }

    const [requesterResponse] = await sql`
      SELECT id
      FROM consultation_responses
      WHERE deal_id = ${id} AND respondent_agent_id = ${query.agentId}
    `;
    const isParticipant = query.agentId === deal.buyer_agent_id || query.agentId === deal.seller_agent_id;
    if (!isParticipant && !requesterResponse) {
      return reply.code(403).send({ error: "Not authorized for this consultation" });
    }

    const autoComplete = await maybeAutoCompleteConsultationDeal(sql, deps, id);
    const [updatedDeal] = await sql`SELECT status FROM deals WHERE id = ${id}`;
    const responses = await sql`
      SELECT *
      FROM consultation_responses
      WHERE deal_id = ${id}
      ORDER BY created_at ASC
    `;

    return {
      deal_id: id,
      deal_status: updatedDeal?.status ?? deal.status,
      max_respondents: deal.max_respondents,
      time_limit_minutes: deal.time_limit_minutes,
      response_count: responses.length,
      auto_completed: autoComplete.completed,
      completion_reason: autoComplete.reason,
      responses,
    };
  });

  // ── Task decomposition: split a parent deal into N child deals ──────────
  // The orchestrator (buyer of parent) becomes the buyer of each child.
  // Each child carries parent_deal_id; completion of all children resolves
  // the parent milestone.
  app.post("/api/deals/decompose", async (request, reply) => {
    const body = decomposeDealSchema.parse(request.body);
    const requesterAgentId = getRequesterAgentId(request, reply);
    if (!requesterAgentId) return;

    // Verify the parent deal exists and requester is the buyer
    const [parent] = await sql`
      SELECT id, buyer_agent_id, seller_agent_id, status, negotiated_total
      FROM deals WHERE id = ${body.parentDealId}
    `;
    if (!parent) return reply.code(404).send({ error: "Parent deal not found" });
    if (parent.buyer_agent_id !== requesterAgentId) {
      return reply.code(403).send({ error: "Only the parent deal buyer can decompose" });
    }
    if (!["active", "proposed"].includes(parent.status)) {
      return reply.code(400).send({ error: `Parent deal status '${parent.status}' is not decomposable (must be active or proposed)` });
    }

    // Validate that child totals don't exceed parent budget
    const childTotal = body.children.reduce((sum, c) => sum + c.negotiatedTotal, 0);
    if (childTotal > Number(parent.negotiated_total)) {
      return reply.code(400).send({
        error: `Child total (${childTotal}) exceeds parent negotiated_total (${parent.negotiated_total})`,
        childTotal,
        parentTotal: Number(parent.negotiated_total),
      });
    }

    const childDealIds: string[] = [];
    const idem = idempotencyKey(request.headers as Record<string, unknown>);

    for (const child of body.children) {
      const childProposal = {
        buyerAgentId: requesterAgentId,
        sellerAgentId: child.sellerAgentId,
        offerId: child.offerId,
        needId: child.needId,
        negotiatedTotal: child.negotiatedTotal,
        maxPriceDeltaPct: body.maxPriceDeltaPct,
        milestones: [{
          idx: 1,
          title: child.title,
          amount: child.negotiatedTotal,
          acceptanceCriteria: child.acceptanceCriteria ?? ["Deliver as specified"],
        }],
        acceptanceTimeoutDays: body.acceptanceTimeoutDays,
        parentDealId: body.parentDealId,
      };
      const childDeal = await createDealProposal(sql, childProposal as any, {
        idempotencyKey: idem || "decompose-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        auditAction: "deal.decompose_child",
        auditActorAgentId: requesterAgentId,
        negotiationActorAgentId: requesterAgentId,
        auditPayload: { parentDealId: body.parentDealId, title: child.title, amount: child.negotiatedTotal },
      });
      childDealIds.push(childDeal.id as string);
    }

    // Link children back into the parent
    await sql`
      UPDATE deals SET child_deal_ids = ${childDealIds}::uuid[]
      WHERE id = ${body.parentDealId}
    `;

    await audit(sql, requesterAgentId, "deal.decompose", "deal", body.parentDealId, idem, {
      childCount: childDealIds.length,
      childTotal,
    });

    return reply.code(201).send({
      parentDealId: body.parentDealId,
      childDealIds,
      childCount: childDealIds.length,
      childTotal,
    });
  });
}
