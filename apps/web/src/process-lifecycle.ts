// Copy of apps/api/src/process-lifecycle.ts (workspaces do not share source).
// Keep the two in sync: apps/web/src/process-lifecycle.test.ts pins the
// behaviour and fails if the two copies drift.
// Process lifecycle glue for running under pm2 cluster mode
// (deploy/ecosystem.config.cjs). Kept free of app imports so it can be
// unit-tested without a database.
//
// A zero-downtime `pm2 reload` works like this:
//   1. pm2 forks a NEW worker; the pm2 daemon keeps owning the listen socket.
//   2. With wait_ready, pm2 waits for the worker's process.send('ready').
//   3. Only then does pm2 send SIGINT to the OLD worker, which must stop
//      accepting, finish in-flight requests, and exit on its own (pm2 sends
//      SIGKILL after kill_timeout).
// notifyPm2Ready covers step 2 and installGracefulShutdown covers step 3.
//
// Why step 3 starts with a drain window instead of closing at once: the
// reverse proxy keeps a pool of keep-alive connections to the worker. Closing
// the server closes the idle ones immediately, and a proxy that writes a
// request onto such a socket at that instant gets a reset. It retries GETs on
// a fresh connection but not POSTs, so those surface as 502. Measured under
// keep-alive load: 4-9 POST 502s per reload with an immediate close, 0 with a
// drain window. During the window the worker keeps serving and answers every
// request with `Connection: close`, so the proxy itself retires each pooled
// socket after its next response; new connections already go to the new
// worker as well. Only then does close() run.

type Sender = ((message: unknown) => boolean) | undefined;

/**
 * Tell pm2 this worker is serving. Call only after app.listen() resolves.
 * A no-op when the process has no IPC channel (plain `node`, tests, docker).
 */
export function notifyPm2Ready(send: Sender = process.send?.bind(process)): boolean {
  if (typeof send !== "function") return false;
  try {
    send("ready");
    return true;
  } catch {
    // The IPC channel can already be closed during a racing shutdown.
    return false;
  }
}

export interface GracefulShutdownOptions {
  /** Hard deadline for drain + close(); exit 1 if it is exceeded. Keep it below pm2 kill_timeout. */
  timeoutMs?: number;
  /**
   * Keep serving for this long before close(), with onDrainStart already
   * called (the app answers `Connection: close` from then on). 0 = close now.
   */
  drainMs?: number;
  /** Called once when the signal arrives, before the drain window. */
  onDrainStart?: () => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  signals?: NodeJS.Signals[];
  /** Where the signal handlers are attached (injectable for tests). */
  target?: Pick<NodeJS.Process, "once">;
}

/**
 * On SIGINT/SIGTERM: call onDrainStart, keep serving for drainMs, then run
 * close() once (stop accepting, finish in-flight requests, release DB
 * pools), then exit. Exiting explicitly matters: under
 * pm2 cluster mode the IPC channel keeps the event loop alive, so a worker
 * that only closes its server would sit until pm2's SIGKILL and turn every
 * reload into a kill_timeout wait.
 *
 * Returns the shutdown function so callers and tests can trigger it directly.
 */
export function installGracefulShutdown(
  close: () => Promise<unknown>,
  {
    timeoutMs = 25_000,
    drainMs = 0,
    onDrainStart = () => {},
    exit = (code) => process.exit(code),
    log = (message) => console.log(message),
    signals = ["SIGINT", "SIGTERM"],
    target = process,
  }: GracefulShutdownOptions = {},
): (signal?: string) => Promise<void> {
  let started: Promise<void> | null = null;

  const shutdown = (signal = "manual"): Promise<void> => {
    if (started) return started;
    log(`[lifecycle] ${signal}: draining for ${drainMs}ms, then closing and exiting`);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref();
    });
    const drainThenClose = async () => {
      onDrainStart();
      if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
      await close();
      return "closed" as const;
    };
    started = Promise.race([drainThenClose(), deadline])
      .then(
        (outcome) => {
          if (outcome === "timeout") {
            log(`[lifecycle] drain + close() exceeded ${timeoutMs}ms; exiting anyway`);
            exit(1);
          } else {
            exit(0);
          }
        },
        (error: unknown) => {
          log(`[lifecycle] close() failed: ${error instanceof Error ? error.message : String(error)}`);
          exit(1);
        },
      )
      .finally(() => clearTimeout(timer));
    return started;
  };

  for (const signal of signals) {
    target.once(signal, () => void shutdown(signal));
  }
  return shutdown;
}

/**
 * Drain window length from SHUTDOWN_DRAIN_MS (default 3000 ms). Clamped to
 * [0, 10000] so a typo cannot push drain + close past pm2's kill_timeout.
 */
export function drainMsFromEnv(raw: string | undefined = process.env.SHUTDOWN_DRAIN_MS): number {
  const n = raw === undefined || raw.trim() === "" ? 3000 : Number(raw);
  if (!Number.isFinite(n)) return 3000;
  return Math.min(10_000, Math.max(0, Math.round(n)));
}
