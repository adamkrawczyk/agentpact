// apps/relayer-daemon/src/index.ts — settlement protocol Phase D entry point
//
// Wires config → interval loops → graceful shutdown. Each sweeper runs
// independently so a chain hiccup on Class B doesn't pause Class C. The
// daemon exposes a minimal HTTP /health endpoint for UptimeRobot (Phase F2).

import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import {
  runAckTimeoutSweep,
  runSchellingSweep,
  runStreamStaleSweep,
  type ChainClient,
  type SqlClient,
} from "./sweepers.js";
import { runAutoCloseSweep } from "./autoclose-sweeper.js";
import { runSettlementSweep } from "./settlement-sweeper.js";
import { runProposalExpirySweep } from "./proposal-expiry-sweeper.js";
// Types only: the CCTP code (and @agentpact/payouts) is loaded lazily, only
// when CCTP_ENABLED=true, so a disabled relay can never stop the existing
// sweepers from booting.
import type { CctpAlert, CctpSweeperDeps } from "./cctp-sweeper.js";

interface SweeperHealth {
  cycles: number;
  lastRunAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** ISO start of the tick currently in flight, or null when idle. */
  inFlightSince: string | null;
  /** Ticks skipped because the previous one had not finished. */
  overlapSkips: number;
}

/** Cross-chain relay state for /health (M1). */
interface CctpHealth {
  enabled: boolean;
  network: string | null;
  /** cctp_transfers rows in `stuck` — each one needs a human. */
  stuckCount: number;
  oldestStuckAgeMs: number | null;
  lastAlertAt: string | null;
  lastAlert: CctpAlert | null;
}

interface DaemonHealth {
  ok: boolean;
  ackSweeper: SweeperHealth;
  schellingSweeper: SweeperHealth;
  streamStaleSweeper: SweeperHealth;
  autocloseSweeper: SweeperHealth;
  settlementSweeper: SweeperHealth;
  proposalExpirySweeper: SweeperHealth;
  cctpSweeper: SweeperHealth;
  cctp: CctpHealth;
}

function freshHealth(): SweeperHealth {
  return {
    cycles: 0,
    lastRunAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    inFlightSince: null,
    overlapSkips: 0,
  };
}

function recordRun(h: SweeperHealth, err: Error | null) {
  h.cycles++;
  h.lastRunAt = new Date().toISOString();
  if (err) {
    h.lastErrorAt = h.lastRunAt;
    h.lastError = err.message;
    h.consecutiveFailures++;
  } else {
    h.consecutiveFailures = 0;
    h.lastError = null;
  }
}

export interface DaemonDeps {
  config: Config;
  /**
   * Called when a tick has been in flight longer than config.tickStallMs.
   * Production passes process.exit(1) so pm2 restarts a wedged process;
   * tests pass a spy. Default: no-op (health still flips to 503).
   */
  onStall?: (name: string, stalledMs: number) => void;
  sql: SqlClient;
  chain: ChainClient;
  /**
   * CCTP relay runtime. Scheduled only when config.cctpEnabled is true; the
   * daemon supplies `alert` itself so every CCTP alert goes through the same
   * structured error log (journal/pm2) the other sweepers use, and /health.
   */
  cctp?: Omit<CctpSweeperDeps, "alert">;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

export function startDaemon(deps: DaemonDeps): { stop: () => Promise<void>; getHealth: () => DaemonHealth } {
  const { config, sql, chain } = deps;
  const log = deps.log ?? ((lvl, msg, meta) => console.log(JSON.stringify({ level: lvl, msg, ...meta })));

  const health: DaemonHealth = {
    ok: true,
    ackSweeper: freshHealth(),
    schellingSweeper: freshHealth(),
    streamStaleSweeper: freshHealth(),
    autocloseSweeper: freshHealth(),
    settlementSweeper: freshHealth(),
    proposalExpirySweeper: freshHealth(),
    cctpSweeper: freshHealth(),
    cctp: {
      enabled: config.cctpEnabled === true,
      network: config.cctpEnabled === true ? (config.cctpNetwork ?? "testnet") : null,
      stuckCount: 0,
      oldestStuckAgeMs: null,
      lastAlertAt: null,
      lastAlert: null,
    },
  };

  type SweeperName = Exclude<keyof DaemonHealth, "ok" | "cctp">;
  const SWEEPERS: SweeperName[] = [
    "ackSweeper", "schellingSweeper", "streamStaleSweeper",
    "autocloseSweeper", "settlementSweeper", "proposalExpirySweeper", "cctpSweeper",
  ];
  const tickStallMs = config.tickStallMs ?? 60 * 60_000;

  // 2026-09-22 prod incident: one tick never returned (no error, no log line,
  // no finished_at), and every sweeper went silent for 8 days while pm2 said
  // `online` and /health said ok:true with frozen lastRunAt values. Health
  // must read LIVENESS, not just the last recorded error.
  function stalledSweepers(nowMs = Date.now()): Array<{ name: SweeperName; ms: number }> {
    const out: Array<{ name: SweeperName; ms: number }> = [];
    for (const name of SWEEPERS) {
      const since = health[name].inFlightSince;
      if (!since) continue;
      const ms = nowMs - Date.parse(since);
      if (ms > tickStallMs) out.push({ name, ms });
    }
    return out;
  }

  function recomputeOk() {
    const failures = SWEEPERS.reduce((n, k) => n + health[k].consecutiveFailures, 0);
    // Degraded on 3+ total consecutive failures across all sweepers, OR on
    // any tick in flight past the stall threshold, OR on any stuck CCTP
    // transfer: user funds waiting on a human must page, not sit in a table.
    health.ok = failures < 3 && stalledSweepers().length === 0 && health.cctp.stuckCount === 0;
  }

  async function safeRun(name: SweeperName, fn: () => Promise<unknown>) {
    const h = health[name];
    // Overlap guard: setInterval fires regardless of whether the previous
    // tick finished. Stacking ticks on a hung dependency multiplies the hang
    // (and on the settlement path re-selects the same deal concurrently).
    if (h.inFlightSince) {
      h.overlapSkips++;
      return;
    }
    h.inFlightSince = new Date().toISOString();
    try {
      const result = await fn();
      recordRun(h, null);
      log("info", `${name}.tick`, { result });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      recordRun(h, e);
      log("error", `${name}.fail`, { error: e.message });
    } finally {
      h.inFlightSince = null;
    }
    recomputeOk();
  }

  const ackTimer = setInterval(
    () => safeRun("ackSweeper", () => runAckTimeoutSweep(sql, chain)),
    config.ackSweepIntervalMs,
  );
  const schTimer = setInterval(
    () => safeRun("schellingSweeper", () => runSchellingSweep(sql, chain)),
    config.schellingSweepIntervalMs,
  );
  const stsTimer = setInterval(
    () => safeRun("streamStaleSweeper", () => runStreamStaleSweep(sql)),
    config.streamStaleSweepIntervalMs,
  );
  const acTimer = setInterval(
    () => safeRun("autocloseSweeper", () => runAutoCloseSweep(sql, chain, config)),
    config.autocloseSweepIntervalMs,
  );

  // moneypath_0920 M1 — the schedule the acceptance-timeout promise never had.
  const setTimer = setInterval(
    () => safeRun("settlementSweeper", () => runSettlementSweep(sql, {
      apiBaseUrl: config.apiBaseUrl,
      adminApiKey: config.adminApiKey,
      completeThreshold: config.settlementCompleteThreshold,
      maxPerTick: config.settlementMaxPerTick,
      autoReleaseEnabled: config.settlementAutoRelease,
    })),
    config.settlementSweepIntervalMs,
  );

  // moneypath M1 remainder — the schedule /api/admin/expire-stale-proposals
  // never had (271 stale proposals on prod 2026-09-22).
  const peTimer = setInterval(
    () => safeRun("proposalExpirySweeper", () => runProposalExpirySweep(sql, {
      apiBaseUrl: config.apiBaseUrl,
      adminApiKey: config.adminApiKey,
      expiryDays: config.proposalExpiryDays,
    })),
    config.proposalExpirySweepIntervalMs,
  );

  // M1 — cross-chain relay. Off unless CCTP_ENABLED=true AND the runtime was
  // built (entrypoint refuses to boot enabled without a gateway + key).
  const cctpAlert = (a: CctpAlert) => {
    health.cctp.lastAlertAt = new Date().toISOString();
    health.cctp.lastAlert = a;
    log("error", "cctp.alert", { ...a });
  };
  let cctpTimer: ReturnType<typeof setInterval> | null = null;
  if (config.cctpEnabled === true) {
    const cctp = deps.cctp;
    if (!cctp) {
      log("error", "cctpSweeper.not_wired", { reason: "CCTP_ENABLED=true but no CCTP runtime was supplied" });
    } else {
      cctpTimer = setInterval(
        () => safeRun("cctpSweeper", async () => {
          const { runCctpSweep } = await import("./cctp-sweeper.js");
          const r = await runCctpSweep({ ...cctp, alert: cctpAlert });
          health.cctp.stuckCount = r.stuck.count;
          health.cctp.oldestStuckAgeMs = r.stuck.oldestStuckAgeMs;
          return r;
        }),
        config.cctpSweepIntervalMs ?? 30_000,
      );
    }
  }

  // Stall watchdog: a wedged tick must become visible AND self-heal. The
  // overlap guard alone would turn a hang into permanent silent skipping.
  let stallReported = false;
  const stallTimer = setInterval(() => {
    const stalled = stalledSweepers();
    recomputeOk();
    if (stalled.length === 0 || stallReported) return;
    stallReported = true;
    for (const s of stalled) {
      log("error", `${s.name}.stalled`, { inFlightMs: s.ms, tickStallMs });
    }
    deps.onStall?.(stalled[0].name, stalled[0].ms);
  }, Math.min(60_000, Math.max(10, Math.floor(tickStallMs / 4))));

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      recomputeOk();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.relayerPort, config.relayerHost, () => {
    log("info", "relayer-daemon.listening", { host: config.relayerHost, port: config.relayerPort });
  });

  return {
    async stop() {
      clearInterval(ackTimer);
      clearInterval(schTimer);
      clearInterval(stsTimer);
      clearInterval(acTimer);
      clearInterval(setTimer);
      clearInterval(peTimer);
      if (cctpTimer) clearInterval(cctpTimer);
      clearInterval(stallTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    getHealth: () => health,
  };
}

// ── Entrypoint ──────────────────────────────────────────────────────────

// Under pm2 fork mode process.argv[1] is pm2's ProcessContainerFork.js, not
// this file, so a bare argv[1] comparison is false and the daemon boots into a
// silent no-op (module loads, nothing starts, no port, no sweeps). Measured on
// prod 2026-09-22: every sweeper had been dead since the 09-01 restart under
// pm2. Resolve both sides to real paths and also honour an explicit override.
const isEntrypoint = (() => {
  if (process.env.RELAYER_FORCE_ENTRYPOINT === "true") return true;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (self === argv) return true;
    // pm2 fork: the real script is in pm_exec_path / process.env.pm_exec_path.
    const pmExec = process.env.pm_exec_path;
    return Boolean(pmExec) && realpathSync(pmExec as string) === self;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const config = loadConfig();

  // ── SQL client ───────────────────────────────────────────────────────
  // Real postgres-js client (same lib + shape the API uses). DATABASE_URL is
  // required at boot — the daemon cannot sweep without it.
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL must be set for the relayer daemon");
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(config.databaseUrl, {
    // Same Supavisor fix as apps/api/src/db.ts (PG 26000, 2026-07-24): the
    // transaction-mode pooler (:6543) can route PREPARE and EXECUTE to
    // different backends. Named prepared statements are unsafe behind it.
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 1800,
  }) as unknown as SqlClient;

  // ── Chain client (viem) ──────────────────────────────────────────────
  // Real implementation uses viem createWalletClient + writeContract.
  // If relayerPrivateKey is absent (e.g. dry-run), fall back to throwing stub.
  let chain: ChainClient;

  if (config.relayerPrivateKey) {
    // Dynamic import so the daemon can boot without viem installed in test
    // environments that only use the stub.
    const { createWalletClient, http, parseAbi, decodeEventLog } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { base, baseSepolia } = await import("viem/chains");

    const account = privateKeyToAccount(config.relayerPrivateKey as `0x${string}`);

    // Determine chain from RPC URL.
    const chainObj = config.baseRpcUrl.includes("sepolia") ? baseSepolia : base;

    const walletClient = createWalletClient({
      account,
      chain: chainObj,
      transport: http(config.baseRpcUrl),
    });

    // Minimal ABI — only the two functions the relayer needs + IntentCreated event.
    const ESCROW_V3_ABI = parseAbi([
      "function createIntentWithAuthorization(address buyer, address verifier, bytes params, address sellerTarget, uint256 maxPrice, uint64 expiresAt, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external returns (bytes32 intentId)",
      "function claimIntentForSeller(bytes32 intentId, bytes ciphertext, bytes witness) external",
      "event IntentCreated(bytes32 indexed intentId, uint8 class, address indexed buyer, address indexed sellerTarget, address verifier, uint256 maxPrice, uint64 expiresAt)",
    ]);

    // Prefer V3 address; fall back to V2 for dev convenience.
    const escrowAddress = (
      config.escrowV3Address ?? config.escrowV2Address
    ) as `0x${string}` | undefined;

    if (!escrowAddress) {
      throw new Error("ESCROW_V3_ADDRESS (or ESCROW_V2_ADDRESS) must be set");
    }

    chain = {
      async acknowledgeTimeout(intentOnChainId: Buffer) {
        // acknowledgeTimeout is on the V2 ABI; included here so the interface
        // is satisfied. V3 inherits V2 functions. For simplicity we call the
        // same contract address — it supports both.
        const { parseAbi: pa } = await import("viem");
        const v2abi = pa(["function acknowledgeTimeout(bytes32 intentId) external"]);
        const hash = await walletClient.writeContract({
          address: escrowAddress,
          abi: v2abi,
          functionName: "acknowledgeTimeout",
          args: [`0x${intentOnChainId.toString("hex")}` as `0x${string}`],
        });
        return { txHash: hash };
      },

      async settleSchelling(intentOnChainId: Buffer) {
        const { parseAbi: pa } = await import("viem");
        const v2abi = pa(["function settleSchelling(bytes32 intentId) external"]);
        const hash = await walletClient.writeContract({
          address: escrowAddress,
          abi: v2abi,
          functionName: "settleSchelling",
          args: [`0x${intentOnChainId.toString("hex")}` as `0x${string}`],
        });
        return { txHash: hash };
      },

      async createIntentWithAuthorization(args) {
        const { createPublicClient, http: httpTransport } = await import("viem");
        const publicClient = createPublicClient({
          chain: chainObj,
          transport: httpTransport(config.baseRpcUrl),
        });

        const toHex = (buf: Buffer): `0x${string}` =>
          `0x${buf.toString("hex")}` as `0x${string}`;

        const hash = await walletClient.writeContract({
          address: escrowAddress,
          abi: ESCROW_V3_ABI,
          functionName: "createIntentWithAuthorization",
          args: [
            args.buyer as `0x${string}`,
            args.verifier as `0x${string}`,
            args.params,
            args.sellerTarget as `0x${string}`,
            args.maxPrice,
            args.expiresAt,
            args.value,
            args.validAfter,
            args.validBefore,
            toHex(args.nonce) as `0x${string}`,
            args.sigV,
            toHex(args.sigR) as `0x${string}`,
            toHex(args.sigS) as `0x${string}`,
          ],
        });

        // Wait for the receipt and parse the IntentCreated log to extract onChainId.
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        let onChainId: Buffer | undefined;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: ESCROW_V3_ABI,
              eventName: "IntentCreated",
              data: log.data,
              topics: log.topics,
            });
            // intentId is the first indexed topic → decoded.args.intentId
            const id = (decoded.args as { intentId: `0x${string}` }).intentId;
            onChainId = Buffer.from(id.slice(2), "hex");
            break;
          } catch {
            // Not this log; continue.
          }
        }

        if (!onChainId) {
          throw new Error(`IntentCreated event not found in tx ${hash}`);
        }

        return { txHash: hash, onChainId };
      },

      async claimIntent(onChainId: Buffer, ciphertext: Buffer, witness: Buffer) {
        const toHex = (buf: Buffer): `0x${string}` =>
          `0x${buf.toString("hex")}` as `0x${string}`;

        const hash = await walletClient.writeContract({
          address: escrowAddress,
          abi: ESCROW_V3_ABI,
          functionName: "claimIntentForSeller",
          args: [
            toHex(onChainId) as `0x${string}`,
            toHex(ciphertext),
            toHex(witness),
          ],
        });
        return { txHash: hash };
      },
    };
  } else {
    // No private key configured — throw on any chain call.
    chain = {
      async acknowledgeTimeout() { throw new Error("Chain client not wired — set RELAYER_PRIVATE_KEY"); },
      async settleSchelling()    { throw new Error("Chain client not wired — set RELAYER_PRIVATE_KEY"); },
      async createIntentWithAuthorization() { throw new Error("Chain client not wired — set RELAYER_PRIVATE_KEY"); },
      async claimIntent()        { throw new Error("Chain client not wired — set RELAYER_PRIVATE_KEY"); },
    };
  }

  const cctp = config.cctpEnabled ? await buildCctpRuntime(config, sql) : undefined;

  const { stop } = startDaemon({
    config, sql, chain, cctp,
    // A wedged tick cannot be un-wedged from inside the process. Exit non-zero
    // so pm2 (autorestart) brings up a fresh one; the stall is logged first.
    onStall: (name, ms) => {
      console.error(JSON.stringify({ level: "error", msg: "relayer-daemon.exit_on_stall", sweeper: name, inFlightMs: ms }));
      setTimeout(() => process.exit(1), 250);
    },
  });
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Build the CCTP relay runtime, or refuse to boot. Enabled-but-misconfigured
 * must crash loudly at start, never degrade into a daemon that silently
 * relays nothing.
 */
async function buildCctpRuntime(config: Config, sql: SqlClient): Promise<Omit<CctpSweeperDeps, "alert">> {
  const { cctpConstants, IrisClient, quoteForwardedBurn } = await import("@agentpact/payouts");
  const { createViemCctpChain } = await import("./cctp-chain.js");
  const { sqlCctpStore } = await import("./cctp-store.js");
  const { httpBindingVerifier } = await import("./cctp-binding.js");
  const { createPublicClient, http } = await import("viem");

  if (!config.cctpGatewayAddress) throw new Error("CCTP_ENABLED=true requires CCTP_GATEWAY_ADDRESS");
  if (!config.relayerPrivateKey) throw new Error("CCTP_ENABLED=true requires RELAYER_PRIVATE_KEY");
  const c = cctpConstants(config.cctpNetwork);
  const rpcChainId = await createPublicClient({ transport: http(config.baseRpcUrl) }).getChainId();
  if (rpcChainId !== c.base.chainId) {
    throw new Error(`CCTP_NETWORK=${config.cctpNetwork} expects Base chain ${c.base.chainId}, BASE_RPC_URL is chain ${rpcChainId}`);
  }

  const iris = new IrisClient({ baseUrl: config.irisBaseUrl ?? c.irisBaseUrl });
  return {
    store: sqlCctpStore(sql),
    iris,
    chain: createViemCctpChain({
      rpcUrl: config.baseRpcUrl,
      privateKey: config.relayerPrivateKey as `0x${string}`,
      network: config.cctpNetwork,
      gateway: config.cctpGatewayAddress as `0x${string}`,
      messageTransmitter: c.base.messageTransmitterV2,
      logLookbackBlocks: BigInt(config.cctpLogLookbackBlocks),
      logChunkBlocks: BigInt(config.cctpLogChunkBlocks),
    }),
    verifyBinding: httpBindingVerifier({ apiBaseUrl: config.apiBaseUrl, adminApiKey: config.adminApiKey }),
    quoteForwardFee: async (amount, destinationDomain) => {
      // Solana: include ATA creation — a payout to an owner without a USDC
      // account would otherwise fail at mint.
      const fees = await iris.getBurnFees(c.base.domain, destinationDomain, { forward: true, includeRecipientSetup: destinationDomain === 5 });
      if (!fees.forwardFee) throw new Error("Iris returned no forwarding fee");
      const q = quoteForwardedBurn({ amount, destinationDomain, speed: config.cctpPayoutSpeed, tiers: fees.tiers, forwardFee: fees.forwardFee });
      return { maxFee: q.maxFee, minFinalityThreshold: q.minFinalityThreshold };
    },
    config: {
      gateway: config.cctpGatewayAddress as `0x${string}`,
      maxPerTick: config.cctpMaxPerTick,
      attestationTimeoutMs: config.cctpAttestationTimeoutMin * 60_000,
      bindTimeoutMs: config.cctpBindTimeoutMin * 60_000,
      forwardTimeoutMs: config.cctpForwardTimeoutMin * 60_000,
      maxAttempts: config.cctpMaxAttempts,
      retryBaseMs: config.cctpRetryBaseMs,
      retryMaxMs: config.cctpRetryMaxMs,
      txDropAfterMs: config.cctpTxDropAfterMin * 60_000,
      receiptWaitMs: 60_000,
      receiptPollMs: 3_000,
      refundGraceMs: config.cctpRefundGraceSec * 1000,
      leaseMs: 10 * 60_000,
    },
  };
}
