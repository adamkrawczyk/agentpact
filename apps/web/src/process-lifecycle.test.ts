// Pins the pm2 cluster-mode lifecycle contract that zero-downtime reloads
// depend on (deploy/ecosystem.config.cjs). See process-lifecycle.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drainMsFromEnv, installGracefulShutdown, notifyPm2Ready } from "./process-lifecycle.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function harness(close: () => Promise<unknown>, timeoutMs = 1_000) {
  const target = new EventEmitter();
  const exits: number[] = [];
  const logs: string[] = [];
  const run = installGracefulShutdown(close, {
    timeoutMs,
    target: target as unknown as Pick<NodeJS.Process, "once">,
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
  });
  return { target, exits, logs, run };
}

test("notifyPm2Ready sends exactly 'ready' when an IPC channel exists", () => {
  const sent: unknown[] = [];
  assert.equal(notifyPm2Ready((m) => (sent.push(m), true)), true);
  assert.deepEqual(sent, ["ready"]);
});

test("notifyPm2Ready is a no-op without IPC and survives a closed channel", () => {
  assert.equal(notifyPm2Ready(undefined), false);
  assert.equal(
    notifyPm2Ready(() => {
      throw new Error("channel closed");
    }),
    false,
  );
});

test("SIGINT drains via close() and then exits 0", async () => {
  let closed = false;
  const h = harness(async () => {
    await new Promise((r) => setTimeout(r, 20));
    closed = true;
  });
  h.target.emit("SIGINT");
  await h.run(); // same promise as the signal-triggered run
  assert.equal(closed, true);
  assert.deepEqual(h.exits, [0]);
});

test("exit happens only after close() resolves, not on the signal", async () => {
  let release!: () => void;
  const h = harness(() => new Promise<void>((r) => (release = r)));
  h.target.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.exits, [], "must not exit while requests are draining");
  release();
  await h.run();
  assert.deepEqual(h.exits, [0]);
});

test("a second signal does not run close() twice", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
  });
  h.target.emit("SIGINT");
  h.target.emit("SIGTERM");
  await h.run();
  assert.equal(calls, 1);
  assert.deepEqual(h.exits, [0]);
});

test("close() that hangs past the deadline exits 1", async () => {
  const h = harness(() => new Promise(() => {}), 30);
  h.target.emit("SIGINT");
  await h.run();
  assert.deepEqual(h.exits, [1]);
});

test("close() that rejects exits 1", async () => {
  const h = harness(async () => {
    throw new Error("pool end failed");
  });
  h.target.emit("SIGINT");
  await h.run();
  assert.deepEqual(h.exits, [1]);
  assert.ok(h.logs.some((l) => l.includes("pool end failed")));
});

test("drain window: onDrainStart fires at once, close() only after drainMs", async () => {
  const events: string[] = [];
  const target = new EventEmitter();
  const t0 = Date.now();
  let closedAt = 0;
  const run = installGracefulShutdown(
    async () => {
      closedAt = Date.now() - t0;
      events.push("close");
    },
    {
      drainMs: 60,
      onDrainStart: () => events.push("drain"),
      target: target as unknown as Pick<NodeJS.Process, "once">,
      exit: (code) => events.push(`exit:${code}`),
      log: () => {},
    },
  );
  target.emit("SIGINT");
  assert.deepEqual(events, ["drain"], "drain starts synchronously with the signal; nothing closed yet");
  await run();
  assert.deepEqual(events, ["drain", "close", "exit:0"]);
  assert.ok(closedAt >= 55, `close() ran after ${closedAt}ms, expected >= drainMs`);
});

test("drain + close share the deadline", async () => {
  const exits: number[] = [];
  const target = new EventEmitter();
  const run = installGracefulShutdown(async () => {}, {
    drainMs: 200,
    timeoutMs: 30,
    target: target as unknown as Pick<NodeJS.Process, "once">,
    exit: (code) => exits.push(code),
    log: () => {},
  });
  target.emit("SIGTERM");
  await run();
  assert.deepEqual(exits, [1]);
});

test("drainMsFromEnv: default 3000, clamped to [0, 10000], junk falls back", () => {
  assert.equal(drainMsFromEnv(undefined), 3000);
  assert.equal(drainMsFromEnv(""), 3000);
  assert.equal(drainMsFromEnv("1500"), 1500);
  assert.equal(drainMsFromEnv("0"), 0);
  assert.equal(drainMsFromEnv("-5"), 0);
  assert.equal(drainMsFromEnv("999999"), 10_000);
  assert.equal(drainMsFromEnv("abc"), 3000);
});

test("ecosystem kill_timeout covers the longest drain + the app deadline", () => {
  // installGracefulShutdown's default deadline (25 s) already includes the
  // drain window (max 10 s); pm2 must not SIGKILL before that deadline.
  const src = readFileSync(resolve(repoRoot, "deploy/ecosystem.config.cjs"), "utf8");
  const kill = Number(/kill_timeout:\s*(\d+)/.exec(src)?.[1]);
  assert.ok(kill > 25_000, `kill_timeout ${kill} must exceed the 25 s app deadline`);
});

test("api and web copies of process-lifecycle.ts are identical", () => {
  const body = (p: string) =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("// Copy of") && !l.startsWith("// Keep the two in sync") && !l.startsWith("// behaviour and fails"))
      .join("\n");
  assert.equal(
    body(resolve(repoRoot, "apps/web/src/process-lifecycle.ts")),
    body(resolve(repoRoot, "apps/api/src/process-lifecycle.ts")),
  );
});

test("ecosystem: api/web reload in cluster mode with wait_ready; relayer/mcp stay single fork", () => {
  const prevEnv = process.env.AGENTPACT_ENV_FILE;
  const tmpEnv = resolve(repoRoot, "deploy", ".ecosystem-test.env");
  // Minimal env so the ecosystem file can be loaded off-box.
  writeFileSync(tmpEnv, "DATABASE_URL=postgres://u:p@db.example:6543/app\nAPI_PORT=4000\n");
  try {
    process.env.AGENTPACT_ENV_FILE = tmpEnv;
    const req = createRequire(import.meta.url);
    const { apps } = req(resolve(repoRoot, "deploy/ecosystem.config.cjs")) as {
      apps: Array<Record<string, unknown> & { env: Record<string, string> }>;
    };
    const byName = Object.fromEntries(apps.map((a) => [a.name as string, a]));
    assert.deepEqual(Object.keys(byName).sort(), ["ap-api", "ap-mcp", "ap-relayer", "ap-web"]);

    for (const name of ["ap-api", "ap-web"]) {
      const a = byName[name];
      assert.equal(a.exec_mode, "cluster", `${name} must be cluster mode for zero-downtime reload`);
      assert.equal(a.wait_ready, true, `${name} must wait for process.send('ready')`);
      assert.ok(Number(a.listen_timeout) >= 30_000, `${name} listen_timeout must cover boot-time schema checks`);
      // The app's own drain deadline (25s default) must fit inside pm2's SIGKILL deadline.
      assert.ok(Number(a.kill_timeout) > 25_000, `${name} kill_timeout must exceed the app drain deadline`);
      assert.equal(a.merge_logs, true, `${name} must keep un-suffixed log file names`);
    }
    for (const name of ["ap-relayer", "ap-mcp"]) {
      assert.equal(byName[name].exec_mode, "fork", `${name} must stay fork mode`);
      assert.equal(byName[name].instances, 1, `${name} must stay a single instance`);
    }
    assert.equal(byName["ap-api"].env.RUN_MIGRATIONS, "false", "API boot must never run migrations");
    assert.equal(byName["ap-relayer"].env.DATABASE_URL, "postgres://u:p@db.example:5432/app", "relayer uses session-mode port");
    assert.equal(byName["ap-api"].env.DATABASE_URL, "postgres://u:p@db.example:6543/app");
    // Scripts resolve inside the app root, not a hardcoded path.
    assert.equal(byName["ap-api"].script, resolve(repoRoot, "apps/api/dist/server.js"));
  } finally {
    rmSync(tmpEnv, { force: true });
    if (prevEnv === undefined) delete process.env.AGENTPACT_ENV_FILE;
    else process.env.AGENTPACT_ENV_FILE = prevEnv;
  }
});
