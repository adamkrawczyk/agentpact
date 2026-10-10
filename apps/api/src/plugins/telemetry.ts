// honest_0710 phase D — api_usage writer.
//
// One row per HTTP response: route TEMPLATE (never the raw URL), method,
// status, duration, the caller's agent id when known, and a coarse client
// kind. No IP and no raw user-agent are ever stored.
//
// The request path never touches the database: onResponse pushes into an
// in-memory queue (after the response has been sent) and a background flush
// writes it with ONE multi-row INSERT per batch, by size or by time. The
// queue is bounded — overflow is dropped and counted — and a failed flush is
// logged and counted, never thrown. onClose drains the queue so shutdown and
// tests are deterministic.
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Sql } from "postgres";
import { hashApiKey } from "../auth.js";

export type ClientKind = "mcp" | "sdk" | "browser" | "other";

export type UsageRow = {
  endpoint: string;
  method: string;
  statusCode: number;
  durationMs: number;
  /** Agent id set by the auth preHandler, when it ran. */
  agentId: string | null;
  /**
   * SHA-256 of a presented x-api-key on routes where auth did not run (public
   * GETs). Used only inside the INSERT to resolve the agent id; never stored.
   */
  apiKeyHash: string | null;
  clientKind: ClientKind;
  createdAt: Date;
};

export type UsageWriter = (rows: UsageRow[]) => Promise<void>;

export type TelemetryOptions = {
  sql?: Sql<Record<string, unknown>>;
  /** Overrides the SQL writer (tests). One call per batch. */
  writer?: UsageWriter;
  /** Flush as soon as this many rows are queued, and write at most this many per INSERT. */
  maxBatch?: number;
  /** Flush at least this often while rows are queued. */
  flushIntervalMs?: number;
  /** Rows beyond this are dropped and counted. */
  maxQueue?: number;
};

export type TelemetryStats = {
  queued: number;
  dropped: number;
  rowsWritten: number;
  rowsLost: number;
  flushFailures: number;
};

export const UNMATCHED_ROUTE = "<unmatched>";

// Health probes and CORS preflights are infrastructure noise, not usage.
const SKIPPED_PREFIXES = ["/health", "/api/health"];

declare module "fastify" {
  interface FastifyInstance {
    telemetry: UsageRecorder;
  }
}

export function classifyClient(headers: Record<string, string | string[] | undefined>): ClientKind {
  if (headers["mcp-protocol-version"] !== undefined) return "mcp";
  const raw = headers["user-agent"];
  const ua = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase() ?? "";
  if (!ua) return "other";
  if (ua.includes("mcp")) return "mcp";
  if (ua.startsWith("agentpact-")) return "sdk";
  if (ua.startsWith("mozilla/")) return "browser";
  return "other";
}

export class UsageRecorder {
  private queue: UsageRow[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private counters = { dropped: 0, rowsWritten: 0, rowsLost: 0, flushFailures: 0 };

  constructor(
    private readonly writer: UsageWriter,
    private readonly log: Pick<FastifyInstance["log"], "warn">,
    private readonly maxBatch: number,
    private readonly maxQueue: number,
  ) {}

  record(row: UsageRow): void {
    if (this.queue.length >= this.maxQueue) {
      this.counters.dropped++;
      return;
    }
    this.queue.push(row);
    if (this.queue.length >= this.maxBatch) void this.flush();
  }

  /** Writes everything queued so far. Never rejects. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  stats(): TelemetryStats {
    return { queued: this.queue.length, ...this.counters };
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.queue.length > 0) void this.flush();
    }, intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatch);
      try {
        await this.writer(batch);
        this.counters.rowsWritten += batch.length;
      } catch (err) {
        this.counters.flushFailures++;
        this.counters.rowsLost += batch.length;
        this.log.warn({ err, rows: batch.length }, "api_usage flush failed; batch dropped");
      }
    }
  }
}

/**
 * ONE multi-row INSERT per batch. The agent id is resolved inside the
 * statement (direct id, else the api-key hash) and joined against agents, so
 * an id that no longer exists becomes NULL instead of failing the batch.
 * lock_timeout keeps the writer from ever queueing behind a DDL lock.
 */
export function createSqlUsageWriter(sql: Sql<Record<string, unknown>>): UsageWriter {
  return async (rows) => {
    const payload = rows.map((r) => ({
      endpoint: r.endpoint,
      method: r.method,
      status_code: r.statusCode,
      response_time_ms: r.durationMs,
      agent_id: r.agentId,
      key_hash: r.apiKeyHash,
      client_kind: r.clientKind,
      created_at: r.createdAt.toISOString(),
    }));
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '500ms'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`
        INSERT INTO api_usage (endpoint, method, status_code, response_time_ms, agent_id, client_kind, created_at)
        SELECT r.endpoint, r.method, r.status_code, r.response_time_ms, a.id, r.client_kind, r.created_at
        FROM jsonb_to_recordset(${tx.json(payload)}::jsonb) AS r(
          endpoint TEXT, method TEXT, status_code INT, response_time_ms INT,
          agent_id UUID, key_hash TEXT, client_kind TEXT, created_at TIMESTAMPTZ
        )
        LEFT JOIN agents a ON a.id = COALESCE(
          r.agent_id,
          (SELECT ac.agent_id FROM agent_credentials ac
            WHERE r.key_hash IS NOT NULL AND ac.api_key_hash = r.key_hash AND ac.revoked_at IS NULL
            LIMIT 1)
        )
      `;
    });
  };
}

const telemetryPlugin: FastifyPluginAsync<TelemetryOptions> = async (app, opts) => {
  const writer = opts.writer ?? (opts.sql ? createSqlUsageWriter(opts.sql) : null);
  if (!writer) throw new Error("telemetry plugin needs either `sql` or `writer`");

  const recorder = new UsageRecorder(writer, app.log, opts.maxBatch ?? 200, opts.maxQueue ?? 10_000);
  recorder.start(opts.flushIntervalMs ?? 2_000);
  app.decorate("telemetry", recorder);

  app.addHook("onResponse", (request, reply, done) => {
    try {
      const endpoint = request.routeOptions.url ?? UNMATCHED_ROUTE;
      if (request.method !== "OPTIONS" && !SKIPPED_PREFIXES.some((p) => endpoint.startsWith(p))) {
        const rawKey = request.headers["x-api-key"];
        recorder.record({
          endpoint,
          method: request.method,
          statusCode: reply.statusCode,
          durationMs: Math.max(0, Math.round(reply.elapsedTime)),
          agentId: request.agentId ?? null,
          apiKeyHash:
            !request.agentId && typeof rawKey === "string" && rawKey.length >= 16
              ? hashApiKey(rawKey)
              : null,
          clientKind: classifyClient(request.headers),
          createdAt: new Date(),
        });
      }
    } catch (err) {
      request.log.warn({ err }, "api_usage record failed");
    }
    done();
  });

  app.addHook("onClose", async () => {
    await recorder.close();
  });
};

// Hooks and the `telemetry` decorator apply to the whole app, not just this
// plugin's scope (the same effect as wrapping with fastify-plugin).
(telemetryPlugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(telemetryPlugin as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] = "agentpact-telemetry";

export default telemetryPlugin;
