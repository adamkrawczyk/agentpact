import { type Config } from "./config.js";
import { type ChainClient, type SqlClient } from "./sweepers.js";
interface SweeperHealth {
    cycles: number;
    lastRunAt: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
}
interface DaemonHealth {
    ok: boolean;
    ackSweeper: SweeperHealth;
    schellingSweeper: SweeperHealth;
    streamStaleSweeper: SweeperHealth;
}
export interface DaemonDeps {
    config: Config;
    sql: SqlClient;
    chain: ChainClient;
    log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}
export declare function startDaemon(deps: DaemonDeps): {
    stop: () => Promise<void>;
    getHealth: () => DaemonHealth;
};
export {};
