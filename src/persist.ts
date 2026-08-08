import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInitialState, type CompressionState } from "acp-kernel";
import type { Session, BlockContent } from "./session.js";

/**
 * On-disk persistence for proxy sessions.
 *
 * WHY: proxy sessions previously lived only in process memory. A restart
 * dropped all compression state. For sessions whose raw history has grown
 * past the model's context limit, the client re-sends full history on the
 * next request — without the saved block summaries there is nothing to fold
 * it under, so the model rejects the oversized request and the session hangs
 * permanently. Persisting the CompressionState (and the blockContents
 * originals cache) lets the proxy rebuild the folded view after a restart so
 * the model only ever sees the small compressed context.
 *
 * DESIGN:
 *  - Memory is a bounded cache (MAX_SESSIONS in session.ts). The disk is the
 *    source of truth. Evicting a session from memory flushes it to disk first;
 *    a later miss reloads it. So memory is bounded while ALL sessions persist.
 *  - One JSON file per session, atomic write (temp + rename) — survives a
 *    crash mid-write (the rename is atomic on posix; a partial temp is
 *    discarded on next load by the corrupt-file fallback).
 *  - Debounced async writes (default 500ms): the hot path never blocks on fs.
 *    Multiple mutations within the window coalesce into one write.
 *  - Forward-compat: `mergeInitialState` fills any fields missing on a file
 *    written by an older version, so a schema change never breaks old files.
 *  - Disable with BILI_PERSIST=0 for ephemeral/test runs.
 */

const PERSIST_VERSION = 1;

interface PersistedSession {
    version: number;
    savedAt: number;
    id: string;
    createdAt: number;
    requests: number;
    condensedToolResults: number;
    tokensSaved: number;
    state: CompressionState;
    /** blockContents serialized as a plain record (Maps do not survive JSON). */
    blockContents: Record<string, BlockContent>;
}

/** Forward-compat: merge a parsed state with a fresh one so missing fields
 *  (added in later versions) get sane defaults instead of `undefined`. */
function mergeState(parsed: CompressionState): CompressionState {
    const fresh = createInitialState();
    return {
        blocks: parsed.blocks ?? fresh.blocks,
        messageRefs: parsed.messageRefs ?? fresh.messageRefs,
        nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
        stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
        nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
        nextRunId: parsed.nextRunId ?? fresh.nextRunId,
    };
}

/** Build a filesystem-safe filename from a session id. Session ids are hashes
 *  (deriveSessionId*) or arbitrary x-acp-session header values — sanitize to
 *  avoid path traversal, keep it readable. The real id is also stored inside
 *  the file so integrity can be verified on load. */
function safeFileName(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "session";
}

export class SessionStore {
    private readonly dir: string;
    private readonly debounceMs: number;
    readonly enabled: boolean;
    private readonly timers = new Map<string, NodeJS.Timeout>();

    constructor(opts?: { dir?: string; debounceMs?: number; enabled?: boolean }) {
        this.dir = opts?.dir ?? defaultDir();
        this.debounceMs = opts?.debounceMs ?? defaultDebounce();
        this.enabled = (opts?.enabled ?? true) && this.debounceMs >= 0;
    }

    private filePath(id: string): string {
        return path.join(this.dir, `${safeFileName(id)}.json`);
    }

    /** Bulk-load every persisted session from disk into a map keyed by session
     *  id. Called once at startup before the server accepts traffic. Corrupt
     *  individual files are skipped (logged) — one bad file never blocks boot. */
    async loadAll(): Promise<Map<string, Session>> {
        const out = new Map<string, Session>();
        if (!this.enabled) return out;
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch {
            return out;
        }
        let names: string[];
        try {
            names = await fs.readdir(this.dir);
        } catch {
            return out;
        }
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            try {
                const raw = await fs.readFile(path.join(this.dir, name), "utf8");
                const parsed = JSON.parse(raw) as PersistedSession;
                if (!parsed || typeof parsed.id !== "string" || !parsed.state || !Array.isArray(parsed.state.blocks)) {
                    continue;
                }
                const blockContents = new Map<string, BlockContent>();
                for (const [bid, content] of Object.entries(parsed.blockContents ?? {})) {
                    if (content && typeof content === "object") blockContents.set(bid, content);
                }
                out.set(parsed.id, {
                    id: parsed.id,
                    state: mergeState(parsed.state),
                    createdAt: parsed.createdAt ?? Date.now(),
                    lastSeen: Date.now(),
                    requests: parsed.requests ?? 0,
                    condensedToolResults: parsed.condensedToolResults ?? 0,
                    tokensSaved: parsed.tokensSaved ?? 0,
                    blockContents,
                });
            } catch {
                // corrupt file — skip, do not poison startup
            }
        }
        return out;
    }

    /** Synchronous reload of a single session. Used on a memory miss (after
     *  LRU eviction). Sync fs is acceptable here because a miss is rare and
     *  reads a single small file (~1ms). Returns null if missing/corrupt. */
    loadSync(id: string): Session | null {
        if (!this.enabled) return null;
        const file = this.filePath(id);
        if (!existsSync(file)) return null;
        try {
            const raw = readFileSync(file, "utf8");
            const parsed = JSON.parse(raw) as PersistedSession;
            if (!parsed || typeof parsed.id !== "string" || !parsed.state) return null;
            const blockContents = new Map<string, BlockContent>();
            for (const [bid, content] of Object.entries(parsed.blockContents ?? {})) {
                if (content && typeof content === "object") blockContents.set(bid, content);
            }
            return {
                id: parsed.id,
                state: mergeState(parsed.state),
                createdAt: parsed.createdAt ?? Date.now(),
                lastSeen: Date.now(),
                requests: parsed.requests ?? 0,
                condensedToolResults: parsed.condensedToolResults ?? 0,
                tokensSaved: parsed.tokensSaved ?? 0,
                blockContents,
            };
        } catch {
            return null;
        }
    }

    /** Schedule a debounced write for a session. Multiple calls within the
     *  window coalesce. Safe to call on the hot path. No-op if disabled. */
    scheduleSave(session: Session): void {
        if (!this.enabled) return;
        const existing = this.timers.get(session.id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.timers.delete(session.id);
            void this.writeNow(session).catch(() => {});
        }, this.debounceMs);
        // Don't keep the event loop alive solely for a pending write.
        timer.unref?.();
        this.timers.set(session.id, timer);
    }

    /** Asynchronously persist a session right now (skips the debounce). */
    async writeNow(session: Session): Promise<void> {
        if (!this.enabled) return;
        const record: PersistedSession = {
            version: PERSIST_VERSION,
            savedAt: Date.now(),
            id: session.id,
            createdAt: session.createdAt,
            requests: session.requests,
            condensedToolResults: session.condensedToolResults,
            tokensSaved: session.tokensSaved,
            state: session.state,
            blockContents: Object.fromEntries(session.blockContents),
        };
        const file = this.filePath(session.id);
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch {
            /* best-effort */
        }
        const tmp = path.join(this.dir, `.tmp-${safeFileName(session.id)}-${process.pid}`);
        const data = JSON.stringify(record);
        await fs.writeFile(tmp, data, "utf8");
        await fs.rename(tmp, file);
    }

    /** Synchronous flush for a single session. Used on memory eviction so a
     *  dirty evicted session is not lost. Sync because eviction runs in the
     *  sync getSession path; a single small write is acceptable. */
    flushSync(session: Session): void {
        if (!this.enabled) return;
        const existing = this.timers.get(session.id);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(session.id);
        }
        const record: PersistedSession = {
            version: PERSIST_VERSION,
            savedAt: Date.now(),
            id: session.id,
            createdAt: session.createdAt,
            requests: session.requests,
            condensedToolResults: session.condensedToolResults,
            tokensSaved: session.tokensSaved,
            state: session.state,
            blockContents: Object.fromEntries(session.blockContents),
        };
        const file = this.filePath(session.id);
        try {
            mkdirSync(this.dir, { recursive: true });
        } catch {
            /* best-effort */
        }
        const tmp = path.join(this.dir, `.tmp-${safeFileName(session.id)}-${process.pid}`);
        try {
            writeFileSync(tmp, JSON.stringify(record), "utf8");
            renameSync(tmp, file);
        } catch {
            /* best-effort: if write fails the previous on-disk version remains */
        }
    }

    /** Flush all sessions with a pending debounce timer. Called on SIGTERM/
     *  SIGINT for graceful shutdown. Fires timers immediately and awaits their
     *  writes. */
    async flushAll(sessions: Iterable<Session>): Promise<void> {
        if (!this.enabled) return;
        const pending: Promise<void>[] = [];
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const s of sessions) {
            pending.push(this.writeNow(s).catch(() => {}));
        }
        await Promise.all(pending);
    }

    /** Cancel all pending writes without flushing (e.g. for tests). */
    cancelAll(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}

function defaultDir(): string {
    const env = process.env.BILI_SESSIONS_DIR;
    if (env) return env;
    return path.join(os.homedir(), ".bili", "sessions");
}

function defaultDebounce(): number {
    const env = process.env.BILI_PERSIST_DEBOUNCE_MS;
    if (env) {
        const n = Number.parseInt(env, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return 500;
}

function persistEnabled(): boolean {
    const env = process.env.BILI_PERSIST;
    if (env === "0" || env === "false") return false;
    return true;
}

/** Singleton store for the running proxy. */
let _store: SessionStore | null = null;

export function getStore(): SessionStore {
    if (!_store) {
        _store = new SessionStore({ enabled: persistEnabled() });
    }
    return _store;
}

/** Test hook: inject a store with a temp dir. */
export function _setStoreForTest(store: SessionStore): void {
    _store = store;
}

/** Avoid unused-import lint for future directory iteration. */
