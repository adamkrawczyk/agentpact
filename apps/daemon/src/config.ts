import { join } from "node:path";
import { z } from "zod";

const booleanish = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const numberish = (defaultValue: number) => z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return value;
}, z.number().finite());

const envSchema = z.object({
  AGENTPACT_API_URL: z.string().url().default("https://api.agentpact.xyz"),
  AGENTPACT_API_KEY: z.string().min(1, "AGENTPACT_API_KEY is required"),
  AGENTPACT_AGENT_ID: z.string().min(1, "AGENTPACT_AGENT_ID is required"),
  AGENTPACT_HEARTBEAT_INTERVAL: numberish(60_000).pipe(z.number().int().positive()),
  AGENTPACT_WATCH_INTERVAL: numberish(300_000).pipe(z.number().int().positive()),
  AGENTPACT_NOTIFY_WEBHOOK: z.string().url().optional(),
  AGENTPACT_AUTOPILOT: booleanish.default(false),
  AGENTPACT_AUTOPILOT_THRESHOLD: numberish(0.85).pipe(z.number().min(0).max(1)),
  AGENTPACT_AUTOPILOT_MAX_PRICE: numberish(100).pipe(z.number().positive()),
  AGENTPACT_AUTOPILOT_ALLOWED_CATEGORIES: z.string().optional(),
  AGENTPACT_AUTOPILOT_RATE_LIMIT: numberish(3).pipe(z.number().int().positive()),
});

export type RuntimeConfig = {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  heartbeatIntervalMs: number;
  watchIntervalMs: number;
  webhookUrl?: string;
  stateFilePath: string;
  autopilot: {
    enabled: boolean;
    threshold: number;
    maxPrice: number;
    allowedCategories?: string[];
    rateLimitPerHour: number;
  };
  flags: {
    dryRun: boolean;
    verbose: boolean;
  };
};

export function loadConfig(input: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  argv?: string[];
  homeDir: string;
}): RuntimeConfig {
  const env = envSchema.parse(input.env);
  const argv = input.argv ?? [];

  return {
    apiUrl: env.AGENTPACT_API_URL,
    apiKey: env.AGENTPACT_API_KEY,
    agentId: env.AGENTPACT_AGENT_ID,
    heartbeatIntervalMs: env.AGENTPACT_HEARTBEAT_INTERVAL,
    watchIntervalMs: env.AGENTPACT_WATCH_INTERVAL,
    webhookUrl: env.AGENTPACT_NOTIFY_WEBHOOK,
    stateFilePath: join(input.homeDir, ".agentpact", "daemon-state.json"),
    autopilot: {
      enabled: env.AGENTPACT_AUTOPILOT,
      threshold: env.AGENTPACT_AUTOPILOT_THRESHOLD,
      maxPrice: env.AGENTPACT_AUTOPILOT_MAX_PRICE,
      allowedCategories: env.AGENTPACT_AUTOPILOT_ALLOWED_CATEGORIES
        ?.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
      rateLimitPerHour: env.AGENTPACT_AUTOPILOT_RATE_LIMIT,
    },
    flags: {
      dryRun: argv.includes("--dry-run"),
      verbose: argv.includes("--verbose"),
    },
  };
}
