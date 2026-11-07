// #3102: per-session in-flight model-forward counter — lets the degenerate-turn
// diagnostic line report whether another same-session forward (dsh title-gen
// sidecar, #2503) was in flight when the turn ended. Correlation only: bili's
// transport is structurally isolated (one socket per concurrent request).
// In-memory only — never persisted.

const counts = new Map<string, number>();

export function beginForward(sessionId: string): void {
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
}

export function endForward(sessionId: string): void {
    const n = (counts.get(sessionId) ?? 0) - 1;
    if (n <= 0) counts.delete(sessionId);
    else counts.set(sessionId, n);
}

/** Other forwards currently in flight under the same session id (the caller's own forward excluded). */
export function otherForwardsInFlight(sessionId: string): number {
    return Math.max(0, (counts.get(sessionId) ?? 0) - 1);
}

export function _resetConcurrentForwardsForTest(): void {
    counts.clear();
}
