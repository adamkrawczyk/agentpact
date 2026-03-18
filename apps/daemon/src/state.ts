import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AutopilotDealRecord = {
  matchFingerprint: string;
  createdAt: string;
};

export type DaemonState = {
  seenMatchFingerprints: string[];
  autopilotDeals: AutopilotDealRecord[];
  lastWatchAt: string | null;
};

export function createEmptyState(): DaemonState {
  return {
    seenMatchFingerprints: [],
    autopilotDeals: [],
    lastWatchAt: null,
  };
}

export function loadState(stateFilePath: string): DaemonState {
  try {
    const raw = JSON.parse(readFileSync(stateFilePath, "utf8")) as Partial<DaemonState>;
    return {
      seenMatchFingerprints: Array.isArray(raw.seenMatchFingerprints)
        ? raw.seenMatchFingerprints.filter((value): value is string => typeof value === "string")
        : [],
      autopilotDeals: Array.isArray(raw.autopilotDeals)
        ? raw.autopilotDeals.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const record = value as Partial<AutopilotDealRecord>;
          return typeof record.matchFingerprint === "string" && typeof record.createdAt === "string"
            ? [{ matchFingerprint: record.matchFingerprint, createdAt: record.createdAt }]
            : [];
        })
        : [],
      lastWatchAt: typeof raw.lastWatchAt === "string" ? raw.lastWatchAt : null,
    };
  } catch {
    return createEmptyState();
  }
}

export function saveState(stateFilePath: string, state: DaemonState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function diffMatches<T extends { fingerprint: string }>(
  seenMatches: Array<{ fingerprint: string }>,
  nextMatches: T[],
): T[] {
  const seen = new Set(seenMatches.map((match) => match.fingerprint));
  return nextMatches.filter((match) => !seen.has(match.fingerprint));
}

export function pruneAutopilotDeals(records: AutopilotDealRecord[], nowIso: string): AutopilotDealRecord[] {
  const cutoff = new Date(nowIso).getTime() - 60 * 60 * 1000;
  return records.filter((record) => new Date(record.createdAt).getTime() >= cutoff);
}
