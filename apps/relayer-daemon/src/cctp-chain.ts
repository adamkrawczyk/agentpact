// apps/relayer-daemon/src/cctp-chain.ts — M1 (lane m1-relay)
//
// viem implementation of CctpChainClient on Base. Broadcast-only: the relayer
// key pays gas and holds no USDC; every call it makes is one anyone may make.
//
// Events are decoded with parseEventLogs over logs emitted BY the gateway
// address only — a look-alike event from another contract in the same tx
// must never advance a transfer (the PR #97 lesson).

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { CCTP_GATEWAY_ABI, MESSAGE_TRANSMITTER_V2_ABI, NONCE_USED } from "./cctp-gateway-abi.js";
import type { CctpChainClient, GatewayEvent, GatewayReceipt } from "./cctp-sweeper.js";

export interface ViemCctpChainConfig {
  rpcUrl: string;
  privateKey: Hex;
  network: "mainnet" | "testnet";
  gateway: Address;
  messageTransmitter: Address;
  /** How far back findDepositOutcome / findSettleOutcome scan. */
  logLookbackBlocks: bigint;
  /** getLogs range per request (public RPCs cap this). */
  logChunkBlocks: bigint;
}

type DecodedLog = ReturnType<typeof parseEventLogs<typeof CCTP_GATEWAY_ABI>>[number];

export function toGatewayEvent(l: DecodedLog): GatewayEvent | null {
  switch (l.eventName) {
    case "CctpDepositBound":
      return {
        name: l.eventName,
        intentId: l.args.intentId,
        dealRef: l.args.dealRef,
        sourceDomain: Number(l.args.sourceDomain),
        amount: l.args.amount,
        feeExecuted: l.args.feeExecuted,
        nonce: l.args.nonce,
      };
    case "CctpDepositRejected":
      return { name: l.eventName, messageHash: l.args.messageHash, reason: l.args.reason };
    case "CctpRefundSent":
      return {
        name: l.eventName,
        intentId: l.args.intentId,
        destinationDomain: Number(l.args.destinationDomain),
        recipient: l.args.recipient,
        amount: l.args.amount,
        maxFee: l.args.maxFee,
      };
    case "CctpPayoutSent":
      return {
        name: l.eventName,
        intentId: l.args.intentId,
        domain: Number(l.args.domain),
        recipient: l.args.recipient,
        amount: l.args.amount,
        maxFee: l.args.maxFee,
      };
    default:
      return null;
  }
}

/** Decode gateway events from raw logs, keeping only those the gateway emitted. */
export function decodeGatewayLogs(logs: Log[], gateway: Address): Array<{ txHash: Hex; event: GatewayEvent }> {
  const own = logs.filter((l) => l.address.toLowerCase() === gateway.toLowerCase());
  const out: Array<{ txHash: Hex; event: GatewayEvent }> = [];
  for (const l of parseEventLogs({ abi: CCTP_GATEWAY_ABI, logs: own, strict: true })) {
    const ev = toGatewayEvent(l);
    if (ev && l.transactionHash) out.push({ txHash: l.transactionHash, event: ev });
  }
  return out;
}

export function createViemCctpChain(cfg: ViemCctpChainConfig): CctpChainClient & { chainId: number } {
  const chain = cfg.network === "mainnet" ? base : baseSepolia;
  const transport = http(cfg.rpcUrl, { timeout: 30_000 });
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account: privateKeyToAccount(cfg.privateKey), chain, transport });

  async function scan(match: (e: GatewayEvent) => boolean): Promise<{ txHash: Hex; event: GatewayEvent } | null> {
    const latest = await publicClient.getBlockNumber();
    const floor = latest > cfg.logLookbackBlocks ? latest - cfg.logLookbackBlocks : 0n;
    // Newest first: a reconcile is almost always about a recent tx.
    for (let to = latest; to >= floor; ) {
      const from = to - cfg.logChunkBlocks + 1n > floor ? to - cfg.logChunkBlocks + 1n : floor;
      const logs = await publicClient.getLogs({ address: cfg.gateway, fromBlock: from, toBlock: to });
      const hit = decodeGatewayLogs(logs, cfg.gateway).find((x) => match(x.event));
      if (hit) return hit;
      if (from === floor) break;
      to = from - 1n;
    }
    return null;
  }

  return {
    chainId: chain.id,

    async isNonceUsed(nonce) {
      const v = await publicClient.readContract({
        address: cfg.messageTransmitter,
        abi: MESSAGE_TRANSMITTER_V2_ABI,
        functionName: "usedNonces",
        args: [nonce],
      });
      return v === NONCE_USED;
    },

    async relayDeposit(message, attestation) {
      return wallet.writeContract({ address: cfg.gateway, abi: CCTP_GATEWAY_ABI, functionName: "relayDeposit", args: [message, attestation] });
    },

    async refund(intentId, maxFee, minFinalityThreshold) {
      return wallet.writeContract({ address: cfg.gateway, abi: CCTP_GATEWAY_ABI, functionName: "refund", args: [intentId, maxFee, minFinalityThreshold] });
    },

    async claimAndForward(intentId, ciphertext, witness, maxFee, minFinalityThreshold) {
      return wallet.writeContract({
        address: cfg.gateway,
        abi: CCTP_GATEWAY_ABI,
        functionName: "claimAndForward",
        args: [intentId, ciphertext, witness, maxFee, minFinalityThreshold],
      });
    },

    async getReceipt(txHash): Promise<GatewayReceipt | null> {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      } catch (err) {
        if (err instanceof Error && /could not be found|not found/i.test(err.message)) return null;
        throw err;
      }
      return {
        status: receipt.status,
        events: decodeGatewayLogs(receipt.logs, cfg.gateway).map((x) => x.event),
      };
    },

    async findDepositOutcome(nonce, messageHash) {
      return scan((e) =>
        (e.name === "CctpDepositBound" && e.nonce.toLowerCase() === nonce.toLowerCase()) ||
        (e.name === "CctpDepositRejected" && e.messageHash.toLowerCase() === messageHash.toLowerCase()));
    },

    async findSettleOutcome(direction, intentId) {
      const want = direction === "refund" ? "CctpRefundSent" : "CctpPayoutSent";
      return scan((e) => e.name === want && e.intentId.toLowerCase() === intentId.toLowerCase());
    },
  };
}
