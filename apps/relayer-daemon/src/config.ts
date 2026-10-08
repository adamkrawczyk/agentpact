// apps/relayer-daemon/src/config.ts — settlement protocol Phase D
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
  // ── Settlement sweeper (moneypath_0920 M1) ────────────────────────────
  // 10 minutes: acceptance timeouts are measured in DAYS, so a tighter cadence
  // buys nothing and only multiplies judge spend on the same held deals.
  settlementSweepIntervalMs: z.coerce.number().int().positive().default(10 * 60_000),
  // The sweeper calls the API's own auto-complete route rather than releasing
  // money itself — see settlement-sweeper.ts for why. It therefore needs the
  // API's base URL and the same admin key an operator would use.
  apiBaseUrl: z.string().url().default("https://api.agentpact.xyz"),
  adminApiKey: z.string().optional(),
  settlementCompleteThreshold: z.coerce.number().min(0).max(1).default(0.85),
  settlementMaxPerTick: z.coerce.number().int().positive().default(25),
  // DEFAULT OFF. A sweeper that starts releasing real money the moment it is
  // deployed is not a feature, it is an incident. Shadow mode judges and
  // records decisions so the thresholds can be read off REAL deals first;
  // SETTLEMENT_AUTO_RELEASE=true is a deliberate, separate act.
  //
  // NOT z.coerce.boolean(): that is JS Boolean(), so the STRING "false" —
  // exactly what an env var holds when someone tries to turn this off —
  // coerces to TRUE. On this switch that failure mode silently releases money.
  // Only the literal string "true" (case-insensitive) enables it.
  settlementAutoRelease: z
    .string()
    .optional()
    .transform((v) => String(v ?? "").toLowerCase() === "true"),
  // ── Proposal-expiry sweeper (moneypath M1 remainder) ────────────────
  // Hourly: proposal deadlines are measured in DAYS (DEAL_PROPOSAL_EXPIRY_DAYS
  // on the API, default 14). The route is idempotent, so a tighter cadence
  // buys nothing. PROPOSAL_EXPIRY_DAYS here only sizes the legacy-gap count
  // (NULL expires_at rows older than this) reported in sweeper_runs.held —
  // it never expires anything itself; the API route owns the deadline.
  proposalExpirySweepIntervalMs: z.coerce.number().int().positive().default(60 * 60_000),
  proposalExpiryDays: z.coerce.number().int().positive().default(14),
  // ── Receipts (ap_v31 M2) ─────────────────────────────────────────────
  // Issuance runs only when BOTH the seed and the key id are set; without a
  // key there is nothing honest to sign with, so the sweeper is not scheduled.
  // The seed is a base64 32-byte ed25519 seed — validated by packages/receipts
  // at first use, never logged.
  receiptSigningKey: z.string().min(1).optional(),
  receiptKeyId: z.string().min(1).optional(),
  receiptSweepIntervalMs: z.coerce.number().int().positive().default(5 * 60_000),
  receiptMaxPerTick: z.coerce.number().int().positive().default(50),
  // DEFAULT OFF, literal "true" only (same reasoning as settlementAutoRelease:
  // z.coerce.boolean() turns the string "false" into true). Anchoring spends
  // relayer gas, so it is a deliberate switch.
  receiptAnchorEnabled: z
    .string()
    .optional()
    .transform((v) => String(v ?? "").toLowerCase() === "true"),
  // How often the anchor tick CHECKS; a batch is opened at most once per
  // receiptAnchorMinIntervalMs (daily).
  receiptAnchorCheckIntervalMs: z.coerce.number().int().positive().default(60 * 60_000),
  receiptAnchorMinIntervalMs: z.coerce.number().int().positive().default(24 * 60 * 60_000),
  // A tick in flight longer than this is WEDGED: /health flips to 503 and the
  // process exits so pm2 restarts it. 60 min clears the worst legitimate
  // settlement tick: 25 deals x (3 judge attempts x 20s + one 30s release
  // call) ~ 39 min. A threshold under that would kill healthy ticks.
  tickStallMs: z.coerce.number().int().positive().default(60 * 60_000),
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
    settlementSweepIntervalMs: env.SETTLEMENT_SWEEP_INTERVAL_MS,
    apiBaseUrl: env.API_BASE_URL,
    adminApiKey: env.ADMIN_API_KEY,
    settlementCompleteThreshold: env.SETTLEMENT_COMPLETE_THRESHOLD,
    settlementMaxPerTick: env.SETTLEMENT_MAX_PER_TICK,
    settlementAutoRelease: env.SETTLEMENT_AUTO_RELEASE,
    proposalExpirySweepIntervalMs: env.PROPOSAL_EXPIRY_SWEEP_INTERVAL_MS,
    proposalExpiryDays: env.PROPOSAL_EXPIRY_DAYS,
    receiptSigningKey: env.RECEIPT_SIGNING_KEY || undefined,
    receiptKeyId: env.RECEIPT_KEY_ID || undefined,
    receiptSweepIntervalMs: env.RECEIPT_SWEEP_INTERVAL_MS,
    receiptMaxPerTick: env.RECEIPT_MAX_PER_TICK,
    receiptAnchorEnabled: env.RECEIPT_ANCHOR_ENABLED,
    receiptAnchorCheckIntervalMs: env.RECEIPT_ANCHOR_CHECK_INTERVAL_MS,
    receiptAnchorMinIntervalMs: env.RECEIPT_ANCHOR_MIN_INTERVAL_MS,
    tickStallMs: env.RELAYER_TICK_STALL_MS,
    logLevel: env.LOG_LEVEL,
  });
}
