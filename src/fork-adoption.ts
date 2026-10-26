import { anthropicToCore, googleToCore, openaiToCore } from "acp-kernel/wire";
import { BLOCKED_REF, STORED_PLACEHOLDER_MARKER, highestUsedIndex, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { stripRawStage } from "./marker/engine.js";
import { normalizeResponsesMessageItems, sanitizeResponsesInputIds, dropWhitespaceResponsesMessages } from "./loop/adapter-responses.js";
import { responsesToCoreWithToolImages } from "./responses-tool-output.js";
import { replaceBiliCompactionItems } from "./codex-compact.js";
import { peekSession, markDirty, reserveRefsThrough, type Session } from "./session.js";
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
 *
 * #1486 extends the same machinery to identified clients whose RESUME forks
 * a new session id (Claude Code --resume replays the full transcript under a
 * fresh UUID): maybeAdoptResume inherits ALL ref assignments whose raw ids
 * appear in the resumed transcript (seedAllRefs — the model's stale citations
 * span the whole history, not just folded blocks) plus, when the operator
 * enables it, the fully-present blocks. Refs are content-addressed (raw ids
 * are SHA-256 of message identity), so an inherited ref always denotes the
 * exact bytes the model saw: a stale citation resolves to its original
 * instead of mis-hitting a renumbered message, and fresh messages number
 * above the parent's ref space (kernel cursor semantics).
 */

/** Protocols whose prepare* pipeline this module mirrors for the id pass.
 *  All four wires are covered (#1853): responses and google log-skipped in
 *  v1, so identified resumes on those wires (codex over /v1/responses;
 *  gemini clients with a conversation header) inherited nothing but lineage
 *  and re-folded everything the parent had already folded. */
const SUPPORTED: ReadonlySet<WireProtocol> = new Set<WireProtocol>(["openai", "anthropic", "responses", "google"]);

interface ForkAdoptionPlan {
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
 *  will see. Returns null for protocols without adoption support.
 *  #1853: the responses branch mirrors prepareResponses's pre-projection
 *  mutations IN ORDER (compaction-echo replacement → type stamping → id
 *  sanitize → whitespace drop → panel/marker strip → chain-carrier strip)
 *  before converting with the same tool-images wrapper prepare uses; google
 *  mirrors prepareGoogle (chain-carrier strip → googleToCore). Id parity
 *  with the kernel's processTurn input is the whole point: an id this pass
 *  misses drops a parent ref from the inheritance; an id it invents matches
 *  nothing (harmless superset). The plugin-mode mid-history sys/developer
 *  in-place marking (prepareResponses's `__bili_inplace_sysdev`) is
 *  deliberately NOT replicated: marked or hoisted, those items contribute
 *  no core message either way, so the id set is identical. */
export function incomingCoreMessages(protocol: WireProtocol, parsed: unknown): CoreMessage[] | null {
    if (!SUPPORTED.has(protocol)) return null;
    const clone = structuredClone(parsed) as Record<string, unknown>;
    if (protocol === "responses") {
        if (Array.isArray(clone.input)) {
            const { items, replaced, dropped } = replaceBiliCompactionItems(clone.input);
            if (replaced + dropped > 0) clone.input = items;
        }
        normalizeResponsesMessageItems(clone.input);
        sanitizeResponsesInputIds(clone.input);
        dropWhitespaceResponsesMessages(clone.input);
        stripRawStage(clone, "responses");
        return responsesToCoreWithToolImages(clone as Parameters<typeof responsesToCoreWithToolImages>[0]).msgs;
    }
    if (protocol === "google") {
        stripRawStage(clone, "google");
        return googleToCore(clone as Parameters<typeof googleToCore>[0]).msgs;
    }
    stripRawStage(clone, protocol);
    if (protocol === "openai") {
        return openaiToCore(clone as Parameters<typeof openaiToCore>[0]).msgs;
    }
    return anthropicToCore(clone as Parameters<typeof anthropicToCore>[0]).msgs;
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
 *  the parent, returns a plan, mutates nothing.
 *  opts.seedAllRefs (#1486): seed EVERY ref whose raw id is present in the
 *  incoming request, not just the ones covered by adopted blocks — a resumed
 *  client cites refs across its whole history (its own earlier text), so the
 *  block-covered subset is far too small. Defaults false (existing callers
 *  keep their behavior).
 *  opts.includeBlocks: set false to plan refs only (no block adoption). */
export function planForkAdoption(
    parent: Session,
    incomingIds: Set<string>,
    opts?: { seedAllRefs?: boolean; includeBlocks?: boolean },
): ForkAdoptionPlan {
    const includeBlocks = opts?.includeBlocks ?? true;
    const byId = new Map<string, CompressionBlock>();
    for (const b of parent.state.blocks) byId.set(b.blockId, b);

    const active: CompressionBlock[] = [];
    let straddled = 0;
    if (includeBlocks) {
        for (const b of parent.state.blocks) {
            if (!b.active) continue;
            if (b.effectiveMessageIds.length === 0) continue;
            if (b.effectiveMessageIds.every((id) => incomingIds.has(id))) active.push(b);
            else straddled++;
        }
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
    if (opts?.seedAllRefs) {
        for (const id of incomingIds) {
            if (parent.state.messageRefs.byRaw[id]) rawIds.add(id);
        }
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
        // #2620: the kernel BLOCKED sentinel (protected tool messages) has no numeric
        // counterpart and is shared by many messages — byRef must never hold it.
        if (ref !== BLOCKED_REF) byRef[ref] = raw;
        const snap = parent.state.tokenSnapshot[ref];
        if (typeof snap === "number" && ref !== BLOCKED_REF) tokenSnapshot[ref] = snap;
        const idx = Number(ref.replace(/\D/g, "")) || 0;
        if (idx > maxIndex && ref !== BLOCKED_REF) {
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
        // #2620: byRef must never hold the kernel BLOCKED sentinel (shared by many
        // protected messages) — reserve byRaw only; mirrors planForkAdoption above.
        if (ref !== BLOCKED_REF && !(ref in session.state.messageRefs.byRef)) session.state.messageRefs.byRef[ref] = raw;
    }
    for (const [ref, tokens] of Object.entries(plan.tokenSnapshot)) {
        if (!(ref in session.state.tokenSnapshot)) session.state.tokenSnapshot[ref] = tokens;
    }
    session.state.nextBlockId = Math.max(session.state.nextBlockId, plan.nextBlockId);
    session.state.nextRunId = Math.max(session.state.nextRunId, plan.nextRunId);
    // Seeded refs only cover messages present in the child, so the cursor
    // would restart below refs the parent assigned to messages the child
    // dropped (its failed tail, a rewound branch) — and the model's older
    // text may still cite those. Reserve the parent's whole ref space.
    reserveRefsThrough(session, highestUsedIndex(parent.state.messageRefs));
    // #3769: carry the orphan-cleanup ledgers too — without this, the failed
    // compress pairs the pre-upgrade keep-two rotation hid (hiddenOrphanRefs)
    // or the fold-gated sweep already swept (sweptOrphanCallIds) would
    // RESURFACE on resume/fork replay, rewriting mid-history at full cache
    // cost. Both are monotonic id/ref sets; the hide pass re-records them
    // every turn, so the carry self-perpetuates afterwards.
    if (parent.state.hiddenOrphanRefs?.length) session.state.hiddenOrphanRefs = [...parent.state.hiddenOrphanRefs];
    if (parent.state.sweptOrphanCallIds?.length) session.state.sweptOrphanCallIds = [...parent.state.sweptOrphanCallIds];
    // #3939 ③: same carry for the truncation latch — resume/fork replay
    // re-sends the clipped messages; without the latch the first replayed
    // turn under a lower estimate re-exposes the full bytes (oscillation).
    if (parent.state.emergencyTruncateLatch?.length) {
        session.state.emergencyTruncateLatch = parent.state.emergencyTruncateLatch.map((e) => ({ ...e }));
    }
    // #3939 ②: same carry for the migration render deferral — a resumed/forked
    // session re-sends the same history; without the deferral the first replay
    // stamps migration tags mid-history (the #3805 byte flip, resurrected).
    if (parent.state.renderDeferredRefs?.length) {
        session.state.renderDeferredRefs = [...parent.state.renderDeferredRefs];
    }
    // #3939 ⑤: same carry for the view latch — a resumed session re-sends the
    // same history; a dropped latch would flip transform bytes on the first
    // replayed turn (crush re-derived, absorb hides landing late).
    if (parent.state.viewLatches) {
        session.state.viewLatches = Object.fromEntries(
            Object.entries(parent.state.viewLatches).map(([k, v]) => [k, { ...v }]),
        );
    }
    if (parent.state.viewLatchConfigDigest) {
        session.state.viewLatchConfigDigest = parent.state.viewLatchConfigDigest;
    }
    markDirty(session);
}

/** #3925 → #3011 C9: what acp_status renders while a fork runs with zero
 *  inherited blocks — the "starting fresh despite an adoptable parent" gap. */
interface ForkAdoptionSkipped {
    parentId: string;
    blocks: number;
    tokens: number;
}

/** Typed read of the forkAdoptionSkipped metadata field (session.metadata is
 *  a free Record<string, unknown>; validate the shape on the way out). */
export function forkAdoptionSkippedOf(session: Session): ForkAdoptionSkipped | undefined {
    const raw = session.metadata.forkAdoptionSkipped;
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.parentId !== "string" || typeof r.blocks !== "number" || typeof r.tokens !== "number") return undefined;
    return { parentId: r.parentId, blocks: r.blocks, tokens: r.tokens };
}

/** #2986/#3925: the lineage link must be durable BEFORE the next request —
 *  markDirty alone persists on the debounce cadence, and a non-graceful exit
 *  inside that window strands the child unlinked forever (the boot sweep and
 *  the read-time decompress/search fallback both key off this link). Fire-
 *  and-forget on purpose: this runs on the model-request hot path, so we must
 *  not stall the response (mirrors persistLineageLinkNow in server/handle.ts). */
function persistForkLineageNow(session: Session, log: (level: string, msg: string) => void): void {
    void getStore().writeNow(session).catch((err) => {
        log("warn", `[fork-adoption] lineage durable write failed for ${session.id}: ${String(err)} (#2986)`);
    });
}

/** Server hook: on a fresh anonymous fork (via "new" + lineage "forked"),
 *  find the parent (memory first, then disk), measure what is adoptable, and
 *  seed the fresh session when enabled. Always logs the adoptable inventory —
 *  the measurement ework asked for in #629 — so operators can size the win
 *  before turning adoption on.
 *
 *  #3925 → #3011 C9: records the persistent derivedFromSessionId link at
 *  detection time whatever the adoption outcome — the same unconditional link
 *  #1333 writes for explicitly derived conversations. Without it a bail left
 *  NO trace: the boot sweep (reconcileDerivedLineage) only iterates sessions
 *  carrying derivedFromSessionId, and decompress/search_context's read-time
 *  parent fallback (derivedAncestorSessions) walks that same link — so an
 *  unlinked child is never healed across a restart and its search stays blind
 *  for life. The link copies nothing at link time; adoption still judges per
 *  block in raw-id set semantics, so a mis-guessed parent can at most be
 *  searched read-only, never adopted from. */
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
    // Link once the parent is confirmed loadable (a dangling link to a
    // vanished id would only churn the read-time walk for nothing).
    const linked = session.metadata.derivedFromSessionId === undefined;
    if (linked) {
        session.metadata.derivedFrom = parentId;
        session.metadata.derivedFromSessionId = parentId;
    }
    if (plan.adoptedActive === 0) {
        if (linked) persistForkLineageNow(session, log);
        log("info", `[fork-adoption] fork of ${parentId}: no fully-present blocks to adopt (${plan.straddled} straddle the fork point); starting fresh; lineage linked so the startup sweep can inherit later folds (#629/#3925)`);
        return;
    }
    if (!enabled) {
        session.metadata.forkAdoptionSkipped = { parentId, blocks: plan.adoptedActive, tokens: plan.adoptedTokens };
        persistForkLineageNow(session, log);
        log("warn", `[fork-adoption] fork of ${parentId}: parent has ${plan.adoptedActive} adoptable block(s) covering ~${plan.adoptedTokens} tokens; forkAdoption disabled, starting fresh (set forkAdoption: true or BILI_FORK_ADOPTION=1). Lineage linked — a bili restart lets the startup sweep inherit those blocks, and acp_status shows the gap (#3925)`);
        return;
    }
    applyForkAdoption(session, plan, parent);
    // #3351 discipline: close the derived-blocks gate ONLY on real block
    // adoption — the boot-sweep retry door stays open otherwise.
    session.metadata.derivedBlocksAdopted = true;
    persistForkLineageNow(session, log);
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

/** Outcome of an inheritance attempt (#3351): lets the caller tell "blocks
 *  were adopted" apart from "refs-only / nothing," so the derived-blocks gate
 *  closes only on real block adoption — the same discipline the boot sweep
 *  (reconcileDerivedLineage) applies, not on ref-only seeding. */
interface AdoptionOutcome {
    adoptedActive: number;
    seededRefs: number;
}

/** #1486: copy-on-resume for an identified client whose resume forked a new
 *  session id (Claude Code --resume). The parent is resolved by the caller
 *  (memory first, then disk) via prefix-affinity's byte-exact full-history
 *  match. Inherits every ref assignment whose raw id is present in the
 *  resumed transcript plus, when blocksEnabled, the fully-present blocks —
 *  same copy-on-fork guarantees as #629: clones only, parent untouched, runs
 *  once on the fresh session's first request. */
export function maybeAdoptResume(args: {
    session: Session;
    parent: Session;
    sharedDepth: number;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    blocksEnabled: boolean;
    log: (level: string, msg: string) => void;
}): AdoptionOutcome {
    const { session, parent, sharedDepth, protocol, parsed, upstreamOrigin, blocksEnabled, log } = args;
    const incomingMsgs = incomingCoreMessages(protocol, parsed);
    if (!incomingMsgs) {
        log("info", `[resume-inheritance] ${session.id}: resumed ${parent.id} (${sharedDepth} shared msgs) but ${protocol} has no adoption support in v1; lineage recorded, refs/blocks not inherited (#1486)`);
        return { adoptedActive: 0, seededRefs: 0 };
    }
    const ids = new Set(incomingMsgs.map((m) => m.id));
    const plan = planForkAdoption(parent, ids, { seedAllRefs: true, includeBlocks: blocksEnabled });
    const seededRefs = Object.keys(plan.refs.byRaw).length;
    if (seededRefs === 0 && plan.adoptedActive === 0) {
        log("info", `[resume-inheritance] ${session.id}: resume of ${parent.id} had nothing to inherit (no overlapping refs${blocksEnabled ? " or fully-present blocks" : ""}); starting fresh (#1486)`);
        return { adoptedActive: 0, seededRefs: 0 };
    }
    applyForkAdoption(session, plan, parent);
    log(
        "info",
        `[resume-inheritance] ${session.id} resumed ${parent.id}: inherited ${seededRefs} ref(s) up to ${plan.maxRef || "n/a"}${plan.adoptedActive > 0 ? `, ${plan.adoptedActive} block(s) (~${plan.adoptedTokens} tokens)` : ""}; stale citations now resolve to their original messages (#1486)`,
    );
    const wanted = new Set([...Object.keys(plan.refs.byRef), ...citedPlaceholderRefs(incomingMsgs)]);
    const storeSlice = cloneStoreForRefs(contentStoreOf(parent), wanted);
    if (storeSlice) {
        adoptContentStore(session, storeSlice);
        const n = Object.keys(storeSlice.byRef).length;
        log("info", `[resume-inheritance] ${session.id} adopted ${n} CCR content-store entr${n === 1 ? "y" : "ies"} for the inherited/cited refs from parent ${parent.id} (#1341/#1486)`);
    }
    return { adoptedActive: plan.adoptedActive, seededRefs };
}

/** #2807: the derived (plugin-register) fork link previously recorded
 *  lineage only and fell back to read-only decompress/search_context — a
 *  replay-fork child that missed the byte-exact prefix match (timestamp
 *  drift, a re-decorated tail, a protocol switch) re-sent the whole raw
 *  history while the parent's fold ledger sat on disk. Adopt the parent's
 *  fully-present blocks by message-id intersection at link time — the same
 *  copy-on-fork seeding maybeAdoptResume runs for the strong path, minus the
 *  byte-prefix requirement. The call lands once per session (handle.ts gates
 *  it on derivedFromSessionId === undefined); the derivedBlocksAdopted marker
 *  it sets gates the BOOT reconcile, and since #3351 it is set only when blocks
 *  were actually adopted (mirroring reconcileDerivedLineage), so a young parent
 *  with no folds yet keeps the door open for a later retry. Gated on
 *  resumeInheritance, NOT forkAdoption: this is an identified fork
 *  (the parent came from the plugin register), same class as the strong
 *  path; #1834/#629 reserve forkAdoption for anonymous forks, and answering
 *  to two different switches left the weak path dark while the boot-time
 *  reconcile (below) still adopted. */
export function maybeAdoptDerivedFork(args: {
    session: Session;
    parent: Session;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    enabled: boolean;
    log: (level: string, msg: string) => void;
}): void {
    const { session, parent, protocol, parsed, upstreamOrigin, enabled, log } = args;
    if (!enabled || session.metadata.derivedBlocksAdopted === true) return;
    try {
        const outcome = maybeAdoptResume({ session, parent, sharedDepth: 0, protocol, parsed, upstreamOrigin, blocksEnabled: true, log });
        if (outcome.adoptedActive > 0) {
            session.metadata.derivedBlocksAdopted = true;
        } else {
            log("info", `[${session.id}] [derived] no blocks adopted from ${parent.id} yet (refs-only or none fully present); leaving the gate open so the boot reconcile can retry once the parent folds (#3351)`);
        }
    } catch (e) {
        log("warn", `[${session.id}] [derived] block adoption from ${parent.id} failed (${String(e)}); continuing fresh (#2807)`);
    }
}

/**
 * Lineage reconcile on boot (#2807 / #1333): the derived fork lineage is
 * persisted (`metadata.derivedFromSessionId`, written by handle.ts:1363) but
 * until now it was write-only — nothing ever read it back. Both adoption
 * paths need process-local state the proxy does not have across a restart:
 * the strong path scans `prefixAffinity.trackedChains` (in-memory), and the
 * weak path needs `derivedParent` from the plugin register table
 * (`pendingRegisters`, in-memory). A bili restart therefore leaves every
 * forked child holding a full raw history with zero blocks while its parent's
 * fold ledger sits on disk — which is how a session that upstream measured at
 * ~480K tokens got rejected as ~1.4M.
 *
 * So reconcile the lineage the other way round: after boot, for every session
 * that records a parent and still has no blocks, load the parent from disk and
 * re-run adoption by raw-id set (see planForkAdoption). This closes the same
 * gap as #2791 (anonymous pfa-* forks) without needing the identity chain.
 *
 * Gated by `resumeInheritance`, not `forkAdoption`: #1834 reserves
 * `forkAdoption` for anonymous forks, while this is an identified lineage
 * (the parent id came from the plugin register) and belongs with the
 * byte-prefix strong path, which is on by default.
 */
export function reconcileDerivedLineage(
    sessions: Session[],
    opts: { log: (level: string, msg: string) => void; adoptionEnabled: boolean },
): number {
    const { log, adoptionEnabled } = opts;
    if (!adoptionEnabled) return 0;
    let adopted = 0;
    for (const s of sessions) {
        // A closed gate must not consume the marker either, so a session stays
        // eligible if the operator turns adoption on and restarts.
        const parentId: unknown = s.metadata.derivedFromSessionId;
        if (typeof parentId !== "string") continue;
        if (parentId === s.id) continue;
        if (s.state.blocks.length > 0) continue;
        if (s.metadata.derivedBlocksAdopted === true) continue;

        let parent = peekSession(parentId);
        if (!parent) {
            parent = getStore().loadSync(parentId, {
                protocol: s.meta.protocol,
                upstreamOrigin: s.meta.upstreamOrigin,
            }) ?? undefined;
        }
        if (!parent) {
            // Evicted before it was persisted — or restored later. Leave the
            // marker unset and retry on the next boot rather than closing the
            // door on a parent that may reappear.
            log("info", `[lineage-reconcile] ${s.id} records parent ${parentId}, which is not on disk; will retry next boot`);
            continue;
        }
        if (parent.state.blocks.length === 0) {
            // Nothing to adopt now. Leave the marker unset: the parent may fold
            // later, and in a multi-hop lineage an intermediate parent may adopt
            // after this one was visited.
            log("info", `[lineage-reconcile] ${s.id}: parent ${parentId} has no blocks to adopt yet; will retry next boot`);
            continue;
        }

        const incomingIds = new Set(Object.keys(s.state.messageRefs.byRaw));
        if (incomingIds.size === 0) {
            // Leave the marker unset: this session has served no request yet, so
            // its first request is still the real reconciliation point (the weak
            // derived path adopts from the parent then). Closing the gate here
            // would defeat that path.
            log("info", `[lineage-reconcile] ${s.id}: no refs to match parent ${parentId} against; deferring to the first request`);
            continue;
        }

        try {
            const plan = planForkAdoption(parent, incomingIds, { seedAllRefs: true });
            if (plan.adoptedActive === 0) {
                // Nothing fully present. Do NOT set the marker: in a multi-hop
                // lineage P→C→G the sweep may not have reached C yet, and a
                // straddled block becomes fully-present once the child grows.
                // Retry on the next boot — the plan is cheap.
                log("info", `[lineage-reconcile] ${s.id}: parent ${parentId} has nothing fully present yet (${plan.straddled} block(s) straddle the fork); will retry next boot`);
                continue;
            }
            applyForkAdoption(s, plan, parent);
            const wanted = new Set(Object.keys(plan.refs.byRef));
            const storeSlice = cloneStoreForRefs(contentStoreOf(parent), wanted);
            if (storeSlice) {
                adoptContentStore(s, storeSlice);
            }
            s.metadata.derivedFrom ??= parent.id;
            s.metadata.derivedFromSessionId = parent.id;
            s.metadata.derivedBlocksAdopted = true;
            adopted++;
            log("info", `[lineage-reconcile] ${s.id} adopted ${plan.adoptedActive} block(s) (~${plan.adoptedTokens} tokens, ${plan.straddled} straddled) from parent ${parent.id} (#2807)`);
        } catch (e) {
            // Transient (a corrupt parent file): leave the marker unset so a
            // later boot can still try, but never let one bad session abort the
            // whole sweep.
            log("warn", `[lineage-reconcile] ${s.id}: adoption from parent ${parent.id} failed (${e instanceof Error ? e.message : String(e)}); continuing`);
        }
    }
    return adopted;
}
