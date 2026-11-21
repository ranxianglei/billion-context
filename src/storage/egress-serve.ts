/**
 * Egress serve-from-log — segment 4b of the op-log outbound view (proposal
 * discussions/7398, #6785 perf work; #7439 ruling 1: self-contained bytes).
 * Rebuilds the outbound core-message portion from the replayed log and runs
 * it through the SAME legacy chain (systemToUser → coreToOpenai →
 * hardenOpenaiAssistantContent) the pipeline uses, so the output is
 * byte-identical by construction when the row bytes are the final core JSON
 * (which the recording guarantees). #7439 ruling 1: the bytes are
 * SELF-CONTAINED in the rows (no content-CAS lookup) — the rebuild reads them
 * straight from the view. prepare-openai (rollout `egressServeLog`, default 0)
 * SERVES these elements as the outbound conversation when the rebuild
 * succeeds, and falls back to the legacy path — with the 4a shadow
 * byte-comparison still running on fallback turns — when it cannot (degrade,
 * never guess).
 *
 * Scope (honest, pinned in tests):
 *   - text, tool, and acp_summary rows rebuild (the entire 10w-row
 *     uncompressed workload, coding sessions included); tool rows ride the
 *     row bytes — the recorded bytes are the FULL core message JSON, so the
 *     toolCallId/toolName sidecars are present and the same legacy chain
 *     reproduces the bytes;
 *   - a row with empty/missing bytes (a pre-#7439 row, or corruption) → null
 *     (caller stays on the legacy path — degrade, never guess).
 */

import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, type BiliMessage } from "acp-kernel/wire";
import { hardenOpenaiAssistantContent, systemToUser } from "../util.js";
import type { EgressViewRow } from "./egress-state.js";

interface EgressRebuildResult {
    /** The rebuilt outbound elements for the conversation rows (system
     *  block excluded — sysParts are built live and stay live). */
    elements: ReturnType<typeof coreToOpenai>;
}

/** Rebuild the outbound core-message portion from a replayed log view.
 *  #7439 ruling 1: the rows are SELF-CONTAINED — the message bytes ride the
 *  row (no content-CAS lookup), so the rebuild reads them straight from the
 *  view. Returns null when ANY row cannot be rebuilt byte-exactly (the caller
 *  must stay on the legacy path for the whole turn — a partial rebuild would
 *  splice two code paths into one outbound body). */
export function rebuildOutboundFromLog(view: readonly EgressViewRow[]): EgressRebuildResult | null {
    const ROLES = ["system", "developer", "user", "assistant", "tool"] as const;
    const msgs: BiliMessage[] = [];
    for (const r of view) {
        if (r.type === "system") continue;
        if (r.bytes === undefined || r.bytes === "") return null;
        let m: unknown;
        try {
            m = JSON.parse(r.bytes);
        } catch {
            return null;
        }
        if (typeof m !== "object" || m === null) return null;
        const c = m as { id?: unknown; role?: unknown; [k: string]: unknown };
        if (typeof c.id !== "string" || typeof c.role !== "string" || !(ROLES as readonly string[]).includes(c.role)) return null;
        msgs.push(m as BiliMessage);
    }
    // Same chain, same predicates as prepare-openai :572 — identity is the
    // claim, so the chain must be identical, not equivalent.
    const elements = hardenOpenaiAssistantContent(coreToOpenai(systemToUser(msgs, (m: BiliMessage) => isRenderedSummaryMessage(m))));
    return { elements };
}

/** The store surface the degradation ladder needs (a subset of UnifiedStore).
 *  #7439 ruling 5: the flow table is the single source of truth — the ladder
 *  reads the prev view and every rollback point from it, never from memory. */
export interface EgressLadderStore {
    egressStateView(sessionId: string): EgressViewRow[];
    egressStateViewAt(sessionId: string, logSeq: number): EgressViewRow[];
    egressFlowMaxSeq(sessionId: string): number;
}

/** #7439 ruling 5: the degradation ladder. Rebuild the outbound from the
 *  CURRENT point first; if that fails (a corrupt/missing-bytes row, or a
 *  replay violation), walk BACKWARD through the flow table to the nearest
 *  healthy point (a log_seq whose view rebuilds cleanly). The flow table is
 *  append-only and never deleted, so a healthy point is almost always a few
 *  ops back. Returns the rebuilt elements + the log_seq served + the row
 *  count, or null when NO point in the walked window rebuilds (the caller does
 *  session-level recovery — NEVER a fallback to client bytes).
 *
 *  The walk is capped at `maxWalk` points (default 100) to bound the cost — a
 *  corrupt row is recent in practice, so the nearest healthy point is close.
 *  Performance of the replay itself is a later concern (ruling 3: "重放成本
 *  毫秒级,性能问题后续再说"). */
export function rebuildOutboundWithLadder(
    store: EgressLadderStore,
    sessionId: string,
    maxWalk = 100,
): { elements: ReturnType<typeof coreToOpenai>; logSeq: number; rows: number } | null {
    // A view with zero rows is NOT a healthy point: it means the walk has
    // gone past the first flow row (log_seq values don't start at 0) or the
    // session is empty — either way there is no conversation to serve.
    const healthy = (view: readonly EgressViewRow[]): { elements: ReturnType<typeof coreToOpenai> } | null =>
        view.length > 0 ? rebuildOutboundFromLog(view) : null;
    // 1. current point (the compacted state — what serving reads normally).
    try {
        const current = store.egressStateView(sessionId);
        const reb = healthy(current);
        if (reb !== null) return { elements: reb.elements, logSeq: store.egressFlowMaxSeq(sessionId), rows: current.length };
    } catch {
        // corrupt current state — fall through to the backward walk.
    }
    // 2. walk backward through the flow table to the nearest healthy point.
    const maxSeq = store.egressFlowMaxSeq(sessionId);
    for (let seq = maxSeq - 1, walked = 0; seq >= 0 && walked < maxWalk; seq--, walked++) {
        let view: EgressViewRow[];
        try {
            view = store.egressStateViewAt(sessionId, seq);
        } catch {
            continue; // a corrupt point — keep walking back.
        }
        const reb = healthy(view);
        if (reb !== null) return { elements: reb.elements, logSeq: seq, rows: view.length };
    }
    // 3. no healthy point in the walked window — whole flow unreadable.
    return null;
}
