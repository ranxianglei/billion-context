import type { CompressionState } from "acp-kernel";
import { findSessionByCanonicalId, markDirty, peekSession, type Session } from "./session.js";
import { getStore } from "./persist.js";
import type { WireProtocol } from "./util.js";

/**
 * Derived-session inheritance (#1333): hosts with an EXPLICIT parent/child
 * relationship (Prime RLM inline spawns write `parentSession` into the child
 * session-file header; opencode task-tool subagents carry `parentID`) report
 * the parent conversation id at binding time (x-bili-plugin-parent-conversation
 * header or register body). On the child's FIRST request the proxy seeds its
 * compression archive from the parent, so search_context / decompress reach
 * everything the parent could — the host-adapter contract §2 parity the pi
 * native adapter already provides via deriveChildState (#367) + #534.
 *
 * Why DORMANT (inactive) copies instead of fork-adoption-style live adoption:
 * - An RLM child starts a FRESH history — the parent's messages are NOT in its
 *   wire context, so adopted blocks would anchor nowhere. Active unanchored
 *   blocks float to the top of the rebuilt view (stale-summary pollution), and
 *   reapOrphanBlocks (src/orphan-gc.ts) deactivates zero-anchor blocks after 3
 *   turns and deletes their cached content — the archive would self-destruct.
 * - Dormant blocks are skipped by orphan-gc, by coveredMessageIds /
 *   highestActiveTier / advanceSurvival, and are NEVER rendered into the
 *   child's view (zero token cost, zero pollution). `expanded: true` pins the
 *   dormancy through the kernel's syncBlocks resurrection pass (a plain
 *   inactive block flips active→inactive on every processTurn).
 * - Retrieval still works: core.decompress resolves by blockId with NO active
 *   filter (acp-kernel blockById), and the original content lives in
 *   session.blockContents (captured at compress time) — copied here, so the
 *   child is SELF-CONTAINED: no runtime ancestor lookup, works after the
 *   parent conversation is evicted or deleted. search_context is extended in
 *   src/decompress-shared.ts to score the dormant archive alongside the
 *   child's own active blocks (core.search scans active-only).
 *
 * Deliberately NOT inherited (same exclusions as applyForkAdoption): nudge
 * state, stats, rules, absorbed records, terminal streak, tokenSnapshot of
 * live messages — the child measures its own growth from its own baseline.
 *
 * Independence from #629: fork-adoption INFERS an anonymous mid-history fork
 * from prefix affinity and filters blocks by incoming-id presence (untrusted
 * inference). Here the host DECLARES the relationship, so the whole archive is
 * copied unfiltered — and the two paths never both fire for one session
 * (this one requires a declaration; that one requires anon affinity).
 */

export interface SeedDerivedArgs {
    /** The fresh child session (first request, no processed state yet). */
    session: Session;
    /** Parent conversation id as declared by the host (verbatim). */
    parentId: string;
    protocol: WireProtocol;
    upstreamOrigin: string;
    enabled: boolean;
    log: (level: string, msg: string) => void;
}

/** Highest ref number used in a ref map (refs look like "m00042"). */
function maxRefNumber(state: CompressionState): number {
    let max = 0;
    for (const key of Object.keys(state.messageRefs.byRef)) {
        const n = Number(key);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
}

export function seedDerivedSession(args: SeedDerivedArgs): void {
    const { session, parentId, protocol, upstreamOrigin, enabled, log } = args;
    // Replay guard: the server gates on stats.requests === 0, but never seed
    // twice regardless (a restart reload must not re-copy the archive).
    if (session.stats.requests > 0 || session.metadata.derivedFrom !== undefined) return;
    let parent = peekSession(parentId) ?? findSessionByCanonicalId(parentId);
    if (!parent) parent = getStore().loadSync(parentId, { protocol, upstreamOrigin }) ?? undefined;
    if (!parent) {
        log("info", `[rlm-inherit] ${protocol} session ${session.id} declared parent ${parentId}: parent not found (evicted and not persisted); starting fresh (#1333)`);
        return;
    }
    if (parent.id === session.id) {
        log("warn", `[rlm-inherit] session ${session.id} declared ITSELF as parent; ignoring (#1333)`);
        return;
    }
    if (!enabled) {
        log("info", `[rlm-inherit] session ${session.id} declared parent ${parentId}: parent holds ${parent.state.blocks.length} block(s); rlmInherit disabled, starting fresh (#1333)`);
        return;
    }
    const inheritedIds: string[] = [];
    let tokens = 0;
    for (const block of parent.state.blocks) {
        const clone = structuredClone(block);
        clone.active = false;
        clone.expanded = true;
        session.state.blocks.push(clone);
        inheritedIds.push(clone.blockId);
        tokens += clone.compressedTokens;
    }
    for (const id of inheritedIds) {
        const content = parent.blockContents.get(id);
        if (content !== undefined) session.blockContents.set(id, structuredClone(content));
    }
    for (const [raw, ref] of Object.entries(parent.state.messageRefs.byRaw)) {
        if (session.state.messageRefs.byRaw[raw] === undefined) session.state.messageRefs.byRaw[raw] = ref;
    }
    for (const [ref, raw] of Object.entries(parent.state.messageRefs.byRef)) {
        if (session.state.messageRefs.byRef[ref] === undefined) session.state.messageRefs.byRef[ref] = raw;
    }
    for (const [ref, count] of Object.entries(parent.state.tokenSnapshot)) {
        if (session.state.tokenSnapshot[ref] === undefined) session.state.tokenSnapshot[ref] = count;
    }
    // Continue the parent's id spaces: the kernel allocates block/run ids from
    // nextBlockId/nextRunId and refs from highestUsedIndex(byRef)+1, so the
    // child's future compressions can never re-issue an inherited id/ref.
    session.state.nextBlockId = Math.max(session.state.nextBlockId, parent.state.nextBlockId);
    session.state.nextRunId = Math.max(session.state.nextRunId, parent.state.nextRunId);
    session.metadata.derivedFrom = {
        parentConversationId: parent.id,
        declaredParentId: parentId,
        at: Date.now(),
        blocks: inheritedIds.length,
    };
    session.metadata.inheritedBlockIds = inheritedIds;
    markDirty(session);
    log("info", `[rlm-inherit] session ${session.id} inherited ${inheritedIds.length} block(s) (~${tokens} tokens, refs up to m${String(maxRefNumber(session.state)).padStart(5, "0")}) from parent ${parent.id} (#1333)`);
}
