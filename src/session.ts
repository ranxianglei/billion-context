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
     *  collectBlockContent full flag semantics. */
    blockContents: Map<string, BlockContent>;
};

const sessions = new Map<string, Session>();

const MAX_SESSIONS = Number.parseInt(process.env.BILI_MAX_SESSIONS ?? "256", 10) || 256;
/** Approximate per-session byte cap for blockContents originals. When exceeded
 *  the oldest block's contents are dropped (the block summary stays; decompress
 *  degrades to returning the summary instead of originals). Bounds memory for
 *  pathological sessions; disk persistence holds everything regardless. A large
 *  default (512MB) so normal long sessions never hit it — disk is cheap, and
 *  losing block originals silently degrades decompress quality. */
const BLOCK_CONTENTS_BYTES_CAP = Number.parseInt(process.env.BILI_BLOCK_CACHE_BYTES ?? String(512 * 1024 * 1024), 10) || 512 * 1024 * 1024;

let initialized = false;

/** Bulk-load all persisted sessions from disk into the in-memory map. Called
 *  once at server startup before listening. Idempotent. */
export async function initSessions(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const store = getStore();
    if (!store.enabled) return;
    const loaded = await store.loadAll();
    for (const [id, s] of loaded) {
        if (!sessions.has(id)) sessions.set(id, s);
    }
}

export function getSession(id: string): Session {
    const existing = sessions.get(id);
    if (existing) {
        existing.lastSeen = Date.now();
        return existing;
    }
    // Memory miss: try reload from disk (e.g. after LRU eviction + restart).
    const store = getStore();
    const reloaded = store.loadSync(id);
    if (reloaded) {
        reloaded.lastSeen = Date.now();
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
    };
    sessions.set(id, session);
    return session;
}

export function listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Mark a session's state as changed so it is persisted on the next debounce.
 *  Call this after any mutation (processTurn, compress, decompress, orphan GC). */
export function markDirty(session: Session): void {
    getStore().scheduleSave(session);
}

/** Record original block content at compress time and enforce the per-session
 *  memory cap. When the cap is exceeded, the oldest block's contents are
 *  dropped (block summary stays active; decompress degrades to summary). */
export function cacheBlockContent(session: Session, blockId: string, content: BlockContent): void {
    session.blockContents.set(blockId, content);
    enforceBlockCacheCap(session);
}

/** Flush a session to disk and drop it from memory (LRU eviction). */
function evictOldest(): void {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, s] of sessions) {
        if (s.lastSeen < oldestSeen) {
            oldestSeen = s.lastSeen;
            oldestId = id;
        }
    }
    if (oldestId) {
        const s = sessions.get(oldestId);
        if (s) getStore().flushSync(s);
        sessions.delete(oldestId);
    }
}

/** Drop oldest blockContents entries until under the byte cap. */
function enforceBlockCacheCap(session: Session): void {
    if (session.blockContents.size === 0) return;
    let bytes = 0;
    for (const c of session.blockContents.values()) {
        bytes += c.one.text.length + c.full.text.length;
    }
    if (bytes <= BLOCK_CONTENTS_BYTES_CAP) return;
    // Evict oldest by createdAt of the block (fall back to insertion order).
    const ordered = [...session.blockContents.entries()].sort(([, a], [, b]) => {
        const ta = a.one.count + a.full.count;
        const tb = b.one.count + b.full.count;
        return ta - tb;
    });
    for (const [bid] of ordered) {
        if (bytes <= BLOCK_CONTENTS_BYTES_CAP) break;
        const c = session.blockContents.get(bid);
        if (c) bytes -= c.one.text.length + c.full.text.length;
        session.blockContents.delete(bid);
    }
}

/** Graceful shutdown: flush all sessions with pending writes. */
export async function flushAllSessions(): Promise<void> {
    await getStore().flushAll(sessions.values());
}
