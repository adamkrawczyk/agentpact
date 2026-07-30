import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isIntentCreationDisabled } from "./routes/utils.js";

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type SqlLike = {
  (template: TemplateStringsArray, ...parameters: readonly unknown[]): Promise<unknown[]> | unknown;
};

type MatchingQueueStatus = {
  dirty: boolean;
  inFlight: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
};

type HealthCheckStatus = "healthy" | "degraded" | "unhealthy";

type HealthCheck = {
  status: HealthCheckStatus;
  latencyMs?: number;
  error?: string;
  [key: string]: unknown;
};

type HealthOptions = {
  matchingQueueStatus?: () => MatchingQueueStatus;
  routeInventoryPath?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.();
  });
}

async function timedCheck<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<{ value?: T; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const value = await Promise.race([fn(), timeout<T>(timeoutMs, label)]);
    return { value, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDb(sql: SqlLike): Promise<HealthCheck> {
  const timeoutMs = envMs("HEALTH_DB_TIMEOUT_MS", 3000);
  const result = await timedCheck(async () => {
    await Promise.resolve(sql`SELECT 1 AS ok`);
  }, timeoutMs, "database health check");

  if (result.error) {
    return { status: "unhealthy", latencyMs: result.latencyMs, error: result.error };
  }
  return { status: "healthy", latencyMs: result.latencyMs };
}

async function checkBrowseSmoke(sql: SqlLike): Promise<HealthCheck> {
  const timeoutMs = envMs("HEALTH_DB_TIMEOUT_MS", 3000);
  const result = await timedCheck(async () => {
    const [offers, needs] = await Promise.all([
      Promise.resolve(sql`SELECT id FROM offers WHERE status = 'active' ORDER BY created_at DESC LIMIT 5`),
      Promise.resolve(sql`SELECT id FROM needs WHERE status = 'open' ORDER BY created_at DESC LIMIT 5`),
    ]);
    return {
      offersSampled: Array.isArray(offers) ? offers.length : undefined,
      needsSampled: Array.isArray(needs) ? needs.length : undefined,
    };
  }, timeoutMs, "browse smoke check");

  if (result.error) {
    return { status: "unhealthy", latencyMs: result.latencyMs, error: result.error };
  }
  return { status: "healthy", latencyMs: result.latencyMs, ...(result.value ?? {}) };
}

function checkMatching(statusFn?: () => MatchingQueueStatus): HealthCheck {
  if (!statusFn) {
    return { status: "degraded", observable: false, error: "matching queue status callback not registered" };
  }

  const status = statusFn();
  const stuckAfterMs = envMs("MATCHING_STUCK_AFTER_MS", 5 * 60 * 1000);
  const lastStartedMs = status.lastStartedAt ? Date.parse(status.lastStartedAt) : undefined;
  const inFlightMs = status.inFlight && lastStartedMs && Number.isFinite(lastStartedMs)
    ? Date.now() - lastStartedMs
    : 0;
  const stuck = status.inFlight && inFlightMs > stuckAfterMs;

  return {
    status: stuck || status.lastError ? "degraded" : "healthy",
    observable: true,
    stuck,
    stuckAfterMs,
    inFlightMs,
    ...status,
  };
}

function checkRegistrationPath(): HealthCheck {
  const intentionallyDisabled = process.env.AGENTPACT_REGISTRATION_DISABLED === "true";
  return {
    status: intentionallyDisabled ? "degraded" : "healthy",
    enabled: !intentionallyDisabled,
    intentionallyDisabled,
    route: "/api/auth/register",
  };
}

// Surfaces the settlement-protocol emergency brake. An operator who trips
// INTENT_CREATION_DISABLED must be able to CONFIRM it took effect without
// attempting a real mint — a kill switch you cannot observe is a kill switch you
// cannot trust. Informational only: a tripped brake is `degraded`, never a 503,
// because the API is deliberately healthy-but-restricted in that state.
function checkIntentCreationPath(): HealthCheck {
  const intentionallyDisabled = isIntentCreationDisabled();
  return {
    status: intentionallyDisabled ? "degraded" : "healthy",
    enabled: !intentionallyDisabled,
    intentionallyDisabled,
    route: "/api/intents",
    note: intentionallyDisabled
      ? "Intent creation is disabled (both POST /api/intents and the deal-accept auto-mint). In-flight intents remain fundable, revealable, claimable, and cancellable."
      : undefined,
  };
}

async function checkRouteInventory(routeInventoryPath: string): Promise<HealthCheck> {
  const requiredRoutes = [
    "`/api/health`",
    "`/api/health/db`",
    "`/api/health/matching`",
    "`/api/health/agent-runtime`",
  ];

  try {
    await access(routeInventoryPath);
    const content = await readFile(routeInventoryPath, "utf8");
    const missingRoutes = requiredRoutes.filter((route) => !content.includes(route));
    return {
      status: missingRoutes.length === 0 ? "healthy" : "degraded",
      path: routeInventoryPath,
      current: missingRoutes.length === 0,
      missingRoutes,
    };
  } catch (error) {
    return {
      status: "degraded",
      path: routeInventoryPath,
      current: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sendByHealth<T extends { ok: boolean }>(reply: FastifyReply, payload: T, unhealthyCode = 503): T | FastifyReply {
  if (!payload.ok) return reply.code(unhealthyCode).send(payload);
  return payload;
}

export function registerHealthChecks(
  app: FastifyInstance,
  sql: SqlLike,
  options: HealthOptions = {},
) {
  const routeInventoryPath = options.routeInventoryPath ?? join(process.cwd(), "docs/API_ROUTE_INVENTORY.md");

  const baseHealth = () => ({
    ok: true,
    service: "agentpact-api",
    timestamp: nowIso(),
  });

  app.get("/health", async () => baseHealth());
  app.get("/api/health", async () => baseHealth());

  app.get("/api/health/db", async (_request, reply) => {
    const database = await checkDb(sql);
    return sendByHealth(reply, {
      ok: database.status === "healthy",
      service: "agentpact-api",
      timestamp: nowIso(),
      checks: { database },
    });
  });

  app.get("/api/health/matching", async (_request, reply) => {
    const matching = checkMatching(options.matchingQueueStatus);
    return sendByHealth(reply, {
      ok: matching.status === "healthy",
      service: "agentpact-api",
      timestamp: nowIso(),
      checks: { matching },
    });
  });

  app.get("/api/health/agent-runtime", async (_request, reply) => {
    const [database, browseSmoke, routeInventory] = await Promise.all([
      checkDb(sql),
      checkBrowseSmoke(sql),
      checkRouteInventory(routeInventoryPath),
    ]);
    const matching = checkMatching(options.matchingQueueStatus);
    const registration = checkRegistrationPath();
    const intentCreation = checkIntentCreationPath();
    const testDatabase = {
      status: process.env.TEST_DATABASE_URL ? "healthy" : "degraded",
      configured: Boolean(process.env.TEST_DATABASE_URL),
      note: process.env.TEST_DATABASE_URL
        ? "TEST_DATABASE_URL is configured for deterministic API tests."
        : "Set TEST_DATABASE_URL for deterministic local/CI API tests; otherwise tests fall back to Testcontainers.",
    };

    const checks = {
      database,
      browseSmoke,
      matching,
      registration,
      intentCreation,
      routeInventory,
      testDatabase,
    };
    // ok = true only when core runtime health is confirmed.
    // informational checks (registration intentionally disabled, intentCreation
    // intentionally disabled, routeInventory staleness,
    // testDatabase not configured) do not block agent operations and must not cause 503.
    const matchingStuck = Boolean(matching.stuck);
    const ok =
      database.status === "healthy" &&
      browseSmoke.status === "healthy" &&
      !matchingStuck;

    return sendByHealth(reply, {
      ok,
      service: "agentpact-api",
      timestamp: nowIso(),
      checks,
    });
  });

  app.get("/health/detailed", async (_request, reply) => {
    const database = await checkDb(sql);
    const checks: Record<string, HealthCheck | string> = {
      api: { status: "healthy" },
      database,
      // Emergency-brake state. Present on BOTH /health and /health/detailed:
      // an operator tripping the brake under pressure should not have to know
      // which of the two endpoints carries it.
      intentCreation: checkIntentCreationPath(),
      timestamp: nowIso(),
    };

    return sendByHealth(reply, {
      // A tripped brake must NOT make this endpoint unhealthy — it is an
      // intentional, healthy-but-restricted state, not an outage.
      ok: database.status === "healthy",
      checks,
    });
  });

  app.get("/ready", async () => {
    const database = await checkDb(sql);
    return { ready: database.status === "healthy" };
  });

  app.get("/live", async () => {
    return { alive: true };
  });
}
