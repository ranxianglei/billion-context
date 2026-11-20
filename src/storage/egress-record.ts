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
 * bare kernel CoreMessage (the degraded-path originalMessages). */
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
 * path lands); it only needs to be stable while the content is unchanged. */
export function buildEgressViewRows(conversation: readonly EgressSourceMsg[], systemText: string | undefined): EgressViewRow[] {
    const rows: EgressViewRow[] = [];
    if (systemText !== undefined && systemText.length > 0) {
        rows.push({ msgid: "system:" + rowHash(systemText), ref: "", tokens: Math.max(1, Math.ceil(systemText.length / 4)), type: "system", contentHash: rowHash(systemText) });
    }
    for (const m of conversation) {
        const text = typeof m.text === "string" ? m.text : "";
        rows.push({
            msgid: m.id,
            ref: /^m\d{4,}$/.test(m.id) ? m.id : "",
            tokens: Math.max(1, Math.ceil(text.length / 4)),
            type: m.id.startsWith("acp_summary") ? "acp_summary" : m.role === "tool" ? "tool" : "text",
            contentHash: rowHash(JSON.stringify([m.id, m.role, m.contentType ?? null, text])),
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
