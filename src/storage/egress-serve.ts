/**
 * Egress serve-from-log — segment 4a of the op-log outbound view (proposal
 * discussions/7398, #6785 perf work). RECONSTRUCTION ONLY: rebuilds the
 * outbound core-message portion from the replayed log + unified content CAS
 * and runs it through the SAME legacy chain (systemToUser → coreToOpenai →
 * hardenOpenaiAssistantContent) the pipeline uses, so the output is
 * byte-identical by construction when the CAS bytes are the final core JSON
 * (which segment 3's recording guarantees). The shadow comparison in
 * prepare-openai (rollout `egressServeLog`, default 0) measures the identity
 * rate against real traffic BEFORE any swap can happen; serving actual
 * outbound bytes from this is a later step behind the same key.
 *
 * v1 scope (honest, pinned in tests):
 *   - text and acp_summary rows rebuild (that is the entire 10w-row
 *     uncompressed workload);
 *   - a row without casRef (recorded before seg 4) or a missing CAS body →
 *     null (caller stays on the legacy path — degrade, never guess);
 *   - tool rows → null for v1 (toolCallId/toolName sidecars are not log
 *     metadata; tool traffic is small and fold-heavy by design).
 */

import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, type BiliMessage } from "acp-kernel/wire";
import { hardenOpenaiAssistantContent, systemToUser } from "../util.js";
import type { EgressViewRow } from "./egress-state.js";

export interface EgressContentStore {
    egressGetContent(hash: string): string | null;
}

export interface EgressRebuildResult {
    /** The rebuilt outbound elements for the conversation rows (system
     *  block excluded — sysParts are built live and stay live). */
    elements: ReturnType<typeof coreToOpenai>;
}

/** Rebuild the outbound core-message portion from a replayed log view.
 *  Returns null when ANY row cannot be rebuilt byte-exactly (the caller
 *  must stay on the legacy path for the whole turn — a partial rebuild
 *  would splice two code paths into one outbound body). */
export function rebuildOutboundFromLog(view: readonly EgressViewRow[], store: EgressContentStore): EgressRebuildResult | null {
    const ROLES = ["system", "developer", "user", "assistant", "tool"] as const;
    const msgs: BiliMessage[] = [];
    for (const r of view) {
        if (r.type === "system") continue;
        if (r.type === "tool" || r.casRef === undefined || r.casRef === "") return null;
        const bytes = store.egressGetContent(r.casRef);
        if (bytes === null) return null;
        let m: unknown;
        try {
            m = JSON.parse(bytes);
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
