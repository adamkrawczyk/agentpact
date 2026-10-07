/**
 * Shared harness for the web route tests: spawn the server, wait for it, and
 * tear down the WHOLE process tree.
 *
 * Why this exists: the old pattern spawned `npx tsx ...` and killed only the npx
 * PID. tsx's node grandchild survived, kept the port, and the next run's
 * waitForServer() accepted that stale server (running OLD code) as ready. Tests
 * then asserted against code that was no longer on disk. Two guards fix it:
 *   1. spawn detached (own process group) and kill the group (-pid);
 *   2. refuse to start if the port is already taken, so a leak fails loudly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolvePromise(true);
    });
    sock.once("error", () => resolvePromise(false));
  });
}

export async function waitForServer(url: string, retries = 60, delayMs = 150): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (r.status < 600) return;
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new Error(`Server at ${url} did not start after ${(retries * delayMs) / 1000}s`);
}

export async function startServer(opts: {
  src: string;
  port: number;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<ChildProcess> {
  if (await portInUse(opts.port)) {
    throw new Error(
      `port ${opts.port} is already in use: a leaked server from an earlier run would answer ` +
        `with stale code. Kill it first (ss -ltnp | grep ${opts.port}).`,
    );
  }
  const child = spawn("npx", ["tsx", "--no-cache", opts.src], {
    cwd: opts.cwd,
    env: { ...process.env, PORT: String(opts.port), ...(opts.env ?? {}) },
    stdio: "ignore",
    detached: true, // own process group, so stopServer can kill npx + tsx + node together
  });
  child.unref();
  await waitForServer(`http://localhost:${opts.port}/robots.txt`);
  return child;
}

export function stopServer(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}
