/**
 * Egress op-log recording — segment 3 of the op-log outbound view (proposal
 * discussions/7398, #6785 perf work). SHADOW RECORDING ONLY: each turn diffs
 * the outbound conversation view against the previous turn's and appends the
 * sparse op batch to the dual tables. Outbound bytes are NEVER read from or
 * written through the log here — that is segment 4, behind its own key.
 * Gated by rollout key `egressOpLog` (default 0 = no recording at all).
 *
 * Identity contract (KDD#11/KDD#17): a view row's msgid is the message's
 * kernel-space id — host msgid in pinned 2×2 lanes (the pin restamps ids
 * position-for-position), content-hash mint otherwise (kernel mints are
 * never re-issued). Ephemeral rows (nudge, sysNotes) are EXCLUDED: they are
 * by-design transient (KDD#7 prefix-cache-anchor) and would churn +I/-D
 * every nudge cycle with no serving value; the leading system block IS a
 * row (its byte stability is what the cache anchor relies on, and a system
 * change must be a visible D+I).
 */

import { createHash } from "node:crypto";
import { diffEgressView, type EgressOp, type EgressViewRow } from "./egress-state.js";

function rowHash(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}

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
 * message. Deterministic over (ids, roles, texts): same inputs → same rows,
 * which is what makes the next diff sparse. `tokens` is a chars/4 estimate
 * for v1 (segment 4 replaces it with the rendered tag triple when the serve
 * path lands); it only needs to be stable while the content is unchanged.
 * `prev` (the previous turn's view): a row whose content is UNCHANGED keeps
 * its existing casRef instead of re-putting the same CAS body — putContent
 * refcount-bumps on hit, so re-putting every turn would inflate each row's
 * refcount by +1/turn forever (the only release is the session sweep). A
 * changed/missing row puts fresh (a missing casRef is filled in, not left
 * absent, so serve-from-log picks it up on the next turn). */
export function buildEgressViewRows(
    conversation: readonly EgressSourceMsg[],
    systemText: string | undefined,
    cas?: { put(text: string): string },
    prev?: readonly EgressViewRow[],
): EgressViewRow[] {
    const rows: EgressViewRow[] = [];
    if (systemText !== undefined && systemText.length > 0) {
        const sysHash = rowHash(systemText);
        const sysMsgid = "system:" + sysHash;
        const sysPrev = prev?.find((r) => r.msgid === sysMsgid && r.contentHash === sysHash);
        rows.push({ msgid: sysMsgid, ref: "", tokens: Math.max(1, Math.ceil(systemText.length / 4)), type: "system", role: "system", contentHash: sysHash, casRef: cas ? (sysPrev?.casRef ?? cas.put(systemText)) : undefined });
    }
    const prevByMsgid = new Map<string, EgressViewRow>();
    for (const p of prev ?? []) if (!prevByMsgid.has(p.msgid)) prevByMsgid.set(p.msgid, p);
    for (const m of conversation) {
        const text = typeof m.text === "string" ? m.text : "";
        const contentHash = rowHash(JSON.stringify([m.id, m.role, m.contentType ?? null, text]));
        const p = prevByMsgid.get(m.id);
        rows.push({
            msgid: m.id,
            ref: /^m\d{4,}$/.test(m.id) ? m.id : "",
            tokens: Math.max(1, Math.ceil(text.length / 4)),
            type: m.id.startsWith("acp_summary") ? "acp_summary" : m.role === "tool" ? "tool" : "text",
            role: m.role,
            contentHash,
            casRef: cas ? ((p && p.contentHash === contentHash ? p.casRef : undefined) ?? cas.put(JSON.stringify(m))) : undefined,
        });
    }
    return rows;
}

/** The storage seam (UnifiedStore today; keeps the recorder testable).
 * `egressPutContent` is the unified-content-CAS seam — seg 4 stores each
 * message's FINAL core JSON under its hash so serve-from-log can rebuild
 * byte-exact without re-running the pipeline (absent → no casRef rows). */
export interface EgressOpLogStore {
    egressStateAppendOps(sessionId: string, ops: EgressOp[], nowMs: number): number[];
    egressStateView(sessionId: string): EgressViewRow[];
    egressStateCompactView(sessionId: string, view: EgressViewRow[], nowMs: number): number;
    egressPutContent?(text: string): string;
}

/** Record this turn's outbound conversation view as sparse ops. Returns the
 * NEW view (caller caches it on the session; absent = hydrate from the
 * tables once, per process). Compacts when the batch carries a -D (the
 * fold shape: cancellation is the trigger, per the proposal). Any
 * EgressStateCorruptError propagates — the caller stops recording for the
 * session and keeps the legacy behavior (no fuzzy fallback, KDD discipline). */
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
    const next = buildEgressViewRows(conversation, systemText, store.egressPutContent ? { put: (t) => store.egressPutContent!(t) } : undefined, prev);
    const ops = diffEgressView(prev, next);
    if (ops.length > 0) {
        store.egressStateAppendOps(sessionId, ops, nowMs);
        if (ops.some((o) => o.type === "D")) {
            store.egressStateCompactView(sessionId, next, nowMs);
        }
    }
    return next;
}
