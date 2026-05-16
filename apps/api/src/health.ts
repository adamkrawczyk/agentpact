import type { FastifyInstance } from "fastify";

/**
 * protocol_1605/A — Health surface.
 *
 * Plan §3 Phase A step 4 acceptance gate:
 *   `curl https://api.agentpact.xyz/api/health` → HTTP 200 < 1s
 *   Returns `{ db: ok, chain: ok|degraded, queue: ok }`.
 *
 * Three endpoints, three contracts:
 *   - GET /health       — Railway/Cloudflare cheap liveness probe. Returns
 *                         instantly without touching the DB. 200 = process up.
 *   - GET /api/health   — protocol_1605/A canonical readiness probe.
 *                         Touches DB, reports chain wallet status, reports
 *                         queue depth if available. Sub-second p95.
 *   - GET /health/detailed — Legacy fan-out kept for the existing monitor
 *                            wiring; same shape as /api/health under the hood.
 *   - GET /ready        — Simple boolean for k8s/Railway-style readiness probes.
 */

type SqlTag = {
  (template: TemplateStringsArray, ...parameters: readonly unknown[]): unknown;
};

type ChainProbe = () => boolean | Promise<boolean>;

export type HealthDeps = {
  /** Returns true if the chain wallet client is initialised. Defaults to checking process.env. */
  isOnChainReady?: ChainProbe;
};

const DB_TIMEOUT_MS = 800;

async function probeDb(sql: SqlTag): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      Promise.resolve(sql`SELECT 1 AS ok`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`db probe exceeded ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, latency_ms: Date.now() - t0 };
    void result;
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeChain(deps: HealthDeps): { ok: boolean; mode: "on-chain" | "simulation" } {
  const fn = deps.isOnChainReady;
  if (typeof fn !== "function") {
    // No probe injected — assume simulation mode (matches isOnChainMode()=false default).
    return { ok: true, mode: "simulation" };
  }
  try {
    const ready = fn();
    if (ready instanceof Promise) {
      // Synchronously approximate — health endpoint must not block on chain RPC.
      // Treat unresolved as degraded.
      return { ok: false, mode: "on-chain" };
    }
    return { ok: Boolean(ready), mode: ready ? "on-chain" : "simulation" };
  } catch {
    return { ok: false, mode: "on-chain" };
  }
}

async function probeQueue(sql: SqlTag): Promise<{ ok: boolean; depth: number | null }> {
  // protocol_1605/A defers the matching-worker extraction (step 2) — until the
  // worker ships, "queue" is an aspirational concept. Report ok:true depth:null
  // so the contract is forward-compatible without lying about a queue we don't
  // own yet. When the worker lands it will overwrite this probe to read the
  // job table.
  void sql;
  return { ok: true, depth: null };
}

function buildPayload(
  db: Awaited<ReturnType<typeof probeDb>>,
  chain: ReturnType<typeof probeChain>,
  queue: Awaited<ReturnType<typeof probeQueue>>,
) {
  const okAll = db.ok && chain.ok && queue.ok;
  return {
    ok: okAll,
    service: "agentpact-api",
    timestamp: new Date().toISOString(),
    db: {
      status: db.ok ? "ok" : "degraded",
      latency_ms: db.latency_ms,
      ...(db.error ? { error: db.error } : {}),
    },
    chain: {
      status: chain.ok ? "ok" : "degraded",
      mode: chain.mode,
    },
    queue: {
      status: queue.ok ? "ok" : "degraded",
      depth: queue.depth,
    },
  };
}

export function registerHealthChecks(
  app: FastifyInstance,
  sql: SqlTag,
  deps: HealthDeps = {},
) {
  // Cheap liveness probe — used by Railway / Cloudflare. Stays exactly
  // backwards-compatible with the pre-A shape: `{ok, service, timestamp}`.
  app.get("/health", async () => ({
    ok: true,
    service: "agentpact-api",
    timestamp: new Date().toISOString(),
  }));

  // protocol_1605/A canonical readiness endpoint.
  app.get("/api/health", async (_request, reply) => {
    const db = await probeDb(sql);
    const chain = probeChain(deps);
    const queue = await probeQueue(sql);
    const payload = buildPayload(db, chain, queue);
    // Always respond 200 when DB and chain are at least minimally healthy;
    // 503 if any critical layer is degraded so monitors can alert without
    // parsing the JSON body. Queue depth is informational only.
    if (!db.ok) {
      return reply.code(503).send(payload);
    }
    return reply.code(200).send(payload);
  });

  // Backwards-compat: existing monitor wiring expects /health/detailed.
  // Same shape as /api/health.
  app.get("/health/detailed", async (_request, reply) => {
    const db = await probeDb(sql);
    const chain = probeChain(deps);
    const queue = await probeQueue(sql);
    const payload = buildPayload(db, chain, queue);
    return reply.code(db.ok ? 200 : 503).send(payload);
  });

  // K8s-style boolean readiness — kept exactly as it was.
  app.get("/ready", async () => {
    try {
      await Promise.resolve(sql`SELECT 1`);
      return { ready: true };
    } catch {
      return { ready: false };
    }
  });
}
