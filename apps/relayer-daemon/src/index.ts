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
import { runReceiptAnchor, runReceiptSweep } from "./receipt-sweeper.js";

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

interface DaemonHealth {
  ok: boolean;
  ackSweeper: SweeperHealth;
  schellingSweeper: SweeperHealth;
  streamStaleSweeper: SweeperHealth;
  autocloseSweeper: SweeperHealth;
  settlementSweeper: SweeperHealth;
  proposalExpirySweeper: SweeperHealth;
  receiptSweeper: SweeperHealth;
  receiptAnchorSweeper: SweeperHealth;
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
   * Receipt anchoring: broadcast a 0-value self-tx carrying `data` and resolve
   * once mined. Only wired when a relayer key is configured.
   */
  anchorBroadcast?: (data: `0x${string}`) => Promise<{ txHash: string }>;
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
    receiptSweeper: freshHealth(),
    receiptAnchorSweeper: freshHealth(),
  };

  type SweeperName = Exclude<keyof DaemonHealth, "ok">;
  const SWEEPERS: SweeperName[] = [
    "ackSweeper", "schellingSweeper", "streamStaleSweeper",
    "autocloseSweeper", "settlementSweeper", "proposalExpirySweeper",
    "receiptSweeper", "receiptAnchorSweeper",
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
    // any tick in flight past the stall threshold.
    health.ok = failures < 3 && stalledSweepers().length === 0;
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

  // ap_v31 M2 — receipts. Off the money path: reads deal records, writes only
  // receipts / receipt_anchor_batches / receipt_signing_keys.
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const { receiptSigningKey, receiptKeyId } = config;
  if (receiptSigningKey && receiptKeyId) {
    timers.push(setInterval(
      () => safeRun("receiptSweeper", () => runReceiptSweep(sql, {
        signingKey: receiptSigningKey,
        keyId: receiptKeyId,
        maxPerTick: config.receiptMaxPerTick ?? 50,
      })),
      config.receiptSweepIntervalMs ?? 5 * 60_000,
    ));
  } else {
    log("warn", "receiptSweeper.disabled", { reason: "RECEIPT_SIGNING_KEY and RECEIPT_KEY_ID must both be set" });
  }
  const anchorBroadcast = deps.anchorBroadcast;
  if (config.receiptAnchorEnabled && anchorBroadcast) {
    timers.push(setInterval(
      () => safeRun("receiptAnchorSweeper", () => runReceiptAnchor(sql, {
        enabled: true,
        broadcast: anchorBroadcast,
        minIntervalMs: config.receiptAnchorMinIntervalMs,
      })),
      config.receiptAnchorCheckIntervalMs ?? 60 * 60_000,
    ));
  } else if (config.receiptAnchorEnabled) {
    log("warn", "receiptAnchorSweeper.disabled", { reason: "RECEIPT_ANCHOR_ENABLED=true but no relayer key is configured" });
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
      for (const t of timers) clearInterval(t);
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
  let anchorBroadcast: DaemonDeps["anchorBroadcast"];

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

    // Receipt anchoring: 0-value tx from the relayer wallet to itself whose
    // calldata is the Merkle root. Resolves only once mined successfully, so a
    // reverted or dropped tx is never recorded as an anchor.
    anchorBroadcast = async (data) => {
      const { createPublicClient, http: httpTransport } = await import("viem");
      const publicClient = createPublicClient({ chain: chainObj, transport: httpTransport(config.baseRpcUrl) });
      const hash = await walletClient.sendTransaction({ account, chain: chainObj, to: account.address, value: 0n, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`anchor tx ${hash} did not succeed (${receipt.status})`);
      return { txHash: hash };
    };

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

  const { stop } = startDaemon({
    config, sql, chain, anchorBroadcast,
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
