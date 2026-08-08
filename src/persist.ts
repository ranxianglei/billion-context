import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
 *    *process* crash mid-write (rename is atomic on posix; a partial temp is
 *    left behind and discarded on next load by the corrupt-file fallback).
 *    Does NOT survive power loss (no fsync of the directory entry); the
 *    debounced writes keep the on-disk state within ~debounce of in-memory.
 *  - Debounced async writes (default 500ms): the hot path never blocks on fs.
 *    Multiple mutations within the window coalesce into one write.
 *  - Forward-compat: `mergeInitialState` fills any fields missing on a file
 *    written by an older version, so a schema change never breaks old files.
 *  - Disable with BILI_PERSIST=0 for ephemeral/test runs.
 *
 * KNOWN LIMITATIONS:
 *  - No fsync of temp file or directory entry — a power loss can lose the
 *    most recent debounce window. Process crashes (SIGKILL) are safe up to
 *    the last successful write.
 *  - No cross-process lock — two proxy processes sharing BILI_SESSIONS_DIR
 *    will clobber each other's writes. Single-instance only.
 *  - All writes within a process are serialized per-session by Node's single
 *    event loop; there is no per-session *request* serialization (two
 *    concurrent HTTP requests for the same session can interleave processTurn
 *    and corrupt in-memory state). See AGENTS.md.
 */

const PERSIST_VERSION = 1;

interface PersistedSession {
    version: number;
    savedAt: number;
    id: string;
    /** Protocol + upstream origin, captured so the on-disk filename can be
     *  namespaced by protocol/provider. Absent in files written before this
     *  field existed; treated as unknown on load (file lives under _unknown/). */
    protocol?: "anthropic" | "openai" | "responses";
    upstreamOrigin?: string;
    createdAt: number;
    requests: number;
    condensedToolResults: number;
    tokensSaved: number;
    state: CompressionState;
    /** blockContents serialized as a plain record (Maps do not survive JSON). */
    blockContents: Record<string, BlockContent>;
}

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

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

/** Extract a short host label from an upstream origin URL, safe for a
 *  filename. Uses the full hostname (sanitized) rather than guessing the
 *  registrable domain — a public-suffix-list lookup is overkill, and the full
 *  host is unambiguous and grep-able. e.g.
 *    "https://coding.dashscope.aliyuncs.com" -> "coding.dashscope.aliyuncs.com"
 *  Falls back to a hash of the origin if parsing fails, so two distinct
 *  origins never collide. */
function hostLabel(upstreamOrigin?: string): string {
    if (!upstreamOrigin) return "unknown";
    try {
        const host = new URL(upstreamOrigin).hostname || "unknown";
        return host.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 48) || "unknown";
    } catch {
        return "unknown-" + createHash("sha256").update(upstreamOrigin, "utf8").digest("hex").slice(0, 6);
    }
}

/** Relative path (under the sessions dir) for a session, namespaced by
 *  protocol and upstream host so a human can tell sessions apart at a glance:
 *    anthropic/bailian_<hash>.json
 *    openai/zhipu_<hash>.json
 *    responses/comfly_<hash>.json
 *  When protocol meta is absent (e.g. a session loaded from an old file
 *  written before meta was captured), fall back to _unknown/ so it still
 *  loads — it will be rewritten with the right namespace on next persist.
 *  Deterministic from (id, protocol, upstreamOrigin), so loadAll can verify
 *  the filename matches the body and loadSync can reverse-lookup. */
function relPathFor(id: string, protocol?: string, upstreamOrigin?: string): string {
    const proto = protocol ?? "_unknown";
    const host = protocol ? hostLabel(upstreamOrigin) + "_" : "";
    return path.join(proto, `${host}${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24)}.json`);
}

/** Legacy flat filename (pre-namespace). Kept only for loadAll to recognize
 *  and migrate old files. */
function legacyFileNameFor(id: string): string {
    return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json";
}

export class SessionStore {
    private readonly dir: string;
    private readonly debounceMs: number;
    readonly enabled: boolean;
    private readonly timers = new Map<string, NodeJS.Timeout>();
    /** Monotonic counter for unique temp filenames within a process. */
    private tmpSeq = 0;
    private readonly log: Logger;

    constructor(opts?: { dir?: string; debounceMs?: number; enabled?: boolean; log?: Logger }) {
        this.dir = opts?.dir ?? defaultDir();
        this.debounceMs = opts?.debounceMs ?? defaultDebounce();
        this.enabled = (opts?.enabled ?? true) && this.debounceMs >= 0;
        this.log = opts?.log ?? defaultLogger;
    }

    private filePath(id: string, protocol?: string, upstreamOrigin?: string): string {
        return path.join(this.dir, relPathFor(id, protocol, upstreamOrigin));
    }

    /** A unique temp path per write (per process). Two overlapping writes for
     *  the same session must not share a temp file, or one rename invalidates
     *  the other. */
    private tempPath(id: string): string {
        return path.join(this.dir, `.tmp-${legacyFileNameFor(id)}-${process.pid}-${this.tmpSeq++}`);
    }

    /** Bulk-load every persisted session from disk into a map keyed by the
     *  REAL session id (read from the file body, not the filename). Called once
     *  at startup before the server accepts traffic. Corrupt individual files
     *  are skipped (logged) — one bad file never blocks boot. */
    async loadAll(): Promise<Map<string, Session>> {
        const out = new Map<string, Session>();
        if (!this.enabled) return out;
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch {
            return out;
        }
        // Recursively walk the sessions dir to pick up the namespaced layout
        // (sessions/<protocol>/<host>_<hash>.json) as well as legacy flat files
        // (sessions/<hash>.json) written by older versions.
        const files: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            let entries: import("node:fs").Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (e.name.startsWith(".tmp-")) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(full);
                } else if (e.isFile() && e.name.endsWith(".json")) {
                    files.push(full);
                }
            }
        };
        await walk(this.dir);
        for (const full of files) {
            const name = path.basename(full);
            try {
                const parsed = JSON.parse(await fs.readFile(full, "utf8")) as PersistedSession;
                if (!isValidRecord(parsed)) continue;
                // Accept the file if EITHER the namespaced name or the legacy
                // flat name matches the body id. The namespaced form is the
                // current convention; the legacy form is tolerated so old
                // files still load (and will be re-persisted under the new
                // namespace on next dirty write).
                const proto = parsed.protocol;
                const origin = parsed.upstreamOrigin;
                const expectedNamespaced = path.basename(relPathFor(parsed.id, proto, origin));
                const expectedLegacy = legacyFileNameFor(parsed.id);
                if (name !== expectedNamespaced && name !== expectedLegacy) {
                    this.log("warn", `[persist] skipping ${full}: filename does not match body id (expected ${expectedNamespaced})`);
                    continue;
                }
                out.set(parsed.id, buildSession(parsed));
            } catch (e) {
                this.log("warn", `[persist] skipping corrupt session file ${full}: ${msg(e)}`);
            }
        }
        return out;
    }

    /** Synchronous reload of a single session. Used on a memory miss (after
     *  LRU eviction). Sync fs is acceptable here because a miss is rare and
     *  reads a single small file (~1ms). Returns null if missing/corrupt or the
     *  body id does not match what we asked for. */
    loadSync(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Session | null {
        if (!this.enabled) return null;
        // Try the namespaced path first (current convention), then fall back to
        // the _unknown/ legacy location for sessions persisted before protocol
        // meta was captured.
        const candidates = [this.filePath(id, meta?.protocol, meta?.upstreamOrigin)];
        if (meta?.protocol) candidates.push(this.filePath(id)); // _unknown/ fallback
        for (const file of candidates) {
            if (!existsSync(file)) continue;
            try {
                const parsed = JSON.parse(readFileSync(file, "utf8")) as PersistedSession;
                if (!isValidRecord(parsed) || parsed.id !== id) continue;
                return buildSession(parsed);
            } catch (e) {
                this.log("warn", `[persist] failed to load session ${id}: ${msg(e)}`);
            }
        }
        return null;
    }

    /** Schedule a debounced write for a session. Multiple calls within the
     *  window coalesce. Safe to call on the hot path. No-op if disabled. */
    scheduleSave(session: Session): void {
        if (!this.enabled) return;
        const existing = this.timers.get(session.id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.timers.delete(session.id);
            void this.writeNow(session).catch((e) => {
                this.log("error", `[persist] debounced write failed for ${session.id}: ${msg(e)}`);
            });
        }, this.debounceMs);
        // Don't keep the event loop alive solely for a pending write.
        timer.unref?.();
        this.timers.set(session.id, timer);
    }

    /** Asynchronously persist a session right now (skips the debounce). Throws
     *  on write failure so callers can react (e.g. avoid evicting). */
    async writeNow(session: Session): Promise<void> {
        if (!this.enabled) return;
        const record = buildRecord(session);
        const file = this.filePath(session.id, session.protocol, session.upstreamOrigin);
        try {
            await fs.mkdir(path.dirname(file), { recursive: true });
        } catch (e) {
            this.log("warn", `[persist] could not create session dir ${this.dir}: ${msg(e)}`);
        }
        const tmp = this.tempPath(session.id);
        const data = JSON.stringify(record);
        await fs.writeFile(tmp, data, "utf8");
        await fs.rename(tmp, file);
    }

    /** Synchronous flush for a single session. Used on memory eviction so a
     *  dirty evicted session is not lost. Sync because eviction runs in the
     *  sync getSession path; a single small write is acceptable.
     *  Returns true on success, false on failure (caller must NOT evict on
     *  failure for a never-persisted session or it is lost permanently). */
    flushSync(session: Session): boolean {
        if (!this.enabled) return true;
        const existing = this.timers.get(session.id);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(session.id);
        }
        const record = buildRecord(session);
        const file = this.filePath(session.id, session.protocol, session.upstreamOrigin);
        try {
            mkdirSync(path.dirname(file), { recursive: true });
        } catch (e) {
            this.log("warn", `[persist] could not create session dir ${this.dir}: ${msg(e)}`);
        }
        const tmp = this.tempPath(session.id);
        try {
            writeFileSync(tmp, JSON.stringify(record), "utf8");
            renameSync(tmp, file);
            return true;
        } catch (e) {
            this.log("error", `[persist] flushSync FAILED for ${session.id}: ${msg(e)} — session NOT evicted to prevent loss`);
            // Best-effort: remove the orphan temp so it doesn't accumulate.
            try {
                require("node:fs").unlinkSync(tmp);
            } catch {
                /* ignore */
            }
            return false;
        }
    }

    /** Flush all dirty sessions with a pending debounce timer. Called on
     *  SIGTERM/SIGINT for graceful shutdown. Clears timers first, then writes
     *  every session that had a pending write. */
    async flushAll(sessions: Iterable<Session>): Promise<void> {
        if (!this.enabled) return;
        const dirty = new Set(this.timers.keys());
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        const pending: Promise<void>[] = [];
        for (const s of sessions) {
            if (!dirty.has(s.id)) continue; // only flush sessions with pending writes
            pending.push(
                this.writeNow(s).catch((e) => {
                    this.log("error", `[persist] shutdown flush failed for ${s.id}: ${msg(e)}`);
                }),
            );
        }
        await Promise.all(pending);
    }

    /** Whether a write is currently pending (debounce timer armed) for a id. */
    hasPending(id: string): boolean {
        return this.timers.has(id);
    }

    /** Cancel all pending writes without flushing (e.g. for tests). */
    cancelAll(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}

function buildRecord(session: Session): PersistedSession {
    return {
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        id: session.id,
        protocol: session.protocol,
        upstreamOrigin: session.upstreamOrigin,
        createdAt: session.createdAt,
        requests: session.requests,
        condensedToolResults: session.condensedToolResults,
        tokensSaved: session.tokensSaved,
        state: session.state,
        blockContents: Object.fromEntries(session.blockContents),
    };
}

function buildSession(parsed: PersistedSession): Session {
    const blockContents = new Map<string, BlockContent>();
    for (const [bid, content] of Object.entries(parsed.blockContents ?? {})) {
        if (content && typeof content === "object") blockContents.set(bid, content);
    }
    return {
        id: parsed.id,
        protocol: parsed.protocol,
        upstreamOrigin: parsed.upstreamOrigin,
        state: mergeState(parsed.state),
        createdAt: parsed.createdAt ?? Date.now(),
        lastSeen: Date.now(),
        requests: parsed.requests ?? 0,
        condensedToolResults: parsed.condensedToolResults ?? 0,
        tokensSaved: parsed.tokensSaved ?? 0,
        blockContents,
        inFlight: 0,
        persisted: true,
    };
}

function isValidRecord(parsed: unknown): parsed is PersistedSession {
    if (!parsed || typeof parsed !== "object") return false;
    const r = parsed as Partial<PersistedSession>;
    return typeof r.id === "string" && typeof r.state === "object" && r.state !== null && Array.isArray(r.state.blocks);
}

function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
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

function defaultLogger(level: string, m: string): void {
    // eslint-disable-next-line no-console
    console.error(`[${level}] ${m}`);
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
