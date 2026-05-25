import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const MAX_PROCESSED = 100;
export function createEmptyState() {
    return {
        processedOrderIds: [],
        lastTickAt: null,
    };
}
export function loadState(stateFilePath) {
    try {
        const raw = JSON.parse(readFileSync(stateFilePath, "utf8"));
        return {
            processedOrderIds: Array.isArray(raw.processedOrderIds)
                ? raw.processedOrderIds.filter((v) => typeof v === "string")
                : [],
            lastTickAt: typeof raw.lastTickAt === "string" ? raw.lastTickAt : null,
        };
    }
    catch {
        return createEmptyState();
    }
}
export function saveState(stateFilePath, state) {
    mkdirSync(dirname(stateFilePath), { recursive: true });
    writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
export function markProcessed(state, orderId) {
    if (state.processedOrderIds.includes(orderId)) {
        return state; // idempotent
    }
    const updated = [...state.processedOrderIds, orderId];
    // prune to last MAX_PROCESSED
    const pruned = updated.slice(-MAX_PROCESSED);
    return { ...state, processedOrderIds: pruned };
}
export function isProcessed(state, orderId) {
    return state.processedOrderIds.includes(orderId);
}
