// #1875: machine-readable business outcome for executed proxy tools. The HTTP
// envelope's ok already means "transport + execution succeeded"; outcome adds
// whether the REQUESTED EFFECT happened. Compress is tri-valued (applied /
// partial / refused) because a partially-applied fold is neither; every other
// tool is binary success | failure. Consumers that only know the old envelope
// shape ignore the extra fields and keep working off result text.
type CompressOutcomeKind = "applied" | "partial" | "refused";
export type ToolOutcomeKind = CompressOutcomeKind | "success" | "failure";

/** #2752: defensive parse of the endpoint's machine-readable `outcome` field —
 *  only the known enum values survive; anything else (legacy proxies without
 *  the field, typos, numbers) degrades to absent so old envelopes keep their
 *  exact shape and no new behavior is inferred from garbage. */
export function parseToolOutcome(value: unknown): ToolOutcomeKind | undefined {
    return value === "applied" || value === "partial" || value === "refused" || value === "success" || value === "failure" ? value : undefined;
}

/** #2752: defensive parse of the endpoint's `blocksCreated` counter — a finite
 *  non-negative integer only (the kernel emits exactly that); anything else is
 *  treated as absent rather than forwarded into host-visible structured state. */
export function parseBlocksCreated(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** #2752: host-visible marker for a PARTIAL compress fold. The receipt's
 *  leading line reads as a clean success ("Compressed … → N block(s), … saved")
 *  with per-range errors riding after it — in large receipts a partial fold is
 *  indistinguishable from a full one without this line. Appended by the
 *  forwarding layer (agent/shared.ts + mcp.ts) ONLY when the endpoint reported
 *  outcome:"partial": applied needs no marker (the leading line says all-folded)
 *  and refused/failure already surface as isError/throw on every lane.
 *  2026-11-25 (session 01a20b76, qwen3.8-27b): the unconditional "Retry ONLY
 *  the failed range(s)" contradicted the kernel's own stale-ref verdict in the
 *  SAME receipt ("NO superset of them can ever compress") and drove the
 *  confabulating model to re-issue the next batch of phantom refs (m04301–
 *  m04364 → m04365–m04503). The retry order is now conditional on the
 *  per-range error text; the forwarding layer cannot see the causes, so the
 *  condition is spelled out in the wording itself. */
export function partialOutcomeNote(blocksCreated?: number): string {
    const created = blocksCreated !== undefined ? `${blocksCreated} block(s) created; ` : "";
    return `[acp-result: PARTIAL — ${created}some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above, and only if their error text says they may resolve on retry — a range whose refs are stale/unknown or above this session's highest allocated ref can NEVER fold (those numbers do not exist): do NOT retry it, call acp_status for the live ranges instead. Do not re-fold the ranges that were applied.]`;
}

export interface ProxyToolResult {
    text: string;
    outcome?: ToolOutcomeKind;
    blocksCreated?: number;
    // #2362: short machine-readable failure cause for log correlation (e.g.
    // `parse:missing-content`, `gate:cannot-anchor`) — outcome=refused alone
    // never says WHY in the [plugin] execution line.
    reason?: string;
    // #3400: original image bytes restored by acp_read_original_image — the loop
    // rides them as an ephemeral carrier message; plugin-lane hosts open the
    // local path named in the receipt text instead (string protocol).
    image?: { base64: string; mediaType: string };
}

export function toolOk(text: string): ProxyToolResult {
    return { text, outcome: "success" };
}

export function toolFail(text: string): ProxyToolResult {
    return { text, outcome: "failure" };
}

export function compressResult(text: string, outcome: CompressOutcomeKind, blocksCreated: number, reason?: string): ProxyToolResult {
    return reason !== undefined ? { text, outcome, blocksCreated, reason } : { text, outcome, blocksCreated };
}
