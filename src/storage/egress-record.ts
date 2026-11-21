/**
 * Egress op-log recording — segment 3 of the op-log outbound view (proposal
 * discussions/7398, revised self-contained-bytes design discussions/7439
 * ruling 1, #6785 perf work). Each turn diffs the outbound conversation view
 * against the previous turn's and appends the sparse op batch to the dual
 * tables. Outbound bytes are served from the log only behind the serve key
 * (segment 4b). Gated by rollout key `egressOpLog` (default 0 = no recording
 * at all).
 *
 * SELF-CONTAINED BYTES (ruling 7439-1): each view row carries the message's
 * FINAL core JSON string directly (the system row carries the system text).
 * No hash references, no fingerprint fields, no content table — the content
 * identity of a row is the byte string itself (the diff keys on msgid and
 * compares bytes directly), so the op-log replays and serves with nothing
 * but the two egress tables.
 *
 * Identity contract (KDD#11/KDD#17): a view row's msgid is the message's
 * kernel-space id — host msgid in pinned 2×2 lanes (the pin restamps ids
 * position-for-position), content-hash mint otherwise (kernel mints are
 * never re-issued). Ephemeral rows (nudge, sysNotes) are EXCLUDED: they are
 * by-design transient (KDD#7 prefix-cache-anchor) and would churn +I/-D
 * every nudge cycle with no serving value; the leading system block IS a
 * row under the constant msgid "egress-system" (its byte stability is what
 * the cache anchor relies on, and a system change shows up as a +U on that
 * row — content identity is bytes, position/identity is the msgid).
 */

import { diffEgressView, type EgressOp, type EgressViewRow } from "./egress-state.js";

/** Constant msgid of the system block row (no hash — identity is the
 * role, not the content; a system change is a +U carrying the new bytes). */
export const EGRESS_SYSTEM_MSGID = "egress-system";

/** Minimal structural shape — accepts both BiliMessage (wire sidecar) and
 * bare kernel CoreMessage (the degraded-path originalMessages). Exported:
 * prepare-openai names the source array it hands to recordEgressTurn. */
export interface EgressSourceMsg {
    id: string;
    role: string;
    contentType?: unknown;
    text?: unknown;
}

/** Build this turn's view rows: [system?] + one row per conversation
 * message. Deterministic over (ids, roles, texts): same inputs → same rows
 * (byte-equal), which is what makes the next diff sparse. `tokens` is a
 * chars/4 estimate (it only needs to be stable while the content is
 * unchanged); `bytes` is the FINAL core JSON of the message — the same
 * bytes the serve path rebuilds from. */
export function buildEgressViewRows(
    conversation: readonly EgressSourceMsg[],
    systemText: string | undefined,
): EgressViewRow[] {
    const rows: EgressViewRow[] = [];
    if (systemText !== undefined && systemText.length > 0) {
        rows.push({
            msgid: EGRESS_SYSTEM_MSGID,
            ref: "",
            tokens: Math.max(1, Math.ceil(systemText.length / 4)),
            type: "system",
            role: "system",
            bytes: systemText,
        });
    }
    for (const m of conversation) {
        const text = typeof m.text === "string" ? m.text : "";
        rows.push({
            msgid: m.id,
            ref: /^m\d{4,}$/.test(m.id) ? m.id : "",
            tokens: Math.max(1, Math.ceil(text.length / 4)),
            type: m.id.startsWith("acp_summary") ? "acp_summary" : m.role === "tool" ? "tool" : "text",
            role: m.role,
            bytes: JSON.stringify(m),
        });
    }
    return rows;
}

/** The storage seam (UnifiedStore today; keeps the recorder testable). */
export interface EgressOpLogStore {
    egressStateAppendOps(sessionId: string, ops: EgressOp[], nowMs: number): number[];
    egressStateView(sessionId: string): EgressViewRow[];
    egressStateCompactView(sessionId: string, view: EgressViewRow[], nowMs: number): number;
}

/** Record this turn's outbound conversation view as sparse ops. `prev` is
 * this turn's starting point — the previous turn's view when present,
 * otherwise a one-shot hydrate from the tables (owner ruling 7439-3: the
 * tables are the only state; there is no long-lived in-memory view cache).
 * Compacts when the batch carries a -D (the fold shape: cancellation is the
 * trigger, per the proposal). Any EgressStateCorruptError propagates — the
 * caller handles it per the degrade ladder (no fuzzy fallback, KDD
 * discipline). */
export function recordEgressTurn(args: {
    store: EgressOpLogStore;
    sessionId: string;
    prev: EgressViewRow[] | undefined;
    conversation: readonly EgressSourceMsg[];
    systemText: string | undefined;
    nowMs: number;
}): EgressViewRow[] {
    const { store, sessionId, conversation, systemText, nowMs } = args;
    const prev = args.prev ?? store.egressStateView(sessionId);
    const next = buildEgressViewRows(conversation, systemText);
    const ops = diffEgressView(prev, next);
    if (ops.length > 0) {
        store.egressStateAppendOps(sessionId, ops, nowMs);
        if (ops.some((o) => o.type === "D")) {
            store.egressStateCompactView(sessionId, next, nowMs);
        }
    }
    return next;
}
