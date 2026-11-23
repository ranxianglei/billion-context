/**
 * Egress serve-from-log — segment 4b of the op-log outbound view (proposal
 * discussions/7398, revised self-contained-bytes design discussions/7439
 * ruling 1, #6785 perf work). Rebuilds the outbound core-message portion
 * from the replayed log and runs it through the SAME legacy chain the
 * pipeline uses, so the output is byte-identical by construction: the
 * recorded bytes ARE the final core JSON (segment 3's recording guarantees
 * it), no content table anywhere.
 *
 * rebuildCoreFromLog is LANE-NEUTRAL (owner ruling 7439-4): it returns the
 * core BiliMessage[] and each lane feeds its own conversion chain
 * (prepare-openai uses the openai wrapper below; anthropic/responses/google
 * join in the same way). prepare-openai (rollout `egressPlane`, default
 * 0) SERVES these elements as the outbound conversation when the rebuild
 * succeeds, and falls back to the legacy path — with the 4a shadow
 * byte-comparison still running on fallback turns — when it cannot (degrade,
 * never guess).
 *
 * Scope (honest, pinned in tests):
 *   - text, tool, and acp_summary rows rebuild (the entire 10w-row
 *     uncompressed workload, coding sessions included); a row is the FULL
 *     core message JSON, so the toolCallId/toolName sidecars are present
 *     and the same legacy chain reproduces the bytes;
 *   - a row whose bytes do not parse / fail the role whitelist → null
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

const CORE_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;

/** Lane-neutral core rebuild: replayed view rows → core BiliMessage[]
 * (system rows excluded — the system block is built live by every lane,
 * never stored in the log). Returns null when ANY row cannot be rebuilt
 * byte-exactly (the caller must stay on the legacy path for the whole turn
 * — a partial rebuild would splice two code paths into one outbound body). */
export function rebuildCoreFromLog(view: readonly EgressViewRow[]): BiliMessage[] | null {
    const msgs: BiliMessage[] = [];
    for (const r of view) {
        if (r.type === "system") continue;
        if (typeof r.bytes !== "string" || r.bytes.length === 0) return null;
        let m: unknown;
        try {
            m = JSON.parse(r.bytes);
        } catch {
            return null;
        }
        if (typeof m !== "object" || m === null) return null;
        const c = m as { id?: unknown; role?: unknown; [k: string]: unknown };
        if (typeof c.id !== "string" || typeof c.role !== "string" || !(CORE_ROLES as readonly string[]).includes(c.role)) return null;
        msgs.push(m as BiliMessage);
    }
    return msgs;
}

/** Rebuild the outbound core-message portion from a replayed log view.
 * Returns null when ANY row cannot be rebuilt byte-exactly (see
 * rebuildCoreFromLog). */
export function rebuildOutboundFromLog(view: readonly EgressViewRow[]): EgressRebuildResult | null {
    const msgs = rebuildCoreFromLog(view);
    if (msgs === null) return null;
    // Same chain, same predicates as prepare-openai :572 — identity is the
    // claim, so the chain must be identical, not equivalent.
    const elements = hardenOpenaiAssistantContent(coreToOpenai(systemToUser(msgs, (m: BiliMessage) => isRenderedSummaryMessage(m))));
    return { elements };
}
