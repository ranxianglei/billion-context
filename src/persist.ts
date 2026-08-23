import { createHash } from "node:crypto";
import * as path from "node:path";
import { StateStore, type PersistedEnvelope } from "acp-kernel/persist";
import { sessionsDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { createInitialState, type CompressionState, type CoreMessage } from "acp-kernel";
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
 *  - Forward-compat: `mergeState` fills any fields missing on a file written
 *    by an older version, so a schema change never breaks old files.
 *  - Disable with BILI_PERSIST=0 for ephemeral/test runs.
 *
 * MECHANISM lives in `acp-kernel/persist` (StateStore: atomic write, rename
 * retries, debounce, per-id serialization, corrupt-tolerant load, recursive
 * discovery). This module is POLICY: the record schema (PersistedSession),
 * the namespaced layout (relPathFor), validity (isValidRecord), and legacy
 * adoption for files written by the pre-envelope store.
 *
 * ON-DISK FORMAT (v3+): an envelope `{version, savedAt, id, payload}` where
 * payload is the flat PersistedSession record. Files written by earlier
 * proxy versions (flat record, no envelope) are adopted on load via the
 * kernel's `legacy` hook and re-persisted in envelope form on the next dirty
 * write — old files keep loading, files migrate organically.
 *
 * KNOWN LIMITATIONS:
 *  - No fsync of temp file or directory entry — a power loss can lose the
 *    most recent debounce window. Process crashes (SIGKILL) are safe up to
 *    the last successful write.
 *  - No cross-process lock — two proxy processes sharing BILI_SESSIONS_DIR
 *    will clobber each other's writes. Single-instance only.
 *  - All writes within a process are serialized per-session by the kernel
 *    store's write chains; there is no per-session *request* serialization
 *    (two concurrent HTTP requests for the same session can interleave
 *    processTurn and corrupt in-memory state). This is a known limitation; a
 *    per-session lock should be added before promoting multi-agent
 *    concurrency as safe.
 */

const PERSIST_VERSION = 3;

interface PersistedSession {
    version: number;
    savedAt: number;
    id: string;
    /** Identity / descriptive metadata (v2+). Absent on v1 files; read via the
     *  flat fallbacks below. */
    meta?: {
        protocol?: "anthropic" | "openai" | "responses";
        upstreamOrigin?: string;
        label?: string;
        title?: string;
    };
    /** Cumulative usage stats (v2+). Absent on v1 files; read via the flat
     *  fallbacks below. */
    stats?: {
        requests?: number;
        tokensSaved?: number;
        inputTokens?: number;
        cachedTokens?: number;
        outputTokens?: number;
        cacheSamples?: number;
        lastInputTokens?: number;
        contextTokens?: number;
    };
    /** Free-form escape hatch (v2+). */
    metadata?: Record<string, unknown>;
    createdAt: number;
    // Legacy flat fields (v1). Kept optional only so buildSession can read
    // older files; v2 records emit grouped meta/stats instead.
    protocol?: "anthropic" | "openai" | "responses";
    upstreamOrigin?: string;
    label?: string;
    requests?: number;
    tokensSaved?: number;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    cacheSamples?: number;
    lastInputTokens?: number;
    contextTokens?: number;
    state: CompressionState;
    /** blockContents serialized as a plain record (Maps do not survive JSON). */
    blockContents: Record<string, BlockContent>;
    /** Latest full-conversation snapshot (v3+): the client's raw messages
     *  from its most recent request, overwritten every turn. Absent on v2
     *  files — export falls back to block-only rendering. */
    messages?: CoreMessage[];
}

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

/** Forward-compat: merge a parsed state with a fresh one so missing fields
 * (added in later versions) get sane defaults instead of `undefined`. */
function mergeState(parsed: CompressionState): CompressionState {
    const fresh = createInitialState();
    return {
        blocks: parsed.blocks ?? fresh.blocks,
        messageRefs: parsed.messageRefs ?? fresh.messageRefs,
        nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
        stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
        nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
        nextRunId: parsed.nextRunId ?? fresh.nextRunId,
        tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
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

/** Session persistence policy over the kernel StateStore mechanism. The
 *  public API predates the extraction and is kept stable for session.ts /
 *  server.ts / export.ts. */
export class SessionStore {
    readonly enabled: boolean;
    private readonly store: StateStore<PersistedSession>;

    constructor(opts?: { dir?: string; debounceMs?: number; enabled?: boolean; log?: Logger }) {
        const debounceMs = opts?.debounceMs ?? defaultDebounce();
        this.enabled = (opts?.enabled ?? true) && debounceMs >= 0;
        this.store = new StateStore<PersistedSession>({
            dir: opts?.dir ?? defaultDir(),
            version: PERSIST_VERSION,
            debounceMs: Math.max(0, debounceMs),
            enabled: this.enabled,
            log: opts?.log ?? defaultLogger,
            relPath: (id, payload) =>
                relPathFor(id, payload.meta?.protocol ?? payload.protocol, payload.meta?.upstreamOrigin ?? payload.upstreamOrigin),
            // Adopt the pre-envelope flat format this store itself wrote
            // before the kernel extraction (and every v1/v2 file before it).
            legacy: (parsed) => (isValidRecord(parsed) ? { id: parsed.id, payload: parsed, version: parsed.version, savedAt: parsed.savedAt } : null),
            validate: (envelope) => isValidRecord(envelope.payload),
        });
    }

    /** Bulk-load every persisted session from disk into a map keyed by the
     *  REAL session id (read from the file body, not the filename). Called once
     *  at startup before the server accepts traffic. Corrupt individual files
     *  are skipped (logged) — one bad file never blocks boot. */
    async loadAll(): Promise<Map<string, Session>> {
        const out = new Map<string, Session>();
        if (!this.enabled) return out;
        for (const [id, envelope] of await this.store.loadAll()) {
            out.set(id, buildSession(envelope.payload));
        }
        return out;
    }

    /** Synchronous reload of a single session. Used on a memory miss (after
     *  LRU eviction). Sync fs is acceptable here because a miss is rare and
     *  reads a single small file (~1ms). Returns null if missing/corrupt or the
     *  body id does not match what we asked for. */
    loadSync(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Session | null {
        if (!this.enabled) return null;
        // Namespaced path first (current convention), then the _unknown/
        // location for sessions persisted before protocol meta was captured.
        // The kernel store also probes the flat legacy name on each call.
        const envelopes = [
            this.store.loadSync(id, relPathFor(id, meta?.protocol, meta?.upstreamOrigin)),
            meta?.protocol ? this.store.loadSync(id, relPathFor(id)) : null,
        ];
        for (const envelope of envelopes) {
            if (envelope) return buildSession(envelope.payload);
        }
        return null;
    }

    /** Schedule a debounced write for a session. Multiple calls within the
     *  window coalesce; the record is built at WRITE time, so the freshest
     *  session state is persisted. Safe to call on the hot path. No-op if
     *  disabled. */
    scheduleSave(session: Session): void {
        this.store.scheduleSave(session.id, () => buildRecord(session));
    }

    /** Asynchronously persist a session right now (skips the debounce). Throws
     *  on write failure so callers can react (e.g. avoid evicting). Serialized
     *  per-session by the kernel store's write chains. */
    async writeNow(session: Session): Promise<void> {
        await this.store.writeNow(session.id, () => buildRecord(session));
    }

    /** Synchronous flush for a single session. Used on memory eviction so a
     *  dirty evicted session is not lost. Sync because eviction runs in the
     *  sync getSession path; a single small write is acceptable.
     *  Returns true on success, false on failure (caller must NOT evict on
     *  failure for a never-persisted session or it is lost permanently). */
    flushSync(session: Session): boolean {
        return this.store.flushSync(session.id, () => buildRecord(session));
    }

    /** Flush all dirty sessions with a pending debounce timer. Called on
     *  SIGTERM/SIGINT for graceful shutdown. The kernel store flushes its own
     *  pending set (builders read the live Session objects at write time, so
     *  no session list is needed) and drains in-flight write chains. */
    async flushAll(_sessions: Iterable<Session>): Promise<void> {
        await this.store.flushAll();
    }

    /** Whether a write is currently pending (debounce timer armed) for a id. */
    hasPending(id: string): boolean {
        return this.store.hasPending(id);
    }

    /** Cancel all pending writes without flushing (e.g. for tests). */
    cancelAll(): void {
        this.store.cancelAll();
    }
}

function buildRecord(session: Session): PersistedSession {
    return {
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        id: session.id,
        meta: { ...session.meta },
        stats: { ...session.stats },
        messages: session.lastMessages,
        metadata: { ...session.metadata },
        state: session.state,
        blockContents: Object.fromEntries(session.blockContents),
        createdAt: session.createdAt,
    };
}

function buildSession(parsed: PersistedSession): Session {
    const blockContents = new Map<string, BlockContent>();
    for (const [bid, content] of Object.entries(parsed.blockContents ?? {})) {
        if (content && typeof content === "object") blockContents.set(bid, content);
    }
    // Read grouped shape (v2+); fall back to flat fields for v1 files.
    const meta = parsed.meta ?? {};
    const stats = parsed.stats ?? {};
    return {
        id: parsed.id,
        meta: {
            protocol: meta.protocol ?? parsed.protocol,
            upstreamOrigin: meta.upstreamOrigin ?? parsed.upstreamOrigin,
            label: meta.label ?? parsed.label,
            title: meta.title,
        },
        stats: {
            requests: stats.requests ?? parsed.requests ?? 0,
            tokensSaved: stats.tokensSaved ?? parsed.tokensSaved ?? 0,
            inputTokens: stats.inputTokens ?? parsed.inputTokens ?? 0,
            cachedTokens: stats.cachedTokens ?? parsed.cachedTokens ?? 0,
            outputTokens: stats.outputTokens ?? parsed.outputTokens ?? 0,
            cacheSamples: stats.cacheSamples ?? parsed.cacheSamples ?? 0,
            lastInputTokens: stats.lastInputTokens ?? parsed.lastInputTokens ?? 0,
            contextTokens: stats.contextTokens ?? parsed.contextTokens ?? 0,
        },
        metadata: parsed.metadata ?? {},
        state: mergeState(parsed.state),
        createdAt: parsed.createdAt ?? Date.now(),
        lastSeen: Date.now(),
        blockContents,
        lastMessages: Array.isArray(parsed.messages) ? parsed.messages : undefined,
        inFlight: 0,
        persisted: true,
    };
}

function isValidRecord(parsed: unknown): parsed is PersistedSession {
    if (!parsed || typeof parsed !== "object") return false;
    const r = parsed as Partial<PersistedSession>;
    return typeof r.id === "string" && typeof r.state === "object" && r.state !== null && Array.isArray(r.state.blocks);
}

function defaultDir(): string {
    return sessionsDir();
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
    // Route through the tee logger (file + stderr) when available; fall back
    // to console.error only if the logger hasn't been configured yet (e.g.
    // during early init or tests).
    loggerLog(level, m);
}

/** Singleton store for the running proxy. */
let _store: SessionStore | null = null;

export function getStore(): SessionStore {
    if (!_store) {
        _store = new SessionStore({ enabled: persistEnabled(), log: defaultLogger });
    }
    return _store;
}

/** Test hook: inject a store with a temp dir. */
export function _setStoreForTest(store: SessionStore): void {
    _store = store;
}
