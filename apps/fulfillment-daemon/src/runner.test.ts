import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { runAuditRunner, TimeoutError, RunnerError } from "./runner.js";

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig: string) => void;
};

function makeSpawn(opts: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number;
  triggerTimeout?: boolean;
}): typeof import("node:child_process").spawn {
  return ((_cmd: string, _args: string[], _options: unknown) => {
    const child: MockChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (_sig: string) => {
        // simulated kill — do nothing extra, timeout triggers rejection
      },
    });

    setTimeout(() => {
      if (opts.stderrData) {
        child.stderr.emit("data", Buffer.from(opts.stderrData));
      }
      if (opts.stdoutData !== undefined) {
        child.stdout.emit("data", Buffer.from(opts.stdoutData));
      }
      if (!opts.triggerTimeout) {
        child.emit("exit", opts.exitCode ?? 0);
      }
    }, 10);

    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
}

const validResult = {
  report_md: "# Audit",
  severity_counts: { high: 0, medium: 0, low: 1, info: 2 },
  verdict: "PASS",
  raw_slither_path: "/tmp/audit-order-1.json",
};

test("runner: valid JSON stdout → returns parsed result", async () => {
  const spawn = makeSpawn({ stdoutData: JSON.stringify(validResult) });
  const result = await runAuditRunner({
    runnerCliPath: "/app/scripts/audit-runner-cli.ts",
    contractAddress: "0xABC",
    buyerEmail: "a@b.com",
    orderId: "order-1",
    spawnFn: spawn,
  });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.severity_counts, { high: 0, medium: 0, low: 1, info: 2 });
});

test("runner: non-zero exit → throws RunnerError with stderr", async () => {
  const spawn = makeSpawn({ exitCode: 1, stderrData: "slither crashed" });
  await assert.rejects(
    () =>
      runAuditRunner({
        runnerCliPath: "/app/scripts/audit-runner-cli.ts",
        contractAddress: "0xABC",
        buyerEmail: "a@b.com",
        orderId: "order-1",
        spawnFn: spawn,
      }),
    (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.match(err.stderr, /slither crashed/);
      return true;
    }
  );
});

test("runner: invalid JSON stdout → throws RunnerError", async () => {
  const spawn = makeSpawn({ stdoutData: "not-json" });
  await assert.rejects(
    () =>
      runAuditRunner({
        runnerCliPath: "/app/scripts/audit-runner-cli.ts",
        contractAddress: "0xABC",
        buyerEmail: "a@b.com",
        orderId: "order-1",
        spawnFn: spawn,
      }),
    (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      return true;
    }
  );
});
