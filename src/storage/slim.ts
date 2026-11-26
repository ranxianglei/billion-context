/**
 * #6785 step 8: the kstate slim split. The sessions.kstate_json column keeps
 * only the BOUNDED fields (nudge, stats, latches, counters, digests); the
 * UNBOUNDED record/array fields (each can grow to MB across a long session)
 * ride one row each in state_fields. The set is frozen: adding a field here
 * is a read-path decision (the builder must know it is row-backed), so it is
 * pinned by tests/issue5874-state-fields.test.ts and reviewed with the
 * kernel-type pin (kernel/src/types.ts field shapes).
 */
export const ROW_BACKED_KSTATE_FIELDS: readonly string[] = Object.freeze([
    "tokenSnapshot",
    "tsStamps",
    "lastPassIds",
    "hiddenOrphanRefs",
    "sweptOrphanCallIds",
    "renderDeferredRefs",
    "viewLatches",
    "absorbed",
    "rules",
]);

const ROW_BACKED_SET = new Set(ROW_BACKED_KSTATE_FIELDS);

/** Split an ordered kstate object (MERGE_STATE_FIELDS order) into the
 *  column part (order-preserving, row-backed fields removed) and the row
 *  part (field → serialized value, only for DEFINED row-backed fields). */
export function splitKstate(
    fields: readonly string[],
    state: Record<string, unknown>,
): { column: Record<string, unknown>; rows: Record<string, string> } {
    const column: Record<string, unknown> = {};
    const rows: Record<string, string> = {};
    for (const field of fields) {
        const v = state[field];
        if (v === undefined) continue;
        if (ROW_BACKED_SET.has(field)) rows[field] = JSON.stringify(v);
        else column[field] = v;
    }
    return { column, rows };
}

/**
 * #7574 (review of #6785) — "is this value the older build's default?".
 * A build that predates the state_fields rows loads a session WITHOUT the
 * nine row-backed fields and writes the column back with whatever its own
 * code put there — nothing, or an empty container. Used by the view
 * builder to tell "the older build had nothing" (empty) from "something
 * was added while the older build ran" (non-empty = newer than the row).
 */
export function isEmptyStateValue(v: unknown): boolean {
    if (v === null || v === undefined || v === "" || v === 0 || v === false) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
}
