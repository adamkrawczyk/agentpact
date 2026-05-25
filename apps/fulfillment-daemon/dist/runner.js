import { spawn } from "node:child_process";
const RUNNER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export class TimeoutError extends Error {
    constructor(orderId) {
        super(`audit-runner-cli timed out after ${RUNNER_TIMEOUT_MS / 1000}s for order ${orderId}`);
        this.name = "TimeoutError";
    }
}
export class RunnerError extends Error {
    stderr;
    constructor(message, stderr) {
        super(message);
        this.stderr = stderr;
        this.name = "RunnerError";
    }
}
export async function runAuditRunner(input) {
    const spawnFn = input.spawnFn ?? spawn;
    const args = [input.runnerCliPath, input.contractAddress, input.buyerEmail, input.orderId];
    if (input.dryRun)
        args.push("--dry-run");
    return new Promise((resolve, reject) => {
        const child = spawnFn("npx", ["tsx", ...args], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
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
                reject(new RunnerError(`audit-runner-cli exited with code ${code ?? 1} for order ${input.orderId}`, stderr));
                return;
            }
            try {
                const lastLine = stdout.trim().split("\n").pop() ?? "";
                const result = JSON.parse(lastLine);
                resolve(result);
            }
            catch {
                reject(new RunnerError(`audit-runner-cli produced invalid JSON for order ${input.orderId}`, stderr));
            }
        });
    });
}
