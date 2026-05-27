// apps/relayer-daemon/src/index.ts — settlement_2705 Phase D entry point
//
// Wires config → interval loops → graceful shutdown. Each sweeper runs
// independently so a chain hiccup on Class B doesn't pause Class C. The
// daemon exposes a minimal HTTP /health endpoint for UptimeRobot (Phase F2).
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { runAckTimeoutSweep, runSchellingSweep, runStreamStaleSweep, } from "./sweepers.js";
function freshHealth() {
    return {
        cycles: 0,
        lastRunAt: null,
        lastErrorAt: null,
        lastError: null,
        consecutiveFailures: 0,
    };
}
function recordRun(h, err) {
    h.cycles++;
    h.lastRunAt = new Date().toISOString();
    if (err) {
        h.lastErrorAt = h.lastRunAt;
        h.lastError = err.message;
        h.consecutiveFailures++;
    }
    else {
        h.consecutiveFailures = 0;
        h.lastError = null;
    }
}
export function startDaemon(deps) {
    const { config, sql, chain } = deps;
    const log = deps.log ?? ((lvl, msg, meta) => console.log(JSON.stringify({ level: lvl, msg, ...meta })));
    const health = {
        ok: true,
        ackSweeper: freshHealth(),
        schellingSweeper: freshHealth(),
        streamStaleSweeper: freshHealth(),
    };
    async function safeRun(name, fn) {
        if (name === "ok")
            return;
        const h = health[name];
        try {
            const result = await fn();
            recordRun(h, null);
            log("info", `${name}.tick`, { result });
        }
        catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            recordRun(h, e);
            log("error", `${name}.fail`, { error: e.message });
        }
        // Degraded state on 3+ consecutive failures.
        health.ok = (health.ackSweeper.consecutiveFailures +
            health.schellingSweeper.consecutiveFailures +
            health.streamStaleSweeper.consecutiveFailures) < 3;
    }
    const ackTimer = setInterval(() => safeRun("ackSweeper", () => runAckTimeoutSweep(sql, chain)), config.ackSweepIntervalMs);
    const schTimer = setInterval(() => safeRun("schellingSweeper", () => runSchellingSweep(sql, chain)), config.schellingSweepIntervalMs);
    const stsTimer = setInterval(() => safeRun("streamStaleSweeper", () => runStreamStaleSweep(sql)), config.streamStaleSweepIntervalMs);
    const server = createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
            res.end(JSON.stringify(health));
            return;
        }
        res.writeHead(404).end();
    });
    server.listen(config.relayerPort, config.relayerHost, () => {
        log("info", "relayer-daemon.listening", { host: config.relayerHost, port: config.relayerPort });
    });
    return {
        async stop() {
            clearInterval(ackTimer);
            clearInterval(schTimer);
            clearInterval(stsTimer);
            await new Promise((resolve) => server.close(() => resolve()));
        },
        getHealth: () => health,
    };
}
// ── Entrypoint ──────────────────────────────────────────────────────────
const isEntrypoint = (() => {
    try {
        return import.meta.url === `file://${process.argv[1]}`;
    }
    catch {
        return false;
    }
})();
if (isEntrypoint) {
    const config = loadConfig();
    // Production wiring of sql + chain lives behind these interfaces; in this
    // scaffold PR we ship the deterministic core only. A follow-up PR plugs in
    // postgres-js + viem against ESCROW_V2_ADDRESS once Phase G has a real
    // contract address.
    const sql = (() => {
        throw new Error("DATABASE_URL not wired in this PR — see apps/relayer-daemon/README.md");
    });
    const chain = {
        async acknowledgeTimeout() { throw new Error("Chain client not wired — see README"); },
        async settleSchelling() { throw new Error("Chain client not wired — see README"); },
    };
    const { stop } = startDaemon({ config, sql, chain });
    const shutdown = async () => {
        await stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
//# sourceMappingURL=index.js.map