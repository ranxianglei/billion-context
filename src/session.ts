import { createInitialState, type CompressionState } from "acp-kernel";
import { getStore } from "./persist.js";

export type BlockContent = {
    one: { text: string; count: number };
    full: { text: string; count: number };
};

export type Session = {
    id: string;
    state: CompressionState;
    createdAt: number;
    lastSeen: number;
    requests: number;
    condensedToolResults: number;
    tokensSaved: number;
    /** Original content of compressed blocks, captured at compress time when
     *  the source messages are still present in the request. decompress reads
     *  from here instead of scanning ctx.messages (which only holds the
     *  post-compression / folded view and loses originals across rounds).
     *  Two views are cached: `one` (one-level: direct messages + nested
     *  child summaries) and `full` (all original messages), matching the
     *  collectBlockContent full flag semantics.
     *  Unbounded in memory by design — block summaries are small relative to
     *  the history they replace, and disk persistence keeps the source of
     *  truth; the MAX_SESSIONS cap bounds the number of concurrent sessions
     *  in memory. See persist.ts. */
    blockContents: Map<string, BlockContent>;
    /** Number of in-flight requests using this session. A session with
     *  inFlight > 0 must NOT be LRU-evicted: evicting it mid-stream flushes a
     *  half-mutated snapshot and then a miss reloads a SECOND Session object,
     *  causing split-brain writes to the same file. See persist.ts M5. */
    inFlight: number;
    /** False until the first successful write to disk. evictOldest will not
     *  drop a never-persisted session on flush failure (that would be a
     *  permanent loss). */
    persisted: boolean;
};

const sessions = new Map<string, Session>();

const MAX_SESSIONS = Number.parseInt(process.env.BILI_MAX_SESSIONS ?? "256", 10) || 256;

let initialized = false;

/** Bulk-load persisted sessions from disk into the in-memory map. Called once
 *  at server startup before listening. Caps at MAX_SESSIONS by savedAt
 *  (keeps the most recent) so a huge backlog cannot OOM on boot. Idempotent. */
export async function initSessions(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const store = getStore();
    if (!store.enabled) return;
    const loaded = await store.loadAll();
    if (loaded.size > MAX_SESSIONS) {
        const entries = [...loaded.entries()].sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0));
        for (const [id, s] of entries) {
            if (sessions.size >= MAX_SESSIONS) break;
            sessions.set(id, s);
        }
    } else {
        for (const [id, s] of loaded) sessions.set(id, s);
    }
}

export function getSession(id: string): Session {
    const existing = sessions.get(id);
    if (existing) {
        existing.lastSeen = Date.now();
        return existing;
    }
    // Memory miss: try reload from disk (e.g. after LRU eviction).
    const store = getStore();
    const reloaded = store.loadSync(id);
    if (reloaded) {
        reloaded.lastSeen = Date.now();
        reloaded.persisted = true;
        sessions.set(id, reloaded);
        return reloaded;
    }
    if (sessions.size >= MAX_SESSIONS) evictOldest();
    const session: Session = {
        id,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        requests: 0,
        condensedToolResults: 0,
        tokensSaved: 0,
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

export function listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
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

/** Flush a session to disk and drop it from memory (LRU eviction). Refuses to
 *  evict sessions that are in-flight or whose flush failed (would lose a
 *  never-persisted session permanently). */
function evictOldest(): void {
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
    if (!oldestId) return;
    const s = sessions.get(oldestId)!;
    const ok = getStore().flushSync(s);
    if (!ok && !s.persisted) {
        // Flush failed AND this session was never written to disk — evicting
        // would permanently lose it. Keep it in memory instead.
        return;
    }
    sessions.delete(oldestId);
}

/** Graceful shutdown: flush all sessions with pending writes. */
export async function flushAllSessions(): Promise<void> {
    await getStore().flushAll(sessions.values());
}
