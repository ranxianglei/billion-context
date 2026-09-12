import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { StateStore, flatFileNameFor, type PersistedEnvelope, type StateStoreCodec } from "acp-kernel/persist";
import { sessionsDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { createSessionCodec, ENCRYPT_MAGIC, parseEncryptionKey } from "./encrypt.js";
import { PersistEpermAlert } from "./persist-eperm.js";
import { createInitialState, defaultCountTokens, prune, type CompressionState, type CoreMessage } from "acp-kernel";
import type { Session, BlockContent, BlockView } from "./session.js";

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
 *  - Encryption at rest (#708): BILI_ENCRYPTION_KEY (hex/base64, exactly 32
 *    bytes) wraps every file as BILIENC1 AES-256-GCM(zstd(JSON)) via the
 *    kernel store's codec hook. Legacy plaintext files are re-encoded in
 *    place once at boot (migrateLegacyFiles); key material never touches
 *    disk or logs.
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
/** Dotfile (invisible to the kernel's .json walk): written after the first
 *  successful #286 migration pass so later boots skip the scan entirely. */
const MIGRATION_MARKER = ".bili-migration-286.done";

const STALE_WARN_THROTTLE_MS = 60_000;

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
    /** Latest folded-view conversation snapshot (v3+): prune() rendered
     *  summaries in place of folded ranges, then truncated to the newest
     *  BILI_PERSIST_TAIL_TOKENS tokens (#401) — the raw full history is NOT
     *  persisted (it duplicated 63% of the corpus; originals of folded
     *  ranges remain available offline via blockContents). Absent on v2
     *  files and when the tail budget is 0 — export falls back to
     *  block-only rendering. */
    messages?: CoreMessage[];
    /** True when `messages` is an already-pruned folded snapshot (see above);
     *  absent on records written before #401, whose `messages` held the raw
     *  history and must still be pruned at export time. */
    messagesFolded?: boolean;
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
        // Without this, a restart re-exposes absorbed tool outputs: state
        // resurrects with absorbed=[] and hideAbsorbedMessages has nothing to hide.
        absorbed: parsed.absorbed ?? fresh.absorbed,
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
    private readonly dir: string;
    private readonly store: StateStore<PersistedSession>;
    private readonly log: Logger;
    private readonly staleWarnAt = new Map<string, number>();
    private readonly codec?: StateStoreCodec;

    constructor(opts?: { dir?: string; debounceMs?: number; enabled?: boolean; log?: Logger }) {
        const debounceMs = opts?.debounceMs ?? defaultDebounce();
        this.enabled = (opts?.enabled ?? true) && debounceMs >= 0;
        this.dir = opts?.dir ?? defaultDir();
        const baseLog = opts?.log ?? defaultLogger;
        this.log = baseLog;
        // #708: env-only key (a key file next to the data sits on the same
        // untrusted filesystem). Invalid values throw here — fail fast at
        // startup instead of running silently unencrypted.
        const keyEnv = process.env.BILI_ENCRYPTION_KEY;
        if (keyEnv) {
            this.codec = createSessionCodec(parseEncryptionKey(keyEnv));
            baseLog("info", "[persist] session-file encryption enabled (AES-256-GCM)");
        }
        const epermAlert = new PersistEpermAlert({
            dir: this.dir,
            threshold: epermAlertThreshold(),
            repeatMs: epermAlertRepeatMs(),
        });
        this.store = new StateStore<PersistedSession>({
            dir: this.dir,
            version: PERSIST_VERSION,
            debounceMs: Math.max(0, debounceMs),
            enabled: this.enabled,
            codec: this.codec,
            log: (level, msg) => {
                epermAlert.observe(level, msg);
                baseLog(level, msg);
            },
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
        let clamped = 0;
        for (const [id, envelope] of await this.store.loadAll()) {
            const session = buildSession(envelope.payload);
            if (hasNegativePersistedTokens(envelope.payload)) {
                // #408 one-time migration: the in-memory value is already
                // clamped by buildSession — rewrite the stale file so the
                // negative value is gone from disk.
                await this.store.writeNow(id, () => buildRecord(session));
                clamped++;
            }
            out.set(id, session);
        }
        if (clamped > 0) {
            loggerLog("info", `[persist] one-time migration (#408): clamped negative lastInputTokens/contextTokens in ${clamped} session(s) to 0`);
        }
        return out;
    }

    /** Single-pass boot (#401): ONE loadAll walk+parse, then the #286
     *  identity migration over the SAME parsed map (no extra directory
     *  walk), then hydration into Sessions. initSessions calls this instead
     *  of migrateLegacyIds()+loadAll(), which walked and parsed the whole
     *  tree twice per start. */
    async boot(): Promise<Map<string, Session>> {
        if (!this.enabled) return new Map();
        await this.migrateLegacyFiles();
        const loaded = await this.store.loadAll();
        await this.applyLegacyMigration(loaded);
        const out = new Map<string, Session>();
        for (const [id, envelope] of loaded) {
            out.set(id, buildSession(envelope.payload));
        }
        return out;
    }

    /** #708: when encryption is enabled, take over legacy plaintext files:
     * every .json under the sessions dir lacking the BILIENC1 magic is
     * re-encoded in place — temp write + rename onto the SAME path, so the
     * atomic replace IS the old-file deletion (no window where both, or
     *  neither, copy exists). A crash mid-run leaves each file either old or
     *  new; the next boot finishes the job and sweeps the crashed run's
     *  orphaned temps. Self-terminating: the 8-byte magic peek decides per
     *  file, so later boots cost O(files × 8 bytes). */
    private async migrateLegacyFiles(): Promise<void> {
        if (!this.codec) return;
        let files: string[];
        try {
            files = await walkJsonFiles(this.dir);
        } catch {
            return;
        }
        let migrated = 0;
        let failed = 0;
        for (const file of files) {
            if (STALE_ENC_TEMP_RE.test(path.basename(file))) {
                await rm(file, { force: true }).catch(() => {});
                continue;
            }
            let head: Buffer;
            try {
                head = await readFileHead(file);
            } catch {
                continue;
            }
            if (head.equals(ENCRYPT_MAGIC)) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(await readFile(file, "utf8"));
            } catch {
                failed++;
                this.log("warn", `[persist] encryption migration (#708): leaving unreadable file in place: ${file}`);
                continue;
            }
            const tmp = `${file}.tmp-enc-${process.pid}-${Date.now()}`;
            try {
                writeFileSync(tmp, this.codec.encode(JSON.stringify(parsed)));
                renameSync(tmp, file);
                migrated++;
            } catch {
                failed++;
                this.log("warn", `[persist] encryption migration (#708): failed to re-encode: ${file}`);
                await rm(tmp, { force: true }).catch(() => {});
            }
        }
        if (migrated > 0 || failed > 0) {
            this.log(
                failed > 0 ? "warn" : "info",
                `[persist] encryption migration (#708): re-encoded ${migrated} legacy session file(s)${failed > 0 ? `, ${failed} failed` : ""}`,
            );
        }
    }

    /** One-time migration for the #286 identity change: sessions persisted
     *  under the old derived hash id are re-keyed to the client-provided
     *  conversation value stored in meta.label (which is now the session id
     *  itself). Collisions on the same label keep the most recently saved
     *  record; the losers, and any label already claimed by a new-format
     *  session, are deleted. Records without a label cannot be mapped and are
     *  left in place (they load under their old id but are never requested
     *  again — the new proxy 400s anonymous requests). Self-terminating:
     *  after one pass no loaded id differs from its label. A completion
     *  marker makes it run ONCE EVER (#401): the old code re-scanned the tree
     *  on every boot because unlabeled files are intentionally kept, so the
     *  "one-time" log line repeated forever. */
    async migrateLegacyIds(): Promise<void> {
        if (!this.enabled) return;
        if (existsSync(this.markerPath())) return;
        const loaded = await this.store.loadAll();
        await this.applyLegacyMigration(loaded);
    }

    private markerPath(): string {
        return path.join(this.dir, MIGRATION_MARKER);
    }

    private async applyLegacyMigration(loaded: Map<string, PersistedEnvelope<PersistedSession>>): Promise<void> {
        // Marker gate lives HERE (not just in migrateLegacyIds) because boot()
        // invokes this directly — unlabeled files are intentionally kept
        // forever, so without the gate the "one-time" pass would re-run and
        // re-log on every single start (#401 root cause 3).
        if (existsSync(this.markerPath())) return;
        const claimed = new Set<string>();
        const byLabel = new Map<string, { id: string; savedAt: number; session: Session }>();
        let unlabeled = 0;
        for (const [id, envelope] of loaded) {
            // #499: anonymous prefix-affinity sessions (#309) carry the shared
            // display label "prefix-affinity" ≠ their pfa- id — they are
            // CURRENT-format, not legacy derived-hash sessions. Migrating them
            // would rekey every pfa session to the single id "prefix-affinity"
            // and DELETE all but the newest sibling on every boot (silent data
            // loss of saved compression state).
            if (id.startsWith("pfa-")) continue;
            const session = buildSession(envelope.payload);
            const label = session.meta.label;
            if (!label) {
                unlabeled++;
                continue;
            }
            if (label === id) {
                claimed.add(id);
                continue;
            }
            const prev = byLabel.get(label);
            if (!prev || envelope.savedAt >= prev.savedAt) {
                if (prev) {
                    await this.removeLegacyFile(prev.id, prev.session);
                    loaded.delete(prev.id);
                }
                byLabel.set(label, { id, savedAt: envelope.savedAt, session });
            } else {
                await this.removeLegacyFile(id, session);
                loaded.delete(id);
            }
        }
        let rekeyed = 0;
        for (const [label, { id, session }] of byLabel) {
            if (claimed.has(label)) {
                await this.removeLegacyFile(id, session);
                loaded.delete(id);
                continue;
            }
            session.id = label;
            await this.store.writeNow(label, () => buildRecord(session));
            await this.removeLegacyFile(id, session);
            const envelope = loaded.get(id);
            if (envelope) {
                loaded.set(label, { ...envelope, id: label, payload: { ...envelope.payload, id: label } });
            }
            loaded.delete(id);
            claimed.add(label);
            rekeyed++;
        }
        try {
            mkdirSync(this.dir, { recursive: true });
            writeFileSync(this.markerPath(), String(Date.now()), "utf8");
        } catch {
            // Read-only dir — migration re-runs next boot (it is idempotent).
        }
        if (rekeyed || unlabeled) {
            loggerLog("info", `[persist] one-time migration (#286): rekeyed ${rekeyed} legacy session(s), left ${unlabeled} unlabeled legacy file(s) in place`);
        }
    }

    /** Remove a legacy session file. The kernel store never deletes (cleanup
     *  is downstream policy), so the path is recomputed here: the namespaced
     *  layout for v2+/v3 files, the _unknown/ fallback, and the flat default
     *  name for pre-envelope v1 files. */
    private async removeLegacyFile(id: string, session: Session): Promise<void> {
        const candidates = new Set([
            relPathFor(id, session.meta.protocol, session.meta.upstreamOrigin),
            relPathFor(id),
            flatFileNameFor(id),
        ]);
        for (const rel of candidates) {
            await rm(path.join(this.dir, rel), { force: true }).catch(() => {});
        }
    }

    /** Shared envelope probe for the sync read paths: namespaced path
     *  first, then the _unknown/ location, letting the kernel store layer
     *  also check its discovered map and the flat legacy name. */
    private loadEnvelope(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): PersistedEnvelope<PersistedSession> | null {
        const envelopes = [
            this.store.loadSync(id, relPathFor(id, meta?.protocol, meta?.upstreamOrigin)),
            meta?.protocol ? this.store.loadSync(id, relPathFor(id)) : null,
        ];
        for (const envelope of envelopes) {
            if (envelope) return envelope;
        }
        return null;
    }

    /** Synchronous reload of a single session. Used on a memory miss (after
     *  LRU eviction). Sync fs is acceptable here because a miss is rare and
     *  reads a single small file (~1ms). Returns null if missing/corrupt or the
     *  body id does not match what we asked for. */
    loadSync(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Session | null {
        if (!this.enabled) return null;
        const envelope = this.loadEnvelope(id, meta);
        if (!envelope) return null;
        const session = buildSession(envelope.payload);
        if (hasNegativePersistedTokens(envelope.payload)) {
            // #408: sync context — debounce the stale-file rewrite
            // (buildSession already clamped the in-memory value).
            this.scheduleSave(session);
            loggerLog("info", `[persist] clamped negative token stats on reload for ${id} (#408)`);
        }
        return session;
    }

    /** #405 fix #4: dual-instance rollback guard. When two proxy processes
     *  share BILI_SESSIONS_DIR, whoever saves last used to win — an instance
     *  holding a STALE in-memory copy would roll counters back (requests:3 →
     *  2). Both signals below are monotonic per session id, so either being
     *  strictly smaller proves staleness. Returns the fresher-on-disk payload
     *  when the incoming record is stale, else null. */
    private staleDiskPayload(incoming: PersistedSession): PersistedSession | null {
        const envelope = this.loadEnvelope(incoming.id, incoming.meta);
        if (!envelope) return null;
        const disk = envelope.payload;
        const diskRequests = disk.stats?.requests ?? disk.requests ?? 0;
        const incRequests = incoming.stats?.requests ?? incoming.requests ?? 0;
        if (incRequests < diskRequests) return disk;
        if (incRequests === diskRequests) {
            const diskBlocks = disk.state?.nextBlockId ?? 0;
            const incBlocks = incoming.state?.nextBlockId ?? 0;
            if (incBlocks < diskBlocks) return disk;
        }
        return null;
    }

    private guardedBuild(session: Session): () => PersistedSession {
        return () => {
            const record = buildRecord(session);
            const disk = this.staleDiskPayload(record);
            if (disk === null) return record;
            const now = Date.now();
            const last = this.staleWarnAt.get(record.id) ?? 0;
            if (now - last >= STALE_WARN_THROTTLE_MS) {
                this.staleWarnAt.set(record.id, now);
                this.log(
                    "warn",
                    `[persist] rejected stale snapshot for session ${record.id}: in-memory copy is older than the on-disk one (another bili instance holds newer state) — keeping disk state, no rollback (#405)`,
                );
            }
            // Rewrite the disk's own payload: content-identical no-op that
            // preserves the newer state while satisfying the write chain.
            return disk;
        };
    }

    /** Schedule a debounced write for a session. Multiple calls within the
     *  window coalesce; the record is built at WRITE time, so the freshest
     *  session state is persisted. Safe to call on the hot path. No-op if
     *  disabled. */
    scheduleSave(session: Session): void {
        this.store.scheduleSave(session.id, this.guardedBuild(session));
    }

    /** Asynchronously persist a session right now (skips the debounce). Throws
     *  on write failure so callers can react (e.g. avoid evicting). Serialized
     *  per-session by the kernel store's write chains. */
    async writeNow(session: Session): Promise<void> {
        await this.store.writeNow(session.id, this.guardedBuild(session));
    }

    /** Synchronous flush for a single session. Used on memory eviction so a
     *  dirty evicted session is not lost. Sync because eviction runs in the
     *  sync getSession path; a single small write is acceptable.
     *  Returns true on success, false on failure (caller must NOT evict on
     *  failure for a never-persisted session or it is lost permanently). */
    flushSync(session: Session): boolean {
        return this.store.flushSync(session.id, this.guardedBuild(session));
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
    const snapshot = boundedFoldedSnapshot(session);
    return {
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        id: session.id,
        meta: { ...session.meta },
        stats: { ...session.stats },
        messages: snapshot,
        messagesFolded: snapshot ? true : undefined,
        metadata: { ...session.metadata },
        state: session.state,
        blockContents: Object.fromEntries(session.blockContents),
        createdAt: session.createdAt,
    };
}

function isBlockView(v: unknown): v is BlockView {
    return !!v && typeof v === "object" && typeof (v as BlockView).text === "string" && typeof (v as BlockView).count === "number";
}

function buildSession(parsed: PersistedSession): Session {
    const blockContents = new Map<string, BlockContent>();
    for (const [bid, content] of Object.entries(parsed.blockContents ?? {})) {
        if (!content || typeof content !== "object") continue;
        const full = (content as Record<string, unknown>).full;
        if (!isBlockView(full)) continue;
        // Legacy files stored byte-identical one/full pairs (#401); normalize
        // to the single-copy form on load so the next write persists it once.
        const one = (content as Record<string, unknown>).one;
        const oneView = isBlockView(one) ? one : null;
        blockContents.set(bid, {
            one: oneView && !(oneView.text === full.text && oneView.count === full.count) ? oneView : null,
            full,
        });
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
            // #408: clamp at restore — pre-clamp versions persisted negative
            // values (lastInputTokens = total − credit before the Math.max
            // guard existed) which would otherwise revive after upgrade and
            // feed the /acp panel + web stats as negative percentages.
            lastInputTokens: Math.max(0, stats.lastInputTokens ?? parsed.lastInputTokens ?? 0),
            // In-memory only — a fresh process has no pending compress fold.
            compressCreditTokens: 0,
            contextTokens: Math.max(0, stats.contextTokens ?? parsed.contextTokens ?? 0),
        },
        metadata: parsed.metadata ?? {},
        state: mergeState(parsed.state),
        createdAt: parsed.createdAt ?? Date.now(),
        // #404: lastSeen reflects the on-disk savedAt (the last real
        // activity), NOT the restore moment — a restart must not fabricate
        // activity for every session (broke fallback=latest ties, panel
        // freshness, and eviction ordering). Consumers that need "has this
        // session been used since boot" read the restored flag.
        lastSeen: parsed.savedAt ?? Date.now(),
        restored: true,
        blockContents,
        lastMessages: Array.isArray(parsed.messages) ? parsed.messages : undefined,
        lastMessagesFolded: parsed.messagesFolded === true,
        inFlight: 0,
        persisted: true,
    };
}

function isValidRecord(parsed: unknown): parsed is PersistedSession {
    if (!parsed || typeof parsed !== "object") return false;
    const r = parsed as Partial<PersistedSession>;
    return typeof r.id === "string" && typeof r.state === "object" && r.state !== null && Array.isArray(r.state.blocks);
}

/** #408: true when a persisted record (grouped v2+ or flat v1) carries a
 *  negative lastInputTokens/contextTokens — only possible in files written by
 *  pre-clamp versions. buildSession clamps on read; this lets the loaders
 *  rewrite the stale file once so the negative value is gone from disk. */
function hasNegativePersistedTokens(parsed: PersistedSession): boolean {
    const stats = parsed.stats ?? {};
    const last = stats.lastInputTokens ?? parsed.lastInputTokens;
    const ctx = stats.contextTokens ?? parsed.contextTokens;
    return (typeof last === "number" && last < 0) || (typeof ctx === "number" && ctx < 0);
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

/** Temp name used by migrateLegacyFiles: `<file>.tmp-enc-<pid>-<ts>`. A
 *  process death between write and rename orphans it; any such name present
 *  at boot is stale by definition (the walk runs before this boot writes
 *  anything) and gets swept. */
const STALE_ENC_TEMP_RE = /\.tmp-enc-\d+-\d+$/;

async function walkJsonFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await walkJsonFiles(full)));
        } else if (e.isFile() && (STALE_ENC_TEMP_RE.test(e.name) || (e.name.endsWith(".json") && !e.name.startsWith(".tmp-")))) {
            out.push(full);
        }
    }
    return out;
}

async function readFileHead(file: string, len: number = ENCRYPT_MAGIC.length): Promise<Buffer> {
    const fh = await open(file, "r");
    try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

/** Token budget for the persisted folded-view snapshot (#401). The raw full
 *  history is never persisted — prune() first replaces folded ranges with
 *  their summaries (exactly what `bili export` renders by default), then the
 *  OLDEST messages are dropped until the view fits. 0 disables message
 *  persistence entirely (block summaries + blockContents survive). */
function persistTailTokens(): number {
    const env = process.env.BILI_PERSIST_TAIL_TOKENS;
    if (env) {
        const n = Number.parseInt(env, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return 16384;
}

/** Bounded folded-view snapshot for the on-disk record (#401). See
 *  PersistedSession.messages. Truncation keeps whole messages from the NEWEST
 *  end; at least one message always survives (even if it alone exceeds the
 *  budget — a handoff doc with an empty tail is useless). */
function boundedFoldedSnapshot(session: Session): CoreMessage[] | undefined {
    const msgs = session.lastMessages;
    if (!msgs || msgs.length === 0) return undefined;
    const budget = persistTailTokens();
    if (budget === 0) return undefined;
    let view = prune(msgs, session.state);
    let total = 0;
    for (const m of view) total += defaultCountTokens(m.text ?? "");
    if (total > budget) {
        let acc = 0;
        let start = 0;
        for (let i = view.length - 1; i >= 0; i--) {
            acc += defaultCountTokens(view[i]!.text ?? "");
            if (acc > budget) {
                start = Math.min(i + 1, view.length - 1);
                break;
            }
        }
        if (start > 0) view = view.slice(start);
    }
    return view;
}

function epermAlertThreshold(): number {
    const env = process.env.BILI_PERSIST_EPERM_ALERT_THRESHOLD;
    if (env) {
        const n = Number.parseInt(env, 10);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 5;
}

function epermAlertRepeatMs(): number {
    const env = process.env.BILI_PERSIST_EPERM_ALERT_REPEAT_MS;
    if (env) {
        const n = Number.parseInt(env, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
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
