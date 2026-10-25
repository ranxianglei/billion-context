import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
const { join } = path;
import { StateStore, flatFileNameFor, type PersistedEnvelope, type StateStoreCodec } from "acp-kernel/persist";
import type { BiliMessage } from "acp-kernel/wire";
import { sessionsDir } from "./paths.js";
import {
    persistEnabled as knobPersistEnabled,
    persistZstdEnabled as knobPersistZstdEnabled,
    persistDebounceMs as knobPersistDebounceMs,
    persistTailTokens as knobPersistTailTokens,
    persistEpermAlertThreshold as knobPersistEpermAlertThreshold,
    persistEpermAlertRepeatMs as knobPersistEpermAlertRepeatMs,
    resolveJsonWriterOff as knobResolveJsonWriterOff,
    resolveArchiveAfterDays,
    fileStorageUnified,
    fileStorageJsonWriter,
    fileStorageArchiveAfterDays,
    fileStorageWalJournalSizeLimit,
    fileStorageBackend,
    fileStorageMysqlDsn,
} from "./knobs.js";
import { log as loggerLog } from "./logger.js";
import { recordRequestedMode } from "./storage/runtime-status.js";
import { VERSION } from "./version.js";
import { createStorageCodec, parseEncryptionKey } from "./encrypt.js";
import { PersistEpermAlert } from "./persist-eperm.js";
import { createInitialState, defaultCountTokens, prune, type CompressionState, type CoreMessage, type MessageContentStore } from "acp-kernel";
import { markDirty } from "./session.js";
import { mergeState } from "./state-hydration.js";
import { restampRefsToLedger } from "acp-kernel";
import { LazyBlockContents, isDroppedMetadata, lazyMetadata } from "./session.js";
import type { Session, BlockContent, BlockView } from "./session.js";
import { orphanContents, resolveStorageMode, UnifiedShadow, type StorageMode } from "./storage/shadow.js";
import { resolveBackendName } from "./storage/backend.js";
import { toLegacyLike, type LegacySessionLike } from "./storage/ingest.js";
import { sha256Hex, type CheckpointRow } from "./storage/store.js";
import type { WireProtocol } from "./util.js";
import { currentContextObservation, CALIBRATION_CLAMP_MAX, CALIBRATION_CLAMP_MIN, CALIBRATION_SAMPLE_MAX, CALIBRATION_SAMPLE_MIN, CALIBRATION_SAMPLE_WINDOW } from "./cache-ledger.js";

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
 *  - Storage encoding at rest: via the kernel store's codec hook, every file
 *    is optionally zstd-compressed when BILI_PERSIST_ZSTD=1/true (default
 *    off — plain JSON; #1080, BILIZSTD1 envelope) and, independently,
 *    AES-256-GCM-encrypted when
 *    BILI_ENCRYPTION_KEY (hex/base64, exactly 32 bytes) is set (#708,
 *    BILIENC1 envelope) — the body-mode byte records compression even inside
 *    BILIENC1, so the two stay separately configurable. Legacy plaintext
 *    files are NEVER rewritten at boot (downgrade safety — see
 *    sweepStaleTemps); they convert organically on their next save. Key
 *    material never touches disk or logs.
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
 *    race on every write. The #405 monotonic-counter guard refuses to roll
 *    the disk record back, and since #2401 the stale resident additionally
 *    converges its in-memory state to the newer disk record at save time, so
 *    serving tracks the newest lineage within one debounce window instead of
 *    staying stale until restart. Residual: a lagging instance whose counters
 *    later CATCH UP numerically is judged fresh again and may re-clobber —
 *    true multi-writer coherence would need an election/lock, which this
 *    design deliberately does not attempt. Recommendation: one state dir =
 *    one live serving instance; restart the proxy on upgrade before resuming
 *    sessions.
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

/** #3406: mtime slack for the ownership stamp check — the same physical write
 *  can surface slightly different mtimeMs across statSync calls on some
 *  filesystems (FUSE, coarse-grained timestamps); the landed-write stamp is
 *  taken from the file we just wrote, so a sub-ms drift must not void our own
 *  ownership. Anything at or below this epsilon is OUR write; anything newer
 *  with a size change is foreign and forces the full read. */
const OWN_WRITE_STAMP_EPSILON_MS = 1;

interface PersistedSession {
    version: number;
    savedAt: number;
    id: string;
    /** Identity / descriptive metadata (v2+). Absent on v1 files; read via the
     *  flat fallbacks below. */
    meta?: {
        protocol?: WireProtocol;
        upstreamOrigin?: string;
        label?: string;
        title?: string;
        activePack?: string;
        hostTitle?: string;
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
        lastInputTokensSource?: string;
        lastInputTokensOrigin?: string;
        overflowArmTokens?: number;
        overflowArmCompletionReserve?: number;
        overflowArmMismatchWarned?: boolean;
        // #3450 follow-up: provider-lifetime completion proof + its scope.
        provenCompletionWall?: number;
        provenCompletionWallOrigin?: string;
        provenCompletionWallModel?: string;
        contextTokens?: number;
        contextTokensSource?: string;
        // #2129: measurement-state fields buildRecord persists via spread —
        // declared here so the on-disk schema documents what the loader must
        // restore (the five decision-grade ones below plus the in-memory-only
        // pendingFoldUsage / lastLocalTextEstimate(+Origin), which ride along
        // but are deliberately not restored — see buildSession).
        localInputEstimate?: number;
        lastUsageGradeTokens?: number;
        calibratedEstimate?: number;
        calibratedEstimateOrigin?: string;
        calibrationRing?: { origin: string; values: number[] };
        pendingFoldUsage?: boolean;
        lastLocalTextEstimate?: number;
        lastLocalTextEstimateOrigin?: string;
        retrieveCalls?: number;
        retrieveHits?: number;
        retrieveMisses?: number;
        retrieveDropped?: number;
        retrieveDelivered?: number;
        storedBytes?: number;
        storeBytesSaved?: number;
        rangeRestores?: number;
        wholeBlockRestores?: number;
        wholeBlockRestoresPreciseAvailable?: number;
    };
    /** Free-form escape hatch (v2+). */
    metadata?: Record<string, unknown>;
    createdAt: number;
    // Legacy flat fields (v1). Kept optional only so buildSession can read
    // older files; v2 records emit grouped meta/stats instead.
    protocol?: WireProtocol;
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
    pluginSnapshot?: CoreMessage[];
    /** #3301: external-converter import payload (see Session.decompositionLog) —
     *  accepted on read; buildRecord deliberately does not emit it. */
    decompositionLog?: CoreMessage[];
    forkContentStore?: MessageContentStore;
}

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

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
export function relPathFor(id: string, protocol?: string, upstreamOrigin?: string): string {
    const proto = protocol ?? "_unknown";
    const host = protocol ? hostLabel(upstreamOrigin) + "_" : "";
    return path.join(proto, `${host}${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24)}.json`);
}

/** Durable synchronous write: open → write → fsync → close. tmp+rename alone
 *  only makes the RENAME atomic — the bytes stay in the page cache until the OS
 *  flushes them, so a power loss / kernel panic between write and rename leaves
 *  a size-correct, VDL=0 all-zero file on disk (#3157). The fsync makes the DATA
 *  durable before the caller's rename publishes the name. Mirrors the repo's
 *  existing atomicWriteConfig / credential-store idiom and the kernel
 *  StateStore.atomicWriteDurable. `mode` applies on create (as writeFileSync's
 *  mode option does). */
function durableWriteFile(file: string, data: Buffer | string, mode?: number): void {
    const fd = openSync(file, "w", mode);
    try {
        writeFileSync(fd, data);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** #1097: the kernel CCR content-store envelope lives in ONE dedicated file
 *  per session, next to the session JSON (same namespace, same codec): the
 *  originals are payload bytes, not state — keeping them out of the session
 *  record preserves whole-file encryption, .json discovery, and the bounded
 *  in-memory session cache (the envelope is lazily loaded per session). */
export function contentStoreRelPathFor(id: string, protocol?: string, upstreamOrigin?: string): string {
    const base = relPathFor(id, protocol, upstreamOrigin);
    return base.slice(0, -".json".length) + ".content-store.json";
}

/** #1937: true when a walked FILENAME is the canonical (or legacy flat /
 *  .fb fallback) name for record `id` — mirrors the kernel StateStore.loadAll
 *  owner check so independent directory walkers agree with loadSync about
 *  which files are addressable. Renamed files fail this check and stay
 *  invisible, exactly as they do for boot/reload. */
export function fileNameMatchesId(base: string, id: string, protocol?: string, upstreamOrigin?: string): boolean {
    const relBase = path.basename(relPathFor(id, protocol, upstreamOrigin));
    const flatBase = flatFileNameFor(id);
    if (base === relBase || base === flatBase) return true;
    if (base.endsWith(".fb.json")) {
        const canonicalBase = `${base.slice(0, -".fb.json".length)}.json`;
        return canonicalBase === relBase || canonicalBase === flatBase;
    }
    return false;
}

/** Session persistence policy over the kernel StateStore mechanism. The
 *  public API predates the extraction and is kept stable for session.ts /
 *  server.ts / export.ts. */
export class SessionStore {
    readonly enabled: boolean;
    private readonly sessionsDir: string;
    private readonly store: StateStore<PersistedSession>;
    private readonly log: Logger;
    private readonly staleWarnAt = new Map<string, number>();

    /** #3049/#3406: ownership token for the stale-guard fast path. Set INSIDE
     *  the guardedBuild closure after the sidecar ingest of the record we are
     *  about to write (or the disk record we adopted): {counters of that
     *  commit, build time, and — once the write has LANDED — the envelope's
     *  post-write stat ("written")}. The next guard compares this token
     *  against the unified row + the envelope file's size/mtime to prove
     *  nobody else committed since — skipping the full-file read+parse that
     *  costs ~320ms/turn on >40MiB sessions. An unstamped token (no "written")
     *  is unproven and never takes the fast path. Cleared on the direct-write
     *  paths (restore/rekey) that bypass guardedBuild. */
    private readonly ownCommit = new Map<string, {
        requests: number;
        nextBlockId: number;
        builtAtMs: number;
        written?: { size: number; mtimeMs: number };
        meta?: { protocol?: string; upstreamOrigin?: string };
    }>();

    /** #3923: cross-instance contention observability hook — fired on EVERY
     *  state commit (fresh build AND adopted disk record, both storage modes,
     *  see noteOwnCommit). The standalone server wires it to the served-marker
     *  writer via setGlobalSessionCommitListener; other hosts leave it unset
     *  (undefined = no-op). A throwing listener must not break the save chain. */
    private sessionCommitListener?: (sessionId: string) => void;

    setSessionCommitListener(fn?: (sessionId: string) => void): void {
        this.sessionCommitListener = fn;
    }

    /** #3049 test seam: how many times the stale guard took the FULL
     *  envelope read (the expensive path). The fast path collapses this to
     *  one read per external writer, not one read per save. */
    private staleGuardFullReads = 0;

    __staleGuardFullReadsForTests(): number {
        return this.staleGuardFullReads;
    }

    /** #3652 test seam: whether the ownership token for id carries a LANDED
     *  write stamp yet. The stamp is applied asynchronously in .then() after
     *  the awaited write resolves — i.e. AFTER the envelope has already landed
     *  on disk — so "file present" does not imply "stamp applied". A test that
     *  writes a foreign envelope must wait for THIS (not just file presence) or
     *  it lands inside the documented residual gap (#3406, src/persist.ts
     *  ownershipFastPath) and the stamp adopts the foreign bytes as ours. */
    __ownWriteStampedForTests(id: string): boolean {
        return this.ownCommit.get(id)?.written !== undefined;
    }
    private readonly codec?: StateStoreCodec;
    private readonly readCodec: StateStoreCodec;
    private boundedReads = false;
    private diskFiles: string[] = [];
    /** #3931 step 3: loadEnvelope lazily seeds the disk index on first use
     *  (network backends make the envelope the sync read path — bare-id
     *  loads must find namespaced files without a bootBounded walk). */
    private diskFilesSeeded = false;
    private readonly legacyAliases = new Map<string, { file: string; id: string; savedAt: number }>();
    private readonly sourceFiles = new Map<string, string>();
    /** #3199: post-boot background alias scan (unified modes only) — null in
     *  legacy mode and until bootBounded defers work. */
    private remainderScan: Promise<void> | null = null;
    /** #2674: monotonic per-process counter for unique content-store temp
     *  names (pid + seq makes collisions across processes/rapid saves
     *  unreachable). */
    private tmpSeq = 0;
    // #3931 step 3: assigned asynchronously for network backends (mysql) —
    // see the constructor and ready().
    private shadow?: UnifiedShadow;
    /** #2960 ②: sessions whose fork_base checkpoint has been cut (or was
     *  found already present) — memoized so steady-state writes of receipt
     *  sessions do not re-query the checkpoints table every flush. */
    private readonly forkBaseCut = new Set<string>();
    private readonly storageMode: StorageMode;
    /** Phase 3 (#2960): true only when the JSON envelope is actually skipped —
     *  requires an explicit off request AND effective-full mode. If the
     *  sidecar dies mid-run (3-strike disable) writerOffActive() turns false
     *  and file writes resume on the very next save (fail-safe: never a
     *  window with no persistent copy at all). */
    private readonly jsonWriterOff: boolean;
    /** #3931 step 3: resolves when the async backend (mysql) opened (or
     *  failed to — the sidecar just stays undefined). Resolved immediately
     *  for sqlite/legacy boots. */
    private readonly mysqlReady: Promise<void> = Promise.resolve();
    /** Await the storage backend before first use (mysql pool + DDL). */
    ready(): Promise<void> {
        return this.mysqlReady;
    }
    /** #3133: writerOff pending builds, keyed by session id. markDirty fires
     *  several times per request and the writerOff branch used to build
     *  synchronously on EVERY call; a microtask-batched run per turn keeps
     *  the immediate-ish semantics while coalescing same-tick calls. */
    private readonly writerOffPending = new Map<string, () => void>();
    /** #3406: host-owned debounced envelope saves (id → armed timer / latest builder).
     *  The debounce lives HERE instead of inside the kernel store so each landed
     *  write goes through the stamped path (store.writeNow + stampOwnWrite): a
     *  kernel-internal debounce cannot observe its own landing, which left every
     *  per-turn debounced save unstamped and killed the ownership fast path. */
    private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly saveBuilders = new Map<string, () => PersistedSession>();
    private readonly debounceMs: number;

    constructor(opts?: { dir?: string; debounceMs?: number; enabled?: boolean; log?: Logger }) {
        const debounceMs = opts?.debounceMs ?? defaultDebounce();
        this.enabled = (opts?.enabled ?? true) && debounceMs >= 0;
        this.debounceMs = Math.max(0, debounceMs);
        this.sessionsDir = opts?.dir ?? defaultDir();
        const baseLog = opts?.log ?? defaultLogger;
        this.log = baseLog;
        // #708/#1080: env-only storage policy (a key file next to the data
        // sits on the same untrusted filesystem). Compression is OPT-IN
        // (owner decision, #1080): BILI_PERSIST_ZSTD=1/true enables it, the
        // default stays plain JSON. Invalid key values throw here — fail
        // fast at startup instead of running silently unencrypted.
        const keyEnv = process.env.BILI_ENCRYPTION_KEY;
        let key: Buffer | null = null;
        if (keyEnv) key = parseEncryptionKey(keyEnv);
        this.codec = createStorageCodec({ key, compress: persistZstdEnabled() });
        // Read historical compression without changing the opt-in write policy.
        this.readCodec = this.codec ?? createStorageCodec({ compress: true })!;
        if (key) {
            baseLog("info", "[persist] session-file encryption enabled (AES-256-GCM)");
        } else if (this.codec) {
            baseLog("info", "[persist] session-file compression enabled (zstd, BILIZSTD1)");
        }
        const epermAlert = new PersistEpermAlert({
            dir: this.sessionsDir,
            threshold: epermAlertThreshold(),
            repeatMs: epermAlertRepeatMs(),
        });
        // #2671 Phase 1 dry-run / Phase 1.5 full: with the unified-storage knob
        // set (env BILI_STORAGE_UNIFIED or file storage.unified), every
        // committed record is double-ingested into <dir>/index.db and
        // digest-reconciled against the legacy load view; with full, reads
        // additionally go unified-first with organic import and legacy
        // fallback (drop-in replacement; rollback = unset the knob).
        // Encryption is a hard opt-out: index.db holds the ingest payload in
        // cleartext, so the sidecar refuses to open while BILI_ENCRYPTION_KEY
        // is active and the store stays legacy-only.
        const storageMode = resolveStorageModeSafe();
        const unifiedBlockedByEncryption = storageMode !== "legacy" && key !== null;
        if (unifiedBlockedByEncryption) {
            baseLog("warn", "[storage] unified sidecar DISABLED: BILI_ENCRYPTION_KEY is active and index.db would hold cleartext ingest payloads — staying legacy-only");
        }
        this.storageMode = storageMode;
        // #3135 ②/#3818: persistence turned off (BILI_PERSIST=0 / enabled:false)
        // is an intentional opt-out — the runtime banner must say so instead of
        // fabricating a "no SQLite engine" degrade for a sidecar that was never
        // supposed to open.
        recordRequestedMode(storageMode, unifiedBlockedByEncryption, !this.enabled);
        // Phase 3 (#2960): stop writing the legacy JSON envelope while the
        // unified store runs in effective-full mode. Ignored (warned once)
        // under shadow/legacy/encryption — there the JSON file is the sole
        // source of truth.
        const wantJsonWriterOff = knobResolveJsonWriterOff(process.env, fileStorageJsonWriter());
        this.jsonWriterOff = wantJsonWriterOff && storageMode === "full" && !unifiedBlockedByEncryption && resolveBackendName(process.env, fileStorageBackend()) === "sqlite";
        if (wantJsonWriterOff && !this.jsonWriterOff) {
            baseLog("warn", "[storage] storage.jsonWriter=off ignored — requires storage.unified=full on the sqlite backend (network backends keep the JSON envelope as the sync read path)");
        }
        const legacyLoad = (rec: unknown): LegacySessionLike | null => {
            const s = buildSession(rec as PersistedSession);
            return toLegacyLike(s);
        };
        // #3931 step 3: network backends (mysql) can only open asynchronously
        // (pool + DDL), so the sidecar attaches when it resolves — until then
        // this.shadow stays undefined and every surface keeps its documented
        // no-sidecar posture (envelope reads/writes, banner, replicas off).
        // `ready()` gates the async consumers (saves, boot, admin).
        const backendName = resolveBackendName(process.env, fileStorageBackend());
        if (this.enabled && !unifiedBlockedByEncryption && backendName === "mysql") {
            this.mysqlReady = UnifiedShadow.openAsync(
                this.sessionsDir,
                process.env,
                legacyLoad,
                fileStorageUnified(),
                fileStorageWalJournalSizeLimit(),
                fileStorageBackend(),
                fileStorageMysqlDsn(),
            ).then((sh) => {
                this.shadow = sh ?? undefined;
            });
            this.shadow = undefined;
        } else {
            this.shadow = this.enabled && !unifiedBlockedByEncryption
                ? (UnifiedShadow.maybeOpen(this.sessionsDir, process.env, legacyLoad, fileStorageUnified(), fileStorageWalJournalSizeLimit(), fileStorageBackend()) ?? undefined)
                : undefined;
        }
        this.store = new StateStore<PersistedSession>({
            dir: this.sessionsDir,
            version: PERSIST_VERSION,
            debounceMs: this.debounceMs,
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
            // #2298: CCR content-store envelopes (#1097) co-reside in the SAME
            // namespace by design (<proto>/<host>_<hash>.content-store.json) but
            // are not session records — declaring them foreign keeps the boot
            // scan from parsing each one and warning "skipping invalid record"
            // per file (hundreds of warns per start at multi-relay scale). Same
            // suffix predicate the GC (#1180) and web walkers already use.
            foreignFile: (file) => path.basename(file).endsWith(".content-store.json"),
        });
    }

    /** #1097: load the session's kernel content-store envelope (namespaced
     *  path first, then the _unknown/ fallback — same probe order as
     *  loadEnvelope). Bounded server startup refuses corrupt originals;
     *  legacy direct callers retain their warned fresh-store fallback. */
    loadContentStore(session: Session): MessageContentStore | null {
        return this.readContentStoreRels(session.id, [
            contentStoreRelPathFor(session.id, session.meta.protocol, session.meta.upstreamOrigin),
            contentStoreRelPathFor(session.id),
        ]);
    }

    /** Id+meta variant for replica freeze/restore (#2671 review 6): the
     *  checkpoint path has no live Session object, only the frozen record's
     *  meta — same rel-path candidates, same parse-and-degrade semantics. */
    private contentStoreById(id: string, meta?: { protocol?: string; upstreamOrigin?: string } | null): MessageContentStore | null {
        return this.readContentStoreRels(id, [
            contentStoreRelPathFor(id, meta?.protocol, meta?.upstreamOrigin),
            contentStoreRelPathFor(id),
        ]);
    }

    private readContentStoreRels(id: string, rels: string[]): MessageContentStore | null {
        if (!this.enabled) return null;
        // #3399/#3765: probe the winning source's CCR BEFORE rels[0]. Adoption
        // rewrites meta.upstreamOrigin to the requesting route during loadSync,
        // so rels[0] targets that route's sidecar — a degraded current-route twin
        // with a valid-but-incomplete CCR would otherwise shadow the winning
        // ledger's originals (missing refs → DIGEST DRIFT). A .fb.json fallback
        // source keeps its canonical <base>.content-store.json name.
        const source = this.sourceFiles.get(id);
        const sourceCcr = source
            ? (source.endsWith(".fb.json")
                ? `${source.slice(0, -".fb.json".length)}.content-store.json`
                : `${source.slice(0, -".json".length)}.content-store.json`)
            : null;
        const paths = [...(sourceCcr ? [sourceCcr] : []),
            ...rels.map(rel => path.join(this.sessionsDir, rel)),
            ...this.diskFiles.filter(file => fileNameMatchesId(path.basename(file), id))
                .map(file => file.replace(/\.json$/, ".content-store.json"))];
        for (const file of new Set(paths)) {
            let buf: Buffer;
            try {
                buf = readFileSync(file);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
                if (!this.boundedReads) {
                    this.log("warn", `[persist] content store for ${id} unreadable, starting fresh: ${String(err)}`);
                    return null;
                }
                throw new Error(`Content store for ${id} cannot be read; refusing to replace its originals`, { cause: err });
            }
            try {
                const text = this.readCodec.decode(buf);
                const parsed = JSON.parse(text) as MessageContentStore;
                if (parsed && typeof parsed === "object" && parsed.version === 1
                    && parsed.byHash && typeof parsed.byHash === "object"
                    && parsed.byRef && typeof parsed.byRef === "object") {
                    return parsed;
                }
                throw new Error(`Content store for ${id} is malformed; refusing to replace its originals`);
            } catch (err) {
                if (!this.boundedReads) {
                    this.log("warn", `[persist] content store for ${id} unreadable, starting fresh: ${String(err)}`);
                    return null;
                }
                throw new Error(`Content store for ${id} unreadable; refusing to replace its originals`, { cause: err });
            }
        }
        return null;
    }

    /** Writes a content-store envelope by id+meta with the same atomic
     *  tmp+rename discipline as saveContentStore — used by restoreReplica,
     *  which has no live Session to mark dirty (#2671 review 6). */
    private writeContentStoreSidecar(id: string, meta: { protocol?: string; upstreamOrigin?: string } | undefined, store: MessageContentStore): void {
        const rel = contentStoreRelPathFor(id, meta?.protocol, meta?.upstreamOrigin);
        const abs = path.join(this.sessionsDir, rel);
        const tmp = path.join(path.dirname(abs), `.tmp-${path.basename(abs, ".json")}-${process.pid}-${this.tmpSeq++}`);
        try {
            mkdirSync(path.dirname(abs), { recursive: true });
            const text = JSON.stringify(store);
            durableWriteFile(tmp, this.codec ? this.codec.encode(text) : text);
            renameSync(tmp, abs);
        } catch (err) {
            try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
            this.log("warn", `[persist] content-store restore write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** #1097: persist the content-store envelope when dirty; an emptied store
     *  (rebase reset) deletes the file. Payload-first: runs BEFORE the session
     *  state write so a crash mid-save leaves at worst a retrieve miss, never
     *  a placeholder whose original is gone.
     *
     *  Atomic (#2674): the envelope goes to a unique .tmp-* sibling in the SAME
     *  directory (same volume ⇒ rename is atomic) and is renamed onto the
     *  destination — mirroring the kernel StateStore.writeInner discipline. A
     *  crash mid-write orphans the temp (swept at next boot, #2674) instead of
     *  truncating the live envelope, which loadContentStore would treat as
     *  "malformed, starting fresh" and silently drop every stored original. On
     *  any failure the temp is unlinked and contentStoreDirty re-set so the next
     *  save retries; the previous envelope stays byte-identical. */
    private saveContentStore(session: Session): boolean {
        if (!this.enabled || !session.contentStoreDirty) return true;
        const rel = contentStoreRelPathFor(session.id, session.meta.protocol, session.meta.upstreamOrigin);
        const abs = path.join(this.sessionsDir, rel);
        const tmp = path.join(path.dirname(abs), `.tmp-${path.basename(abs, ".json")}-${process.pid}-${this.tmpSeq++}`);
        try {
            if (!session.contentStore || Object.keys(session.contentStore.byRef).length === 0) {
                rmSync(abs, { force: true });
                session.contentStoreDirty = false;
                return true;
            }
            mkdirSync(path.dirname(abs), { recursive: true });
            const text = JSON.stringify(session.contentStore);
            durableWriteFile(tmp, this.codec ? this.codec.encode(text) : text, 0o600);
            renameSync(tmp, abs);
            session.contentStoreDirty = false;
            return true;
        } catch (err) {
            try { rmSync(tmp, { force: true }); } catch { /* best-effort: a stuck temp is swept at next boot */ }
            session.contentStoreDirty = true;
            this.log("warn", `[persist] content-store write failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
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
            // #2671 full mode: prefer the unified view (importing from the
            // envelope we already parsed); the file stays the enumeration
            // base and the fallback when the index has nothing better.
            const session = this.buildForLoadAll(id, envelope.payload);
            if (hasNegativePersistedTokens(envelope.payload)) {
                // #408 one-time migration: the in-memory value is already
                // clamped by buildSession — rewrite the stale file so the
                // negative value is gone from disk.
                await this.store.writeNow(id, () => buildRecord(session));
                clamped++;
                // #3049: the clamp rewrite writes a DIFFERENT payload than any
                // ingested record (clamped stats) without a sidecar ingest —
                // drop any stale token; boot-time loads have none, but keep
                // this correct for future callers.
                this.ownCommit.delete(id);
            }
            out.set(id, session);
        }
        // #2960 R2.1 boot union (full mode): rows whose legacy file is gone
        // (deleted, or written by a Phase 3 future that stops writing JSON)
        // remain enumerable — the index is self-sufficient. Shadow stays
        // file-walk: there JSON is the truth base.
        if (this.shadow?.readsUnified) {
            for (const id of this.shadow.listSessionIds()) {
                if (out.has(id)) continue;
                const session = this.loadSync(id);
                if (session) out.set(id, session);
            }
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
    async boot(limits?: { maxSessions: number; maxBytes: number }): Promise<Map<string, Session>> {
        if (!this.enabled) return new Map();
        await this.sweepStaleTemps();
        if (limits) return this.bootBounded(limits);
        const loaded = await this.store.loadAll();
        await this.applyLegacyMigration(loaded);
        const out = new Map<string, Session>();
        for (const [id, envelope] of loaded) {
            out.set(id, this.buildForLoadAll(id, envelope.payload));
        }
        // #2960 R2.1 boot union (full mode) — mirrors loadAll: index rows
        // without a legacy file stay enumerable (the index is
        // self-sufficient). bootBounded (limits path) intentionally stays
        // file-based: bounded boot is the cold-start triage path for huge
        // legacy trees.
        if (this.shadow?.readsUnified) {
            for (const id of this.shadow.listSessionIds()) {
                if (out.has(id)) continue;
                const session = this.loadSync(id);
                if (session) out.set(id, session);
            }
        }
        return out;
    }

    /** Keep only file metadata while indexing. Legacy aliases are adopted on
     *  resume without deleting their historical state or original companions. */
    /** True when a state file for `id` exists on disk (hot or cold root,
     *  canonical or flat name) — the same path shapes loadEnvelope probes. */
    private stateFileOnDisk(id: string): boolean {
        for (const root of [this.sessionsDir, `${this.sessionsDir}-cold`]) {
            if (existsSync(path.join(root, relPathFor(id)))) return true;
            if (existsSync(path.join(root, flatFileNameFor(id)))) return true;
        }
        return false;
    }

    private async bootBounded(limits: { maxSessions: number; maxBytes: number }): Promise<Map<string, Session>> {
        if (!Number.isFinite(limits.maxSessions) || limits.maxSessions < 0 || !Number.isFinite(limits.maxBytes) || limits.maxBytes < 0) {
            throw new Error("Invalid session boot limits");
        }
        this.boundedReads = true;
        mkdirSync(this.sessionsDir, { recursive: true });
        this.diskFiles = [];
        this.diskFilesSeeded = true;
        this.legacyAliases.clear();
        const warm: Array<{ file: string; id: string; meta: PersistedSession["meta"]; savedAt: number; bytes: number }> = [];
        const canonical = new Set<string>();
        const filesByRoot = new Map<string, string[]>();
        for (const root of [this.sessionsDir, `${this.sessionsDir}-cold`]) {
            const files = existsSync(root) ? await walkJsonFiles(root) : [];
            for (const file of files) {
                if (path.basename(file).endsWith(".content-store.json")) continue;
                this.diskFiles.push(file);
                filesByRoot.set(root, [...(filesByRoot.get(root) ?? []), file]);
            }
        }
        // #3199: unified mode (shadow or full) — the listener must not wait
        // for the whole corpus to parse. Two stages: (1) parse a bounded
        // WINDOW of the newest files (mtime desc, stopped once the window
        // holds a full budget's worth of candidates), (2) arbitrate the final
        // warm set by savedAt desc with the original while-pop trim (#404 —
        // mtime only orders the parse window, never the survivor choice).
        // Seed label aliases from the index rows first (no decode); the rest
        // of the bookkeeping finishes in the background. Gate is
        // replicasAvailable() — a live non-degraded sidecar EXISTS (shadow OR
        // full) — NOT readsUnified, which is the full-mode-only "rows are
        // authoritative" predicate.
        if (this.replicasAvailable()) {
            this.seedIndexedAliases(canonical);
            const hot = (filesByRoot.get(this.sessionsDir) ?? [])
                .map((file) => {
                    try {
                        const st = statSync(file);
                        return { file, mtimeMs: st.mtimeMs, size: st.size };
                    } catch {
                        return null; // raced deletion between walk and stat
                    }
                })
                .filter((c): c is { file: string; mtimeMs: number; size: number } => c !== null)
                .sort((a, b) => b.mtimeMs - a.mtimeMs);
            const parsedFiles = new Set<string>();
            const parsedCands: Array<{ file: string; id: string; meta: PersistedSession["meta"]; savedAt: number; bytes: number }> = [];
            let windowBytes = 0;
            for (const cand of hot) {
                if (parsedCands.length >= limits.maxSessions && windowBytes >= limits.maxBytes) break;
                // on-disk size lower-bounds decoded size (#2803) — cheap pre-filter
                if (cand.size > limits.maxBytes) continue;
                const parsed = await this.readRawFileWithBytes(cand.file);
                parsedFiles.add(cand.file);
                if (!parsed) continue;
                const rec = this.parseBootPayload(parsed.value);
                if (!rec || !fileNameMatchesId(path.basename(cand.file), rec.payload.id, rec.meta.protocol, rec.meta.upstreamOrigin)) continue;
                const savedAt = rec.payload.savedAt ?? 0;
                if (rec.payload.id === rec.meta.label || rec.payload.id.startsWith("pfa-")) this.noteCanonical(rec.payload.id, canonical);
                else if (rec.meta.label) this.upsertLegacyAlias(rec.meta.label, { file: cand.file, id: rec.payload.id, savedAt }, canonical);
                const bytes = parsed.bytes;
                if (bytes > limits.maxBytes) continue;
                windowBytes += bytes;
                parsedCands.push({ file: cand.file, id: rec.payload.id, meta: rec.meta, savedAt, bytes });
            }
            parsedCands.sort((a, b) => b.savedAt - a.savedAt);
            while (parsedCands.length > limits.maxSessions || parsedCands.reduce((sum, item) => sum + item.bytes, 0) > limits.maxBytes) parsedCands.pop();
            warm.push(...parsedCands);
            this.remainderScan = this.scanRemainderInBackground(parsedFiles, canonical);
            void this.remainderScan;
        } else {
            // legacy mode: keep the synchronous full parse exactly as before —
            // there is no index to lean on, so nothing can be deferred.
            for (const root of [this.sessionsDir, `${this.sessionsDir}-cold`]) {
                for (const file of filesByRoot.get(root) ?? []) {
                    const parsed = await this.readRawFileWithBytes(file);
                    if (!parsed) continue;
                    const rec = this.parseBootPayload(parsed.value);
                    if (!rec || !fileNameMatchesId(path.basename(file), rec.payload.id, rec.meta.protocol, rec.meta.upstreamOrigin)) continue;
                    const savedAt = rec.payload.savedAt ?? 0;
                    if (rec.payload.id === rec.meta.label || rec.payload.id.startsWith("pfa-")) canonical.add(rec.payload.id);
                    else if (rec.meta.label) {
                        const previous = this.legacyAliases.get(rec.meta.label);
                        if (!previous || savedAt >= previous.savedAt) this.legacyAliases.set(rec.meta.label, { file, id: rec.payload.id, savedAt });
                    }
                    if (root !== this.sessionsDir) continue;
                    const bytes = parsed.bytes;
                    if (bytes > limits.maxBytes) continue;
                    warm.push({ file, id: rec.payload.id, meta: rec.meta, savedAt, bytes });
                    warm.sort((a, b) => b.savedAt - a.savedAt);
                    while (warm.length > limits.maxSessions || warm.reduce((sum, item) => sum + item.bytes, 0) > limits.maxBytes) warm.pop();
                }
            }
        }
        for (const id of canonical) this.legacyAliases.delete(id);
        const out = new Map<string, Session>();
        for (const item of warm) {
            const alias = item.meta?.label && this.legacyAliases.get(item.meta.label);
            if (alias && alias.file !== item.file) continue;
            const id = alias ? item.meta!.label! : item.id;
            const session = this.loadSync(id, item.meta);
            if (session) out.set(id, session);
        }
        // #3135 ⑥/#3818: full mode's bounded boot warms only what the FILE
        // scan saw — but with the JSON writer off (full's Phase 3 posture)
        // pure-index sessions have no file at all. Union in PURE-INDEX ids
        // so a jsonWriter=off user's fresh sessions stay enumerable after a
        // restart; loadSync routes them to the index view directly.
        // An id with a state file on disk was ALREADY offered to the file
        // scan under the decoded-byte budget (#2803) — loading it again here
        // would bypass maxBytes and over-warm the heap (bounded-boot scale
        // test). File-backed ids stay lazy-loadable through loadSync either
        // way, so skipping them loses nothing.
        // The pure-index ids that do enter are measured by their SERIALIZED
        // record — the same proxy readRawFileWithBytes gives the file path
        // (#2803: the budget is a RAM proxy, not a disk one).
        if (this.shadow?.readsUnified) {
            let warmBytes = 0;
            for (const item of warm) warmBytes += item.bytes;
            for (const id of this.shadow.listSessionIds()) {
                if (out.size >= limits.maxSessions) break;
                if (warmBytes >= limits.maxBytes) break;
                if (out.has(id)) continue;
                if (this.stateFileOnDisk(id)) continue;
                const session = this.loadSync(id);
                if (!session) continue;
                const bytes = this.estimateDecodedBytes(session);
                if (warmBytes + bytes > limits.maxBytes) continue;
                warmBytes += bytes;
                out.set(id, session);
            }
        }
        this.log("info", `[persist] indexed ${this.diskFiles.length} state files; warmed ${out.size} sessions within ${limits.maxBytes} decoded bytes; older states load on demand`);
        return out;
    }

    /** Shared envelope→(record, meta) extraction for the boot passes; null on
     *  any parse/validation failure (same gates as before the split). Meta is
     *  resolved to the flat fallbacks so callers never see undefined. */
    private parseBootPayload(raw: unknown): { payload: PersistedSession; meta: NonNullable<PersistedSession["meta"]> } | null {
        const payload = raw && typeof raw === "object" && "payload" in raw ? raw.payload : raw;
        if (!isValidRecord(payload)) return null;
        const meta = payload.meta ?? { protocol: payload.protocol, upstreamOrigin: payload.upstreamOrigin, label: payload.label };
        return { payload, meta };
    }

    /** Incremental canonical registration: adding an id to the canonical set
     *  voids any alias under the same name NOW instead of at end-of-scan —
     *  the incremental result equals the old final "delete all canonical
     *  labels from the alias map" pass. */
    private noteCanonical(id: string, canonical: Set<string>): void {
        canonical.add(id);
        this.legacyAliases.delete(id);
    }

    /** Alias upsert with the newest-savedAt-wins rule; refuses names that are
     *  (or became) canonical ids. Returns whether the map changed. */
    private upsertLegacyAlias(label: string, entry: { file: string; id: string; savedAt: number }, canonical: Set<string>): boolean {
        if (canonical.has(label)) return false;
        const previous = this.legacyAliases.get(label);
        if (previous && entry.savedAt < previous.savedAt) return false;
        this.legacyAliases.set(label, entry);
        return true;
    }

    /** #3199: pre-seed label aliases from the unified index rows so label-based
     *  resume of recorded sessions works WITHOUT parsing their files during
     *  boot. Unrecorded files get their aliases from the background scan. */
    private seedIndexedAliases(canonical: Set<string>): void {
        const shadow = this.shadow;
        if (!shadow) return;
        let rows;
        try {
            rows = shadow.sessionSummaries();
        } catch {
            return; // sidecar degraded mid-boot: background scan still covers it
        }
        for (const r of rows) {
            if (!r.label || r.label === r.sessionId || r.sessionId.startsWith("pfa-")) continue;
            const file = this.resolveIndexedFile(r.sessionId, r.protocol, r.origin);
            if (!file) continue;
            this.upsertLegacyAlias(r.label, { file, id: r.sessionId, savedAt: r.updatedAt }, canonical);
        }
    }

    /** #3199: locate a recorded session's JSON file by its id alone — the same
     *  three rel-path candidates the live probes use, across both roots; first
     *  existing regular file wins (stat-only, no decode). */
    private resolveIndexedFile(id: string, protocol?: string, origin?: string): string | null {
        const candidates = [relPathFor(id, protocol, origin), relPathFor(id), flatFileNameFor(id)];
        for (const root of [this.sessionsDir, `${this.sessionsDir}-cold`]) {
            for (const rel of candidates) {
                const file = path.join(root, rel);
                try {
                    if (statSync(file).isFile()) return file;
                } catch {
                    // missing candidate: next
                }
            }
        }
        return null;
    }

    /** #3199: finish alias/canonical bookkeeping over the corpus AFTER boot
     *  returned, so the listener is not held by files outside the warm window.
     *  Idempotent with the synchronous part (same upsert rules); yields the
     *  event loop between files like the web disk index does. */
    private async scanRemainderInBackground(parsedFiles: Set<string>, canonical: Set<string>): Promise<void> {
        let scanned = 0;
        let aliased = 0;
        for (const file of this.diskFiles) {
            if (parsedFiles.has(file)) continue;
            scanned++;
            const parsed = await this.readRawFileWithBytes(file);
            if (parsed) {
                const rec = this.parseBootPayload(parsed.value);
                if (rec && fileNameMatchesId(path.basename(file), rec.payload.id, rec.meta.protocol, rec.meta.upstreamOrigin)) {
                    const savedAt = rec.payload.savedAt ?? 0;
                    if (rec.payload.id === rec.meta.label || rec.payload.id.startsWith("pfa-")) this.noteCanonical(rec.payload.id, canonical);
                    else if (rec.meta.label) aliased += this.upsertLegacyAlias(rec.meta.label, { file, id: rec.payload.id, savedAt }, canonical) ? 1 : 0;
                }
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (scanned > 0) {
            this.log("info", `[persist] background index scan finished after boot: ${scanned} file(s) scanned, ${aliased} alias(es) recorded`);
        }
    }

    /** #3199: resolves when the post-boot background alias scan has finished
     *  (immediate in legacy mode or when nothing was deferred). */
    backgroundScanComplete(): Promise<void> {
        return this.remainderScan ?? Promise.resolve();
    }

    private readEnvelopeFile(file: string, id: string): PersistedEnvelope<PersistedSession> | null {
        let bytes: Buffer;
        try {
            bytes = readFileSync(file);
        } catch (err) {
            // Probes gate on existsSync first; the GC sweep (#1082) or an
            // operator archiving files can delete between gate and read.
            // Absence is absence — any other error stays fail-closed.
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
        let raw: unknown;
        try { raw = JSON.parse(bytes.toString("utf8")); }
        catch {
            try { raw = JSON.parse(this.readCodec.decode(bytes)); }
            catch (decodeError) {
                // #3157 self-heal: a size-correct but undecodable file (a VDL=0
                // zero file left by a crash between write and rename — now
                // prevented by the fsync fix) used to throw here on every load,
                // 502-ing the whole lane until a human deleted the file. Isolate
                // it beside the original and start this session fresh instead.
                this.quarantineCorruptState(file, id, decodeError);
                return null;
            }
        }
        const payload = raw && typeof raw === "object" && "payload" in raw ? raw.payload : raw;
        if (!isValidRecord(payload)) {
            this.quarantineCorruptState(file, id, new Error(`record for ${id} failed validation`));
            return null;
        }
        if (raw && typeof raw === "object" && "payload" in raw && "id" in raw && raw.id !== id) return null;
        if (payload.id !== id) return null;
        return { id, payload, version: payload.version, savedAt: payload.savedAt };
    }

    /** #3157 self-heal: rename an undecodable/malformed session state file out
     *  of the way so it stops poisoning the lane, preserving it beside the
     *  original for forensics. Mirrors loadConversations' corrupt-file handling
     *  (plugin.ts). Best-effort: if the rename fails (Windows AV/indexer lock),
     *  the caller still treats the file as a miss — the session starts fresh and
     *  the next boot retries the isolation. The `.corrupt-<ts>` suffix does not
     *  end in `.json`, so the directory walkers skip it next boot (it stays for
     *  forensics; sweepStaleTemps only removes `.tmp-*` orphans). */
    private quarantineCorruptState(file: string, id: string, cause: unknown): void {
        const causeText = cause instanceof Error ? cause.message : String(cause);
        const quarantinePath = `${file}.corrupt-${Date.now()}`;
        try {
            renameSync(file, quarantinePath);
            this.log("warn", `[persist] quarantined undecodable session state ${path.basename(file)} → ${path.basename(quarantinePath)}; starting ${id} fresh (${causeText})`);
        } catch (renameErr) {
            this.log("error", `[persist] failed to quarantine corrupt session state ${path.basename(file)}; resuming ${id} empty this load (${causeText}; rename: ${renameErr instanceof Error ? renameErr.message : String(renameErr)})`);
        }
    }

    /** #2671: per-id session build for the directory walks (loadAll/boot).
     *  In full mode this imports the just-parsed envelope into the unified
     *  index and serves the view from there when possible (organic import at
     *  boot); otherwise it is the plain legacy build. Never throws — an
     *  import/view failure falls back to the legacy build. */
    private buildForLoadAll(id: string, payload: PersistedSession): Session {
        if (this.shadow?.readsUnified) {
            // Staleness guard: the unified row is refreshed by EVERY runtime
            // build (guardedBuild ingests before the write chain flushes the
            // JSON), so an on-disk payload can only be equal (idempotent) or
            // STALE (this load raced a newer in-flight write — e.g. the #286
            // rekey re-serializes an older envelope on first boot). Re-ingesting
            // the stale payload would revert newer fold state — the load-side
            // face of #2401. Import only when the index has never seen the id
            // (organic first open) or the payload is strictly newer than the
            // row (a JSON write that bypassed the ingest: #408 clamp rewrite,
            // #286 rekey, restoreReplica's direct writeNow — all stamp a fresh
            // savedAt at build time).
            const dbAt = this.shadow.sessionUpdatedAt(id);
            if (dbAt === null || payload.savedAt > dbAt) {
                this.shadow.importRecord(payload);
            }
            const view = this.shadow.viewFor(id);
            if (view) return buildSession(viewToRecord(view));
        }
        return buildSession(payload);
    }

    /** #708/#1080 review: boot NEVER rewrites session file CONTENT. The first
     *  draft re-encoded every legacy plaintext file in place at boot — a mass
     *  format flip that a downgrade (rollback during incident triage) would
     *  meet with "skipping corrupt file" + empty-session resume + overwrite,
     *  silently destroying history. Legacy plaintext files keep loading via
     *  the codec's magic dispatch and convert organically on their next save;
     *  the only thing boot touches is orphaned `.tmp-*` temps from crashed
     *  writes of previous runs (pure deletion of garbage, never content).
     *  #2674 widened the sweep from `.tmp-enc-*` to EVERY `.tmp-*` name so the
     *  atomic content-store companion temps (and the kernel session-write
     *  temps they now sit beside) leave no accumulating orphans. */
    private async sweepStaleTemps(): Promise<void> {
        let files: string[];
        try {
            files = await walkJsonFiles(this.sessionsDir);
        } catch {
            return;
        }
        for (const file of files) {
            if (isStaleTempName(path.basename(file))) {
                await rm(file, { force: true }).catch(() => {});
            }
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
        return path.join(this.sessionsDir, MIGRATION_MARKER);
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
            // #3049: direct write bypassing guardedBuild — the boot rekey
            // rewrites envelopes without the sidecar ingest, so any prior
            // ownership token for this id is stale.
            this.ownCommit.delete(label);
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
            mkdirSync(this.sessionsDir, { recursive: true });
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
        // #2671 GC parity: when the legacy file goes, the unified sidecar's
        // rows go with it (deleteSession releases CAS refcounts too).
        this.shadow?.remove(id);
        await this.removeSessionFiles(id, session.meta);
    }

    /** Every on-disk file belonging to this session id, whatever namespace it
     *  sits in. Explicit candidates first (when meta is known), then a shallow
     *  tree walk with loadEnvelope's lazy hash-suffix predicate: a standalone
     *  opener never ran a directory scan, and legacy lanes carry no index row
     *  revealing the protocol, so the walk is the only complete answer there. */
    /** Public for the CLI maintenance surface (`bili sessions ls` sizes walk
     *  the same candidate set rm deletes). */
    async findSessionFiles(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Promise<string[]> {
        const rels = new Set<string>();
        for (const rel of [
            relPathFor(id, meta?.protocol, meta?.upstreamOrigin),
            relPathFor(id),
            flatFileNameFor(id),
        ]) {
            if (existsSync(path.join(this.sessionsDir, rel))) rels.add(rel);
        }
        const expected = path.basename(relPathFor(id));
        const matches = (base: string): boolean =>
            fileNameMatchesId(base, id, meta?.protocol, meta?.upstreamOrigin) || base.endsWith(`_${expected}`);
        try {
            for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
                if (entry.isFile()) {
                    if (matches(entry.name)) rels.add(entry.name);
                    continue;
                }
                if (!entry.isDirectory()) continue;
                try {
                    for (const f of await readdir(path.join(this.sessionsDir, entry.name), { withFileTypes: true })) {
                        if (f.isFile() && matches(f.name)) rels.add(path.join(entry.name, f.name));
                    }
                } catch { /* unreadable subdir: the explicit candidates still cover it */ }
            }
        } catch { /* missing dir: nothing on disk */ }
        return [...rels];
    }

    private async removeSessionFiles(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Promise<void> {
        for (const rel of await this.findSessionFiles(id, meta)) {
            await rm(path.join(this.sessionsDir, rel), { force: true }).catch(() => {});
            if (rel.endsWith(".json") && !rel.endsWith(".fb.json")) {
                await rm(path.join(this.sessionsDir, `${rel.slice(0, -".json".length)}.content-store.json`), { force: true }).catch(() => {});
            }
        }
    }

    /** #3928: user-facing single-session deletion (`bili sessions rm`). The
     *  same supported path the boot rekey/dedup uses, exposed standalone:
     *  unified sidecar rows FIRST (deleteSession cascades every table and
     *  releases CAS refcounts incl. media; pinned checkpoints survive by
     *  design), then the legacy files. Safe to call from a process where no
     *  proxy runs and nothing is resident in memory — that is exactly the
     *  point. */
    async removeSession(id: string): Promise<{ envelopeFound: boolean; unifiedHadRows: boolean }> {
        // Resolve identity from whichever side knows it: the unified row
        // carries protocol+origin even when the JSON tree is already gone,
        // and the envelope carries them when only the tree survives.
        let meta: { protocol?: string; upstreamOrigin?: string } | undefined;
        const unifiedAvailable = this.replicasAvailable();
        if (unifiedAvailable) {
            try {
                const row = this.liveShadow().sessionSummaries().find((r) => r.sessionId === id);
                if (row && (row.protocol || row.origin)) meta = { protocol: row.protocol, upstreamOrigin: row.origin };
            } catch { /* sidecar degraded mid-call: fall back to tree-only probing */ }
        }
        const envelope = this.loadEnvelope(id, meta);
        if (envelope) meta = { ...meta, ...envelope.payload.meta };
        const unifiedHadRows = unifiedAvailable && this.liveShadow().sessionUpdatedAt(id) !== null;
        const files = await this.findSessionFiles(id, meta);
        if (unifiedAvailable) this.liveShadow().remove(id);
        await this.removeSessionFiles(id, meta);
        return { envelopeFound: files.length > 0 || envelope !== null, unifiedHadRows };
    }

    /** Shared envelope probe for the sync read paths. When the request names
     *  a protocol, the namespaced files for this id form ONE candidate pool
     *  (#3399 — see loadNamespacedPool); on pool miss (or without protocol
     *  meta) the probes fall back to the _unknown/ location, letting the
     *  kernel store layer also check its discovered map and the flat legacy
     *  name. */
    private loadEnvelope(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): PersistedEnvelope<PersistedSession> | null {
        if (meta?.protocol) {
            const pooled = this.loadNamespacedPool(id, { protocol: meta.protocol, upstreamOrigin: meta.upstreamOrigin });
            if (pooled) return pooled;
        }
        const livePaths = new Set([
            path.join(this.sessionsDir, relPathFor(id, meta?.protocol, meta?.upstreamOrigin)),
            path.join(this.sessionsDir, relPathFor(id)),
            path.join(this.sessionsDir, flatFileNameFor(id)),
        ]);
        for (const file of livePaths) {
            if (!existsSync(file)) continue;
            const envelope = this.readEnvelopeFile(file, id);
            if (envelope) {
                this.sourceFiles.set(id, file);
                return envelope;
            }
        }
        // #3931 step 3: network backends make the envelope the sync read
        // path — their viewFor/importRecord sync facades always miss, so
        // bare-id loads must find namespaced files without a bootBounded
        // walk. Seeded once, sync. ANY unified mode (#3769 flake): on the
        // sqlite path viewFor usually hits, but a bare-id load whose index
        // row is not there yet (fresh store over an existing dir, row still
        // in an in-flight chain) must still hydrate the pooled envelope off
        // disk — without this the legacy fallback silently returns null and
        // the session looks nonexistent until a full boot walk.
        if (!this.diskFilesSeeded && this.shadow) {
            this.diskFiles = [
                ...walkJsonFilesSync(this.sessionsDir),
                ...(existsSync(`${this.sessionsDir}-cold`) ? walkJsonFilesSync(`${this.sessionsDir}-cold`) : []),
            ].filter((f) => !path.basename(f).endsWith(".content-store.json"));
            this.diskFilesSeeded = true;
        }
        // A bounded boot does not seed the kernel's discovered-path map.
        // Probe indexed paths lazily, live before cold, and reject corrupt
        // matching files instead of silently resuming with empty fold state.
        const expected = path.basename(relPathFor(id, meta?.protocol, meta?.upstreamOrigin));
        const candidates = this.diskFiles.filter(file => fileNameMatchesId(path.basename(file), id, meta?.protocol, meta?.upstreamOrigin)
            || (!meta?.protocol && path.basename(file).endsWith(`_${expected}`)));
        for (const file of candidates) {
            if (!existsSync(file)) continue;
            const envelope = this.readEnvelopeFile(file, id);
            if (envelope) {
                this.sourceFiles.set(id, file);
                return envelope;
            }
        }
        const alias = this.legacyAliases.get(id);
        if (alias) {
            const envelope = this.readEnvelopeFile(alias.file, alias.id);
            if (envelope && (!meta?.protocol || envelope.payload.meta?.protocol === meta.protocol)) {
                this.sourceFiles.set(id, alias.file);
                return { ...envelope, id, payload: { ...envelope.payload, id } };
            }
        }
        // Writes and the legacy bulk boot also maintain the kernel's compact
        // discovered-path index. Preserve those lookups without bulk loading.
        return this.store.loadSync(id, relPathFor(id, meta?.protocol, meta?.upstreamOrigin));
    }

    /** #3399: cross-route ledger recovery. The conversation id is the identity;
     *  the host prefix in the filename is display metadata derived from the
     *  request's upstream origin (#280/#286 — those mutate mid-conversation).
     *  A provider switch therefore leaves the fold ledger under its OLD route
     *  name while the probes below target only the NEW one — the cold load
     *  returns empty state and the client re-sends the full unfolded history
     *  (refold from scratch, or a local 413 once the core text exceeds the
     *  doomed-probe gate). Collect every same-protocol file whose name carries
     *  this id's sha suffix — the computed exact-route name always (covers
     *  files created after boot, which the walked index lacks), plus the
     *  walked siblings — and pick the winner by fold progress: requests, then
     *  nextBlockId, mirroring staleDiskPayload's clobber guard. Counters
     *  measure how much folded history a copy carries; savedAt only records
     *  who last touched disk and would crown a fresh-but-empty twin, so it is
     *  tie-break material at best. Canonical/spill (.fb.json) pairs reconcile
     *  to their freshest copy first (kernel loadAll convention); corrupt
     *  members still quarantine per #3157; a pool with no surviving member is
     *  a miss and falls through to the legacy probes below. */
    private loadNamespacedPool(id: string, meta: { protocol: string; upstreamOrigin?: string }): PersistedEnvelope<PersistedSession> | null {
        const proto = meta.protocol;
        const dir = path.join(this.sessionsDir, proto);
        const logicalFor = (file: string): string => file.endsWith(".fb.json") ? `${file.slice(0, -".fb.json".length)}.json` : file;
        const candidates = new Set<string>([path.join(dir, path.basename(relPathFor(id, proto, meta.upstreamOrigin)))]);
        const suffix = `_${path.basename(relPathFor(id))}`;
        for (const file of this.diskFiles) {
            const base = path.basename(file);
            if (base.endsWith(".content-store.json")) continue;
            if (path.dirname(file) !== dir || !logicalFor(base).endsWith(suffix)) continue;
            candidates.add(file);
        }
        const valid = new Map<string, { file: string; env: PersistedEnvelope<PersistedSession> }>();
        for (const file of candidates) {
            if (!existsSync(file)) continue;
            const env = this.readEnvelopeFile(file, id);
            if (!env) continue;
            const savedProtocol = env.payload.meta?.protocol ?? env.payload.protocol;
            if (savedProtocol && savedProtocol !== proto) continue;
            const prior = valid.get(logicalFor(file));
            if (!prior || (env.savedAt ?? 0) > (prior.env.savedAt ?? 0)) valid.set(logicalFor(file), { file, env });
        }
        if (valid.size === 0) return null;
        const exact = path.join(this.sessionsDir, relPathFor(id, proto, meta.upstreamOrigin));
        const winner = [...valid.values()].sort((a, b) => {
            const ra = a.env.payload.stats?.requests ?? a.env.payload.requests ?? 0;
            const rb = b.env.payload.stats?.requests ?? b.env.payload.requests ?? 0;
            if (ra !== rb) return rb - ra;
            const na = a.env.payload.state?.nextBlockId ?? 0;
            const nb = b.env.payload.state?.nextBlockId ?? 0;
            if (na !== nb) return nb - na;
            if (a.file === exact) return -1;
            if (b.file === exact) return 1;
            return (b.env.savedAt ?? 0) - (a.env.savedAt ?? 0);
        })[0];
        this.sourceFiles.set(id, winner.file);
        if (winner.file !== exact) {
            this.log("info", `[persist] restored ${id} from another upstream route (${path.basename(winner.file)}; ${winner.env.payload.stats?.requests ?? winner.env.payload.requests ?? 0} requests) under protocol ${proto} (#3399)`);
        }
        return winner.env;
    }

    /** #3399: a cold load that recovered a session from a file NOT on the
     *  requested route must adopt the requesting route's upstream origin —
     *  getSession's fill-if-absent merge cannot override a stale-but-present
     *  origin, and without adoption every subsequent save re-forks under the
     *  old host name (the degraded twin survives, the restored ledger never
     *  converges onto the live route). Adopting makes the next save rewrite
     *  the current-route file with the full content. Only the origin is
     *  adopted: the protocol of a surviving candidate already equals the
     *  request's (pool isolation / alias re-check), and label/title stay put
     *  — they are identity, not route. */
    private adoptRequestedRoute(id: string, session: Session, meta?: { protocol?: string; upstreamOrigin?: string }): void {
        if (!meta?.protocol || !meta.upstreamOrigin) return;
        const src = this.sourceFiles.get(id);
        if (!src || src === path.join(this.sessionsDir, relPathFor(id, meta.protocol, meta.upstreamOrigin))) return;
        if (session.meta.upstreamOrigin === meta.upstreamOrigin) return;
        session.meta.upstreamOrigin = meta.upstreamOrigin;
        this.log("info", `[persist] adopted route ${hostLabel(meta.upstreamOrigin)} for ${id} restored from ${path.basename(src)} (#3399)`);
        this.scheduleSave(session);
    }

    /** Synchronous reload of a single session. Used on a memory miss (after
     *  LRU eviction). Sync fs is acceptable here because a miss is rare and
     *  reads a single small file (~1ms). Returns null if missing/corrupt or the
     *  body id does not match what we asked for. */
    /** #3573: make the lazy-load moment observable. This is where persisted
     *  state re-enters memory after a restart or eviction; logging what it
     *  actually carried turns "the session came back raw" from a post-mortem
     *  guess into a one-line diagnosis. refs>0 with zero blocks is the
     *  incident signature (#3573): identity loaded but every fold missing, so
     *  the full history replays and preflight must rebuild from scratch.
     *  compressions (state.stats.compressionCount) disambiguates that
     *  signature in one grep: >0 proves compression ran in this session's
     *  lifetime, so zero blocks means folds existed and are now missing
     *  (investigate); 0 means the session was likely never folded (raw replay
     *  is its normal shape). (#2734 removed the last writer of the legacy
     *  stats.tokensSaved counter — reading it here logged a dead 0 and broke
     *  exactly this disambiguation, so the diagnostic now reads the kernel's
     *  live counter instead.) The warn stays broad on purpose — a loss mode
     *  that erases stats must not be able to go silent again. */
    private logColdLoad(id: string, source: string, session: Session, savedAt?: number): void {
        const refs = Object.keys(session.state.messageRefs.byRef ?? {}).length;
        const blocks = session.state.blocks.length;
        const active = session.state.blocks.filter((b) => b.active).length;
        const compressions = session.state.stats?.compressionCount ?? 0;
        const ageMin = savedAt ? Math.round(Math.max(0, Date.now() - savedAt) / 60000) : undefined;
        this.log("info", `[persist] cold-loaded ${id} from ${source}: ${refs} ref(s), ${blocks} block(s) (${active} active), baseline ${session.stats.lastInputTokens} tok, compressions ${compressions}${ageMin !== undefined ? `, savedAt ~${ageMin} min ago` : ""}`);
        if (refs > 0 && blocks === 0) {
            this.log("warn", `[persist] ${id} loaded with ${refs} mapped ref(s) but NO persisted blocks (compressions=${compressions}) — the folded history will replay raw and preflight must rebuild from scratch (#3573)`);
        }
    }

    loadSync(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Session | null {
        if (!this.enabled) return null;
        if (this.shadow?.readsUnified) {
            // #3135 ④/#3818: the last sampled verify drifted for this
            // session — the envelope is the fresher/authoritative copy while
            // it exists (writerOff sessions have none and keep serving the
            // index: their envelope IS the index). Serve the file directly
            // and skip organic import (importing a record the digest just
            // proved divergent would re-stamp the watermark as if verified).
            if (this.shadow.driftedSessions.has(id)) {
                const driftedEnvelope = this.loadEnvelope(id, meta);
                if (driftedEnvelope) {
                    // #4323: the latch historically served the envelope
                    // unconditionally on the assumption it was the fresher copy
                    // — true for one-off external churn, FALSE under a
                    // multi-writer ping-pong (#394): the last file write may be
                    // an OLDER generation than the index (measured incident:
                    // envelope 12 active blocks vs index 16 — serving the file
                    // put ~240K folded tokens back into context). Fold progress
                    // is the freshness proxy owner-ruled for this class:
                    // strictly more active blocks wins; a tie or an unreadable
                    // other side keeps the historical envelope preference.
                    const envActive = countActiveBlocks(driftedEnvelope.payload);
                    const idxActive = this.shadow.activeBlockCount(id);
                    if (idxActive !== null && idxActive > envActive) {
                        const unified = this.loadUnified(id);
                        if (unified) {
                            this.log("warn", `[persist] serving ${id} from the UNIFIED store despite the drift latch: legacy envelope holds ${envActive} active block(s), the index holds ${idxActive} — taking the fuller fold coverage instead of the older generation (#4323/#394)`);
                            return this.afterLoad(id, unified);
                        }
                    }
                    const drifted = buildSession(driftedEnvelope.payload);
                    // #4323: "drifted" only proves the two copies DIVERGED —
                    // not which side is ahead. With multiple writers sharing a
                    // sessions directory (the 2026-10-22 incident) the INDEX
                    // can hold the newer generation: serving the stale
                    // envelope resurrected an older fold state whose coverage
                    // no longer matched the canonical rows, the raw history
                    // replayed unfolded (0 compressible ranges) and preflight
                    // dead-ended at a phantom 8.29M tokens. Compare both
                    // sides' mapped-ref counts and serve the richer one; the
                    // envelope keeps winning ties (its bytes are whole-file
                    // atomic, the index's superiority must be visible).
                    const unifiedView = this.loadUnified(id);
                    if (unifiedView) {
                        const envRefs = Object.keys((drifted.state as { messageRefs?: { byRef?: Record<string, unknown> } }).messageRefs?.byRef ?? {}).length;
                        const idxState = unifiedView.state as { messageRefs?: { byRef?: Record<string, unknown> } };
                        const idxRefs = Object.keys(idxState.messageRefs?.byRef ?? {}).length;
                        if (idxRefs > envRefs) {
                            this.log("warn", `[persist] drift on ${id}: unified index carries ${idxRefs} mapped ref(s) vs envelope ${envRefs} — serving the richer index side (multi-writer generation, #4323)`);
                            return this.afterLoad(id, unifiedView);
                        }
                    }
                    if (hasNegativePersistedTokens(driftedEnvelope.payload)) {
                        this.scheduleSave(drifted);
                        this.log("info", `[persist] clamped negative token stats on reload for ${id} (#408)`);
                    }
                    this.log("info", `[persist] serving ${id} from the legacy envelope: last sampled digest drifted (#3135 ④)`);
                    this.logColdLoad(id, "legacy file (drift fallback)", drifted, driftedEnvelope.payload.savedAt);
                    return drifted;
                }
            }
            const unified = this.loadUnified(id);
            if (unified) {
                // #4216/#4370 defensive cold-load sync: the freeze shapes are
                // wider than the orphan fingerprint — a journal-write failure
                // or an async-backend importRecord miss freezes the index with
                // NO retained orphan contents in the view. Probe the envelope
                // once per cold load and let PROGRESS, not shape, decide
                // (requests strictly greater, or equal with a greater fold
                // cursor — the freshness proxy owner-ruled for cross-writer
                // generations, #4323): a strictly-ahead envelope can only be
                // the newer generation, never a rollback; equal/behind keeps
                // the index authoritative. Cold loads are rare (process
                // restart) — the one read+parse buys complete recovery
                // (#3128 availability over performance).
                const envelope = this.loadEnvelope(id, meta);
                if (envelope) {
                    const indexedRequests = Number(unified.stats.requests ?? 0);
                    const envRequests = Number(envelope.payload.stats?.requests ?? 0);
                    const ahead = envRequests > indexedRequests ||
                        (envRequests === indexedRequests && Number(envelope.payload.state?.nextBlockId ?? 0) > unified.state.nextBlockId);
                    if (ahead) {
                        const recovered = buildSession(envelope.payload);
                        this.log("info", `[persist] recovering ${id} from a strictly-ahead envelope on cold load (index requests ${indexedRequests}, envelope ${envRequests}${orphanContents(unified) ? ", orphan-frozen index" : ""})`);
                        return this.afterLoad(id, this.shadow.importRecord(envelope.payload) ?? toLegacyLike(recovered));
                    }
                }
                return this.afterLoad(id, unified);
            }
            // Miss (or sidecar failure): organic import from the legacy file,
            // then serve from the index; fall back to the plain legacy load
            // when even the import cannot run.
            const envelope = this.loadEnvelope(id, meta);
            if (!envelope) return null;
            const imported = this.shadow.importRecord(envelope.payload);
            if (imported) {
                // #3818: serve the freshly PARSED view, not the index rebuild.
                // The full file was already read to import it, so this is both
                // cheaper and LOSSLESS: the index represents blockContents for
                // blocks in state.blocks only — records carrying contents
                // with no block entry (hand-built archives, web seeds) would
                // silently lose them through a viewFor rebuild on first load.
                // Later loads take viewFor and keep whatever the index can
                // represent; the envelope stays the superset on disk.
                return this.afterLoad(id, imported);
            }
            // Legacy fallback — same single-build semantics as plain legacy
            // mode (see the note below on why no adapter round-trip here).
            const session = buildSession(envelope.payload);
            if (hasNegativePersistedTokens(envelope.payload)) {
                this.scheduleSave(session);
                this.log("info", `[persist] clamped negative token stats on reload for ${id} (#408)`);
            }
            this.logColdLoad(id, "legacy file", session, envelope.payload.savedAt);
            this.adoptRequestedRoute(id, session, meta);
            return session;
        }
        const envelope = this.loadEnvelope(id, meta);
        if (!envelope) return null;
        // Legacy path — intentionally the ORIGINAL single buildSession(payload):
        // wrapping this in the toLegacyLike/viewToRecord adapter (like the
        // unified branch above) would run the record through a second
        // normalization round-trip and reshape persisted-state bytes (the
        // storage-render goldens catch exactly that).
        const session = buildSession(envelope.payload);
        if (hasNegativePersistedTokens(envelope.payload)) {
            // #408: sync context — debounce the stale-file rewrite
            // (buildSession already clamped the in-memory value).
            this.scheduleSave(session);
            this.log("info", `[persist] clamped negative token stats on reload for ${id} (#408)`);
        }
        this.logColdLoad(id, "legacy file", session, envelope.payload.savedAt);
        this.adoptRequestedRoute(id, session, meta);
        return session;
    }

    /** Shared post-load fixups for the unified read path: rebuilds the
     *  Session from a store view (viewToRecord → buildSession, the same
     *  forward-compat pass as a legacy load) and applies the #408 clamp
     *  rewrite. */
    private afterLoad(id: string, view: LegacySessionLike): Session {
        const record = viewToRecord(view);
        const session = buildSession(record);
        if (hasNegativePersistedTokens(record)) {
            this.scheduleSave(session);
            this.log("info", `[persist] clamped negative token stats on reload for ${id} (#408)`);
        }
        // #4316 layer 3 PR3/3: align the citation space with the unified
        // ledger exactly once per state, at the ONLY safe moment — cold
        // load. Mid-conversation alignment would shift refs the client has
        // already seen (byte-stability contract, snapshot-render D-suite);
        // a restart boundary has no in-flight compress call, so nothing can
        // observe a half-renumbered map. Post-load arrivals keep minting
        // counter refs (fresh numbers, no collision). Envelope-only loads
        // (no rows) skip honestly.
        this.maybeRestampToLedger(session);
        this.logColdLoad(id, "unified store", session, record.savedAt);
        return session;
    }

    /** #4316 PR3/3: one-time ref/ledger alignment at cold load. Guards:
     *  state already aligned, no ref map, unified store unavailable, or no
     *  rows for this session → no-op. Multi-generation ids (edits) are
     *  excluded by seqByRaw itself — their legacy refs stay put. */
    private maybeRestampToLedger(session: Session): void {
        const state = session.state as (CompressionState & { refLedgerAligned?: boolean });
        if (state.refLedgerAligned === true) return;
        if (!state.messageRefs || Object.keys(state.messageRefs.byRaw).length === 0) return;
        try {
            const seqByRawId = this.unifiedSeqByRaw(session.id);
            if (seqByRawId === null || seqByRawId.size === 0) return;
            const outcome = restampRefsToLedger(state, seqByRawId);
            if (outcome.superseded.size > 0) {
                session.restampSuperseded = outcome.superseded;
            }
            state.refLedgerAligned = true;
            this.log("info", `[persist] ledger-aligned refs for ${session.id}: kept=${outcome.kept} restamped=${outcome.restamped} rehomed=${outcome.rehomed} blocked=${outcome.blocked} superseded=${outcome.superseded.size} (#4316 PR3/3)`);
            this.scheduleSave(session);
        } catch (err) {
            // Alignment is an optimization of the citation space, never a
            // load blocker — a failed stamp leaves the legacy refs intact.
            this.log("warn", `[persist] ref/ledger alignment skipped for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Unified-first view load (full mode). Null on miss. */
    private loadUnified(id: string): LegacySessionLike | null {
        return this.shadow ? this.shadow.viewFor(id) : null;
    }

    /** Read-only state load for cross-session search (#841): unlike loadSync,
     *  never schedules a save (no #408 clamp-rewrite side effect). */
    loadStateForSearch(id: string): CompressionState | null {
        if (!this.enabled) return null;
        if (this.shadow?.readsUnified) {
            const view = this.loadUnified(id);
            if (view) return mergeState(view.state as unknown as Parameters<typeof mergeState>[0]);
        }
        const envelope = this.loadEnvelope(id);
        if (!envelope) return null;
        return mergeState(envelope.payload.state);
    }

    /** Phase 2 (#2671): replica/checkpoint operations. All throw on error —
     *  unlike the shadow mirrors, these are explicit operator actions, and a
     *  half-completed replica must surface, not log-and-degrade. Requires the
     *  unified sidecar (shadow or full mode); legacy mode fails fast with a
     *  clear message so the HTTP layer can 501. */
    /** #2960 ③: unified-first CCR read. Full mode only — under shadow the
     *  index may lag files it has not re-recorded, so the sidecar stays the
     *  read of record there. Never throws: a missing/unreadable row simply
     *  falls back to the file path. */
    unifiedCcrFor(id: string): MessageContentStore | null {
        if (!this.shadow?.readsUnified) return null;
        try {
            return this.shadow.getCcr(id);
        } catch {
            return null;
        }
    }

    /** #3301: stored message decompositions (+ seq±1 neighbors) for
     *  fold-anchor backfill after a wire-shape flip (consumed by
     *  fold-decomposition-lookup → reconcileFoldCoverage.storedMessages).
     *  Full mode only (same gate as the other unified reads); null when
     *  unavailable — callers fall back to wire-side backfill. Never throws. */
    unifiedMessageRows(sessionId: string, msgIds: readonly string[]): { seq: number; msgId: string; content: string }[] | null {
        if (!this.shadow?.readsUnified || msgIds.length === 0) return null;
        try {
            return this.shadow.messagesForIds(sessionId, msgIds, true);
        } catch {
            return null;
        }
    }

    replicasAvailable(): boolean {
        return this.shadow !== undefined && !this.shadow.stats.disabled;
    }

    /** #4316 PR3/3: raw id → canonical seq map for the one-time ledger
     *  re-stamp (single-row ids only — multi-generation ids are excluded by
     *  the store). Null when the unified store is unavailable; the re-stamp
     *  then degrades to legacy refs (honest skip, never a guess). */
    unifiedSeqByRaw(id: string): Map<string, number> | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.seqByRaw(id);
        } catch {
            return null;
        }
    }

    /** #4316 PR3/3: live (non-retired) row count for a session — the fork
     *  endpoint passes count - 1 as the inclusive throughSeq. -1 when the
     *  unified store is unavailable (kernel-only fork). */
    unifiedLiveRowCount(id: string): number {
        if (!this.shadow) return -1;
        try {
            return this.shadow.liveRowCount(id);
        } catch {
            return -1;
        }
    }

    /** #4316 PR3/3: fork adoption row clone (child keeps the parent's seq
     *  values so cloned kernel refs keep pointing at the same ledger
     *  positions). Null when the unified store is unavailable — the fork
     *  endpoint then proceeds exactly as before (kernel-only clone). */
    unifiedCloneSessionRows(parentId: string, childId: string, throughSeq: number): boolean {
        if (!this.shadow) return false;
        try {
            return this.shadow.cloneSessionRows(parentId, childId, throughSeq);
        } catch {
            return false;
        }
    }

    /** #3248: raw canonical history rows (core-form message JSON, seq
     *  order) from the unified messages table. Shadow AND full both qualify —
     *  the shadow sidecar ingests the raw tail on every save (#3007 rawTail +
     *  #3166 watermark), so the table is a faithful canonical log even while
     *  the JSON envelope stays the truth base. Null when the unified store is
     *  unavailable (legacy-only lanes) — callers must not guess. */
    /** #3901/#3463: run the unified-store GC (age-sweep archive + zero-ref
     *  collection + optional vacuum) through the live sidecar. Returns null
     *  when the unified store is unavailable (legacy-only lanes). The
     *  archive dir defaults to <sessions>/archive next to the envelopes. */
    unifiedGc(opts: { archiveAfterDays?: number; vacuum?: "full" | "incremental"; archiveDir?: string } = {}): { archived: number; contentRowsDeleted: number } | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            const days = opts.archiveAfterDays ?? resolveArchiveAfterDays(undefined, fileStorageArchiveAfterDays());
            return this.shadow.gc({ archiveAfterDays: days, archiveDir: opts.archiveDir ?? join(this.sessionsDir, "archive"), vacuum: opts.vacuum });
        } catch (err) {
            this.log("warn", `[persist] unified gc failed: ${String(err)}`);
            return null;
        }
    }

    /** #4175: online consistent snapshot of the unified store (VACUUM INTO,
     *  sqlite only). Default destination lives beside the archive dir so a
     *  backups/ tree grows in one place: sessionsDir/backups/index-<ts>.db. */
    unifiedBackup(dst?: string): { ok: boolean; path?: string; bytes?: number; error?: string } {
        if (!this.shadow || this.shadow.stats.disabled) return { ok: false, error: "unavailable" };
        try {
            const target = dst ?? join(this.sessionsDir, "backups", `index-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
            const bytes = this.shadow.backupInto(target);
            this.log("info", `[persist] unified backup written: ${target} (${bytes} bytes)`);
            return { ok: true, path: target, bytes };
        } catch (err) {
            const error = String(err);
            this.log("warn", `[persist] unified backup failed: ${error}`);
            return { ok: false, error };
        }
    }

    /** #3928: read-only prediction of unifiedGc for `bili storage gc --dry-run`.
     *  Same mode gate as unifiedGc (null on legacy-only); DB-driven by design —
     *  the plan must predict what the real run does, and the real run sees only
     *  index.db. */
    unifiedGcPlan(archiveAfterDays?: number, now?: number): import("./storage/store.js").GcPlan | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            const days = archiveAfterDays ?? resolveArchiveAfterDays(undefined, fileStorageArchiveAfterDays());
            return this.shadow.gcPlan(days, now);
        } catch {
            return null;
        }
    }

    /** #3901/#3463: restore an archived session from its export file. */
    unifiedRestoreArchived(sessionId: string, archiveDir?: string): { ok: boolean; reason?: string } | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.restoreArchived(sessionId, { archiveDir: archiveDir ?? join(this.sessionsDir, "archive") });
        } catch (err) {
            this.log("warn", `[persist] unified restore failed: ${String(err)}`);
            return null;
        }
    }

    /** #3928: archive one session through the live sidecar (`bili sessions
     *  archive`) — same single append-only archive log as the gc age-sweep. */
    unifiedArchiveSession(sessionId: string, archiveDir?: string): { ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number } | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.archiveSession(sessionId, { archiveDir: archiveDir ?? join(this.sessionsDir, "archive") });
        } catch (err) {
            this.log("warn", `[persist] unified archive failed: ${String(err)}`);
            return null;
        }
    }

    /** #3928: per-session index.db footprint for `bili sessions ls`. Null when
     *  the unified store is unavailable (legacy-only lanes) — sizes then
     *  degrade to the JSON-tree view. */
    unifiedSessionStorageStats(sessionId: string): import("./storage/store.js").SessionStorageStats | null {
        if (!this.replicasAvailable()) return null;
        try {
            return this.liveShadow().sessionStorageStats(sessionId);
        } catch {
            return null; // sidecar degraded mid-call: sizes degrade to JSON-only
        }
    }

    /** #3928: physical index.db shrink after deletions (`bili sessions rm`).
     *  Throws on failure — the deletion itself is already committed, callers
     *  report the shrink as partial. Throws in legacy-only lanes — check
     *  replicasAvailable() first. */
    unifiedVacuum(mode: "full" | "incremental" = "full"): void {
        this.liveShadow().vacuum(mode);
    }

    unifiedRawMessages(sessionId: string): { seq: number; content: string }[] | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.rawMessages(sessionId);
        } catch {
            return null; // sidecar degraded mid-call: treat as unavailable
        }
    }

    /** #3756 snapshot render: the logical transcript view's seq pointers
     *  (tail_json.tailSeqs). Null when the unified store is unavailable. */
    unifiedTailSeqs(sessionId: string): number[] | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.tailSeqs(sessionId);
        } catch {
            return null;
        }
    }

    /** #3756 snapshot render: full-identity row view of the unified
     *  transcript (msgId/ref/refNum/contentHash included) in seq order.
     *  Null when the unified store is unavailable — the render lane must
     *  degrade to the legacy path, never guess. */
    unifiedTailViewRows(sessionId: string): import("./storage/store.js").MessageRow[] | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.tailViewRows(sessionId);
        } catch {
            return null; // sidecar degraded mid-call: treat as unavailable
        }
    }

    /** #D5-5 render windowing: identity-only rows (seq + msg_id). Null when
     *  the unified store is unavailable — the render lane degrades, never
     *  guesses. */
    unifiedMessageIdRows(sessionId: string): { seq: number; msgId: string }[] | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.messageIdRows(sessionId);
        } catch {
            return null;
        }
    }

    /** #D5-5 render windowing: content rows outside the covered intervals.
     *  Null when the unified store is unavailable. */
    unifiedUncoveredRows(sessionId: string, intervals: readonly [number, number][]): import("./storage/store.js").MessageRow[] | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        try {
            return this.shadow.uncoveredRows(sessionId, intervals);
        } catch {
            return null;
        }
    }

    /** #4738: message rows restricted to the given raw ids (msg_id) — the
     *  web display fallback for block leaves whose bytes fell out of the
     *  client's live window (native compaction). EVERY stored version of each
     *  id comes back; callers pick the newest (max seq). Null when the
     *  unified store is unavailable or degraded (callers keep the legacy
     *  lastMessages-only behavior); an empty array means "available, nothing
     *  stored" — an honest miss. */
    async unifiedMessageRowsByIds(sessionId: string, rawIds: string[]): Promise<import("./storage/store.js").MessageRow[] | null> {
        if (!this.shadow || this.shadow.stats.disabled || rawIds.length === 0) return null;
        try {
            return await this.shadow.messageRowsByIdsAsync(sessionId, rawIds);
        } catch {
            return null; // sidecar degraded mid-call: treat as unavailable
        }
    }

    /** #2960 R2.1: summary rows for list surfaces (CLI export, web exposure
     *  tick). Full mode only — in shadow the JSON tree is the truth base and
     *  rows may lag files never yet recorded, so list surfaces must walk.
     *  Null when unavailable (legacy/shadow/degraded) — callers fall back to
     *  the legacy file walk. */
    unifiedSessionSummaries(): import("./storage/store.js").SessionSummaryRow[] | null {
        if (!this.shadow?.readsUnified) return null;
        try {
            return this.shadow.sessionSummaries();
        } catch {
            return null; // sidecar degraded mid-call: fall back to the walk
        }
    }

    /** #3199: which authority backs the web list surfaces for THIS store.
     *  "authoritative" (full mode): the rows alone are complete — organic
     *  import on every load/write keeps them whole, so a session whose JSON
     *  file vanished stays listed (R2.1 self-sufficient index). "reconcile"
     *  (shadow mode): the rows are a BASELINE only — the JSON tree is still
     *  the truth base, so callers must reconcile against it (adopt fresh
     *  rows, decode files newer than their row or never recorded, drop ghost
     *  rows whose file vanished). null = legacy/degraded — plain file walk. */
    webSummaryBaseline(): "authoritative" | "reconcile" | null {
        if (!this.shadow || this.shadow.stats.disabled) return null;
        // #3931 step 3 (v1): the web summary surface reads the sync facade —
        // on a network backend those rows are unavailable, and an EMPTY
        // authoritative row set would blank the session list. Ride the disk
        // walk (envelopes are always written there) until the async twin is
        // wired into this surface.
        if (this.shadow.isAsyncBackend) return null;
        return this.shadow.mode === "full" ? "authoritative" : "reconcile";
    }

    /** #2960 R2.2 / #3199: web list rows — stats/metadata JSON + block
     *  aggregates from one SQL. Full mode serves them as the authoritative
     *  answer; shadow mode (#3199) serves them as a BASELINE the caller must
     *  reconcile against the JSON tree (see webSummaryBaseline) — shadow rows
     *  may lag files never yet recorded, and ghost rows must be dropped there.
     *  Null → the web falls back to the bounded disk index walk. */
    unifiedWebSummaries(): import("./storage/store.js").WebSummaryRow[] | null {
        if (this.webSummaryBaseline() === null) return null;
        const shadow = this.shadow;
        if (!shadow) return null;
        try {
            return shadow.webSummaryRows();
        } catch {
            return null; // sidecar degraded mid-call: fall back to the walk
        }
    }

    /** #2960 R2.1: durable identity lookup — (namespace, conversation id) →
     *  sessions row key. Null when unavailable or unclaimed. */
    lookupConversation(namespace: string, conversationId: string): string | null {
        if (!this.replicasAvailable()) return null;
        try {
            return (this.shadow as UnifiedShadow).lookupConversation(namespace, conversationId);
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Extension namespaces (#3069 v4). Available in shadow AND full (like
    // checkpoints); legacy-only instances fail fast with the same 501-able
    // message the replica routes use. These are HOST/PLUGIN/UI state — the
    // kernel session state stays in kstate_json and never flows here.
    // ------------------------------------------------------------------

    setSessionExt(sessionId: string, key: string, value: unknown): void {
        this.liveShadow().setSessionExt(sessionId, key, value);
    }

    getSessionExt(sessionId: string, key: string): unknown {
        return this.liveShadow().getSessionExt(sessionId, key);
    }

    listSessionExt(sessionId: string): { key: string; value: unknown; updatedAt: number }[] {
        return this.liveShadow().listSessionExt(sessionId);
    }

    deleteSessionExt(sessionId: string, key?: string): number {
        return this.liveShadow().deleteSessionExt(sessionId, key);
    }

    setKv(namespace: string, key: string, value: unknown): void {
        this.liveShadow().setKv(namespace, key, value);
    }

    getKv(namespace: string, key: string): unknown {
        return this.liveShadow().getKv(namespace, key);
    }

    listKv(namespace?: string, keyPrefix?: string): { namespace: string; key: string; value: unknown; updatedAt: number }[] {
        return this.liveShadow().listKv(namespace, keyPrefix);
    }

    deleteKv(namespace: string, key?: string): number {
        return this.liveShadow().deleteKv(namespace, key);
    }
    private liveShadow(): UnifiedShadow {
        if (!this.replicasAvailable()) throw new Error("[storage] replicas require the unified store (storage.unified=shadow|full or BILI_STORAGE_UNIFIED); this instance runs legacy-only");
        return this.shadow as UnifiedShadow;
    }

    /** Freezes the session's CURRENT persisted state as a checkpoint. Callers
     *  holding a resident (in-memory) session must saveNow() it first — this
     *  snapshots exactly what the unified index last ingested. */
    /** #2960 ②: fork↔replica convergence (write half). The moment a
     *  session's raw snapshot becomes an external contract — a fork receipt
     *  on this session (child) or a retained-parent flag — the unified store
     *  cuts a PINNED fork_base checkpoint holding the exact record the
     *  envelope persists (pluginSnapshot + forkContentStore included). The
     *  pinned row survives session deletion (deleteSession sweeps only
     *  unpinned checkpoints), so the fork substrate can be resurrected via
     *  restoreReplica even after the session row and envelope are gone —
     *  the substrate Phase 3 needs to stop writing the envelope blobs. */
    private maybeCutForkBase(session: Session): void {
        void this.maybeCutForkBaseAsync(session);
    }

    /** #3931 step 3: the async twin body — sqlite resolves through the same
     *  sync calls (identical behavior, one promise hop); mysql rides the
     *  backend queue. Fire-and-forget from the save paths. */
    private async maybeCutForkBaseAsync(session: Session): Promise<void> {
        if (!this.shadow || this.shadow.stats.disabled) return;
        const retained = session.metadata.publicForkReceipt !== undefined
            || session.metadata.publicSnapshotRetained === true;
        if (!retained || !Array.isArray(session.pluginSnapshot) || session.pluginSnapshot.length === 0) return;
        if (this.forkBaseCut.has(session.id)) return;
        try {
            if ((await this.shadow.listCheckpointsAsync(session.id)).some((cp) => cp.kind === "fork_base")) {
                this.forkBaseCut.add(session.id);
                return;
            }
            const record = buildRecord(session);
            const activeBlockIds = session.state.blocks
                .filter((b) => (b as { active?: boolean }).active !== false)
                .map((b) => b.blockId)
                .sort();
            await this.shadow.insertCheckpointAsync({
                cpId: `cp-${randomUUID()}`,
                sessionId: session.id,
                seqAt: session.pluginSnapshot!.length,
                blockSetHash: sha256Hex(JSON.stringify(activeBlockIds)),
                kind: "fork_base",
                label: `fork-base ${session.id}`,
                pinned: true,
                createdAt: Date.now(),
                stateJson: JSON.stringify(record),
            });
            this.forkBaseCut.add(session.id);
        } catch (err) {
            this.log("warn", `[storage] fork_base checkpoint cut failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async createReplica(sessionId: string, opts: { label?: string; pinned?: boolean; kind?: "auto" | "manual" | "replica" | "fork_base" } = {}): Promise<CheckpointRow> {
        const shadow = this.liveShadow();
        const view = await shadow.viewForAsync(sessionId);
        if (!view) throw new Error(`[storage] session ${sessionId} is not in the unified index (unknown, or never persisted under this mode)`);
        const record = viewToRecord(view);
        // CCR originals must survive the rollback the replica exists for:
        // the live content-store sidecar (not just what the unified index
        // captured) is the authoritative envelope — stamp it into the frozen
        // record (#2690 review blocking 6: "restore without the content-store
        // envelope → CCR cannot fetch originals").
        const ccr = this.contentStoreById(sessionId, view.meta as { protocol?: string; upstreamOrigin?: string } | undefined);
        if (ccr) record.forkContentStore = ccr;
        const cpId = `cp-${randomUUID()}`;
        const activeBlockIds = view.state.blocks
            .filter((b) => (b as { active?: boolean }).active !== false)
            .map((b) => b.blockId)
            .sort();
        await shadow.insertCheckpointAsync({
            cpId,
            sessionId,
            seqAt: await this.shadow!.sessionTipSeqAsync(sessionId),
            blockSetHash: sha256Hex(JSON.stringify(activeBlockIds)),
            kind: opts.kind ?? "replica",
            label: opts.label ?? null,
            pinned: opts.pinned === true,
            createdAt: Date.now(),
            stateJson: JSON.stringify(record),
        });
        const row = await shadow.getCheckpointAsync(cpId);
        if (!row) throw new Error(`[storage] checkpoint ${cpId} missing right after insert (index inconsistency)`);
        return row;
    }

    async listReplicas(sessionId?: string): Promise<CheckpointRow[]> {
        await this.ready();
        return this.liveShadow().listCheckpointsAsync(sessionId);
    }

    /** Blob size of one checkpoint's frozen record (for detail views). */
    async replicaByteLen(cpId: string): Promise<number> {
        return (await this.liveShadow().checkpointStateAsync(cpId)).byteLen;
    }

    /** Materializes a checkpoint as a NEW session (the original is never
     *  touched). The frozen record is written through the normal dual path —
     *  legacy JSON file + unified ingest — so the restored session is a
     *  first-class citizen from the first read. */
    async restoreReplica(cpId: string, opts: { sessionId?: string } = {}): Promise<{ sessionId: string; restoredFrom: string; seqAt: number }> {
        const shadow = this.liveShadow();
        const cp = await shadow.getCheckpointAsync(cpId);
        if (!cp) throw new Error(`[storage] checkpoint not found: ${cpId}`);
        const { stateJson } = await shadow.checkpointStateAsync(cpId);
        const record = JSON.parse(stateJson) as PersistedSession;
        const newId = opts.sessionId ?? `restore-${randomUUID().slice(0, 8)}`;
        // A caller-chosen id must never silently overwrite a live session —
        // refuse loudly so the HTTP layer can 409 (#2690 review blocking 6).
        if (opts.sessionId !== undefined && this.loadEnvelope(newId) !== null) {
            throw new Error(`[storage] session ${newId} already exists — restore to a fresh id or delete the existing session first`);
        }
        record.id = newId;
        record.savedAt = Date.now();
        record.meta = { ...record.meta, restoredFrom: cp.session_id, restoredCheckpoint: cp.cp_id } as PersistedSession["meta"];
        await this.store.writeNow(newId, () => record);
        shadow.record(record);
        // #3049: the replica record was ingested from the checkpoint payload
        // — the ownership token must mirror exactly those counters.
        this.ownCommit.set(newId, {
            requests: record.stats?.requests ?? record.requests ?? 0,
            nextBlockId: record.state?.nextBlockId ?? 0,
            builtAtMs: Date.now(),
        });
        // Materialize the content-store sidecar for the restored id too:
        // buildRecord drops forkContentStore on the next live save (no fork
        // receipt), so the record alone is not durable — the sidecar is what
        // survives every later save/restart cycle.
        if (record.forkContentStore) {
            this.writeContentStoreSidecar(newId, record.meta as { protocol?: string; upstreamOrigin?: string } | undefined, record.forkContentStore);
        }
        return { sessionId: newId, restoredFrom: cp.session_id, seqAt: cp.seq_at };
    }

    /** Drops a checkpoint. Explicit operator action overrides `pinned` —
     *  pinning protects against GC, not against deletion. */
    async deleteReplica(cpId: string): Promise<boolean> {
        return this.liveShadow().deleteCheckpointAsync(cpId);
    }

    /** #1937: sessions directory this store resolves against (the web summary
     *  index walks it; tests swap BILI_SESSIONS_DIR between runs, so the value
     *  must come from THIS instance, not a fresh env read). */
    get dir(): string {
        return this.sessionsDir;
    }

    /** #1937: decode ONE session file by PATH into a full Session for the web
     *  detail view (lazy single-file load — no full-directory scan). Returns
     *  null when absent/undecodable/invalid, or when the body id does not
     *  match `expectId` (renamed-file race; mirrors kernel loadSync's
     *  envelope.id === id guard). Read-only: no #408 clamp-rewrite side
     *  effect, like loadStateForSearch. */
    async loadSessionFromFile(file: string, expectId?: string): Promise<Session | null> {
        const parsed = await this.readRawFile(file);
        if (!parsed || typeof parsed !== "object") return null;
        const p = parsed as Record<string, unknown>;
        const rec = p.payload && typeof p.payload === "object" ? p.payload : parsed;
        if (!isValidRecord(rec)) return null;
        if (expectId !== undefined && rec.id !== expectId) return null;
        return buildSession(rec);
    }

    /** #1082 GC: read+decode a single session file by PATH (not session id),
     *  returning the parsed record (envelope or legacy flat) or null when the
     *  file is missing, undecodable, or not JSON. The codec-aware twin of the
     *  kernel store's id-keyed loaders: the GC walks the directory itself
     *  (mtime pre-filter) and only decodes age-eligible candidates. */
    /** #2803: readRawFile plus the DECODED text length — the boot warm-set
     *  budget counts decoded bytes (a RAM proxy), not compressed on-disk size. */
    private async readRawFileWithBytes(file: string): Promise<{ value: unknown; bytes: number } | null> {
        try {
            const raw = await readFile(file);
            // Format-agnostic (GC #1082 review): try plain JSON first, then any
            // codec framing (BILIENC1 encryption, plus opt-in zstd body per
            // #1083). Enumerating magic bytes here would re-create the cross-PR
            // drift this method exists to avoid — every new on-disk frame would
            // silently no-op the sweep. Framed files fail the utf8 parse on
            // the magic prefix, so the fallback order is exact.
            try {
                return { value: JSON.parse(raw.toString("utf8")), bytes: raw.byteLength };
            } catch {
                const text = this.readCodec.decode(raw);
                return { value: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8") };
            }
        } catch {
            return null;
        }
    }

    async readRawFile(file: string): Promise<unknown | null> {
        const parsed = await this.readRawFileWithBytes(file);
        return parsed?.value ?? null;
    }

    /** #3928: decoded byte size of one session file for `bili sessions ls` —
     *  the #2803 idiom (post-decode length, not compressed on-disk size).
     *  Null when the file is missing or undecodable. */
    async decodedBytesOf(file: string): Promise<number | null> {
        const parsed = await this.readRawFileWithBytes(file);
        return parsed === null ? null : parsed.bytes;
    }

    /** #405 fix #4: dual-instance rollback guard. When two proxy processes
     *  share BILI_SESSIONS_DIR, whoever saves last used to win — an instance
     *  holding a STALE in-memory copy would roll counters back (requests:3 →
     *  2). Both signals below are monotonic per session id, so either being
     *  strictly smaller proves staleness. Returns the fresher-on-disk payload
     *  when the incoming record is stale, else null.
     *
     *  #3049: the guard used to re-read and re-parse the ENTIRE envelope on
     *  every save just to compare these two numbers (~320ms and a full file
     *  read per turn on >40MiB sessions). ownershipFastPath proves — without
     *  reading the file — that no other writer has committed since OUR last
     *  build, in which case the disk record is exactly the one this builder
     *  chain last wrote (or converged to), and the in-process comparison
     *  below (monotonic counters, same session object) is sufficient. */
    private staleDiskPayload(incoming: PersistedSession): PersistedSession | null {
        if (this.ownershipFastPath(incoming)) return null;
        this.staleGuardFullReads++;
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

    /** #3049/#3406 ownership fast path — proves "the disk envelope is still
     *  the record this process last committed" with three cheap signals, no
     *  payload read:
     *
     *  1. Unified row counters equal OUR last commit's counters. Every
     *     shadow/full instance sharing the directory shares index.db (#394
     *     multi-process topology), and each commit ingests before it writes
     *     the file — so a sibling's newer commit bumps the row first and this
     *     comparison fails, falling back to the exact full read.
     *  2. #3406: the token carries the stat of a write that actually LANDED
     *     ("written", stamped after the awaited write resolves — see
     *     stampOwnWrite — including host-debounced saves, whose debounce is
     *     host-owned precisely so their landing goes through the stamped
     *     writeNow path), and the envelope file still matches it BYTE-FOR-
     *     BYTE: same size, mtime not newer beyond sub-ms clock skew. Any
     *     difference means a writer that does NOT share the index (legacy-
     *     mode sibling, manual edit) touched the file after our last write,
     *     so the full read decides. An unstamped token (restore-replica seed,
     *     crash before stamping) is unproven and never takes this path — the
     *     old #3286 grace window (builtAtMs + 1.5s) mis-classified exactly
     *     those foreign writes as ours when they landed inside the window
     *     (#3406 item 2).
     *  3. The incoming counters are not behind our own commit — they cannot
     *     be, in-process (same session object, monotonic counters), but the
     *     check keeps this path self-contained; any surprise defers to the
     *     full read.
     *
     *  Residual: a foreign write landing in the microsecond gap between our
     *  awaited write resolving and the stamp's statSync can be adopted as
     *  "ours" for one cycle — vs the 1.5s window it replaces. A foreign
     *  write byte-identical to ours changes nothing observable. Crash safety
     *  is clean: a process that dies between its DB ingest and its file write
     *  leaves no stamped token here (fresh map), so the next boot always
     *  takes the full read. */
    private ownershipFastPath(incoming: PersistedSession): boolean {
        const own = this.ownCommit.get(incoming.id);
        if (!own) return false;
        const shadow = this.shadow;
        if (!shadow || shadow.stats.disabled) return false; // shadow/full only — legacy stays exact
        const incRequests = incoming.stats?.requests ?? incoming.requests ?? 0;
        const incBlocks = incoming.state?.nextBlockId ?? 0;
        if (incRequests < own.requests || incBlocks < own.nextBlockId) return false;
        let row: { requests: number; nextBlockId: number } | null = null;
        try {
            row = shadow.sessionCounters(incoming.id);
        } catch {
            return false; // sidecar hiccup — full read decides
        }
        if (!row || row.requests !== own.requests || row.nextBlockId !== own.nextBlockId) return false;
        const stat = this.statEnvelope(incoming.id, incoming.meta);
        if (!stat) return false;
        if (!own.written) return false; // unproven token (see stampOwnWrite) — full read decides
        if (stat.size !== own.written.size) return false; // any byte-count change is a foreign write (bigger OR smaller)
        if (stat.mtimeMs > own.written.mtimeMs + OWN_WRITE_STAMP_EPSILON_MS) return false;
        return true;
    }

    /** #3049: stat the envelope the way loadEnvelope would resolve it — the
     *  kernel-discovered source file first, then the canonical live paths.
     * Null when no file exists yet (first save: the full read correctly
     * returns null-fast via loadEnvelope's miss). */
    private statEnvelope(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): { size: number; mtimeMs: number } | null {
        const candidates: string[] = [];
        const known = this.sourceFiles.get(id);
        if (known) candidates.push(known);
        candidates.push(
            path.join(this.sessionsDir, relPathFor(id, meta?.protocol, meta?.upstreamOrigin)),
            path.join(this.sessionsDir, relPathFor(id)),
            path.join(this.sessionsDir, flatFileNameFor(id)),
        );
        for (const file of candidates) {
            try {
                const st = statSync(file);
                return { size: st.size, mtimeMs: st.mtimeMs };
            } catch {
                // try next
            }
        }
        return null;
    }

    /** #3818: decoded-size proxy for budget arbitration of index-only
     *  sessions — the serialized record the JSON writer would emit, which
     *  is what readRawFileWithBytes measures for file-backed candidates
     *  (#2803: the budget is a RAM proxy, not a disk one). */
    private estimateDecodedBytes(session: Session): number {
        try {
            return JSON.stringify(this.guardedBuild(session)()).length;
        } catch {
            return Number.MAX_SAFE_INTEGER;
        }
    }

    private guardedBuild(session: Session): () => PersistedSession {
        // #2671: capture the storage-mode stamp EAGERLY, at enqueue time —
        // the kernel write chain may invoke the builder on a later tick than
        // the caller (serialized chains, #2674), and the stamp must describe
        // the mode under which the caller asked to persist, not whatever the
        // env says when a background chain happens to reach the build.
        // #3135 ③/#3818: "the mode under which the caller asked to persist"
        // is the INSTANCE's live stamp, not the raw knob — once full is the
        // default, a dead/absent sidecar (engine missing, 3-strike disable,
        // mkdir'd index.db path) means the record will only ever exist on
        // the JSON envelope, and the stamp must say legacy for that copy.
        const stamp = this.liveStorageStamp;
        return () => {
            const record = buildRecord(session, stamp);
            const disk = this.staleDiskPayload(record);
            if (disk === null) {
                // #3301: external-converter import payload rides exactly ONE
                // save into the unified index (first-open imports take the
                // importRecord path), then is consumed so steady saves keep
                // the delta fast path (#3133) instead of paying full
                // re-ingests forever. buildRecord omits it, so the disk file
                // never carries it.
                const payload = session.decompositionLog;
                if (payload !== undefined) session.decompositionLog = undefined;
                // #2960 ⑤: the table holds the RAW tail (full fidelity); the
                // envelope keeps its bounded folded view for legacy readers.
                // ②a caveat: once foldResidentTail has folded the resident
                // tail (lastMessagesFolded), the in-memory copy is a bounded
                // RE-RENDER, not the live raw log — claiming rawness here
                // would let the equal-length watermark delta skip the
                // tail-pointer rebuild while the re-render reorders the
                // summary (first-render yields to the leading user message,
                // #2755), and the sampled digest would rightly flag drift.
                // The raw rows stay interned from the saves that saw them;
                // folded saves present the envelope render (no override),
                // which the delta path already routes to the full ingest.
                const tail = session.lastMessagesFolded !== true ? session.lastMessages : undefined;
                this.shadow?.record(payload !== undefined ? { ...record, decompositionLog: payload } : record,
                    tail && tail.length > 0
                        ? { lastMessages: tail, lastMessagesFolded: session.lastMessagesFolded }
                        : undefined, session.contentStore ?? undefined);
                this.noteOwnCommit(session.id, record);
                return record;
            }
            const now = Date.now();
            const last = this.staleWarnAt.get(record.id) ?? 0;
            if (now - last >= STALE_WARN_THROTTLE_MS) {
                this.staleWarnAt.set(record.id, now);
                this.log(
                    "warn",
                    `[persist] rejected stale snapshot for session ${record.id}: in-memory copy is older than the on-disk one (another bili instance holds newer state) — keeping disk state and converging in-memory state to it, so subsequent requests serve the fuller fold coverage instead of the stale view (#405/#2401)`,
                );
            }
            // #2401: the guard proved the disk record is strictly newer — but
            // only protecting DISK left this resident serving forever-stale
            // fold state (missing blocks' covered content re-entered the wire
            // unfolded and got re-billed until restart). Apply the disk record
            // to the live session so serving converges on the same newest-wins
            // arbitration the write side just used.
            this.convergeToDisk(session, disk);
            this.shadow?.record(disk);
            // Rewrite the disk's own payload: content-identical no-op that
            // preserves the newer state while satisfying the write chain.
            this.noteOwnCommit(session.id, disk);
            return disk;
        };
    }

    /** #3049: record what THIS builder chain just committed (the record it
     *  returned — our fresh build, or the disk payload the guard made us
     *  adopt). The unified row was ingested from the same payload in the same
     *  closure, so token counters === row counters until any other writer
     *  commits. Called from inside the guardedBuild closure only.
     *  #3406: the LANDED-write stamp ("written") and the record's identity
     *  meta are carried across rebuilds — envelope-writing lanes re-stamp
     *  after their write lands (stampOwnWrite), and writerOff/index-only
     *  saves never touch the file, so the previous stamp stays valid. */
    private noteOwnCommit(id: string, committed: PersistedSession): void {
        const prev = this.ownCommit.get(id);
        this.ownCommit.set(id, {
            requests: committed.stats?.requests ?? committed.requests ?? 0,
            nextBlockId: committed.state?.nextBlockId ?? 0,
            builtAtMs: Date.now(),
            written: prev?.written,
            meta: committed.meta
                ? { protocol: committed.meta.protocol, upstreamOrigin: committed.meta.upstreamOrigin }
                : prev?.meta,
        });
        try {
            this.sessionCommitListener?.(id);
        } catch {
            // observability hook — a failure must never break the save chain
        }
    }

    /** #3406: stamp the envelope's post-write stat into the ownership token —
     *  the proof that OUR bytes are the ones on disk right now, replacing the
     *  #3286 build-time grace window. Called ONLY after a write has LANDED —
     *  the explicit writeNow resolved, the host-debounced save fired through
     *  writeNow, or flushSync reported ok. A missing file (null stat) or a
     *  write failure leaves the token unstamped, which ownershipFastPath
     *  treats as unproven → full read. */
    private stampOwnWrite(id: string): void {
        const token = this.ownCommit.get(id);
        if (!token) return;
        const stat = this.statEnvelope(id, token.meta);
        if (!stat) return;
        token.written = stat;
    }

    /** #2401: read-side convergence. Replace the live session's persisted
     *  surfaces with the newer disk record, in place (the object identity is
     *  load-bearing — request handlers and the pool map hold references to
     *  THIS object). The client/agent re-sends full history on the next
     *  request in BOTH compression modes, so any in-turn progress made on the
     *  losing lineage is re-derived from the resend; worst case costs one
     *  extra compression round-trip. Deliberately NOT copied: contentStore
     *  (separate-file lifecycle — degrades to retrieve misses, never crashes),
     *  runtime-only fields (inFlight, pendingRetrievals handled below,
     *  restored, lockChain), and metadata (kept local; re-stamped per request
     *  where it matters). */
    private convergeToDisk(session: Session, disk: PersistedSession): void {
        const fresh = buildSession(disk);
        const droppedRetrievals = session.pendingRetrievals.length;
        session.state = fresh.state;
        session.blockContents = fresh.blockContents;
        session.stats = fresh.stats;
        // #2960 ⑤: a tailless disk record never clears the in-memory tail —
        // the envelope tail is a bounded snapshot of THIS session's live tail
        // (or was skipped by a full-mode writer), so the in-memory copy is
        // never older than what the disk copy carries.
        session.lastMessages = fresh.lastMessages ?? session.lastMessages;
        session.lastMessagesFolded = fresh.lastMessages !== undefined ? fresh.lastMessagesFolded : session.lastMessagesFolded;
        session.pluginSnapshot = fresh.pluginSnapshot;
        session.decompositionLog = fresh.decompositionLog ?? session.decompositionLog;
        session.lastSeen = fresh.lastSeen;
        if (!session.meta.protocol && fresh.meta.protocol) session.meta.protocol = fresh.meta.protocol;
        if (!session.meta.upstreamOrigin && fresh.meta.upstreamOrigin) session.meta.upstreamOrigin = fresh.meta.upstreamOrigin;
        if (!session.meta.label && fresh.meta.label) session.meta.label = fresh.meta.label;
        // Queued injections reference refs of the replaced lineage — drop them
        // the way a full rebase does (#1343 rationale) instead of misattributing
        // the expected loss as a proxy-restart drop later.
        session.pendingRetrievals.length = 0;
        delete session.metadata.ccrUndelivered;
        delete session.metadata.ccrDropNotes;
        if (droppedRetrievals > 0) {
            this.log("warn", `[persist] ${session.id}: dropped ${droppedRetrievals} queued retrieval(s) during state convergence to the newer disk record (#2401)`);
        }
        markDirty(session);
    }

    /** Schedule a debounced write for a session. Multiple calls within the
     *  window coalesce; the record is built at WRITE time, so the freshest
     *  session state is persisted. Safe to call on the hot path. No-op if
     *  disabled.
     *  #3406: the debounce is host-owned (saveTimers/saveBuilders) — timer
     *  semantics mirror the kernel store's (first call arms, later calls swap
     *  the builder only, unref'd) — but the firing write lands through
     *  store.writeNow AND gets stamped (stampOwnWrite), which the kernel's
     *  internal debounce could not do: every per-turn save then proved its
     *  bytes on disk and the ownership fast path stayed live. */
    scheduleSave(session: Session): void {
        if (!this.saveContentStore(session)) return;
        if (this.writerOffActive() || this.envelopeFrozen(session.id)) {
            // Phase 3 (#2960): index-only persistence — the builder closure
            // runs the sidecar ingest (raw tail + live CCR) and the stale-disk
            // guard; no envelope write is armed, so no debounce is needed.
            // #3133: coalesce same-tick markDirty storms into ONE build — the
            // builder reads session state at run time, so the batched run
            // persists the freshest view (nothing between now and the
            // microtask can be lost: it re-arms through this same path).
            if (this.writerOffPending.has(session.id)) return;
            const run = (): void => {
                this.writerOffPending.delete(session.id);
                try {
                    this.guardedBuild(session)();
                    this.maybeCutForkBase(session);
                    // #3135 ①/#3818: the 3-strike may have fired INSIDE that
                    // build (shadow.record's catch disables the sidecar after
                    // consecutive failures). writerOffActive() turns false for
                    // the NEXT save — but this very session currently exists
                    // on NEITHER copy (index got no rows, envelope was never
                    // armed). Land one synchronous JSON write NOW via the
                    // kernel store so the disabling tick always closes with
                    // the data on the durable file copy.
                    if (this.shadow && this.shadow.stats.disabled) {
                        this.log("warn", `[persist] unified sidecar disabled mid-build for ${session.id} — landing an immediate JSON envelope write (#3135 ①)`);
                        const build = this.guardedBuild(session);
                        void this.store.writeNow(session.id, build).then(() => this.stampOwnWrite(session.id)).catch(() => {
                            // Errors surface through the kernel write chain's own logging.
                        });
                    }
                    // #3818 writerOff safety valve REMOVED (#4216/#4242):
                    // the orphan/reap shape is now representable — its
                    // contents ride sessions.orphans_json in the same
                    // transaction as everything else, so writerOff's contract
                    // ("the index can represent everything I write") holds
                    // without a JSON-envelope escape hatch.
                } catch (err) {
                    // Kernel-store never-throw save discipline: an uncaughtException
                    // escaping this microtask is fatal in embedded/plugin hosts
                    // without process-level handlers; the next markDirty retries.
                    this.log("error", `[persist] writerOff coalesced build failed for ${session.id}: ${String(err)}`);
                }
            };
            this.writerOffPending.set(session.id, run);
            queueMicrotask(() => {
                if (this.writerOffPending.get(session.id) === run) run();
            });
            return;
        }
        if (!this.enabled) return;
        const id = session.id;
        this.saveBuilders.set(id, this.guardedBuild(session));
        const existing = this.saveTimers.get(id);
        if (existing) return;
        const timer = setTimeout(() => {
            this.saveTimers.delete(id);
            const build = this.saveBuilders.get(id);
            this.saveBuilders.delete(id);
            if (!build) return;
            // Errors are logged inside the kernel write chain; swallowing here
            // keeps a failed timer write from becoming an unhandledRejection.
            void this.store.writeNow(id, build).then(() => {
                this.stampOwnWrite(id); // #3406: the write LANDED — prove our bytes are on disk
            }).catch(() => {});
        }, this.debounceMs);
        timer.unref?.();
        this.saveTimers.set(id, timer);
    }

    /** Asynchronously persist a session right now (skips the debounce). Throws
     *  on write failure so callers can react (e.g. avoid evicting).
     *
     *  #3406 item 5 — concurrent writeNow on ONE session cannot lose updates,
     *  by construction (verified by tests/issue3406-writenow-concurrent.test.ts):
     *  the kernel store serializes per-id writeNow through its writeChains
     *  (kernel/src/persist/store.ts), and the guardedBuild closure defers
     *  buildRecord(session) to CHAIN-RUN time against the LIVE session — so
     *  each queued write persists the state as of its own turn, never a
     *  snapshot captured at enqueue time. The later writer therefore always
     *  commits a snapshot at least as fresh as anything before it; a mutation
     *  landing between two concurrent calls shows up in BOTH commits. The
     *  writerOff branch below is fully synchronous (no await between the
     *  check and the build), so concurrent callers there cannot interleave
     *  either. Do NOT regress this by eager-snapshotting the record here. */
    async writeNow(session: Session): Promise<void> {
        if (!this.saveContentStore(session)) throw new Error(`Originals were not saved for ${session.id}`);
        if (this.writerOffActive() || this.envelopeFrozen(session.id)) {
            // #3133: drop the armed microtask (token mismatch below) — this
            // sync build subsumes it; later mutations re-arm on their own.
            this.writerOffPending.delete(session.id);
            this.guardedBuild(session)();
            this.maybeCutForkBase(session);
            this.foldResidentTail(session);
            this.dropResidentBlockContents(session);
            this.dropResidentMetadata(session);
            return;
        }
        await this.store.writeNow(session.id, this.guardedBuild(session));
        this.stampOwnWrite(session.id); // #3406: the write LANDED — prove our bytes are on disk
        this.maybeCutForkBase(session);
        this.foldResidentTail(session);
        this.dropResidentBlockContents(session);
        this.dropResidentMetadata(session);
    }

    /** #3050 R3 ②a: once a save has captured the raw tail (envelope + the
     *  unified messages table via the ⑤ rawTail override), an idle session
     *  keeps only the bounded folded view resident — the exact shape a
     *  restart restores (buildSession stamps lastMessagesFolded). Mid-turn
     *  saves (inFlight > 0) keep the raw tail: the live turn may still read
     *  it, and snapshotMessages re-arms the raw copy on the next request. */
    private foldResidentTail(session: Session): void {
        if (session.inFlight > 0) return;
        const raw = session.lastMessages;
        if (!raw || raw.length === 0) return;
        session.lastMessages = boundedFoldedSnapshot(session);
        session.lastMessagesFolded = true;
    }

    /** #3050 R3 ②c: after a successful save, an idle session's metadata
     *  record (fold anchors, cache ledger, lineage — the reconciliation
     *  bookkeeping that dominates long sessions) folds to a transparent
     *  lazy proxy; any access re-materializes the persisted shape (the
     *  exact record a restart would restore). Same refusal semantics as
     *  ②b: an unrecoverable drop throws instead of going empty. */
    private dropResidentMetadata(session: Session): void {
        if (session.inFlight > 0 || !this.enabled) return;
        if (isDroppedMetadata(session.metadata)) return;
        if (Object.keys(session.metadata).length === 0) return;
        // Hand-built sessions (tests, seeds) may carry no meta — the lazy
        // loader degrades to the id-only lookup, same as a protocol-less file.
        const meta = session.meta ?? undefined;
        session.metadata = lazyMetadata(session.id, { protocol: meta?.protocol, upstreamOrigin: meta?.upstreamOrigin }, (id, m) => {
            const loaded = this.loadSync(id, m);
            return loaded ? loaded.metadata : null;
        });
    }

    /** #3050 R3 ②b: after a successful save, an idle session's block
     *  contents fold away too — the envelope (or the unified index) is the
     *  authoritative copy, and the next touch re-materializes through the
     *  store-bound loader (one disk read per burst). Mid-turn saves keep the
     *  resident set; sessions that never persisted keep their plain map. */
    private dropResidentBlockContents(session: Session): void {
        if (session.inFlight > 0 || !this.enabled) return;
        const existing = session.blockContents;
        if (existing instanceof LazyBlockContents) {
            existing.drop();
            return;
        }
        if (existing.size === 0) return;
        const lazy = new LazyBlockContents(session.id, { protocol: session.meta.protocol, upstreamOrigin: session.meta.upstreamOrigin }, (id, meta) => {
            const loaded = this.loadSync(id, meta);
            return loaded ? Object.fromEntries(loaded.blockContents) : null;
        });
        lazy.drop();
        session.blockContents = lazy;
    }

    /** Synchronous flush for a single session. Used on memory eviction so a
     *  dirty evicted session is not lost. Sync because eviction runs in the
     *  sync getSession path; a single small write is acceptable.
     *  Returns true on success, false on failure (caller must NOT evict on
     *  failure for a never-persisted session or it is lost permanently). */
    flushSync(session: Session): boolean {
        if (!this.saveContentStore(session)) return false;
        if (this.writerOffActive() || this.envelopeFrozen(session.id)) {
            // #3133: same subsume rule as writeNow.
            this.writerOffPending.delete(session.id);
            try {
                this.guardedBuild(session)();
            } catch (err) {
                // Same never-throw flush contract as the kernel-store branch
                // below: evictOldest (src/session.ts) calls this without an
                // error boundary and relies on false to keep the session
                // resident — a throw would escape the sync eviction path.
                this.log("error", `[persist] writerOff flushSync build failed for ${session.id}: ${String(err)}`);
                return false;
            }
            this.maybeCutForkBase(session);
            this.foldResidentTail(session);
            this.dropResidentBlockContents(session);
            this.dropResidentMetadata(session);
            return true;
        }
        // Mirror the kernel flushSync contract: a sync commit supersedes any
        // armed debounce for this id (its builder would just re-write the
        // fresher state moments later — redundant IO racing this fence).
        const armed = this.saveTimers.get(session.id);
        if (armed) {
            clearTimeout(armed);
            this.saveTimers.delete(session.id);
            this.saveBuilders.delete(session.id);
        }
        const ok = this.store.flushSync(session.id, this.guardedBuild(session));
        if (ok) {
            this.stampOwnWrite(session.id); // #3406: the write LANDED — prove our bytes are on disk
            this.maybeCutForkBase(session);
            this.foldResidentTail(session);
            this.dropResidentBlockContents(session);
            this.dropResidentMetadata(session);
        }
        return ok;
    }

    /** Flush all dirty content stores, then pending session writes. Called on
     *  SIGTERM/SIGINT for graceful shutdown. Content stores live outside the
     *  kernel StateStore, so retry them from the resident session list before
     *  the kernel drains its pending writes and in-flight chains. */
    async flushAll(sessions: Iterable<Session> = []): Promise<void> {
        // #3133: run armed writerOff builds BEFORE the sidecar closes below —
        // a stray microtask would build against a closed store and burn a
        // 3-strike disable for no reason.
        this.drainWriterOffPending();
        for (const session of sessions) this.saveContentStore(session);
        await this.flushScheduledSaves();
        await this.store.flushAll();
        this.shadow?.close();
    }

    /** #3406: drain the host-owned debounced saves before the kernel store's
     *  own flushAll — its timers no longer know about them. Mirrors the
     *  kernel's drain: clear timers, write each pending builder now (stamped),
     *  log failures; store.flushAll then also drains any still-in-flight chain. */
    private async flushScheduledSaves(): Promise<void> {
        const ids = [...this.saveTimers.keys()];
        for (const timer of this.saveTimers.values()) clearTimeout(timer);
        this.saveTimers.clear();
        const builders = new Map<string, () => PersistedSession>();
        for (const id of ids) {
            const build = this.saveBuilders.get(id);
            if (build) builders.set(id, build);
            this.saveBuilders.delete(id);
        }
        await Promise.all([...builders.entries()].map(([id, build]) =>
            this.store.writeNow(id, build).then(() => {
                this.stampOwnWrite(id);
            }).catch((e) => {
                this.log("error", `[persist] shutdown flush failed for ${id}: ${String(e)}`);
            }),
        ));
    }

    /** #3135 ③/#3818: the honest per-instance mode stamp — the mode that is
     *  actually holding data RIGHT NOW. The knob resolution says what was
     *  REQUESTED; this says what a record built at this instant will survive
     *  on (legacy = the JSON envelope is the only durable copy: persistence
     *  disabled, sidecar never opened, or the sidecar 3-strike-disabled). */
    get liveStorageStamp(): "legacy" | "shadow" | "full" {
        if (!this.enabled) return "legacy";
        if (!this.shadow || this.shadow.stats.disabled) return "legacy";
        return this.storageMode;
    }

    /** Close the unified sidecar without flushing pending writes. Intended for
     *  short-lived stores (CLI export, one-shot loaders): cancels debounced
     *  writes first so nothing builds against a closed handle. Windows cannot
     *  delete a directory while index.db is open, so leaking the handle pins
     *  the caller's cleanup. Never throws. */
    closeQuietly(): void {
        this.cancelAll();
        this.shadow?.close();
    }

    /** #3931 step 3: async twin of closeQuietly for network backends —
     *  awaits the mysql sidecar open (no-op for sqlite/legacy), cancels
     *  pending saves, then drains the ingest queue and closes the pool.
     *  Tests and short-lived processes on mysql MUST use this or the pool
     *  keeps the event loop alive forever. */
    async closeQuietlyAsync(): Promise<void> {
        await this.ready();
        this.cancelAll();
        await this.shadow?.closeAsync();
    }

    /** Whether a write is currently pending (debounce timer armed) for a id. */
    hasPending(id: string): boolean {
        return this.saveTimers.has(id) || this.writerOffPending.has(id);
    }

    /** Phase 3 (#2960): the JSON envelope is skipped only while the sidecar
     *  is both configured off AND actually alive — a mid-run sidecar death
     *  (3-strike disable) automatically resumes file writes. */
    private writerOffActive(): boolean {
        return this.jsonWriterOff && this.shadow !== undefined && !this.shadow.stats.disabled;
    }

    /** #4323: per-session envelope freeze (escalated structural drift, see
     *  UnifiedShadow.envelopeFrozen) — the save routes index-only exactly
     *  like writerOff, so a multi-writer ping-pong (#394) can no longer
     *  churn the file copy from this process. */
    private envelopeFrozen(sessionId: string): boolean {
        return this.shadow?.envelopeFrozen(sessionId) ?? false;
    }

    /** Cancel all pending writes without flushing (e.g. for tests). */
    cancelAll(): void {
        for (const timer of this.saveTimers.values()) clearTimeout(timer);
        this.saveTimers.clear();
        this.saveBuilders.clear();
        this.store.cancelAll();
        this.writerOffPending.clear();
    }

    /** #3133: run and clear armed writerOff builds now (shutdown path). */
    private drainWriterOffPending(): void {
        if (this.writerOffPending.size === 0) return;
        const runs = [...this.writerOffPending.values()];
        this.writerOffPending.clear();
        for (const run of runs) run();
    }
}

/** Effective storage mode under which a session file is being written (#2671).
 *  Mirrors the SessionStore constructor's resolution: encryption hard-blocks
 *  the unified sidecar, so from the file's perspective there is no db copy
 *  and the stamp is "legacy". Stamped into metadata on every save so the web
 *  UI can show, per session, whether an index.db copy exists — lanes with
 *  different BILI_STORAGE_UNIFIED settings share one sessions dir. Also the
 *  stamp source for live (never-persisted) sessions at creation time (#3093)
 *  so the detail panel never falls back to a bogus legacy dash while a
 *  session is still running. */
export function effectiveFileStorageMode(): "legacy" | "shadow" | "full" {
    // #3135 ③/#3818: a live store instance is the authority — the knob tier
    // below cannot see a dead sidecar (missing engine, 3-strike disable,
    // unwritable index.db path), and with full as the default that gap would
    // stamp "full" onto records that only ever exist on the JSON envelope.
    // Peek the singleton WITHOUT creating it (getStore has constructor side
    // effects; pre-store callers keep the pure knob resolution).
    const live = peekStoreForStamp();
    if (live) return live.liveStorageStamp;
    const mode = resolveStorageModeForProcess();
    if (mode === "legacy") return "legacy";
    const keyEnv = process.env.BILI_ENCRYPTION_KEY;
    return keyEnv !== undefined && keyEnv !== "" ? "legacy" : mode;
}

function buildRecord(session: Session, storageMode: "legacy" | "shadow" | "full" = effectiveFileStorageMode()): PersistedSession {
    const snapshot = boundedFoldedSnapshot(session);
    const observation = currentContextObservation(session);
    if (session.pluginSnapshot && session.contentStore) {
        const previous = session.metadata.publicSnapshotStoredRefs;
        session.metadata.publicSnapshotStoredRefs = [...new Set([
            ...(Array.isArray(previous) ? previous : []),
            ...session.pluginSnapshot.flatMap((m) => {
                const ref = session.state.messageRefs.byRaw[m.id];
                return ref && session.contentStore!.byRef[ref] ? [ref] : [];
            }),
        ])];
    }
    return {
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        id: session.id,
        meta: { ...session.meta },
        // Credits are one-shot and are not restored; persist the effective view instead.
        stats: { ...session.stats, ...(observation ? { contextTokens: observation.tokens, contextTokensSource: observation.source } : {}) },
        messages: snapshot,
        messagesFolded: snapshot ? true : undefined,
        // #2077: the raw snapshot is persisted lazily — only once it becomes an
        // external contract (a fork receipt exists on this session, or a fork
        // was cut from this one and set the sticky retained flag). Non-forking
        // sessions pay no disk cost; the in-memory copy self-heals on the next
        // model request because plugin agents resend their full history.
        pluginSnapshot: session.metadata.publicForkReceipt !== undefined || session.metadata.publicSnapshotRetained === true ? session.pluginSnapshot : undefined,
        forkContentStore: session.metadata.publicForkReceipt ? session.contentStore : undefined,
        // Per-session provenance: record the bili build that wrote this file so the
        // web UI can show which version last touched the session; pre-stamp files
        // load without the key and render an honest dash.
        // #2671: effective storage mode at write time — with mixed lanes sharing
        // one sessions dir this is the only per-file record of whether a unified
        // (index.db) copy of this session exists. Digest-neutral: canonical.ts
        // drops the key entirely (unlike biliVersion's "__VER__" value-mask) —
        // its PRESENCE is new, so value-masking can't keep old corpus pins green.
        metadata: { ...session.metadata, biliVersion: VERSION, storageMode },
        state: session.state,
        blockContents: Object.fromEntries(session.blockContents),
        createdAt: session.createdAt,
    };
}

function isBlockView(v: unknown): v is BlockView {
    return !!v && typeof v === "object" && typeof (v as BlockView).text === "string" && typeof (v as BlockView).count === "number";
}

// #2129: restore-time validation for the #1933 F1 calibrated factor. The learner
// publishes factors clamped to [CLAMP_MIN, CLAMP_MAX] (two-way since #2366), but
// applyEstimateCalibration applies whatever it is given UNCLAMPED — a corrupt or
// hand-edited file outside the published band would move every calibrated reading
// off-scale (k̂>4 over-inflates, k̂<0.25 over-deflates). Reject out-of-band values
// instead of trusting them: absent falls back to the raw estimate (legacy behavior).
function restoreCalibratedEstimate(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v >= CALIBRATION_CLAMP_MIN && v <= CALIBRATION_CLAMP_MAX ? v : undefined;
}

// #2129: same discipline for the evidence ring — keep only samples the learner
// itself would admit (finite, within the plausibility band) and only the newest
// window-size entries; anything else drops the ring wholesale so a malformed
// file can neither teach a factor nor mask a fresh learning run on restart.
function restoreCalibrationRing(v: unknown): { origin: string; values: number[] } | undefined {
    if (!v || typeof v !== "object") return undefined;
    const ring = v as { origin?: unknown; values?: unknown };
    if (typeof ring.origin !== "string" || ring.origin.length === 0) return undefined;
    if (!Array.isArray(ring.values)) return undefined;
    const values = ring.values.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= CALIBRATION_SAMPLE_MIN && x <= CALIBRATION_SAMPLE_MAX);
    const recent = values.slice(-CALIBRATION_SAMPLE_WINDOW);
    return recent.length > 0 ? { origin: ring.origin, values: recent } : undefined;
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
            // #1724: buildRecord persists activePack via spread but this reader dropped it
            activePack: typeof meta.activePack === "string" ? meta.activePack : undefined,
            // #2322: same as activePack above — buildRecord persists hostTitle via the spread; restore so the name survives restart
            hostTitle: typeof meta.hostTitle === "string" ? meta.hostTitle : undefined,
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
            // #857: provenance — legacy files lack it; absent stays absent and
            // evidence-grade consumers treat absent as untrusted.
            lastInputTokensSource: stats.lastInputTokensSource === "usage" || stats.lastInputTokensSource === "estimate" || stats.lastInputTokensSource === "overflow-arm" ? stats.lastInputTokensSource : undefined,
            // #1110: one-shot overflow arm — legacy files lack it; absent = no arm.
            overflowArmTokens: typeof stats.overflowArmTokens === "number" && Number.isFinite(stats.overflowArmTokens) && stats.overflowArmTokens > 0 ? stats.overflowArmTokens : undefined,
            // #3450: proven completion reservation + one-time warn flag — legacy files lack both.
            overflowArmCompletionReserve: typeof stats.overflowArmCompletionReserve === "number" && Number.isFinite(stats.overflowArmCompletionReserve) && stats.overflowArmCompletionReserve > 0 ? stats.overflowArmCompletionReserve : undefined,
            overflowArmMismatchWarned: stats.overflowArmMismatchWarned === true ? true : undefined,
            // #3450 follow-up: the proof outlives the arm, so a restart must not forget it; absent = no proof.
            provenCompletionWall: typeof stats.provenCompletionWall === "number" && Number.isFinite(stats.provenCompletionWall) && stats.provenCompletionWall > 0 ? stats.provenCompletionWall : undefined,
            provenCompletionWallOrigin: typeof stats.provenCompletionWallOrigin === "string" && stats.provenCompletionWallOrigin.length > 0 ? stats.provenCompletionWallOrigin : undefined,
            provenCompletionWallModel: typeof stats.provenCompletionWallModel === "string" && stats.provenCompletionWallModel.length > 0 ? stats.provenCompletionWallModel : undefined,
            // In-memory only — a fresh process has no pending compress fold.
            compressCreditTokens: 0,
            contextTokens: Math.max(0, stats.contextTokens ?? parsed.contextTokens ?? 0),
            // #1839: display provenance — legacy files lack it; absent = no marker.
            contextTokensSource: stats.contextTokensSource === "usage" || stats.contextTokensSource === "estimate" ? stats.contextTokensSource : undefined,
            // #2129: measurement-state fields buildRecord persists via spread but this
            // reader used to drop — after a restart the preflight gate judged on the
            // UNCALIBRATED local estimate (k̂ lost → folded fitting payloads) and nudge
            // sizing fell through to the raw char-count bound (usage anchor lost →
            // EMERGENCY ghosts, #2122 incident). Restored with the same validation
            // discipline as the entries above: corrupt values are rejected outright.
            localInputEstimate: typeof stats.localInputEstimate === "number" && Number.isFinite(stats.localInputEstimate) && stats.localInputEstimate > 0 ? stats.localInputEstimate : undefined,
            lastUsageGradeTokens: typeof stats.lastUsageGradeTokens === "number" && Number.isFinite(stats.lastUsageGradeTokens) && stats.lastUsageGradeTokens >= 0 ? stats.lastUsageGradeTokens : undefined,
            lastInputTokensOrigin: typeof stats.lastInputTokensOrigin === "string" && stats.lastInputTokensOrigin.trim().length > 0 ? stats.lastInputTokensOrigin : undefined,
            calibratedEstimate: restoreCalibratedEstimate(stats.calibratedEstimate),
            calibratedEstimateOrigin: typeof stats.calibratedEstimateOrigin === "string" && stats.calibratedEstimateOrigin.trim().length > 0 ? stats.calibratedEstimateOrigin : undefined,
            calibrationRing: restoreCalibrationRing(stats.calibrationRing),
            // Intentionally NOT restored (#2129 triage): pendingFoldUsage is set at
            // compress execution and consumed only as a log-suffix attribution by the
            // NEXT usage report (#695) — restoring a stale true would mislabel an
            // unrelated post-reload report, and losing it costs one log suffix.
            // lastLocalTextEstimate(+Origin) is the pending k̂ pairing input whose
            // session.ts doc already says "a restart simply loses one pending pair".
            retrieveCalls: stats.retrieveCalls ?? 0,
            retrieveHits: stats.retrieveHits ?? 0,
            retrieveMisses: stats.retrieveMisses ?? 0,
            retrieveDropped: stats.retrieveDropped ?? 0,
            retrieveDelivered: stats.retrieveDelivered ?? 0,
            storedBytes: stats.storedBytes ?? 0,
            storeBytesSaved: stats.storeBytesSaved ?? 0,
            rangeRestores: stats.rangeRestores ?? 0,
            // #1336: retrieval-quality counters (whole-block restores vs cheaper
            // precise path available) — round-trip so the long-run ratio in
            // acp_status survives restarts instead of silently resetting.
            wholeBlockRestores: stats.wholeBlockRestores ?? 0,
            wholeBlockRestoresPreciseAvailable: stats.wholeBlockRestoresPreciseAvailable ?? 0,
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
        // #1343: arm the reload reconcile for the first request of THIS
        // process — getSession() clears `restored` before prepare runs, so
        // the reconcile needs its own one-shot marker to fire exactly once.
        ccrReconcilePending: true,
        blockContents,
        lastMessages: Array.isArray(parsed.messages) ? parsed.messages : undefined,
        lastMessagesFolded: parsed.messagesFolded === true,
        pluginSnapshot: Array.isArray(parsed.pluginSnapshot) ? parsed.pluginSnapshot : undefined,
        decompositionLog: Array.isArray(parsed.decompositionLog) ? parsed.decompositionLog : undefined,
        contentStore: parsed.forkContentStore,
        inFlight: 0,
        persisted: true,
        pendingRetrievals: [],
    };
}

export function isValidRecord(parsed: unknown): parsed is PersistedSession {
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

/** #4323: active fold blocks a persisted record carries — the freshness
 *  proxy for drift-latched source selection (loadSync). Defensive: malformed
 *  files must count as zero, never throw into the load path. */
function countActiveBlocks(payload: PersistedSession): number {
    const blocks = payload.state?.blocks;
    if (!Array.isArray(blocks)) return 0;
    return blocks.filter((b) => !!b && b.active === true).length;
}

/** #2671 Phase 1.5: adapter that lets buildSession (with its full forward-
 *  compat pass, incl. mergeState) rebuild a Session from a unified-store
 *  view. `messagesFolded` is only ever set when `messages` is present — an
 *  absent messages field means "raw history that still needs export-time
 *  pruning" in the persisted-record contract, and that semantic must be
 *  preserved here (false is explicit: folded=false). */
function viewToRecord(view: LegacySessionLike): PersistedSession {
    const record: PersistedSession = {
        version: PERSIST_VERSION,
        savedAt: view.lastSeen,
        id: view.id,
        createdAt: view.createdAt,
        meta: view.meta as PersistedSession["meta"],
        stats: view.stats as PersistedSession["stats"],
        metadata: view.metadata,
        state: view.state as unknown as CompressionState,
        blockContents: Object.fromEntries(view.blockContents),
    };
    if (view.lastMessages !== undefined) {
        record.messages = view.lastMessages;
        record.messagesFolded = view.lastMessagesFolded === true;
    }
    if (view.pluginSnapshot !== undefined) record.pluginSnapshot = view.pluginSnapshot;
    if (view.contentStore !== undefined) record.forkContentStore = view.contentStore as unknown as NonNullable<PersistedSession["forkContentStore"]>;
    return record;
}

/** resolveStorageMode guarded for the constructor: env parsing cannot throw
 *  (resolveStorageMode is total), so this only exists to keep the call site
 *  honest about the default when the knob is absent. */
function resolveStorageModeSafe(): StorageMode {
    return resolveStorageModeForProcess();
}

/** Mode resolution as the running lane sees it: env tier first, then the
 *  config-file tier, then legacy (#2671). One seam so the constructor, the
 *  per-file stamp, and the status label can never disagree. */
function resolveStorageModeForProcess(): StorageMode {
    return resolveStorageMode(process.env, fileStorageUnified());
}

/** One-line effective-storage label for status panels (#2671). Mirrors the
 *  constructor's mode resolution so a panel can never claim a mode the store
 *  didn't take: encryption blocks the unified sidecar even when
 *  BILI_STORAGE_UNIFIED asks for it, and that must be visible. Uses the raw
 *  env presence for the encryption check — an unparseable key never gets this
 *  far (the constructor throws first). */
export function storageStatusLabel(): string {
    const mode = resolveStorageModeForProcess();
    if (mode === "legacy") return "storage: legacy (json only)";
    const encrypted = process.env.BILI_ENCRYPTION_KEY !== undefined && process.env.BILI_ENCRYPTION_KEY !== "";
    if (encrypted) {
        return `storage: ${mode} requested — blocked by BILI_ENCRYPTION_KEY, running legacy-only`;
    }
    if (mode !== "full") return "storage: shadow (dual-write dry-run → index.db)";
    return knobResolveJsonWriterOff(process.env, fileStorageJsonWriter()) && !encrypted
        ? "storage: full (unified-only, json envelope off)"
        : "storage: full (unified-first reads, dual-write)";
}

function defaultDir(): string {
    return sessionsDir();
}

function defaultDebounce(): number {
    return knobPersistDebounceMs();
}

function persistEnabled(): boolean {
    return knobPersistEnabled();
}

/** #1080 (owner decision): session files stay plain JSON by default —
 *  recoverability (jq/grep-debuggable, no downgrade tail risk) beats silent
 *  disk savings. Only persist.enabled=false / BILI_PERSIST_ZSTD=1/true opts
 *  into zstd (BILIZSTD1); anything else keeps plain JSON. */
function persistZstdEnabled(): boolean {
    return knobPersistZstdEnabled();
}

/** True for any temp-file name bili or the kernel leaves in the sessions tree:
 *  a `.tmp-*` prefix (kernel session-write temps AND the atomic content-store
 *  companion temps, #2674) or the legacy `<file>.tmp-enc-<pid>-<ts>` codec
 *  suffix. A process death between write and rename orphans one; any such name
 *  present at boot is stale by definition (the walk runs before this boot writes
 *  anything) and gets swept. #2674 widened this from `.tmp-enc-*` to all `.tmp-*`. */
function isStaleTempName(name: string): boolean {
    return name.startsWith(".tmp-") || /\.tmp-enc-\d+-\d+$/.test(name);
}

/** #3931 step 3 sync twin — the lazy disk index for loadEnvelope. */
function walkJsonFilesSync(dir: string, out: string[] = []): string[] {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkJsonFilesSync(full, out);
        else if (e.isFile() && (isStaleTempName(e.name) || e.name.endsWith(".json"))) out.push(full);
    }
    return out;
}

async function walkJsonFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await walkJsonFiles(full)));
        } else if (e.isFile() && (isStaleTempName(e.name) || e.name.endsWith(".json"))) {
            out.push(full);
        }
    }
    return out;
}

/** Token budget for the persisted folded-view snapshot (#401). The raw full
 *  history is never persisted — prune() first replaces folded ranges with
 *  their summaries (exactly what `bili export` renders by default), then the
 *  OLDEST messages are dropped until the view fits. 0 disables message
 *  persistence entirely (block summaries + blockContents survive). */
function persistTailTokens(): number {
    return knobPersistTailTokens();
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
    return knobPersistEpermAlertThreshold();
}

function epermAlertRepeatMs(): number {
    return knobPersistEpermAlertRepeatMs();
}

function defaultLogger(level: string, m: string): void {
    // Route through the tee logger (file + stderr) when available; fall back
    // to console.error only if the logger hasn't been configured yet (e.g.
    // during early init or tests).
    loggerLog(level, m);
}

/** Singleton store for the running proxy. */
let _store: SessionStore | null = null;

/** #3923: process-global commit listener — registered by the standalone
 *  server BEFORE the lazy singleton exists; applied at construction (and to
 *  any store injected later via _setStoreForTest). */
let globalSessionCommitListener: ((sessionId: string) => void) | undefined;

export function setGlobalSessionCommitListener(fn: ((sessionId: string) => void) | undefined): void {
    globalSessionCommitListener = fn;
    _store?.setSessionCommitListener(fn);
}

/** #3135 ③/#3818: stamp-resolution helper — observe the singleton store if it
 *  exists, never construct one (see effectiveFileStorageMode). */
function peekStoreForStamp(): SessionStore | null {
    return _store;
}

/** #3982 compress-from-store: recover the raw client view for an evicted
 *  session from the unified transcript. Read-only and peek-only — the module
 *  singleton must already exist (never construct a store on a compress path);
 *  a disabled/unavailable sidecar, zero rows, or ANY unparsable row returns
 *  null so callers keep their honest refusal instead of folding against a
 *  half-readable view. Rows are the raw client view caliber (#2627 — what a
 *  live model request would have re-sent), persisted on every save via the
 *  raw-tail ingest. */
export function peekStoredTailView(sessionId: string): BiliMessage[] | null {
    const store = peekStoreForStamp();
    if (!store) return null;
    const rows = store.unifiedTailViewRows(sessionId);
    if (!rows || rows.length === 0) return null;
    const messages: BiliMessage[] = [];
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.content) as BiliMessage;
            if (typeof parsed?.id !== "string" || typeof parsed?.role !== "string") return null;
            messages.push(parsed);
        } catch {
            return null;
        }
    }
    return messages;
}

export function getStore(): SessionStore {
    if (!_store) {
        _store = new SessionStore({ enabled: persistEnabled(), log: defaultLogger });
        if (globalSessionCommitListener !== undefined) _store.setSessionCommitListener(globalSessionCommitListener);
    }
    return _store;
}

/** Test hook: inject a store with a temp dir. */
export function _setStoreForTest(store: SessionStore): void {
    _store = store;
    if (globalSessionCommitListener !== undefined) store.setSessionCommitListener(globalSessionCommitListener);
}
