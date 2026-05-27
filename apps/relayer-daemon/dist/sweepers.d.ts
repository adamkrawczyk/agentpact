export interface SqlClient {
    <T = unknown>(template: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}
export interface ChainClient {
    acknowledgeTimeout(intentOnChainId: Buffer): Promise<{
        txHash: string;
    }>;
    settleSchelling(intentOnChainId: Buffer): Promise<{
        txHash: string;
    }>;
}
export interface SweeperResult {
    scanned: number;
    acted: number;
    failed: Array<{
        intentId: string;
        error: string;
    }>;
}
/**
 * Class B ack-timeout sweeper. Picks delivered intents whose ack window has
 * lapsed and calls acknowledgeTimeout. Idempotent: the contract reverts
 * with "not delivered" if a buyer raced us with their own acknowledge(),
 * so we treat that revert as a benign skip rather than a hard failure.
 */
export declare function runAckTimeoutSweep(sql: SqlClient, chain: ChainClient, now?: Date): Promise<SweeperResult>;
/**
 * Schelling round-timeout sweeper. Picks intents in reveal_round1 /
 * reveal_round2 whose deadline has lapsed and calls settleSchelling.
 */
export declare function runSchellingSweep(sql: SqlClient, chain: ChainClient, now?: Date): Promise<SweeperResult>;
/**
 * Stream-stale sweeper. Flags Class C streaming intents that haven't seen
 * a claim_unit in 24h+. Does NOT cancel (cancel is buyer/seller choice).
 * Returns the IDs that would be flagged — the daemon's main loop calls a
 * notifier with the result.
 */
export declare function runStreamStaleSweep(sql: SqlClient, now?: Date): Promise<{
    stale: Array<{
        id: string;
    }>;
}>;
