import { sendHeartbeat } from "./heartbeat.js";
import { watchMarket } from "./watcher.js";
import { loadState } from "./state.js";
async function fetchJson(input) {
    const response = await input.fetchFn(`${input.apiUrl}${input.path}`, {
        method: input.method ?? "GET",
        headers: {
            "content-type": "application/json",
            "x-api-key": input.apiKey,
        },
    });
    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
        throw new Error(`${input.method ?? "GET"} ${input.path} failed with ${response.status}: ${text}`);
    }
    return body;
}
function validateAutopilot(config) {
    if (config.autopilot.threshold < 0 || config.autopilot.threshold > 1) {
        throw new Error("AGENTPACT_AUTOPILOT_THRESHOLD must be between 0 and 1");
    }
    if (config.autopilot.maxPrice <= 0) {
        throw new Error("AGENTPACT_AUTOPILOT_MAX_PRICE must be positive");
    }
    if (config.autopilot.rateLimitPerHour <= 0) {
        throw new Error("AGENTPACT_AUTOPILOT_RATE_LIMIT must be positive");
    }
    return config.autopilot.enabled ? "enabled" : "disabled";
}
export async function runSelfCheck(input) {
    const fetchFn = input.fetchFn ?? fetch;
    const log = input.log ?? console.log;
    const results = [];
    async function check(name, fn) {
        try {
            const detail = await fn();
            results.push({ name, ok: true, ...(detail ? { detail } : {}) });
            log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            results.push({ name, ok: false, detail });
            log(`FAIL ${name} - ${detail}`);
        }
    }
    await check("API reachable", async () => {
        await fetchJson({ fetchFn, apiUrl: input.config.apiUrl, path: "/api/health", apiKey: input.config.apiKey });
    });
    await check("auth works", async () => {
        const body = await fetchJson({ fetchFn, apiUrl: input.config.apiUrl, path: "/api/auth/verify", apiKey: input.config.apiKey });
        const agentId = body && typeof body === "object" ? body.agentId : undefined;
        if (agentId && String(agentId) !== input.config.agentId) {
            throw new Error(`API key belongs to ${String(agentId)}, expected ${input.config.agentId}`);
        }
    });
    await check("agent exists", async () => {
        await fetchJson({
            fetchFn,
            apiUrl: input.config.apiUrl,
            path: `/api/agents/${encodeURIComponent(input.config.agentId)}`,
            apiKey: input.config.apiKey,
        });
    });
    await check("heartbeat works", async () => {
        await sendHeartbeat({ config: input.config, fetchFn });
    });
    await check("recommendations endpoint works", async () => {
        const state = loadState(input.config.stateFilePath);
        const result = await watchMarket({
            apiUrl: input.config.apiUrl,
            apiKey: input.config.apiKey,
            agentId: input.config.agentId,
            state,
            nowIso: new Date().toISOString(),
            fetchFn,
        });
        return `${result.matches.length} matches`;
    });
    await check("autopilot config valid", async () => validateAutopilot(input.config));
    return results;
}
