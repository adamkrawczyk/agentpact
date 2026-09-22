// apps/relayer-daemon/src/entrypoint.test.ts
//
// Regression for the 2026-09-22 prod incident: under pm2 fork mode
// process.argv[1] is pm2's ProcessContainerFork.js, so the daemon's old
// `import.meta.url === file://argv[1]` entrypoint check was always false and
// every sweeper silently never started. This spawns the built daemon the way
// pm2 does (argv[1] = a foreign wrapper, real script only in pm_exec_path) and
// asserts it still boots and listens.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function bootLikePm2(port: number, env: Record<string, string>): Promise<{ listening: boolean; out: string }> {
  // Foreign wrapper that imports the real script, exactly like pm2's fork container.
  const dir = mkdtempSync(join(tmpdir(), "relayer-pm2-"));
  const wrapper = join(dir, "ProcessContainerFork.mjs");
  writeFileSync(wrapper, `import(${JSON.stringify(DIST)});`);
  return new Promise((res) => {
    let out = "";
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://x:y@127.0.0.1:1/nope",
        RELAYER_HOST: "127.0.0.1",
        RELAYER_PORT: String(port),
        ...env,
      },
    });
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const done = (listening: boolean) => {
      child.kill("SIGKILL");
      res({ listening, out });
    };
    const t = setTimeout(() => done(out.includes("relayer-daemon.listening")), 6000);
    child.stdout.on("data", () => {
      if (out.includes("relayer-daemon.listening")) { clearTimeout(t); done(true); }
    });
    child.on("exit", () => { clearTimeout(t); done(out.includes("relayer-daemon.listening")); });
  });
}

describe("relayer entrypoint detection", () => {
  const skip = !existsSync(DIST);
  it("boots when argv[1] is a foreign wrapper but pm_exec_path names the script (pm2 fork mode)", { skip }, async () => {
    const port = await freePort();
    const r = await bootLikePm2(port, { pm_exec_path: DIST });
    assert.equal(r.listening, true, r.out);
  });
  it("stays inert when imported as a library (no pm_exec_path, foreign argv[1])", { skip }, async () => {
    const port = await freePort();
    const r = await bootLikePm2(port, { pm_exec_path: "" });
    assert.equal(r.listening, false, r.out);
  });
});
