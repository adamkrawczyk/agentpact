// apps/relayer-daemon/src/cctp-sweeper.ts — M1 (lane m1-relay)
//
// Moves cross-chain USDC transfers (cctp_transfers) through their states.
// The relayer NEVER holds user funds: every movement happens inside the
// AgentPactCctpGateway on Base; the relayer only broadcasts calls anyone may
// make (relayDeposit / refund / claimAndForward) and records what happened.
//
// DEPOSIT  (buyer burned on Ethereum/Solana → gateway on Base)
//   submitted ─Iris poll─▶ attestation_pending ─attested─▶ attested
//     ─gateway.relayDeposit─▶ relayed ─binding verifier (m1-api)─▶ bound
//   A gateway CctpDepositRejected (business-invalid deposit, refunded in the
//   same tx) ends the deposit as `refunded` and opens a refund row to track
//   the burn back.
//
// REFUND / PAYOUT  (gateway on Base → buyer/seller chain, via Circle's
//   Forwarding Service, so nobody has to relay the destination mint)
//   A bound deposit whose intent expired gets a `refund` row; one whose
//   intent has a seller reveal and a non-Base payout route gets a `payout`
//   row. The row is INSERTED BEFORE the broadcast (unique per deposit, 057),
//   then: submitted ─gateway.refund / claimAndForward─▶ submitted(+tx)
//     ─receipt─▶ attestation_pending ─Iris complete─▶ forwarded
//     ─forwardTxHash─▶ completed
//
// IDEMPOTENCY — a transfer is never broadcast twice:
//   - ticks never overlap (index.ts safeRun guard) AND each broadcast takes a
//     compare-and-set lease on (id, status) first;
//   - the tx hash is persisted the moment the node returns it; a row with a
//     hash is only ever re-checked by receipt, never re-sent;
//   - before relaying, MessageTransmitterV2.usedNonces(nonce) is read: a
//     message someone already received is RECONCILED from the gateway's
//     events, not retried until the revert budget runs out.
//
// WATCHDOGS → status `stuck` + one alert per episode (alerted_at):
//   attestation_timeout · relay_failed (reverts/errors past max attempts)
//   mint_without_bound_intent (relayed, binding check never confirms)
//   nonce_used_unreconciled · execute_failed · forward_timeout
//   Stuck count + oldest age are returned every tick for /health.

import type { Hex } from "viem";
import {
  CCTP_DOMAIN,
  IrisRateLimitedError,
  decodeCctpMessage,
  decodeHookData,
  evmAddressToBytes32,
  messageHash as hashMessage,
  type IrisMessage,
  type IrisMessagesResult,
} from "@agentpact/payouts";
import type { CctpBindingVerifier } from "./cctp-binding.js";
import type { CctpStore, CctpTransfer, TransferPatch } from "./cctp-store.js";

// ── Chain + Iris seams (mocked in tests, viem/IrisClient in production) ────

export type GatewayEvent =
  | { name: "CctpDepositBound"; intentId: Hex; dealRef: Hex; sourceDomain: number; amount: bigint; feeExecuted: bigint; nonce: Hex }
  | { name: "CctpDepositRejected"; messageHash: Hex; reason: string }
  | { name: "CctpRefundSent"; intentId: Hex; destinationDomain: number; recipient: Hex; amount: bigint; maxFee: bigint }
  | { name: "CctpPayoutSent"; intentId: Hex; domain: number; recipient: Hex; amount: bigint; maxFee: bigint };

export interface GatewayReceipt {
  status: "success" | "reverted";
  /** Gateway events only, decoded from logs emitted BY the gateway address. */
  events: GatewayEvent[];
}

export interface CctpChainClient {
  /** MessageTransmitterV2.usedNonces(nonce) == 1 on Base. */
  isNonceUsed(nonce: Hex): Promise<boolean>;
  relayDeposit(message: Hex, attestation: Hex): Promise<Hex>;
  refund(onchainIntentId: Hex, maxFee: bigint, minFinalityThreshold: number): Promise<Hex>;
  claimAndForward(onchainIntentId: Hex, ciphertext: Hex, witness: Hex, maxFee: bigint, minFinalityThreshold: number): Promise<Hex>;
  /** null = not mined (yet). */
  getReceipt(txHash: Hex): Promise<GatewayReceipt | null>;
  /** Find the gateway tx that consumed this message (bound or rejected). */
  findDepositOutcome(nonce: Hex, messageHash: Hex): Promise<{ txHash: Hex; event: GatewayEvent } | null>;
  /** Find an already-mined CctpRefundSent / CctpPayoutSent for this intent. */
  findSettleOutcome(direction: "refund" | "payout", onchainIntentId: Hex): Promise<{ txHash: Hex; event: GatewayEvent } | null>;
}

export interface CctpIris {
  getMessages(sourceDomain: number, txHash: Hex): Promise<IrisMessagesResult>;
}

/** maxFee + finality for a gateway → Forwarding Service burn. */
export type ForwardFeeQuoter = (amount: bigint, destinationDomain: number) => Promise<{ maxFee: bigint; minFinalityThreshold: number }>;

export type CctpAlertKind =
  | "attestation_timeout" | "relay_failed" | "mint_without_bound_intent" | "nonce_used_unreconciled"
  | "execute_failed" | "forward_timeout" | "burn_not_for_gateway";

export interface CctpAlert {
  kind: CctpAlertKind;
  transferId: string;
  direction: CctpTransfer["direction"];
  dealId: string | null;
  reason: string;
  attempts: number;
}

export interface CctpSweeperConfig {
  gateway: Hex;
  maxPerTick: number;
  /** A deposit with no attestation this long after submission is stuck. */
  attestationTimeoutMs: number;
  /** A relayed deposit the binding check has not confirmed this long is stuck. */
  bindTimeoutMs: number;
  /** A refund/payout burn not forwarded this long after attestation is stuck. */
  forwardTimeoutMs: number;
  /** Broadcast attempts (relay / refund / payout) before `stuck`. */
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** How long a broadcast tx may stay unmined before it is treated as dropped. */
  txDropAfterMs: number;
  /** In-tick wait for a fresh tx's receipt (poll every receiptPollMs). */
  receiptWaitMs: number;
  receiptPollMs: number;
  /** Refund only this long after the intent's expiresAt (clock skew margin). */
  refundGraceMs: number;
  leaseMs: number;
}

export interface CctpSweeperDeps {
  store: CctpStore;
  chain: CctpChainClient;
  iris: CctpIris;
  verifyBinding: CctpBindingVerifier;
  quoteForwardFee: ForwardFeeQuoter;
  alert: (a: CctpAlert) => void;
  config: CctpSweeperConfig;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CctpSweepResult {
  runId: string | null;
  scanned: number;
  acted: number;
  held: number;
  failed: number;
  spawned: number;
  stuck: { count: number; oldestStuckAgeMs: number | null };
}

const BASE_DOMAIN = CCTP_DOMAIN.base;

type Outcome = "acted" | "held" | "failed";

export async function runCctpSweep(deps: CctpSweeperDeps): Promise<CctpSweepResult> {
  const now = deps.now ?? (() => new Date());
  const result: CctpSweepResult = {
    runId: null, scanned: 0, acted: 0, held: 0, failed: 0, spawned: 0,
    stuck: { count: 0, oldestStuckAgeMs: null },
  };
  result.runId = await deps.store.openRun(now());
  const ctx = new Tick(deps, now);

  try {
    result.spawned = await ctx.spawnChildren();
    const rows = await deps.store.due(now(), deps.config.maxPerTick);
    result.scanned = rows.length;
    for (const row of rows) {
      let outcome: Outcome;
      try {
        outcome = await ctx.step(row);
      } catch (err) {
        // A bug or an unclassified error on ONE row must not strand the rest.
        outcome = "failed";
        await ctx.retryOrStick(row, row.direction === "deposit" ? "relay_failed" : "execute_failed", errMsg(err)).catch(() => {});
      }
      result[outcome]++;
    }
    const s = await deps.store.stuckSummary();
    result.stuck = { count: s.count, oldestStuckAgeMs: s.oldestStuckAt ? now().getTime() - s.oldestStuckAt.getTime() : null };
    await deps.store.finishRun(result.runId, now(), result);
    return result;
  } catch (err) {
    await deps.store.finishRun(result.runId, now(), result, errMsg(err)).catch(() => {});
    throw err;
  }
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

class Tick {
  private irisBlockedUntil = 0;
  private readonly gateway32: Hex;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly d: CctpSweeperDeps, private readonly now: () => Date) {
    this.gateway32 = evmAddressToBytes32(d.config.gateway);
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = d.random ?? Math.random;
  }

  private get cfg() {
    return this.d.config;
  }

  // ── child spawning ──────────────────────────────────────────────────────

  async spawnChildren(): Promise<number> {
    let n = 0;
    const cutoff = new Date(this.now().getTime() - this.cfg.refundGraceMs);
    for (const dep of await this.d.store.refundCandidates(cutoff, this.cfg.maxPerTick)) {
      const child = await this.d.store.insertChild(dep, {
        direction: "refund",
        sourceDomain: BASE_DOMAIN,
        destinationDomain: dep.sourceDomain,
        amount: netOf(dep),
        recipient: dep.refundRecipient,
      }, this.now());
      if (child) n++;
    }
    for (const dep of await this.d.store.payoutCandidates(this.cfg.maxPerTick)) {
      const child = await this.d.store.insertChild(dep, {
        direction: "payout",
        sourceDomain: BASE_DOMAIN,
        destinationDomain: dep.payoutDomain as number,
        amount: netOf(dep),
        recipient: dep.payoutRecipient,
      }, this.now());
      if (child) n++;
    }
    return n;
  }

  // ── dispatch ────────────────────────────────────────────────────────────

  async step(row: CctpTransfer): Promise<Outcome> {
    if (row.direction === "deposit") {
      switch (row.status) {
        case "submitted":
        case "attestation_pending":
          return this.pollAttestation(row);
        case "attested":
          return this.relay(row);
        case "relayed":
          return this.bind(row);
        default:
          return "held";
      }
    }
    switch (row.status) {
      case "submitted":
        return this.execute(row);
      case "attestation_pending":
      case "forwarded":
        return this.pollAttestation(row);
      default:
        return "held";
    }
  }

  // ── Iris ────────────────────────────────────────────────────────────────

  private async pollAttestation(row: CctpTransfer): Promise<Outcome> {
    const t = this.now();
    const since = row.direction === "deposit" ? row.createdAt : row.statusChangedAt;
    const timeout = row.status === "forwarded" ? this.cfg.forwardTimeoutMs : this.cfg.attestationTimeoutMs;
    if (t.getTime() - since.getTime() > timeout) {
      await this.stick(row, row.status === "forwarded" ? "forward_timeout" : "attestation_timeout",
        `no ${row.status === "forwarded" ? "forwarded mint" : "attestation"} after ${Math.round((t.getTime() - since.getTime()) / 60_000)} min`);
      return "failed";
    }
    if (!row.sourceTxHash) {
      await this.stick(row, "attestation_timeout", "row has no source tx hash to look up");
      return "failed";
    }
    if (t.getTime() < this.irisBlockedUntil) {
      await this.d.store.update(row.id, row.status, { nextAttemptAt: new Date(this.irisBlockedUntil) }, t);
      return "held";
    }

    let res: IrisMessagesResult;
    try {
      res = await this.d.iris.getMessages(row.sourceDomain, row.sourceTxHash);
    } catch (err) {
      if (err instanceof IrisRateLimitedError) {
        // Iris locks the caller out for minutes: stop asking for the rest of
        // this tick, push this row past the lockout.
        this.irisBlockedUntil = t.getTime() + err.retryAfterMs;
        await this.d.store.update(row.id, row.status, { nextAttemptAt: new Date(this.irisBlockedUntil), lastError: err.message }, t);
        return "held";
      }
      await this.d.store.update(row.id, row.status, { lastError: `iris: ${errMsg(err)}` }, t);
      return "held";
    }

    const msg = res.kind === "found" ? this.pickMessage(row, res.messages) : null;
    if (msg === "foreign") {
      await this.stick(row, "burn_not_for_gateway", "no CCTP message in this tx is addressed to the gateway for this transfer", "failed");
      return "failed";
    }
    if (!msg || msg.status !== "complete" || !msg.attestation || !msg.message) {
      const next = row.status === "submitted" ? "attestation_pending" : row.status;
      await this.d.store.update(row.id, row.status, { status: next, lastError: msg?.delayReason ?? null }, t);
      return "held";
    }

    const decoded = decodeCctpMessage(msg.message);
    if (row.direction === "deposit") {
      // hookData the gateway cannot use is STILL relayed: the gateway refunds
      // it (CctpDepositRejected). Not relaying would strand the buyer's USDC —
      // a message locked to the gateway as destinationCaller has no other way in.
      let hook = null;
      try {
        hook = decodeHookData(decoded.burn.hookData);
      } catch { /* left null; the gateway decides */ }
      const patch: TransferPatch = {
        status: "attested",
        message: msg.message,
        attestation: msg.attestation,
        nonce: decoded.nonce,
        messageHash: hashMessage(msg.message),
        feeExecuted: decoded.burn.feeExecuted,
        maxFee: decoded.burn.maxFee,
        payoutDomain: hook?.payoutDomain ?? null,
        payoutRecipient: hook?.payoutRecipient ?? null,
        refundRecipient: hook?.refundRecipient ?? null,
        intentExpiresAt: hook ? new Date(Number(hook.expiresAt) * 1000) : null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      };
      await this.d.store.update(row.id, row.status, patch, t);
      return "acted";
    }

    // refund / payout burn from the gateway: the Forwarding Service mints.
    const patch: TransferPatch = {
      nonce: decoded.nonce,
      messageHash: hashMessage(msg.message),
      feeExecuted: decoded.burn.feeExecuted,
      lastError: null,
    };
    if (msg.forwardTxHash) {
      await this.d.store.update(row.id, row.status, { ...patch, status: "completed", destinationTxHash: msg.forwardTxHash as Hex }, t);
      return "acted";
    }
    if (row.status !== "forwarded") {
      await this.d.store.update(row.id, row.status, { ...patch, status: "forwarded" }, t);
      return "acted";
    }
    return "held";
  }

  /**
   * The message in this tx that belongs to this row. null = nothing usable
   * yet (pending); "foreign" = the tx has messages and none is ours.
   */
  private pickMessage(row: CctpTransfer, messages: IrisMessage[]): IrisMessage | "foreign" | null {
    let pending = false;
    const ours: Array<{ m: IrisMessage; hookDealRef: Hex | null }> = [];
    for (const m of messages) {
      if (!m.message) {
        pending = true;
        continue;
      }
      let dm;
      try {
        dm = decodeCctpMessage(m.message);
      } catch {
        continue;
      }
      if (row.direction !== "deposit") {
        if (dm.sourceDomain === BASE_DOMAIN && dm.destinationDomain === row.destinationDomain && eqHex(dm.burn.messageSender, this.gateway32)) {
          return m;
        }
        continue;
      }
      if (dm.destinationDomain !== BASE_DOMAIN || dm.sourceDomain !== row.sourceDomain) continue;
      if (!eqHex(dm.burn.mintRecipient, this.gateway32)) continue;
      // destinationCaller must be the gateway (or open), else something other
      // than relayDeposit could receive it.
      if (!eqHex(dm.destinationCaller, this.gateway32) && !/^0x0{64}$/.test(dm.destinationCaller)) continue;
      let hookDealRef: Hex | null = null;
      try {
        hookDealRef = decodeHookData(dm.burn.hookData).dealRef;
      } catch { /* relayed anyway — see pollAttestation */ }
      ours.push({ m, hookDealRef });
    }
    if (row.direction === "deposit" && ours.length > 0) {
      // Prefer the burn bound to this row's deal. Otherwise relay what is
      // addressed to the gateway: the binding check then refuses to call it
      // funded and the row surfaces as mint_without_bound_intent.
      return ours.find((o) => row.dealRef && eqHex(o.hookDealRef, row.dealRef))?.m ?? ours[0].m;
    }
    return pending || messages.length === 0 ? null : "foreign";
  }

  // ── deposit: relay ──────────────────────────────────────────────────────

  private async relay(row: CctpTransfer): Promise<Outcome> {
    const t = this.now();
    if (!row.message || !row.attestation || !row.nonce || !row.messageHash) {
      await this.stick(row, "relay_failed", "attested row is missing message/attestation/nonce");
      return "failed";
    }

    // A tx we already sent: only ever re-check it, never re-send blindly.
    if (row.destinationTxHash) {
      const receipt = await this.d.chain.getReceipt(row.destinationTxHash);
      if (!receipt) {
        if (t.getTime() - row.updatedAt.getTime() < this.cfg.txDropAfterMs) return "held";
        // Unmined for too long: forget the hash; the next attempt re-checks
        // usedNonces first, so a late-mined original is reconciled, not doubled.
        return this.retryOrStick(row, "relay_failed", `relay tx ${row.destinationTxHash} not mined; treating as dropped`, { destinationTxHash: null }, false);
      }
      return this.onRelayReceipt(row, row.destinationTxHash, receipt);
    }

    if (await this.d.chain.isNonceUsed(row.nonce)) return this.reconcileUsedNonce(row);

    if (!(await this.d.store.lease(row.id, "attested", row.attempts, t, new Date(t.getTime() + this.cfg.leaseMs)))) return "held";
    let txHash: Hex;
    try {
      txHash = await this.d.chain.relayDeposit(row.message, row.attestation);
    } catch (err) {
      return this.retryOrStick(row, "relay_failed", `relayDeposit: ${errMsg(err)}`);
    }
    // Persist the hash BEFORE waiting on it.
    await this.d.store.update(row.id, "attested", { destinationTxHash: txHash, attempts: row.attempts + 1, nextAttemptAt: null }, this.now());
    const fresh = { ...row, destinationTxHash: txHash, attempts: row.attempts + 1 };
    const receipt = await this.waitReceipt(txHash);
    if (!receipt) return "held";
    return this.onRelayReceipt(fresh, txHash, receipt);
  }

  private async onRelayReceipt(row: CctpTransfer, txHash: Hex, receipt: GatewayReceipt): Promise<Outcome> {
    const t = this.now();
    if (receipt.status === "reverted") {
      // The revert may be "nonce already used" (someone relayed it first).
      if (row.nonce && (await this.d.chain.isNonceUsed(row.nonce))) return this.reconcileUsedNonce({ ...row, destinationTxHash: null });
      return this.retryOrStick(row, "relay_failed", `relayDeposit tx ${txHash} reverted`, { destinationTxHash: null }, false);
    }
    return this.applyDepositEvent(row, txHash, receipt.events, t);
  }

  private async applyDepositEvent(row: CctpTransfer, txHash: Hex, events: GatewayEvent[], t: Date): Promise<Outcome> {
    const bound = events.find((e): e is Extract<GatewayEvent, { name: "CctpDepositBound" }> =>
      e.name === "CctpDepositBound" && eqHex(e.nonce, row.nonce));
    if (bound) {
      await this.d.store.update(row.id, "attested", {
        status: "relayed",
        destinationTxHash: txHash,
        onchainIntentId: bound.intentId,
        feeExecuted: bound.feeExecuted,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      }, t);
      return "acted";
    }
    const rejected = events.find((e): e is Extract<GatewayEvent, { name: "CctpDepositRejected" }> =>
      e.name === "CctpDepositRejected" && eqHex(e.messageHash, row.messageHash));
    if (rejected) {
      // Business-invalid deposit: the gateway burned it back in the same tx.
      // Not a fault of the relayer — no alert; track the return leg.
      const moved = await this.d.store.update(row.id, "attested", {
        status: "refunded",
        destinationTxHash: txHash,
        lastError: `gateway rejected deposit: ${rejected.reason}`,
      }, t);
      if (moved) {
        await this.d.store.insertChild(row, {
          direction: "refund",
          sourceDomain: BASE_DOMAIN,
          destinationDomain: row.sourceDomain,
          amount: netOf(row),
          recipient: row.refundRecipient,
          sourceTxHash: txHash,
          status: "attestation_pending",
        }, t);
      }
      return "acted";
    }
    await this.stick(row, "mint_without_bound_intent", `relay tx ${txHash} succeeded but emitted neither CctpDepositBound nor CctpDepositRejected for this message`);
    return "failed";
  }

  private async reconcileUsedNonce(row: CctpTransfer): Promise<Outcome> {
    const found = await this.d.chain.findDepositOutcome(row.nonce as Hex, row.messageHash as Hex);
    if (!found) {
      await this.stick(row, "nonce_used_unreconciled", `message nonce ${row.nonce} already used on Base but no gateway event found`);
      return "failed";
    }
    return this.applyDepositEvent(row, found.txHash, [found.event], this.now());
  }

  // ── deposit: bind ───────────────────────────────────────────────────────

  private async bind(row: CctpTransfer): Promise<Outcome> {
    const t = this.now();
    const res = await this.d.verifyBinding({
      transferId: row.id,
      dealId: row.dealId,
      dealRef: row.dealRef,
      sourceDomain: row.sourceDomain,
      relayTxHash: row.destinationTxHash as Hex,
      messageHash: row.messageHash as Hex,
      nonce: row.nonce as Hex,
    });
    if (res.bound) {
      await this.d.store.update(row.id, "relayed", {
        status: "bound",
        intentId: res.intentId ?? row.intentId,
        onchainIntentId: res.onchainIntentId,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      }, t);
      return "acted";
    }
    const age = t.getTime() - row.statusChangedAt.getTime();
    if (!res.retryable || age > this.cfg.bindTimeoutMs) {
      await this.stick(row, "mint_without_bound_intent", `minted into the gateway but not bound: ${res.reason}`);
      return "failed";
    }
    return this.retryOrStick(row, "mint_without_bound_intent", `binding: ${res.reason}`);
  }

  // ── refund / payout: execute ────────────────────────────────────────────

  private async execute(row: CctpTransfer): Promise<Outcome> {
    const t = this.now();
    if (!row.onchainIntentId) {
      await this.stick(row, "execute_failed", "no on-chain intent id to settle");
      return "failed";
    }
    if (row.sourceTxHash) {
      const receipt = await this.d.chain.getReceipt(row.sourceTxHash);
      if (!receipt) {
        if (t.getTime() - row.updatedAt.getTime() < this.cfg.txDropAfterMs) return "held";
        return this.retryOrStick(row, "execute_failed", `${row.direction} tx ${row.sourceTxHash} not mined; treating as dropped`, { sourceTxHash: null }, false);
      }
      return this.onExecuteReceipt(row, row.sourceTxHash, receipt);
    }

    // A previous attempt may have landed even though we never saw its hash
    // (crash between broadcast and persist, or a "dropped" tx mined late).
    // The gateway emits one Sent event per intent — look before re-sending.
    if (row.attempts > 0) {
      const prior = await this.d.chain.findSettleOutcome(row.direction as "refund" | "payout", row.onchainIntentId);
      if (prior) return this.onExecuteReceipt(row, prior.txHash, { status: "success", events: [prior.event] });
    }

    let reveal = null;
    if (row.direction === "payout") {
      reveal = row.intentId ? await this.d.store.reveal(row.intentId) : null;
      if (!reveal) {
        await this.stick(row, "execute_failed", "payout row has no seller reveal to claim with");
        return "failed";
      }
    }
    let fee;
    try {
      fee = await this.d.quoteForwardFee(row.amount, row.destinationDomain);
    } catch (err) {
      return this.retryOrStick(row, "execute_failed", `fee quote: ${errMsg(err)}`);
    }

    if (!(await this.d.store.lease(row.id, "submitted", row.attempts, t, new Date(t.getTime() + this.cfg.leaseMs)))) return "held";
    let txHash: Hex;
    try {
      txHash = row.direction === "refund"
        ? await this.d.chain.refund(row.onchainIntentId, fee.maxFee, fee.minFinalityThreshold)
        : await this.d.chain.claimAndForward(row.onchainIntentId, reveal!.ciphertext, reveal!.witness, fee.maxFee, fee.minFinalityThreshold);
    } catch (err) {
      return this.retryOrStick(row, "execute_failed", `${row.direction}: ${errMsg(err)}`);
    }
    await this.d.store.update(row.id, "submitted", { sourceTxHash: txHash, maxFee: fee.maxFee, attempts: row.attempts + 1, nextAttemptAt: null }, this.now());
    const receipt = await this.waitReceipt(txHash);
    if (!receipt) return "held";
    return this.onExecuteReceipt({ ...row, sourceTxHash: txHash, attempts: row.attempts + 1 }, txHash, receipt);
  }

  private async onExecuteReceipt(row: CctpTransfer, txHash: Hex, receipt: GatewayReceipt): Promise<Outcome> {
    const t = this.now();
    if (receipt.status === "reverted") {
      const prior = await this.d.chain.findSettleOutcome(row.direction as "refund" | "payout", row.onchainIntentId as Hex);
      if (prior) return this.onExecuteReceipt(row, prior.txHash, { status: "success", events: [prior.event] });
      return this.retryOrStick(row, "execute_failed", `${row.direction} tx ${txHash} reverted`, { sourceTxHash: null }, false);
    }
    const want = row.direction === "refund" ? "CctpRefundSent" : "CctpPayoutSent";
    const ev = receipt.events.find((e) => e.name === want && eqHex((e as { intentId: Hex }).intentId, row.onchainIntentId));
    if (!ev || (ev.name !== "CctpRefundSent" && ev.name !== "CctpPayoutSent")) {
      await this.stick(row, "execute_failed", `${row.direction} tx ${txHash} succeeded without ${want} for this intent`);
      return "failed";
    }
    await this.d.store.update(row.id, "submitted", {
      status: "attestation_pending",
      sourceTxHash: txHash,
      amount: ev.amount,
      maxFee: ev.maxFee,
      attempts: 0,
      lastError: null,
    }, t);
    if (row.parentTransferId) {
      await this.d.store.update(row.parentTransferId, "bound", { status: row.direction === "refund" ? "refunded" : "completed" }, t);
    }
    if (row.direction === "payout" && row.intentId) await this.d.store.markIntentClaimed(row.intentId, txHash);
    return "acted";
  }

  // ── shared ──────────────────────────────────────────────────────────────

  private async waitReceipt(txHash: Hex): Promise<GatewayReceipt | null> {
    const deadline = Date.now() + this.cfg.receiptWaitMs;
    for (;;) {
      const r = await this.d.chain.getReceipt(txHash);
      if (r || Date.now() >= deadline) return r;
      await this.sleep(this.cfg.receiptPollMs);
    }
  }

  /**
   * Count a failed attempt; back off; at maxAttempts the row is stuck.
   * `countAttempt=false` when the attempt was already counted at broadcast.
   */
  async retryOrStick(row: CctpTransfer, kind: CctpAlertKind, reason: string, extra: TransferPatch = {}, countAttempt = true): Promise<Outcome> {
    const attempts = countAttempt ? row.attempts + 1 : row.attempts;
    if (attempts >= this.cfg.maxAttempts) {
      await this.stick({ ...row, attempts }, kind, `${reason} (after ${attempts} attempts)`, "stuck", extra);
      return "failed";
    }
    const delay = Math.min(this.cfg.retryMaxMs, this.cfg.retryBaseMs * 2 ** (attempts - 1));
    const jittered = Math.round(delay / 2 + this.random() * (delay / 2));
    const t = this.now();
    await this.d.store.update(row.id, row.status, {
      ...extra,
      attempts,
      lastError: reason.slice(0, 500),
      nextAttemptAt: new Date(t.getTime() + jittered),
    }, t);
    return "failed";
  }

  /** Transition to stuck (or failed) and fire exactly one alert for it. */
  private async stick(row: CctpTransfer, kind: CctpAlertKind, reason: string, status: "stuck" | "failed" = "stuck", extra: TransferPatch = {}): Promise<void> {
    const t = this.now();
    const moved = await this.d.store.update(row.id, row.status, {
      ...extra,
      status,
      attempts: row.attempts,
      stuckReason: `${kind}: ${reason}`.slice(0, 500),
      stuckAt: t,
      lastError: reason.slice(0, 500),
      alertedAt: t,
    }, t);
    if (!moved) return;
    this.d.alert({ kind, transferId: row.id, direction: row.direction, dealId: row.dealId, reason, attempts: row.attempts });
  }
}

function eqHex(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** What the gateway escrowed for a deposit: amount − feeExecuted. */
function netOf(dep: CctpTransfer): bigint {
  const net = dep.amount - (dep.feeExecuted ?? 0n);
  return net > 0n ? net : dep.amount;
}
