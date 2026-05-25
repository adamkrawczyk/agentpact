import { spawn } from "node:child_process";

const RUNNER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type RunnerResult = {
  report_md: string;
  severity_counts: { high: number; medium: number; low: number; info: number };
  verdict: "PASS" | "CONDITIONAL" | "FAIL";
  raw_slither_path?: string;
};

export class TimeoutError extends Error {
  constructor(orderId: string) {
    super(`audit-runner-cli timed out after ${RUNNER_TIMEOUT_MS / 1000}s for order ${orderId}`);
    this.name = "TimeoutError";
  }
}

export class RunnerError extends Error {
  constructor(
    message: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export async function runAuditRunner(input: {
  runnerCliPath: string;
  contractAddress: string;
  buyerEmail: string;
  orderId: string;
  dryRun?: boolean;
  spawnFn?: typeof spawn;
}): Promise<RunnerResult> {
  const spawnFn = input.spawnFn ?? spawn;
  const args = [input.runnerCliPath, input.contractAddress, input.buyerEmail, input.orderId];
  if (input.dryRun) args.push("--dry-run");

  return new Promise<RunnerResult>((resolve, reject) => {
    const child = spawnFn("npx", ["tsx", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TimeoutError(input.orderId));
    }, RUNNER_TIMEOUT_MS);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new RunnerError(`Runner spawn error: ${err.message}`, stderr));
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new RunnerError(
            `audit-runner-cli exited with code ${code ?? 1} for order ${input.orderId}`,
            stderr
          )
        );
        return;
      }
      try {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        const result = JSON.parse(lastLine) as RunnerResult;
        resolve(result);
      } catch {
        reject(
          new RunnerError(
            `audit-runner-cli produced invalid JSON for order ${input.orderId}`,
            stderr
          )
        );
      }
    });
  });
}
