// #3714: custom-wire endpoint visibility. A host plugin whose fetch gate
// (isModelApiUrl, native-intercept) does not recognize a model-shaped URL sends
// it DIRECT with zero compression, and those requests NEVER reach this proxy —
// so the server-side unrecognizedPaths stat (#1290/#1291, which only counts
// requests that ARRIVED at a proxy path) stays silent on exactly this case. The
// evidence lives in the HOST process; the proxy learns about it only via a
// fire-and-forget host report on first sighting of each distinct endpoint. This
// module keeps the latest reported set per agent in memory and feeds both status
// surfaces (#2152 parity) plus the acp_status unknown-conversation reply.
const pathsByAgent = new Map<string, Set<string>>();

/** Latest-report-wins per agent; called from /__bili/plugin/unrouted after validation. */
export function recordUnroutedReport(agent: string, paths: string[]): void {
    pathsByAgent.set(agent, new Set(paths));
}

/** Union across agents, stable-sorted. Empty until the first report — absence means
 *  "no direct-through-unrecognized-endpoint traffic observed", not "none exist". */
export function unroutedPathsUnion(): string[] {
    const all = new Set<string>();
    for (const s of pathsByAgent.values()) for (const p of s) all.add(p);
    return [...all].sort();
}

/** Wire payload shared by /__bili/status and /__bili/overview: agent -> sorted list. */
export function unroutedStatusWire(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [agent, s] of pathsByAgent) out[agent] = [...s].sort();
    return out;
}

/** Test hook: clear all reported agents between scenarios. */
export function _resetUnroutedStatusForTest(): void {
    pathsByAgent.clear();
}
