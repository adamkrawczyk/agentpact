import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PROCESSED = 100;

export type FulfillmentState = {
  processedOrderIds: string[];
  lastTickAt: string | null;
};

export function createEmptyState(): FulfillmentState {
  return {
    processedOrderIds: [],
    lastTickAt: null,
  };
}

export function loadState(stateFilePath: string): FulfillmentState {
  try {
    const raw = JSON.parse(readFileSync(stateFilePath, "utf8")) as Partial<FulfillmentState>;
    return {
      processedOrderIds: Array.isArray(raw.processedOrderIds)
        ? raw.processedOrderIds.filter((v): v is string => typeof v === "string")
        : [],
      lastTickAt: typeof raw.lastTickAt === "string" ? raw.lastTickAt : null,
    };
  } catch {
    return createEmptyState();
  }
}

export function saveState(stateFilePath: string, state: FulfillmentState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function markProcessed(
  state: FulfillmentState,
  orderId: string
): FulfillmentState {
  if (state.processedOrderIds.includes(orderId)) {
    return state; // idempotent
  }
  const updated = [...state.processedOrderIds, orderId];
  // prune to last MAX_PROCESSED
  const pruned = updated.slice(-MAX_PROCESSED);
  return { ...state, processedOrderIds: pruned };
}

export function isProcessed(state: FulfillmentState, orderId: string): boolean {
  return state.processedOrderIds.includes(orderId);
}
