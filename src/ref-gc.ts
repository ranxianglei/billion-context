import { highestUsedIndex, type CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";

/**
 * Message-ref garbage collection (#390).
 *
 * WHY: message ids are content fingerprints (acp-kernel wire/message-id), so
 * any edit / truncation / dedup of a message gives it a NEW id — the old id
 * keeps its byRaw/byRef entry forever. Nothing in the kernel pipeline recycles
 * those dead entries, so the ref space (m00001..m99999) grows monotonically
 * toward the 99999 cap, where kernel allocateFreeRef throws "ref capacity
 * exhausted" and the prepare catch degrades the request to "kernel transform
 * failed, forwarding unchanged" — compression silently stalls for the rest of
 * the session. Dead tokenSnapshot entries (keyed by ref) leak the same way.
 *
 * WHAT: after each processTurn (and after orphan-gc, so a reaped block's ids
 * are collected the same turn) prune every byRaw/byRef/tokenSnapshot entry
 * whose raw id is no longer reachable:
 *   - present in the incoming or outgoing view (outgoing includes rendered
 *     summaries), or
 *   - folded into an ACTIVE block (effectiveMessageIds — kept as tombstones
 *     so the block stays decompressable and the model can still cite its
 *     tags), or
 *   - cited as mNNNNN inside outgoing-view text (a live summary may cite a
 *     tag whose raw id left every other surface; keeping its mapping
 *     guarantees a freed slot is never re-allocated onto a tag a live summary
 *     still shows — that would misattribute on decompress).
 *
 * The kernel recomputes its allocation cursor each turn as
 * highestUsedIndex(map)+1 (assignRefsNode), so pruning dead entries makes
 * freed slots reusable automatically — no cursor surgery needed. The capacity
 * throw then requires 99999 genuinely LIVE refs. We also warn once per
 * threshold crossing so the pathological case is never silent.
 */

const CITED_REF = /\bm(\d{5})\b/g;
const REF_CAPACITY_WARN = 90_000;

export function gcMessageRefs(
    session: Session,
    incoming: CoreMessage[],
    outgoing: CoreMessage[],
    log: (level: string, msg: string) => void,
): { pruned: number } {
    const { byRaw, byRef } = session.state.messageRefs;
    const tokenSnapshot = session.state.tokenSnapshot;
    const live = new Set<string>();
    for (const m of incoming) if (m.id) live.add(m.id);
    for (const m of outgoing) if (m.id) live.add(m.id);
    for (const match of citedRefs(outgoing)) {
        const rawId = byRef[`m${match}`];
        if (rawId) live.add(rawId);
    }
    for (const b of session.state.blocks) {
        if (!b.active) continue;
        for (const id of b.effectiveMessageIds) live.add(id);
    }

    const nextByRaw: Record<string, string> = {};
    let pruned = 0;
    for (const [rawId, ref] of Object.entries(byRaw)) {
        if (live.has(rawId)) nextByRaw[rawId] = ref;
        else pruned++;
    }
    const nextByRef: Record<string, string> = {};
    for (const [ref, rawId] of Object.entries(byRef)) {
        if (live.has(rawId)) nextByRef[ref] = rawId;
    }
    if (pruned === 0) return { pruned };
    const nextSnapshot: Record<string, number> = {};
    for (const [ref, tokens] of Object.entries(tokenSnapshot ?? {})) {
        if (nextByRef[ref] !== undefined) nextSnapshot[ref] = tokens;
    }
    session.state = {
        ...session.state,
        messageRefs: {
            ...session.state.messageRefs,
            byRaw: nextByRaw,
            byRef: nextByRef,
        },
        tokenSnapshot: nextSnapshot,
    };
    log("info", `[${session.id}] ref gc: pruned ${pruned} dead ref mapping(s), ${Object.keys(nextByRaw).length} live`);
    const highest = highestUsedIndex(session.state.messageRefs);
    if (highest >= REF_CAPACITY_WARN) {
        log("warn", `[${session.id}] message refs at m${String(highest).padStart(5, "0")} approaching capacity 99999 — compression may stall if exhausted`);
    }
    return { pruned };
}

/** Returns the digit part of every mNNNNN cited in message text (no "m"
 *  prefix — callers re-add it for byRef lookups). */
function citedRefs(messages: CoreMessage[]): Set<string> {
    const refs = new Set<string>();
    for (const m of messages) {
        if (!m.text) continue;
        for (const match of m.text.matchAll(CITED_REF)) refs.add(match[1]);
    }
    return refs;
}
