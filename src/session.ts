import { createInitialState, type CompressionState, type CoreMessage } from "acp-kernel";
import { getStore } from "./persist.js";

export type BlockView = { text: string; count: number };

/** Original content of a compressed block, captured at compress time. `full`
 *  (all original messages) is always stored. `one` (one-level: direct messages
 *  + nested child summaries) is `null` when it is byte-identical to `full` —
 *  always the case for leaf blocks, since nested children are deactivated at
 *  creation and the one-level view skips inactive children — and is persisted
 *  as a single copy in that case (#401: the duplicated copy was 50% of
 *  blockContents bytes on disk). */
export type BlockContent = {
    one: BlockView | null;
    full: BlockView;
};

/** One successful compress, recorded for #189 observability: correlating a
 *  downstream transient upstream rejection (e.g. GLM 3007 captcha) with the
 *  context rewrite that preceded it. `shrinkRatio` is the fraction of the
 *  pre-compress context removed by this compress; `foldPoint` is the start ref
 *  of the earliest folded range (where the prefix structure rewrites). */
export type LastCompressInfo = {
    at: number;
    shrinkRatio: number;
    foldPoint: string;
    blocks: number;
    tokensCompressed: number;
};

/** Compact suffix for retry/error logs: the rewrite that may have triggered a
 *  transient upstream rejection. Empty when no compress has been recorded. */
export function lastCompressSuffix(info: LastCompressInfo | undefined): string {
    if (!info) return "";
    return ` [after compress: shrink ${Math.round(info.shrinkRatio * 100)}% foldPoint=${info.foldPoint} blocks=${info.blocks} ~${info.tokensCompressed}tok]`;
}

export type Session = {
    id: string;
    /** Identity / descriptive metadata. Populated on first request. */
    meta: {
        /** Client wire protocol. Absent until the first request resolves it.
         *  Captured at first request and persisted, so the on-disk filename can
         *  be namespaced by protocol/provider (e.g.
         *  sessions/anthropic/bailian_<hash>.json) and a human can tell
         *  sessions apart at a glance. */
        protocol?: "anthropic" | "openai" | "responses";
        /** Upstream origin URL this session routes to. */
        upstreamOrigin?: string;
        /** Human-readable conversation label (the affinity token), e.g.
         *  "ses_abc123" from opencode's x-session-affinity, or a client-provided
         *  id from codex's body.session_id. Pure conversation dimension — no
         *  key or upstream — so it is safe to display. Empty/undefined if the
         *  client sent none. */
        label?: string;
        /** Short human-readable title derived from the first user message
         *  (truncated). Lets the web UI show "Fix auth bug" instead of a hash.
         *  Set once on the first request that has a user message. */
        title?: string;
    };
    /** Cumulative usage stats, summed across all requests. Each sample =
     *  one upstream usage report. Persisted; survives restart. */
    stats: {
        requests: number;
        /** Approximate tokens saved by compression (legacy/rough — kept for
         *  backward compat with old session files, not shown in UI). */
        tokensSaved: number;
        /** Cumulative input (prompt) tokens billed by upstream. */
        inputTokens: number;
        /** Cumulative prompt-cache-hit tokens. */
        cachedTokens: number;
        /** Cumulative output (completion) tokens. */
        outputTokens: number;
        /** Number of upstream usage samples recorded. */
        cacheSamples: number;
        /** Last upstream-reported input_tokens for THIS session (single-turn,
         *  overwritten each turn). Source of truth for tokenCount — never an
         *  estimate. See onCacheUsage in compress-loop-*.ts. */
        lastInputTokens: number;
        /** Tokens compressed THIS turn whose fold has not yet materialized in
         *  an upstream usage report (the post-compress re-request re-sends the
         *  UNFOLDED history for prefix-cache reasons, so its usage report
         *  over-reports). Usage recorders net this credit out of
         *  lastInputTokens; the next prepare() — where the fold actually
         *  happens — clears it. In-memory only. */
        compressCreditTokens: number;
        /** Current in-context (uncompressed) token count at last processTurn. */
        contextTokens: number;
    };
    /** Free-form escape hatch for future fields not yet promoted to typed
     *  members. Persisted as-is (must be JSON-serializable). Use sparingly —
     *  prefer promoting a stable field into `meta` or `stats` once it's clear. */
    metadata: Record<string, unknown>;
    state: CompressionState;
    createdAt: number;
    lastSeen: number;
    /** Original content of compressed blocks, captured at compress time when
     *  the source messages are still present in the request. decompress reads
     *  from here instead of scanning ctx.messages (which only holds the
     *  post-compression / folded view and loses originals across rounds).
     *  Two views are cached — `one` (one-level: direct messages + nested
     *  child summaries) and `full` (all original messages), matching the
     *  collectBlockContent full flag semantics — but when the views are
     *  byte-identical (leaf blocks) only one copy is kept (`one: null`,
     *  #401).
     *  Unbounded in memory by design — block summaries are small relative to
     *  the history they replace, and disk persistence keeps the source of
     *  truth; the MAX_SESSIONS cap bounds the number of concurrent sessions
     *  in memory. See persist.ts. */
    blockContents: Map<string, BlockContent>;
    /** Latest full conversation snapshot, taken from the client's raw request
     *  each turn (originalMessages). The client is the source of truth and
     *  sends its complete history every request, so overwriting this per
     *  request keeps a bounded, up-to-date copy — that is what makes offline
     *  export complete. Bounded by MAX_SESSIONS, same as blockContents. */
    lastMessages?: CoreMessage[];
    /** Number of in-flight requests using this session. A session with
     *  inFlight > 0 must NOT be LRU-evicted: evicting it mid-stream flushes a
     *  half-mutated snapshot and then a miss reloads a SECOND Session object,
     *  causing split-brain writes to the same file. See persist.ts M5. */
    inFlight: number;
    /** False until the first successful write to disk. evictOldest will not
     *  drop a never-persisted session on flush failure (that would be a
     *  permanent loss). */
    persisted: boolean;
    /** In-memory only (NOT persisted — buildRecord omits it): true while the
     *  session was restored from disk and has seen no request in THIS process
     *  (#404). Restored sessions carry their on-disk savedAt as lastSeen (not
     *  Date.now()), so consumers can tell boot-restore staleness from real
     *  activity; fallback=latest skips restored sessions rather than guessing
     *  among a readdir-order tie. Cleared on the first real request touch. */
    restored?: boolean;
    /** In-memory only (NOT persisted — buildRecord omits it): the most recent
     *  successful compress, set by applyRanges and read by the replay/preflight
     *  retry callbacks to correlate a transient upstream rejection with the
     *  rewrite that preceded it (#189). A fresh process has none. */
    lastCompress?: LastCompressInfo;
    /** In-memory only (NOT persisted): tokens folded out of THIS request's
     *  forwarded view vs the host's own (unfolded) view, computed in prepare*
     *  as est(originalMessages) − est(processedMessages). Usage recorders add
     *  this back into the input-side usage field before forwarding to the host,
     *  so the host's usage anchor carries the uncompressed baseline instead of
     *  the post-fold value (#408). Overwritten each prepare(); 0 when nothing
     *  was folded this request. */
    hostCreditTokens?: number;
    /** In-memory only (NOT persisted): last input-side usage total reported to
     *  the host AFTER the hostCreditTokens backfill (uncompressed baseline).
     *  Feeds the /acp panel tokenCount so it matches what the host footer
     *  shows (#408). 0/undefined until the first backfilled usage lands. */
    hostContextTokens?: number;
    /** Promise chain for per-session serialization. Two concurrent requests
     *  sharing a session id would interleave processTurn / stream-rewriter
     *  mutations on session.state, corrupting it. withSessionLock chains each
     *  critical section onto the previous one so they run strictly in order. */
    lockChain?: Promise<unknown>;
};

const sessions = new Map<string, Session>();

// `|| 256` only catches falsy (0/NaN); Math.max(1, ...) also rejects negatives.
let MAX_SESSIONS = Math.max(1, Number.parseInt(process.env.BILI_MAX_SESSIONS ?? "256", 10) || 256);

let initialized = false;

/** Bulk-load persisted sessions from disk into the in-memory map. Called once
 *  at server startup before listening. boot() does ONE loadAll pass plus the
 *  #286 migration over the same parsed map (#401: the
 *  old migrateLegacyIds()+loadAll() pair walked and parsed the tree twice).
 *  Caps at MAX_SESSIONS by the most recently active of createdAt/lastSeen-
 *  from-disk (keeps the freshest; a session that is old but was active until
 *  recently must not lose its slot to a newer-created-but-idle one, #404) so
 *  a huge backlog cannot OOM on boot. Idempotent. */
export async function initSessions(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const store = getStore();
    if (!store.enabled) return;
    const loaded = await store.boot();
    if (loaded.size > MAX_SESSIONS) {
        const freshness = (s: Session) => Math.max(s.createdAt ?? 0, s.lastSeen ?? 0);
        const entries = [...loaded.entries()].sort((a, b) => freshness(b[1]) - freshness(a[1]));
        for (const [id, s] of entries) {
            if (sessions.size >= MAX_SESSIONS) break;
            sessions.set(id, s);
        }
    } else {
        for (const [id, s] of loaded) sessions.set(id, s);
    }
}

export function getSession(id: string, meta?: { protocol?: Session["meta"]["protocol"]; upstreamOrigin?: string; label?: string }): Session {
    const existing = sessions.get(id);
    if (existing) {
        existing.lastSeen = Date.now();
        existing.restored = false;
        // Fill in protocol/upstream/label meta on an existing session if the caller
        // now knows it (e.g. a session was created by loadAll without meta).
        if (meta?.protocol && !existing.meta.protocol) existing.meta.protocol = meta.protocol;
        if (meta?.upstreamOrigin && !existing.meta.upstreamOrigin) existing.meta.upstreamOrigin = meta.upstreamOrigin;
        if (meta?.label && !existing.meta.label) existing.meta.label = meta.label;
        return existing;
    }
    // Memory miss: try reload from disk (e.g. after LRU eviction).
    const store = getStore();
    const reloaded = store.loadSync(id, meta);
    if (reloaded) {
        // A memory-miss reload is triggered by a real request: stamp fresh
        // activity, not the restored-from-disk state (#404).
        reloaded.lastSeen = Date.now();
        reloaded.restored = false;
        reloaded.persisted = true;
        sessions.set(id, reloaded);
        return reloaded;
    }
    if (sessions.size >= MAX_SESSIONS) {
        const evicted = evictOldest();
        if (!evicted) {
            throw new Error(`session pool exhausted (MAX_SESSIONS=${MAX_SESSIONS}; all in-flight)`);
        }
    }
    const session: Session = {
        id,
        meta: { protocol: meta?.protocol, upstreamOrigin: meta?.upstreamOrigin, label: meta?.label },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
    sessions.set(id, session);
    return session;
}

/** Mark a session as in-use by a request. Must be paired with releaseInFlight.
 *  Prevents LRU eviction of a session mid-stream. */
export function acquireInFlight(session: Session): void {
    session.inFlight++;
}

/** Release an in-use marker. Decrements; the session becomes evictable again. */
export function releaseInFlight(session: Session): void {
    if (session.inFlight > 0) session.inFlight--;
}

/** Serialize a critical section per session. Each call chains onto the
 *  previous lockChain, so concurrent requests for the same session execute
 *  strictly one-at-a-time. This prevents two processTurn / stream-rewriter
 *  invocations from interleaving mutations on session.state.
 *
 *  For single-agent workflows (the common case) there is no contention and
 *  the chain resolves immediately. The cost is one Promise allocation. */
export async function withSessionLock<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    const prev = session.lockChain ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    session.lockChain = prev.then(() => done);
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

export function listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Read-only in-memory lookup. Unlike getSession, never creates or reloads a
 *  session — used by the plugin tool API, which must not conjure state for a
 *  conversation it has never seen. */
export function peekSession(id: string): Session | undefined {
    return sessions.get(id);
}

/** Overwrite the session's full-conversation snapshot with the latest client
 *  raw request messages (originalMessages from prepare*). One array per
 *  session, replaced every request — bounded, always the newest state. Empty
 *  arrays (parse failures) never clobber a good snapshot. */
export function snapshotMessages(session: Session, messages: CoreMessage[]): void {
    if (messages.length > 0) session.lastMessages = messages;
}

/** Mark a session's state as changed so it is persisted on the next debounce.
 *  Call this after any mutation (processTurn, compress, decompress, orphan GC). */
export function markDirty(session: Session): void {
    getStore().scheduleSave(session);
}

/** Record original block content at compress time. */
export function cacheBlockContent(session: Session, blockId: string, content: BlockContent): void {
    session.blockContents.set(blockId, content);
}

export function resetSessionCompression(session: Session): void {
    session.state = createInitialState();
    session.blockContents.clear();
    session.stats.lastInputTokens = 0;
    session.stats.contextTokens = 0;
    session.hostCreditTokens = 0;
    session.hostContextTokens = 0;
    session.metadata.nativeCompactionAt = Date.now();
    markDirty(session);
}

export function markNativeCompactionBoundary(session: Session): void {
    session.metadata.nativeCompactionBoundary = {
        at: Date.now(),
        pendingRebase: true,
    };
    markDirty(session);
}

export function reconcileNativeCompactionBoundary(session: Session): boolean {
    const boundary = session.metadata.nativeCompactionBoundary;
    if (!boundary || typeof boundary !== "object" || !(boundary as Record<string, unknown>).pendingRebase) {
        return false;
    }
    resetSessionCompression(session);
    session.metadata.nativeCompactionBoundary = {
        ...(boundary as Record<string, unknown>),
        pendingRebase: false,
        rebasedAt: Date.now(),
    };
    markDirty(session);
    return true;
}

/** Mark a client-side native compaction (omp /compact on the anthropic wire).
 *  The sid does NOT rotate on in-session compaction, so the per-sid registry
 *  reuses the same key with stale state. Consumed by the NEXT processTurn via
 *  applyCompactionArchive (#395). Distinct from nativeCompactionBoundary
 *  (Responses/codex, which rebases by resetting state). */
export function markCompactionBoundary(session: Session): void {
    session.metadata.compactionBoundary = {
        at: Date.now(),
        pending: true,
    };
    markDirty(session);
}

type PreCompactionArchive = Record<string, { at: number; reason: string }>;

function readPreCompactionArchive(session: Session): PreCompactionArchive {
    const raw = session.metadata.preCompactionArchive;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as PreCompactionArchive;
    }
    return {};
}

export function preCompactionArchiveOf(session: Session): PreCompactionArchive {
    return readPreCompactionArchive(session);
}

// Must run AFTER the processTurn that followed markCompactionBoundary (so
// syncBlocks has deactivated the blocks whose raw ids left the shortened
// history). Blocks active in `activeBefore` but inactive now are archived;
// byRaw/byRef are pruned to liveRawIds (stops the #390 additive leak).
// nextIndex is left alone so a freed ref slot is never re-allocated onto a
// retained tail's live tag.
export function applyCompactionArchive(
    session: Session,
    activeBefore: Set<string>,
    liveRawIds: Set<string>,
    log: (level: string, msg: string) => void,
): void {
    const boundary = session.metadata.compactionBoundary;
    if (!boundary || typeof boundary !== "object" || !(boundary as Record<string, unknown>).pending) {
        return;
    }
    const activeAfter = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    const deactivated = [...activeBefore].filter((id) => !activeAfter.has(id));
    if (deactivated.length > 0) {
        const archive = readPreCompactionArchive(session);
        const at = Date.now();
        for (const id of deactivated) {
            archive[id] = { at, reason: "content replaced by client native compaction summary" };
        }
        session.metadata.preCompactionArchive = archive;
    }

    const { byRaw, byRef } = session.state.messageRefs;
    const prunedByRaw: Record<string, string> = {};
    for (const [rawId, ref] of Object.entries(byRaw)) {
        if (liveRawIds.has(rawId)) prunedByRaw[rawId] = ref;
    }
    const prunedByRef: Record<string, string> = {};
    for (const [ref, rawId] of Object.entries(byRef)) {
        if (liveRawIds.has(rawId)) prunedByRef[ref] = rawId;
    }
    session.state.messageRefs.byRaw = prunedByRaw;
    session.state.messageRefs.byRef = prunedByRef;

    session.metadata.compactionBoundary = {
        ...(boundary as Record<string, unknown>),
        pending: false,
        archivedAt: Date.now(),
        archivedBlocks: deactivated,
    };
    markDirty(session);
    log("info", `[${session.id}] native compaction boundary: archived ${deactivated.length} pre-compaction block(s)${deactivated.length > 0 ? ` (${deactivated.join(", ")})` : ""}; pruned ref maps to ${prunedByRaw.length} live raw id(s)`);
}

/** Flush a session to disk and drop it from memory (LRU eviction). Refuses to
 *  evict sessions that are in-flight or whose flush failed (would lose a
 *  never-persisted session permanently). Returns true if a slot was freed. */
function evictOldest(): boolean {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, s] of sessions) {
        // Never evict a session being actively mutated by a request — flushing
        // its half-mutated state then reloading a second object causes
        // split-brain writes to the same file.
        if (s.inFlight > 0) continue;
        if (s.lastSeen < oldestSeen) {
            oldestSeen = s.lastSeen;
            oldestId = id;
        }
    }
    if (!oldestId) return false;
    const s = sessions.get(oldestId)!;
    const ok = getStore().flushSync(s);
    if (!ok && !s.persisted) {
        // Flush failed AND this session was never written to disk — evicting
        // would permanently lose it. Keep it in memory instead.
        return false;
    }
    sessions.delete(oldestId);
    return true;
}

/** Graceful shutdown: flush all sessions with pending writes. */
export async function flushAllSessions(): Promise<void> {
    await getStore().flushAll(sessions.values());
}

export function _resetSessionsForTest(max?: number): void {
    if (max !== undefined) MAX_SESSIONS = Math.max(1, Math.floor(max));
    for (const s of sessions.values()) {
        if (s.inFlight > 0) s.inFlight = 0;
    }
    sessions.clear();
}

export function _sessionsSizeForTest(): number {
    return sessions.size;
}
