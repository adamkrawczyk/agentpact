import { join } from "node:path";
import { z } from "zod";

const booleanish = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const numberish = (defaultValue: number) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return value;
  }, z.number().finite());

const envSchema = z.object({
  AGENTPACT_API_URL: z.string().url().default("https://api.agentpact.xyz"),
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),
  AUDIT_RUNNER_CLI_PATH: z.string().min(1).default("/app/scripts/audit-runner-cli.ts"),
  FULFILLMENT_TICK_SECONDS: numberish(60).pipe(z.number().int().positive()),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: booleanish.default(false),
  AGENTPACT_STATE_FILE: z.string().min(1).optional(),
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
});

export type RuntimeConfig = {
  apiUrl: string;
  adminApiKey: string;
  runnerCliPath: string;
  tickSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
  dryRun: boolean;
  stateFilePath: string;
  discordWebhookUrl?: string;
};

export function loadConfig(input: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir: string;
}): RuntimeConfig {
  const env = envSchema.parse(input.env);

  return {
    apiUrl: env.AGENTPACT_API_URL,
    adminApiKey: env.ADMIN_API_KEY,
    runnerCliPath: env.AUDIT_RUNNER_CLI_PATH,
    tickSeconds: env.FULFILLMENT_TICK_SECONDS,
    logLevel: env.LOG_LEVEL,
    dryRun: env.DRY_RUN,
    stateFilePath:
      env.AGENTPACT_STATE_FILE ??
      join(input.homeDir, ".agentpact-fulfillment", "state.json"),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
  };
}
