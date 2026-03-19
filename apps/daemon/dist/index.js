#!/usr/bin/env node
import { homedir } from "node:os";
import { buildDealProposal, proposeDeal, selectAutopilotMatches } from "./autopilot.js";
import { loadConfig } from "./config.js";
import { sendHeartbeat } from "./heartbeat.js";
import { createNotifier } from "./notifier.js";
import { loadState, pruneAutopilotDeals, saveState } from "./state.js";
import { watchMarket } from "./watcher.js";
export async function runDaemon(config, deps = {}) {
    const log = deps.log ?? console.log;
    const now = deps.now ?? (() => new Date().toISOString());
    const fetchFn = deps.fetchFn ?? fetch;
    const notifier = createNotifier({
        webhookUrl: config.webhookUrl,
        dryRun: config.flags.dryRun,
        verbose: config.flags.verbose,
        log,
    });
    let state = loadState(config.stateFilePath);
    let stopped = false;
    let heartbeatRunning = false;
    let watcherRunning = false;
    async function heartbeatTick() {
        if (stopped || heartbeatRunning)
            return;
        heartbeatRunning = true;
        try {
            await sendHeartbeat({ config, fetchFn, log });
        }
        catch (error) {
            log(`[agentpact-daemon] heartbeat error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            heartbeatRunning = false;
        }
    }
    async function watcherTick() {
        if (stopped || watcherRunning)
            return;
        watcherRunning = true;
        try {
            const watchResult = await watchMarket({
                apiUrl: config.apiUrl,
                apiKey: config.apiKey,
                agentId: config.agentId,
                state,
                nowIso: now(),
                fetchFn,
            });
            state = watchResult.nextState;
            if (watchResult.newMatches.length > 0) {
                await notifier.notifyNewMatches(watchResult.newMatches);
            }
            const autopilotMatches = selectAutopilotMatches({
                agentId: config.agentId,
                now: now(),
                matches: watchResult.newMatches,
                autopilot: config.autopilot,
                autopilotDeals: state.autopilotDeals,
            });
            for (const match of autopilotMatches) {
                if (config.flags.dryRun) {
                    log(`[agentpact-daemon] dry-run autopilot candidate ${match.summary}`);
                    continue;
                }
                const deal = await proposeDeal({
                    apiUrl: config.apiUrl,
                    apiKey: config.apiKey,
                    proposal: buildDealProposal(config.agentId, match),
                    fetchFn,
                });
                state = {
                    ...state,
                    autopilotDeals: pruneAutopilotDeals([
                        ...state.autopilotDeals,
                        { matchFingerprint: match.fingerprint, createdAt: now() },
                    ], now()),
                };
                await notifier.notifyAutopilotDeal(match, deal.id);
            }
            saveState(config.stateFilePath, state);
        }
        catch (error) {
            log(`[agentpact-daemon] watcher error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            watcherRunning = false;
        }
    }
    await heartbeatTick();
    await watcherTick();
    const heartbeatTimer = setInterval(() => {
        void heartbeatTick();
    }, config.heartbeatIntervalMs);
    heartbeatTimer.unref();
    const watcherTimer = setInterval(() => {
        void watcherTick();
    }, config.watchIntervalMs);
    watcherTimer.unref();
    return async () => {
        stopped = true;
        clearInterval(heartbeatTimer);
        clearInterval(watcherTimer);
        saveState(config.stateFilePath, state);
        log("[agentpact-daemon] shutdown complete");
    };
}
export async function main(argv = process.argv.slice(2), env = process.env) {
    const config = loadConfig({ env, argv, homeDir: homedir() });
    const shutdown = await runDaemon(config);
    const handleSignal = (signal) => {
        console.log(`[agentpact-daemon] received ${signal}, shutting down`);
        void shutdown().finally(() => process.exit(0));
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
}
if (import.meta.url === `file://${process.argv[1]}`) {
    void main().catch((error) => {
        console.error(`[agentpact-daemon] fatal error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
