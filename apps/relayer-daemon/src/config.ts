// apps/relayer-daemon/src/config.ts — settlement_2705 Phase D
//
// Parsed env with zod. Centralized so test fixtures can pass in a
// known-good config object without juggling process.env.

import { z } from "zod";

const schema = z.object({
  relayerPort: z.coerce.number().int().positive().default(4011),
  relayerHost: z.string().default("127.0.0.1"),
  relayerPrivateKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  databaseUrl: z.string().url().optional(),
  baseRpcUrl: z.string().url().default("https://mainnet.base.org"),
  escrowV2Address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // V3 escrow for gasless funding. Falls back to escrowV2Address if unset.
  escrowV3Address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  platformWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // Sweeper cadences (ms). Tightened by tests by setting low values.
  ackSweepIntervalMs: z.coerce.number().int().positive().default(60_000),
  schellingSweepIntervalMs: z.coerce.number().int().positive().default(60_000),
  streamStaleSweepIntervalMs: z.coerce.number().int().positive().default(5 * 60_000),
  // Autoclose sweeper cadence + spend cap.
  autocloseSweepIntervalMs: z.coerce.number().int().positive().default(30_000),
  autocloseMaxUsdc: z.coerce.number().positive().default(5),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse({
    relayerPort: env.RELAYER_PORT,
    relayerHost: env.RELAYER_HOST,
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY,
    databaseUrl: env.DATABASE_URL,
    // Accept BASE_RPC_URL (relayer convention) or RPC_URL (the name already set
    // on the api Railway service) so prod env stays consistent across services.
    baseRpcUrl: env.BASE_RPC_URL ?? env.RPC_URL,
    escrowV2Address: env.ESCROW_V2_ADDRESS,
    escrowV3Address: env.ESCROW_V3_ADDRESS,
    platformWallet: env.PLATFORM_WALLET,
    ackSweepIntervalMs: env.ACK_SWEEP_INTERVAL_MS,
    schellingSweepIntervalMs: env.SCHELLING_SWEEP_INTERVAL_MS,
    streamStaleSweepIntervalMs: env.STREAM_STALE_SWEEP_INTERVAL_MS,
    autocloseSweepIntervalMs: env.AUTOCLOSE_SWEEP_INTERVAL_MS,
    autocloseMaxUsdc: env.AUTOCLOSE_MAX_USDC,
    logLevel: env.LOG_LEVEL,
  });
}
