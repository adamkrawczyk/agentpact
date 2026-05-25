import { existsSync } from "node:fs";
export async function runSelfCheck(input) {
    const fetchFn = input.fetchFn ?? fetch;
    const results = [];
    // 1. ADMIN_API_KEY present
    results.push({
        check: "ADMIN_API_KEY",
        ok: input.config.adminApiKey.length > 0,
        message: input.config.adminApiKey.length > 0
            ? "ADMIN_API_KEY is set"
            : "ADMIN_API_KEY is missing",
    });
    // 2. AGENTPACT_API_URL reachable via /health
    try {
        const response = await fetchFn(`${input.config.apiUrl}/health`);
        results.push({
            check: "API_HEALTH",
            ok: response.ok,
            message: response.ok
                ? `GET ${input.config.apiUrl}/health => ${response.status}`
                : `GET ${input.config.apiUrl}/health returned ${response.status}`,
        });
    }
    catch (error) {
        results.push({
            check: "API_HEALTH",
            ok: false,
            message: `GET ${input.config.apiUrl}/health failed: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
    // 3. AUDIT_RUNNER_CLI_PATH exists
    const cliExists = existsSync(input.config.runnerCliPath);
    results.push({
        check: "RUNNER_CLI_PATH",
        ok: cliExists,
        message: cliExists
            ? `${input.config.runnerCliPath} exists`
            : `${input.config.runnerCliPath} not found`,
    });
    for (const result of results) {
        const icon = result.ok ? "✅" : "❌";
        console.log(`${icon} [${result.check}] ${result.message}`);
    }
    return results;
}
