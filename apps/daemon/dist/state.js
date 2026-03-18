import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export function createEmptyState() {
    return {
        seenMatchFingerprints: [],
        autopilotDeals: [],
        lastWatchAt: null,
    };
}
export function loadState(stateFilePath) {
    try {
        const raw = JSON.parse(readFileSync(stateFilePath, "utf8"));
        return {
            seenMatchFingerprints: Array.isArray(raw.seenMatchFingerprints)
                ? raw.seenMatchFingerprints.filter((value) => typeof value === "string")
                : [],
            autopilotDeals: Array.isArray(raw.autopilotDeals)
                ? raw.autopilotDeals.flatMap((value) => {
                    if (!value || typeof value !== "object")
                        return [];
                    const record = value;
                    return typeof record.matchFingerprint === "string" && typeof record.createdAt === "string"
                        ? [{ matchFingerprint: record.matchFingerprint, createdAt: record.createdAt }]
                        : [];
                })
                : [],
            lastWatchAt: typeof raw.lastWatchAt === "string" ? raw.lastWatchAt : null,
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
export function diffMatches(seenMatches, nextMatches) {
    const seen = new Set(seenMatches.map((match) => match.fingerprint));
    return nextMatches.filter((match) => !seen.has(match.fingerprint));
}
export function pruneAutopilotDeals(records, nowIso) {
    const cutoff = new Date(nowIso).getTime() - 60 * 60 * 1000;
    return records.filter((record) => new Date(record.createdAt).getTime() >= cutoff);
}
