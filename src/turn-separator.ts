// #2627 turn-separator id helpers live in this ZERO-DEPENDENCY leaf so the
// storage seam can consume them without dragging session.ts (and its built-
// acp-kernel package import) into graphs that must load unbuilt kernel source
// (the mysql-contract CI lane installs with --ignore-scripts: no kernel/dist).
// session.ts re-exports these for its existing consumers.

/** #2627: bili-synthesized Responses turn separators (repairResponsesAssistantOrdering,
 *  src/server.ts) are OUTBOUND-ONLY ordering markers — no client's resent history
 *  ever contains them, so they can never anchor or be covered. When a
 *  separator-bearing view reached applyCompression (the plugin lane handed its
 *  processed view straight in), their ids were registered into new blocks'
 *  direct/effectiveMessageIds and inherited by higher folds via child merge —
 *  permanently "missing" on every reconcile pass: false [acp-drift]/fold-
 *  reconcile warns and stalled per-block ledger evidence against an unchanged
 *  history. They are protocol-ordering artifacts, not compressible raw history:
 *  exclude them everywhere coverage is stored or compared. */
export const RESPONSES_TURN_SEPARATOR_ID_PREFIX = "acp_turn_sep_";

export function isResponsesTurnSeparatorId(id: string): boolean {
    return id.startsWith(RESPONSES_TURN_SEPARATOR_ID_PREFIX);
}

/** #5139: the markers exist ONLY in the send view — the apply view has none of
 *  these ids, so any analysis pass screened against the apply view must run on
 *  the send view minus them, or range endpoints landing on a marker ref vanish
 *  at projection (BoundaryNotFoundError → silent demotion). No-op when absent. */
export function withoutTurnSeparators<T extends { id?: string }>(messages: T[]): T[] {
    const isSep = (m: T): boolean => typeof m.id === "string" && isResponsesTurnSeparatorId(m.id);
    return messages.some(isSep) ? messages.filter((m) => !isSep(m)) : messages;
}

/** #2627: strip turn-separator ids from block coverage IN PLACE (load-time heal
 *  of persisted state + post-commit scrub). Returns how many ids were removed;
 *  0 means the state was already clean. */
export function scrubTurnSeparatorIds(
    blocks: ReadonlyArray<{ directMessageIds?: string[]; effectiveMessageIds?: string[] }>,
): number {
    let removed = 0;
    for (const block of blocks) {
        for (const key of ["directMessageIds", "effectiveMessageIds"] as const) {
            const ids = block[key];
            if (!ids) continue;
            const kept = ids.filter((id) => !isResponsesTurnSeparatorId(id));
            if (kept.length !== ids.length) {
                removed += ids.length - kept.length;
                block[key] = kept;
            }
        }
    }
    return removed;
}
