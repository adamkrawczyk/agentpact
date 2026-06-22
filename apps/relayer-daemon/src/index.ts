// apps/relayer-daemon/src/index.ts — settlement_2705 Phase D entry point
//
// Wires config → interval loops → graceful shutdown. Each sweeper runs
// independently so a chain hiccup on Class B doesn't pause Class C. The
// daemon exposes a minimal HTTP /health endpoint for UptimeRobot (Phase F2).

import { createServer } from "node:http";
import { loadConfig, type Config } from "./config.js";
import {
  runAckTimeoutSweep,
  runSchellingSweep,
  runStreamStaleSweep,
  type ChainClient,
  type SqlClient,
} from "./sweepers.js";
import { runAutoCloseSweep } from "./autoclose-sweeper.js";

interface SweeperHealth {
  cycles: number;
  lastRunAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

interface DaemonHealth {
  ok: boolean;
  ackSweeper: SweeperHealth;
  schellingSweeper: SweeperHealth;
  streamStaleSweeper: SweeperHealth;
  autocloseSweeper: SweeperHealth;
}

function freshHealth(): SweeperHealth {
  return {
    cycles: 0,
    lastRunAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
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
  sql: SqlClient;
  chain: ChainClient;
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
  };

  async function safeRun(name: keyof DaemonHealth, fn: () => Promise<unknown>) {
    if (name === "ok") return;
    const h = health[name] as SweeperHealth;
    try {
      const result = await fn();
      recordRun(h, null);
      log("info", `${name}.tick`, { result });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      recordRun(h, e);
      log("error", `${name}.fail`, { error: e.message });
    }
    // Degraded state on 3+ total consecutive failures across all sweepers.
    health.ok = (
      health.ackSweeper.consecutiveFailures +
      health.schellingSweeper.consecutiveFailures +
      health.streamStaleSweeper.consecutiveFailures +
      health.autocloseSweeper.consecutiveFailures
    ) < 3;
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

  const server = createServer((req, res) => {
    if (req.url === "/health") {
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    getHealth: () => health,
  };
}

// ── Entrypoint ──────────────────────────────────────────────────────────

const isEntrypoint = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
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

  const { stop } = startDaemon({ config, sql, chain });
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
