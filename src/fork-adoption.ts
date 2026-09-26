import { anthropicToCore, openaiToCore } from "acp-kernel/wire";
import { STORED_PLACEHOLDER_MARKER, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "./acp-panel.js";
import { peekSession, markDirty, type Session } from "./session.js";
import { getStore } from "./persist.js";
import { adoptContentStore, cloneStoreForRefs, contentStoreOf } from "./store.js";
import type { WireProtocol } from "./util.js";

/**
 * Fork block-adoption (#629): when an anonymous client's history diverges in
 * the middle (edited message, regenerate-from-earlier, parallel branches),
 * prefix-affinity forks it into a NEW session with zero compression state and
 * the shared prefix's folded blocks are lost — the client replays (and the
 * proxy re-compresses) content the parent had already folded (#351: a 458K
 * token history resent raw). Adoption fixes the waste: on fork, copy the
 * parent's compression blocks whose source content is FULLY present in the
 * incoming request into the fresh session, so the fork starts where the
 * shared prefix ended instead of at zero.
 *
 * Adoptability is judged in raw-id SET semantics, not position math: a raw id
 * is a SHA-256 of the message identity (role+contentType+text+toolCallId+
 * toolName, wire/message-id.ts), so the same bytes produce the same id in
 * parent and child. A block is adoptable iff every id in its
 * effectiveMessageIds appears among the incoming request's core ids —
 * position-free, immune to subagent interleaving and reordering, and it
 * naturally rejects blocks that straddle the fork point (some source messages
 * beyond the fork are absent from the incoming). Tier blocks (T2/T3) carry
 * their children's messages in effectiveMessageIds, so a qualifying tier
 * block drags its whole child closure along; children are copied as inactive
 * records exactly as they stand in the parent (consumed-by-parent).
 *
 * Seeding is the disk-restore recipe (persist.ts buildSession → mergeState)
 * applied to a filtered subset: blocks + blockContents + the messageRefs
 * entries of the adopted ids (+ their tokenSnapshot), plus the CCR content-
 * store entries behind those refs (#1341): a ref-filtered independent clone,
 * because adopted block summaries cite their covered refs as retrievable and
 * the fork must be able to honor that (an empty store turns every cited ref
 * into a miss — or, until the kernel's placeholder-as-original fix lands,
 * into a fake hit once the child folds). The clone also covers refs cited by
 * placeholder-shaped incoming messages, whose originals are absent from the
 * view and nothing else can restore. The kernel's assignRefs cursor is
 * highestUsedIndex(map)+1, so seeded refs push fresh assignments ABOVE the
 * parent's ref space — within the new session a ref number still denotes
 * exactly one message, ever (the kernel's id-never-reused contract).
 * Deliberately NOT inherited: nudge state, the parent's own stats counters,
 * absorbed records, rules, terminalStreak (store byte counters are recomputed
 * from the child's own store via adoptContentStore).
 *
 * Copy-on-fork, not shared: the parent is deep-copied and untouched, so the
 * two branches never mutate each other's blocks. Adoption runs once, on the
 * fresh session's FIRST request (stats.requests === 0), before prepare*'s
 * processTurn assigns refs; afterwards the fork resolves via a normal prefix
 * match and never re-adopts.
 */

/** Protocols whose prepare* pipeline this module mirrors for the id pass.
 *  Responses/google anonymous forks log-skip in v1 (their conversion
 *  pipelines differ; missing adoption there is a perf loss, never a
 *  correctness risk). */
const SUPPORTED: ReadonlySet<WireProtocol> = new Set<WireProtocol>(["openai", "anthropic"]);

export interface ForkAdoptionPlan {
    /** Blocks to seed (active adoptables + their tier children, inactive). */
    blocks: CompressionBlock[];
    /** blockIds in `blocks` (for blockContents lookup). */
    blockIds: Set<string>;
    /** Active (adoptable) block count — the headline number for logs. */
    adoptedActive: number;
    /** Sum of compressedTokens over the adopted ACTIVE blocks. */
    adoptedTokens: number;
    /** Active blocks rejected because part of their source is absent. */
    straddled: number;
    /** Highest ref string seeded, for logs. */
    maxRef: string;
    refs: { byRaw: Record<string, string>; byRef: Record<string, string> };
    tokenSnapshot: Record<string, number>;
    nextBlockId: number;
    nextRunId: number;
}

/** Core messages of the incoming request, computed through the SAME
 *  strip + convert pipeline as prepare* so the ids match what processTurn
 *  will see. Returns null for protocols without adoption support. */
function incomingCoreMessages(protocol: WireProtocol, parsed: unknown): CoreMessage[] | null {
    if (!SUPPORTED.has(protocol)) return null;
    const clone = structuredClone(parsed) as {
        messages?: unknown;
    };
    stripAcpPanelMessages(clone.messages);
    stripAcpStatusMarkers(clone.messages);
    if (protocol === "openai") {
        return openaiToCore(clone as Parameters<typeof openaiToCore>[0]).msgs;
    }
    return anthropicToCore(clone as Parameters<typeof anthropicToCore>[0]).msgs;
}

/** Core message ids of the incoming request (see incomingCoreMessages). */
export function incomingCoreIds(protocol: WireProtocol, parsed: unknown): Set<string> | null {
    const msgs = incomingCoreMessages(protocol, parsed);
    return msgs ? new Set(msgs.map((m) => m.id)) : null;
}

/** Refs cited by placeholder-shaped incoming messages (#1341). Such a
 *  message's own bytes differ from the original's, so its raw id maps to no
 *  parent ref — the citation embedded in the placeholder is the only link
 *  back to the stored original, and arrival-time storing skips placeholder
 *  text by design, so nothing else can restore it. */
function citedPlaceholderRefs(msgs: CoreMessage[]): string[] {
    const refs: string[] = [];
    for (const m of msgs) {
        const text = m.text ?? "";
        const at = text.indexOf(STORED_PLACEHOLDER_MARKER);
        if (at < 0) continue;
        const mm = /#(m\d{4,})/.exec(text.slice(at));
        if (mm) refs.push(mm[1]);
    }
    return refs;
}

/** Decide which of the parent's blocks survive into the fork. Pure: reads
 *  the parent, returns a plan, mutates nothing. */
export function planForkAdoption(parent: Session, incomingIds: Set<string>): ForkAdoptionPlan {
    const byId = new Map<string, CompressionBlock>();
    for (const b of parent.state.blocks) byId.set(b.blockId, b);

    const active: CompressionBlock[] = [];
    let straddled = 0;
    for (const b of parent.state.blocks) {
        if (!b.active) continue;
        if (b.effectiveMessageIds.length === 0) continue;
        if (b.effectiveMessageIds.every((id) => incomingIds.has(id))) active.push(b);
        else straddled++;
    }

    // Closure over directBlockIds: a tier block's children ride along as the
    // inactive records they are in the parent (their summaries back
    // decompress/acp_status history; they fold nothing on their own).
    const closure = new Set<string>();
    const queue = active.map((b) => b.blockId);
    while (queue.length > 0) {
        const id = queue.pop()!;
        if (closure.has(id)) continue;
        closure.add(id);
        for (const child of byId.get(id)?.directBlockIds ?? []) queue.push(child);
    }

    const blocks: CompressionBlock[] = [];
    const rawIds = new Set<string>();
    for (const id of closure) {
        const b = byId.get(id);
        if (!b) continue;
        blocks.push(structuredClone(b));
        for (const mid of b.effectiveMessageIds) rawIds.add(mid);
    }

    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const tokenSnapshot: Record<string, number> = {};
    let maxIndex = 0;
    let maxRef = "";
    for (const raw of rawIds) {
        const ref = parent.state.messageRefs.byRaw[raw];
        if (!ref) continue;
        byRaw[raw] = ref;
        byRef[ref] = raw;
        const snap = parent.state.tokenSnapshot[ref];
        if (typeof snap === "number") tokenSnapshot[ref] = snap;
        const idx = Number(ref.replace(/\D/g, "")) || 0;
        if (idx > maxIndex) {
            maxIndex = idx;
            maxRef = ref;
        }
    }

    return {
        blocks,
        blockIds: closure,
        adoptedActive: active.length,
        adoptedTokens: active.reduce((sum, b) => sum + b.compressedTokens, 0),
        straddled,
        maxRef,
        refs: { byRaw, byRef },
        tokenSnapshot,
        nextBlockId: parent.state.nextBlockId,
        nextRunId: parent.state.nextRunId,
    };
}

/** Seed a fresh fork session from the plan. Copy-on-fork: every value is a
 *  clone; the parent session is never touched. */
export function applyForkAdoption(session: Session, plan: ForkAdoptionPlan, parent: Session): void {
    for (const b of plan.blocks) {
        session.state.blocks.push(b);
        const content = parent.blockContents.get(b.blockId);
        if (content) session.blockContents.set(b.blockId, structuredClone(content));
    }
    for (const [raw, ref] of Object.entries(plan.refs.byRaw)) {
        if (!(raw in session.state.messageRefs.byRaw)) session.state.messageRefs.byRaw[raw] = ref;
        if (!(ref in session.state.messageRefs.byRef)) session.state.messageRefs.byRef[ref] = raw;
    }
    for (const [ref, tokens] of Object.entries(plan.tokenSnapshot)) {
        if (!(ref in session.state.tokenSnapshot)) session.state.tokenSnapshot[ref] = tokens;
    }
    session.state.nextBlockId = Math.max(session.state.nextBlockId, plan.nextBlockId);
    session.state.nextRunId = Math.max(session.state.nextRunId, plan.nextRunId);
    markDirty(session);
}

/** Server hook: on a fresh anonymous fork (via "new" + lineage "forked"),
 *  find the parent (memory first, then disk), measure what is adoptable, and
 *  seed the fresh session when enabled. Always logs the adoptable inventory —
 *  the measurement ework asked for in #629 — so operators can size the win
 *  before turning adoption on. */
export function maybeAdoptForkBlocks(args: {
    session: Session;
    parentId: string;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    enabled: boolean;
    log: (level: string, msg: string) => void;
}): void {
    const { session, parentId, protocol, parsed, upstreamOrigin, enabled, log } = args;
    const incomingMsgs = incomingCoreMessages(protocol, parsed);
    if (!incomingMsgs) {
        log("info", `[fork-adoption] ${protocol} anonymous fork of ${parentId}: no adoption support in v1, starting fresh (#629)`);
        return;
    }
    let parent = peekSession(parentId);
    if (!parent) parent = getStore().loadSync(parentId, { protocol, upstreamOrigin }) ?? undefined;
    if (!parent) {
        log("info", `[fork-adoption] fork parent ${parentId} not found (evicted and not persisted); starting fresh (#629)`);
        return;
    }
    const plan = planForkAdoption(parent, new Set(incomingMsgs.map((m) => m.id)));
    if (plan.adoptedActive === 0) {
        log("info", `[fork-adoption] fork of ${parentId}: no fully-present blocks to adopt (${plan.straddled} straddle the fork point); starting fresh (#629)`);
        return;
    }
    if (!enabled) {
        log("info", `[fork-adoption] fork of ${parentId}: parent has ${plan.adoptedActive} adoptable block(s) covering ~${plan.adoptedTokens} tokens; forkAdoption disabled, starting fresh (set forkAdoption: true or BILI_FORK_ADOPTION=1)`);
        return;
    }
    applyForkAdoption(session, plan, parent);
    log("info", `[fork-adoption] session ${session.id} adopted ${plan.adoptedActive} block(s) (~${plan.adoptedTokens} tokens, refs up to ${plan.maxRef || "n/a"}) from parent ${parentId} across fork (#629)`);
    // #1341: carry the originals behind the refs the fork now advertises as
    // retrievable — covered messages of the adopted blocks ∪ refs cited by
    // placeholder-shaped incoming messages (their originals left the view).
    const wanted = new Set([...Object.keys(plan.refs.byRef), ...citedPlaceholderRefs(incomingMsgs)]);
    const storeSlice = cloneStoreForRefs(contentStoreOf(parent), wanted);
    if (storeSlice) {
        adoptContentStore(session, storeSlice);
        const n = Object.keys(storeSlice.byRef).length;
        log("info", `[fork-adoption] session ${session.id} adopted ${n} CCR content-store entr${n === 1 ? "y" : "ies"} for the covered/cited refs from parent ${parentId} (#1341)`);
    }
}
