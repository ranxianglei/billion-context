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

/** #564: the exact marker text repairResponsesAssistantOrdering (src/server.ts)
 *  injects as a user message to re-split two assistant runs that a fold merged. */
export const RESPONSES_TURN_SEPARATOR = "[The exchange between these two assistant turns was compressed.]";

export function isResponsesTurnSeparatorId(id: string): boolean {
    return id.startsWith(RESPONSES_TURN_SEPARATOR_ID_PREFIX);
}

/** #4388: text-level detection for the outbound-only marker. The wire codecs
 *  re-derive core ids when re-parsing a serialized body, so the id prefix never
 *  survives the judge's exit-side round-trip — the exact text is the only
 *  wire-neutral identifier (same discipline as the acp_summary text markers). */
export function isResponsesTurnSeparatorText(text: string | undefined): boolean {
    return (text ?? "").trim() === RESPONSES_TURN_SEPARATOR;
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
