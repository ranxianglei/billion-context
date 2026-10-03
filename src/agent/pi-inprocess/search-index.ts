/**
 * Search index — bridges pi's session log into acp-kernel's search.
 *
 * Builds SearchDoc[] from:
 *  1. All compression blocks (active AND inactive) — via blockDocs()
 *  2. Historical messages that compression folded into a block summary.
 *
 * Which messages are searchable? Those covered by SOME block's
 * effectiveMessageIds — i.e. messages that were compressed into a summary and
 * are no longer individually visible. Messages still live in context (not in
 * any block) are skipped: the model can already see them.
 *
 * We deliberately do NOT use pi's buildContextEntries for the visible check:
 * ACP prunes messages itself (no pi `compaction` entry is written), so pi
 * reports ALL entries as in-context. The ACP state is the source of truth.
 */

import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { blockDocs, messageDocs, type SearchDoc, type MessageInput, type MessageRole } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import type { CompressionState } from "acp-kernel";

/** All message refs covered by any block (active or inactive). */
function buildCoveredRefs(state: CompressionState): Set<string> {
    const s = new Set<string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) s.add(id);
    }
    return s;
}

/** ref → owning blockId (first/earliest block wins — outermost summary). */
function buildMessageOwnerMap(state: CompressionState): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) {
            if (!m.has(id)) m.set(id, b.blockId);
        }
    }
    return m;
}

function estimateTokens(text: string): number {
    if (typeof text !== "string" || !text) return 0;
    const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkCount = cjk?.length ?? 0;
    return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

function toRole(entry: SessionMessageEntry): MessageRole | null {
    const role = entry.message.role;
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "toolResult") return "tool";
    return null;
}

export function buildSearchDocs(ctx: ExtensionContext, state: CompressionState): SearchDoc[] {
    const sm = ctx.sessionManager;
    const allEntries: SessionEntry[] = sm.getEntries();
    const covered = buildCoveredRefs(state);
    const ownerMap = buildMessageOwnerMap(state);

    const blockTier = new Map<string, number>();
    for (const b of state.blocks) blockTier.set(b.blockId, b.tier ?? 1);

    const msgs: MessageInput[] = [];
    for (const entry of allEntries) {
        if (entry.type !== "message") continue;
        const role = toRole(entry);
        if (!role) continue;

        const cores = entriesToCoreMessages([entry]);
        for (const cm of cores) {
            if (!cm.id) continue;
            // Only include messages that were compressed into a block.
            // Still-live messages are visible to the model — no need to search them.
            if (!covered.has(cm.id)) continue;
            const text = cm.text ?? "";
            if (!text || text.length < 2) continue;
            const ownerBlock = ownerMap.get(cm.id);
            msgs.push({
                ref: cm.id,
                role,
                text,
                tokens: estimateTokens(text),
                blockId: ownerBlock,
                tier: ownerBlock ? blockTier.get(ownerBlock) : undefined,
            });
        }
    }

    return [...blockDocs(state), ...messageDocs(msgs)];
}
