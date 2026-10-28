/**
 * Unified storage store (#2671 Phase 1).
 *
 * One SQLite database (index.db, WAL) + content-addressed blobs in the
 * content table. Every mutation is one transaction; messages and content
 * are append-only.
 *
 * Phase 1 fidelity contract (pinned by tests/storage-unified.test.ts against
 * tests/golden/storage-corpus): a legacy session ingested here and loaded
 * via loadLegacyView() MUST reproduce the exact canonical digest that
 * SessionStore.loadSync produces for the same on-disk files.
 *
 * Representation discipline: verbatim facts (payload_json / content / *_json
 * bags) are the truth; scalar columns are projections; verifyProjections()
 * asserts they agree. Readers migrate from facts to projections field by
 * field, always guarded by those assertions.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { log as loggerLog } from "../logger.js";
import { openSqliteDatabase, type SqliteDatabase, type SqliteEngineName, type SqliteEngineSource } from "./driver.js";
import { migrateSchema, storagePragmas, WAL_JOURNAL_SIZE_LIMIT } from "./schema.js";
import { identityOfStoredContent } from "./identity.js";
import { recordIntegrityOutcome, recordSecondProcessOwner, recordBackupOutcome } from "./runtime-status.js";
import { integrityModeFor, writeIntegrityCache, scheduleBackgroundIntegrityCheck, backgroundIntegrityInflightForTests, noteIntegrityCheckRun } from "./integrity-check.js";
import { listInstances, type RegistryEntry } from "../instance.js";
import type { MessageContentStore } from "acp-kernel";

/** #3250: run a PASSIVE wal_checkpoint every N successful ingests. The
 *  built-in autocheckpoint alone cannot guarantee reclamation in a long-lived
 *  process: while a foreign connection holds a read snapshot (dashboard /
 *  export / second lane sharing the directory — #2671 topology) WAL backfill
 *  is blocked at that snapshot and the file grows until the reader lets go.
 *  PASSIVE never blocks the ingest path; a failed checkpoint is logged and
 *  forgotten — the next tick retries and journal_size_limit does the rest. */
const WAL_CHECKPOINT_EVERY_INGESTS = 20;

/** PR #4725 N3: covered-seq span point queries chunk the msg_id IN (…) list
 *  to stay under SQLite's 999 bound-parameter limit (1 session id + 500). */
const SEQ_SPAN_QUERY_BATCH = 500;

export function sha256Hex(bytes: string | Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export interface SessionRow {
    sessionId: string;
    parentSessionId?: string | null;
    forkPointSeq?: number | null;
    protocol?: string | null;
    label?: string | null;
    title?: string | null;
    hostTitle?: string | null;
    /** #2960: owning agent namespace (metadata.pluginAgent, "proxy" for
     *  bare proxy lanes) and the persistence-time upstream origin. Identity
     *  metadata — R2.1 will make them part of the row key. */
    namespace?: string;
    origin?: string | null;
    status?: string;
    createdAt: number;
    updatedAt: number;
    nextBlockId: number;
    nextRunId: number;
    metaJson: string;
    statsJson: string;
    metadataJson: string;
    /** Kernel-state fields with no dedicated tables yet, EXCLUDING
     *  blocks/messageRefs/deadRefs/nextBlockId/nextRunId (those come from
     *  tables). Key order inside is irrelevant — loadLegacyView rebuilds the
     *  state object in mergeState field order. */
    kstateJson: string;
    /** View pointers: {tailSeqs: number[]|null, tailFolded: boolean,
     *  pluginSnapshotLen: number|null}. Content itself lives in messages. */
    tailJson: string;
    /** Verbatim CCR store JSON (dying subsystem, Phase 3 removes it). */
    ccrJson: string | null;
    /** #3133 ingest watermark: highest absolute message seq whose bytes this
     *  index has verified (NULL = no trusted prefix → next save ingests
     *  fully). Computed by ingestSession only (delta provenance or full-path
     * alignment) — never by planners or callers; read via ingestWatermark(). */
    lastIngestedSeq?: number | null;
    /** #3841 reap journal: contents of reaped blocks (state.blocks lost
     *  the entry, blockContents keeps the text). Served via loadLegacyView
     *  merge into blockContents; never resurrects state.blocks. */
    orphansJson?: string | null;
}

export interface MessageRow {
    seq: number;
    msgId: string;
    /** Verbatim ref token from state.messageRefs.byRaw (may be "BLOCKED"). */
    ref: string | null;
    /** Numeric projection of ref (null when ref is null or non-numeric). */
    refNum: number | null;
    role: string;
    kind: string;
    /** Verbatim serialized message (includes id; exact parsed-file bytes). */
    content: string;
    /** #3133: sha256(content) as computed by the planner's intern pass —
     *  lets ingestSession skip re-hashing every message on every save.
     *  Identical value to sha256Hex(content); optional for direct callers. */
    contentHash?: string;
    /** #3762: media payloads split out of `content` (bytes live in the
     *  content CAS, refcounted via message_media rows). Ingest-only —
     *  readers always receive hydrated content. */
    media?: { hash: string; bytes: string }[];
    /** #4390: position-independent identity (stored-bytes serialization
     *  minus id/wireIndex) — the cross-save JOIN key. content_hash stays
     *  the byte-faithful CAS key; identity is what remap/sweep/guard join
     *  on, so a client head-truncation (wireIndex shift) no longer re-mints
     *  the surviving generation. Optional for direct callers. */
    identity?: string;
}

/** #4738: one stored message addressed by its mNNNNN ref number — the web
 *  hydration row, served when the resident window no longer carries the bytes. */
export type MessageRefContentRow = { refNum: number; role: string; kind: string; content: string };

export interface BlockRow {
    blockId: string;
    ord: number;
    startSeq: number;
    endSeq: number;
    startRef: number | null;
    endRef: number | null;
    tier: number;
    /** JSON of the full BlockView {text, count}. */
    summary: string;
    /** JSON of the one-line BlockView, or null (legacy #401 collapse). */
    one: string | null;
    supersedesBlockId: string | null;
    active: boolean;
    createdAt: number;
    coveredHash: string;
    /** Verbatim serialized CompressionBlock (includes summary). */
    payloadJson: string;
}

export interface RefRow {
    ord: number;
    rawId: string;
    /** Verbatim ref token ("m00123" or "BLOCKED"). */
    ref: string;
    refNum: number | null;
}

export interface CcrEntryRow {
    ord: number;
    key: string;
    content: string;
}

/** One checkpoint/replica row (Phase 2, #2671). `state_hash` never leaves
 *  the store — list/get return this projection only; the blob itself is
 *  read via checkpointState() when restoring. */
export interface CheckpointRow {
    cp_id: string;
    session_id: string;
    seq_at: number;
    block_set_hash: string;
    kind: "auto" | "manual" | "replica" | "fork_base";
    created_at: number;
    pinned: number;
    label: string | null;
}

/** Summary row for the export/web list fast path (#2960 R2.1). Parity
 *  contract with the legacy walk in export.ts listSessions. updatedAt (#3199)
 *  = sessions.updated_at (ms epoch, last ingest time) — boot uses it as the
 *  alias savedAt when seeding label aliases from rows without decoding files. */
 export interface SessionSummaryRow {
     sessionId: string;
     title: string | undefined;
     label: string | undefined;
     protocol: string | undefined;
     origin: string | undefined;
     namespace: string;
     blocks: number;
     latestBlockAt: number | undefined;
     contextTokens: number | undefined;
     updatedAt: number;
     /** #3928: 'active' or 'archived' — archived rows are tombstones kept for
      *  restore (see archiveSession); the CLI surfaces both. */
     status: string;
 }

/** #2960 R2.2: row backing the WEB session list in full mode. Carries the
 *  JSON columns the web summaryOf needs (stats/metadata) plus block
 *  aggregates extracted from payloads (topic/summary lead of the first
 *  block, gross compressed tokens over ACTIVE blocks) — everything the
 *  bounded disk index used to decode whole envelope files for. */
 export interface WebSummaryRow {
     sessionId: string;
     title: string | undefined;
     hostTitle: string | undefined;
     label: string | undefined;
     protocol: string | undefined;
     origin: string | undefined;
     /** #3928: 'active' or 'archived' (see SessionSummaryRow.status). */
     status: string;
     updatedAt: number;
    statsJson: string;
    metadataJson: string;
    blocks: number;
    firstTopic: string | null;
    firstSummary: string | null;
    activeCompressedTokens: number;
}

/** #3928: per-session footprint inside index.db, backing `bili sessions ls`.
 *  CAS bytes are split by ownership so the number is honest: only refcount-1
 *  blobs die with this session (they are attributed to it); shared blobs are
 *  counted but never double-attributed, because they outlive any single
 *  session's deletion. */
export interface SessionStorageStats {
    rows: {
        messages: number;
        media: number;
        blocks: number;
        deadRefs: number;
        refs: number;
        ccrEntries: number;
        sessionExt: number;
        checkpoints: number;
        pinnedCheckpoints: number;
    };
    /** Bytes held in inline JSON columns of this session's rows (sessions
     *  record + blocks payload_json + session_ext value_json) — everything
     *  except the content-addressed blobs. */
    inlineBytes: number;
    /** CAS blob bytes this session references at refcount = 1 (freed when it
     *  is deleted). */
    casExclusiveBytes: number;
    /** CAS blobs this session references that other sessions also hold
     *  (refcount > 1) — they survive the deletion. */
    casSharedBlobs: number;
}

/** #3928: one age-sweep candidate in a gc plan. */
interface GcPlanCandidate {
    sessionId: string;
    label?: string;
    updatedAt: number;
}

/** #3928: read-only gc prediction (see UnifiedStore.gcPlan). */
export interface GcPlan {
    /** Age cutoff in ms; null when days <= 0 (no age-sweep planned). */
    cutoff: number | null;
    candidates: GcPlanCandidate[];
    zeroRefRows: number;
    zeroRefBytes: number;
    pageSize: number;
}

export interface IngestSessionInput {
    session: SessionRow;
    messages: MessageRow[];
    blocks: BlockRow[];
    deadRefs: { ord: number; ref: string; refNum: number; recordedAt: number }[];
    refs: RefRow[];
    ccrEntries: CcrEntryRow[];
    /** Plan-space pointer sequences (indices into `messages`), if the caller
     *  has them. ingestSession rewrites both the rows and these pointers to
     *  absolute seqs before insert — see remapPlanSeqs. */
    pluginSnapshotSeqs?: number[] | null;
    tailSeqs?: number[] | null;
    /** Serialized orphan map (Record<blockId, {one, full}>) — blockContents
     *  entries whose block is absent from state.blocks (#4216/#4242: the reap
     *  shape is REPRESENTABLE; rides the same transaction so the session row,
     *  blocks and tail keep advancing). MERGE semantics on write: existing
     *  journal entries survive, because LazyBlockContents means a live
     *  session's in-memory map may not carry entries trimmed earlier. */
    orphansJson?: string | null;
}

/** Extension-namespace guards (#3069): keys/namespaces are non-empty
 *  printable ASCII-range strings up to 256 chars — loose by design (callers
 *  namespace by convention like "r3:" / "web:" / "lane:"), hostile by
 *  accident is what we guard, not hostile by design. */
const EXT_KEY_MAX = 256;
const EXT_VALUE_MAX_BYTES = 4 * 1024 * 1024;

function validateExtKey(value: string, what: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > EXT_KEY_MAX) {
        throw new Error(`[storage] extension ${what} must be a non-empty string of at most ${EXT_KEY_MAX} characters`);
    }
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) {
            throw new Error(`[storage] extension ${what} must not contain control characters`);
        }
    }
}

function serializeExtValue(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new Error("[storage] extension values must be JSON-serializable (undefined/functions are not)");
    }
    if (json.length > EXT_VALUE_MAX_BYTES) {
        throw new Error(`[storage] extension value exceeds ${EXT_VALUE_MAX_BYTES} bytes — store large payloads in the content CAS instead`);
    }
    return json;
}

/** Escapes LIKE metacharacters for the ESCAPE '\\' clause used by listKv. */
function likeEscape(prefix: string): string {
    return prefix.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/**
 * #4175: raised when PRAGMA quick_check fails at open. Migrations must never
 * run against a corrupt file, so this fires BEFORE migrateSchema; the shadow
 * layer catches it, quarantines the file set (db/-wal/-shm → .corrupt-<ts>),
 * and reopens fresh (the JSON envelopes remain the recovery source).
 */
export class StorageIntegrityError extends Error {
    constructor(public readonly dbPath: string, public readonly detail: string) {
        super(`[storage] integrity quick_check failed for ${dbPath}: ${detail}`);
        this.name = "StorageIntegrityError";
    }
}

/** #4175: true when a pid belongs to a live process (EPERM = alive, foreign user). */
function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

export class UnifiedStore {
    readonly engine: SqliteEngineName;
    /** Where the engine came from (#2833): builtin / host / self-downloaded — logged at enable so field diagnosis can tell which acquisition path a lane ran on. */
    readonly engineSource: SqliteEngineSource;
    private readonly db: SqliteDatabase;
    /** #3250: successful-ingest counter driving the WAL_CHECKPOINT_EVERY_INGESTS cadence. */
    private ingestCount = 0;
    /** #4175: the live foreign pid found holding <db>.lock at open, if any. */
    private readonly foreignLockHolder: { pid: number } | null;
    private readonly lockPath: string | null;
    private readonly dbPath: string;
    /** #4609: the last completed check (sync, cache hit, or background
     * verdict) said the file set is sound — a clean close then refreshes the
     * verdict cache onto the post-checkpoint stats so the next boot skips
     * the rescan. Never true while a check is still in flight or failed. */
    private lastIntegrityOk = false;

    private constructor(db: SqliteDatabase, engine: SqliteEngineName, engineSource: SqliteEngineSource, lockPath: string | null, foreignLockHolder: { pid: number } | null, dbPath: string) {
        this.db = db;
        this.engine = engine;
        this.engineSource = engineSource;
        this.lockPath = lockPath;
        this.foreignLockHolder = foreignLockHolder;
        this.dbPath = dbPath;
    }

    static open(
        path: string,
        engine?: SqliteEngineName,
        opts?: { walJournalSizeLimitBytes?: number },
    ): UnifiedStore {
        mkdirSync(dirname(path), { recursive: true });
        const { db, engine: used, source } = openSqliteDatabase(path, engine);
        // #4175/#4609: integrity self-check, verdict-cached and size-gated.
        // An unchanged file set (index.db + -wal stats + schema version) skips
        // the rescan; a small store checks synchronously BEFORE migrations (a
        // corrupt file must never be migrated against — #4175's premise,
        // preserved wherever it is cheap); a large store checks in the
        // background post-open (#4609: a 14 GB quick_check costs ~260 s and
        // the 60 s native spawn budget killed the child mid-scan). A cached
        // failure throws here so the shadow's quarantine-and-reopen-fresh
        // path (#4175) runs — including for failures found by the background
        // check of a previous run. BILI_STORAGE_QUICK_CHECK=0 opts out of all
        // of it (no check, no cache IO).
        let integrityOk = false;
        const mode = integrityModeFor(path);
        if (mode.kind === "cached-fail") {
            recordIntegrityOutcome(path, false, 0, mode.detail);
            db.close();
            throw new StorageIntegrityError(path, mode.detail);
        }
        if (mode.kind === "cached-ok") {
            recordIntegrityOutcome(path, true, 0, "verdict cache hit (file set unchanged since the last check)");
            integrityOk = true;
        } else if (mode.kind === "sync") {
            noteIntegrityCheckRun();
            const started = Date.now();
            let verdict: string;
            try {
                const rows = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check?: unknown }>;
                verdict = rows.map((row) => String(row.quick_check ?? "")).join(" ").trim();
            } catch (err) {
                // Corrupt header (NOTADB) throws from the statement itself, so
                // the verdict branch never runs: close the handle we opened
                // before rethrowing — the #2771 fallback tells operators to
                // DELETE the file, and Windows refuses to delete a file this
                // process still holds (unlink EBUSY, #4347 probe).
                recordIntegrityOutcome(path, false, Date.now() - started, String(err).slice(0, 400));
                db.close();
                throw err;
            }
            const durationMs = Date.now() - started;
            recordIntegrityOutcome(path, verdict === "ok", durationMs, verdict === "ok" ? undefined : verdict.slice(0, 400));
            if (verdict !== "ok") {
                db.close();
                throw new StorageIntegrityError(path, verdict.slice(0, 400));
            }
            writeIntegrityCache(path, true);
            integrityOk = true;
        }
        // #4175: second-process-on-the-same-db detection. A live foreign pid
        // is reported loudly (web wire + banner) but never blocks — blocking
        // would brick the second lane outright; the documented posture is one
        // #3633 instance per session directory. A dead pid means a stale
        // lock: take it over.
        const lockPath = `${path}.lock`;
        let foreignLockHolder: { pid: number } | null = null;
        try {
            if (existsSync(lockPath)) {
                const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
                const pid = typeof parsed.pid === "number" ? parsed.pid : null;
                if (pid !== null && pid !== process.pid && processAlive(pid)) {
                    foreignLockHolder = { pid };
                    // #3923/#3959: a live foreign pid that maps to a KNOWN bili
                    // instance of a DIFFERENT lane is the deliberate shared-directory
                    // topology — informational, not a corruption alarm. When stale
                    // entries share the pid (restarted instance), the newest
                    // startedAt is the live one.
                    const peer = listInstances()
                        .filter((e) => e.pid === pid)
                        .reduce<RegistryEntry | undefined>((best, e) => (best === undefined || (e.startedAt ?? 0) > (best.startedAt ?? 0) ? e : best), undefined);
                    const ownLane = process.env.BILI_LAUNCHER_LANE?.trim() || undefined;
                    const benign = peer !== undefined && ownLane !== undefined && peer.lane !== undefined && peer.lane !== ownLane;
                    if (benign) {
                        loggerLog("info", `[storage] process (pid ${pid}, lane ${peer?.lane}, instance ${peer?.instanceId.slice(0, 8)}) is also using ${path} — different lanes sharing one sessions directory is the supported topology (#3923/#3959); informational only.`);
                    } else {
                        loggerLog("error", `[storage] another process (pid ${pid}) is already writing ${path} — two processes on one index.db corrupt it (#3923/#3959). One session dir must have exactly one instance (#3633); this lane keeps running but the condition is reported.`);
                    }
                    recordSecondProcessOwner(pid, { lane: peer?.lane, instanceId: peer?.instanceId, benign });
                }
            }
            writeFileSync(lockPath, JSON.stringify({ pid: process.pid, boot: Date.now() }));
        } catch (err) {
            loggerLog("warn", `[storage] lockfile discipline skipped for ${path}: ${String(err)}`);
        }
        try {
            const limit = opts?.walJournalSizeLimitBytes ?? WAL_JOURNAL_SIZE_LIMIT;
            for (const pragma of storagePragmas(limit)) db.exec(pragma);
            migrateSchema(db);
        } catch (err) {
            // The handle we just opened must not leak when the file turns out
            // to be corrupt: the #2771 fallback tells operators to DELETE the
            // file to reset the index — and Windows refuses to delete a file a
            // live process still holds open. Close, then rethrow for the
            // shadow's legacy-only degradation.
            db.close();
            throw err;
        }
        // #3250: converge the WAL an unclean exit left behind (SIGKILL / power
        // loss never reaches close()). Moving committed frames into the main db
        // now shortens the NEXT crash's recovery replay. Isolated from the open
        // contract above on purpose: under a multi-process shared directory
        // (#2671) a TRUNCATE can come back busy while a foreign connection is
        // mid-transaction — that must log, not fail the open; the periodic and
        // close-time passes retry the reclamation.
        try {
            db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        } catch (err) {
            loggerLog("warn", `[storage] WAL checkpoint on open failed for ${path}: ${String(err)}`);
        }
        const store = new UnifiedStore(db, used, source, lockPath, foreignLockHolder, path);
        if (integrityOk) store.noteIntegrityOk();
        // #4609: a large store's cache-miss check runs post-open on a second
        // read-only connection — open() returns immediately; the verdict
        // lands in runtime-status and the cache (a cached failure makes the
        // NEXT open quarantine + reopen fresh via the #4175 path).
        if (mode.kind === "async") scheduleBackgroundIntegrityCheck(path, (ok) => { if (ok) store.noteIntegrityOk(); });
        return store;
    }

    /** #4609: mark this instance's file set as verified (sync check ok,
     * cache hit, or background verdict ok) so a clean close refreshes the
     * verdict cache onto the post-checkpoint stats. */
    noteIntegrityOk(): void {
        this.lastIntegrityOk = true;
    }

    close(): void {
        // #3250: converge the WAL before releasing the handle so a clean exit
        // leaves nothing for the next boot's recovery to replay. Same isolation
        // as open(): a checkpoint hiccup logs and never throws — callers treat
        // close() as best-effort shutdown work.
        try {
            this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        } catch (err) {
            loggerLog("warn", `[storage] WAL checkpoint on close failed: ${String(err)}`);
        }
        this.db.close();
        // #4609: a clean close of a verified store refreshes the verdict
        // cache onto the post-checkpoint stats — the normal restart path then
        // skips the rescan. Deferred while a background check is still in
        // flight (its own completion writes the cache). Best-effort.
        if (this.lastIntegrityOk && !backgroundIntegrityInflightForTests(this.dbPath)) {
            writeIntegrityCache(this.dbPath, true);
        }
        // #4175: release the ownership lockfile on a clean close so the next
        // open in another process is not told a dead pid holds it. When a
        // foreign holder was reported at open we never owned the lock — leave it.
        if (this.lockPath !== null && this.foreignLockHolder === null) {
            try {
                unlinkSync(this.lockPath);
            } catch {
                /* best-effort: a stale lock is taken over at next open */
            }
        }
    }

    /** #4175: the live foreign pid seen holding <db>.lock at open, or null. */
    lockHolder(): { pid: number } | null {
        return this.foreignLockHolder;
    }

    /**
     * #4175: online consistent snapshot via SQLite's native VACUUM INTO —
     * safe while WAL writers are active (it reads a consistent snapshot and
     * never blocks them). Refuses an existing target (atomicity discipline:
     * a backup path is produced exactly once). Returns the produced byte
     * length.
     */
    backupInto(dstPath: string): number {
        if (existsSync(dstPath)) {
            throw new Error(`[storage] backup target already exists: ${dstPath}`);
        }
        mkdirSync(dirname(dstPath), { recursive: true });
        const quoted = dstPath.replace(/'/g, "''");
        this.db.exec(`VACUUM INTO '${quoted}'`);
        recordBackupOutcome(dstPath, statSync(dstPath).size);
        return statSync(dstPath).size;
    }

    /** #3049: O(1) ownership probe for the persist stale-guard. Reads only
     *  the two monotonic counters the rollback guard compares (stats.requests,
     *  state.nextBlockId) — never the payload columns — so the guard can skip
     *  its full envelope read+parse when nothing else has committed since this
     *  process's last save. next_block_id is a dedicated column; requests is
     *  the one small stats_json parse. Null = no row yet (organic import
     *  pending / foreign id). */
    sessionCounters(sessionId: string): { requests: number; nextBlockId: number } | null {
        const row = this.db
            .prepare("SELECT next_block_id, stats_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { next_block_id: number; stats_json: string } | undefined;
        if (!row) return null;
        try {
            const stats = JSON.parse(row.stats_json) as { requests?: unknown };
            return {
                requests: typeof stats.requests === "number" ? stats.requests : 0,
                nextBlockId: row.next_block_id,
            };
        } catch {
            return null;
        }
    }

    /** Content CAS: insert-if-absent + refcount bump; returns hash. */
    private putContent(content: string | Buffer, precomputedHash?: string): string {
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        // #3133: planner-produced rows carry the digest from their intern or
        // delta pass — skip the per-message re-hash here (same value: sha256
        // over the same utf8 bytes). Only direct callers without a planner
        // pay the hash at this layer.
        const hash = precomputedHash ?? sha256Hex(bytes);
        const existing = this.db.prepare("SELECT refcount FROM content WHERE hash = ?").get(hash) as
            | { refcount: number }
            | undefined;
        if (existing) {
            this.db.prepare("UPDATE content SET refcount = refcount + 1 WHERE hash = ?").run(hash);
        } else {
            this.db
                .prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)")
                .run(hash, bytes.byteLength, bytes);
        }
        return hash;
    }

    /** refcount-aware release; the CAS body itself never leaves. */
    /** #4242: merge the incoming orphan map over the journal's current
     *  contents. Incoming entries win on key collision (same id, refreshed
     *  view); existing entries the live session no longer carries (trimmed
     *  from memory by LazyBlockContents) survive. */
    private mergeOrphansJson(sessionId: string, incomingJson: string | null): string | null {
        if (incomingJson === null) {
            // No orphans in this save — keep whatever the journal already
            // holds (a previous reap's trimmed-away contents must survive).
            const row = this.db
                .prepare("SELECT orphans_json FROM sessions WHERE session_id = ?")
                .get(sessionId) as { orphans_json: string | null } | undefined;
            return row?.orphans_json ?? null;
        }
        let merged: Record<string, unknown> = {};
        try {
            const existing = this.db
                .prepare("SELECT orphans_json FROM sessions WHERE session_id = ?")
                .get(sessionId) as { orphans_json: string | null } | undefined;
            if (existing?.orphans_json) {
                const parsed = JSON.parse(existing.orphans_json) as Record<string, unknown>;
                if (parsed && typeof parsed === "object") merged = parsed;
            }
        } catch {
            // corrupt journal → start fresh (loadLegacyView skips bad entries too)
        }
        try {
            const incoming = JSON.parse(incomingJson) as Record<string, unknown>;
            if (incoming && typeof incoming === "object") merged = { ...merged, ...incoming };
        } catch {
            // corrupt incoming → keep existing only
        }
        return Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
    }

    private releaseContent(hash: string | null): void {
        if (!hash) return;
        // #3987 / #4242: delete-on-zero. The old decrement-only update left
        // zero-refcount rows behind (11.32 GB of orphans on a real corpus)
        // because the only sweeps lived in deleteSession()/gc(), which nobody
        // runs on a schedule. Releasing the LAST reference now removes the
        // row in the same statement — orphans cannot structurally accumulate.
        // Re-putContent of the same bytes re-inserts cleanly (putContent is
        // upsert), so no correctness change, only no-leak.
        this.db
            .prepare(
                "UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0 RETURNING refcount",
            )
            .all(hash)
            .forEach((row) => {
                if ((row as { refcount: number }).refcount <= 0) {
                    this.db.prepare("DELETE FROM content WHERE hash = ? AND refcount <= 0").run(hash);
                }
            });
    }

    /** Ingests one session plan as a single transaction. Full path (no
     *  `delta`): identity-based absolute-seq remap of every plan row; the
     *  watermark becomes the abs seq backing the plan's LAST tail message
     *  (NULL when the plan carries no tail) — the trusted tip need not be
     *  the table's max, because delta appends anchor at max(seq)+1, never
     *  at watermark+1, so rows above the tip (a fold's summary) cannot
     *  collide with them.
     *
     *  Delta path (#3133, `delta` given): the plan carries ONLY messages
     *  past the trusted prefix, with placeholder seqs (renumbered here).
     *  The boundary row (msg_id + content_hash at seq trustedSeq) is
     *  RE-VERIFIED inside this transaction (BEGIN IMMEDIATE serializes
     *  writers, so the in-tx check is authoritative — the caller's pre-plan
     *  probe was just an optimization), every delta message's identity must
     *  be absent (strictly-append — a re-derived tail would otherwise be
     *  silently dropped by the UNIQUE constraint), and new rows take
     *  max(seq)+1.. so no slot can collide. On any disagreement this
     *  returns false WITHOUT writing anything; the caller falls back to the
     *  full plan. A stale or foreign-written watermark therefore costs one
     *  redundant full write — never wrong rows — and the watermark write
     *  itself rides the SAME transaction as the rows. */
    ingestSession(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean },
    ): boolean {
        const s = input.session;
        const ok = this.db.transaction((): boolean => {
            let messages: MessageRow[];
            let watermark: number | null;
            if (delta) {
                const probe = this.probeIngestBoundary(s.sessionId, delta.trustedSeq);
                if (!probe || probe.msgId !== delta.boundaryMsgId || probe.contentHash !== delta.boundaryHash) {
                    return false;
                }
                // Strictly-append guard: a delta message whose identity
                // already has a row (rewound/re-derived tail) must not be
                // silently skipped by the UNIQUE(session_id, msg_id,
                // content_hash) constraint — its tailSeqs slot would point
                // at nothing and the read view would drop it. One indexed
                // probe per NEW message; any hit → full ingest instead.
                const existingIdentity = this.db.prepare(
                    "SELECT 1 FROM messages WHERE session_id = ? AND msg_id = ? AND identity = ?",
                );
                for (const m of input.messages) {
                    if (!m.contentHash) return false;
                    // #4390: join on identity (position-independent). Retired
                    // rows count as existing — a rewind-redo falls back to the
                    // full path, which reactivates the tombstone in place.
                    if (existingIdentity.get(s.sessionId, m.msgId, m.identity ?? identityOfStoredContent(m.content))) return false;
                }
                // Placeholder→absolute renumber: the plan emitted
                // watermark+1.. under the aligned assumption; anchoring at
                // the CURRENT max(seq)+1 (re-read inside this transaction)
                // is what makes slot collisions structurally impossible —
                // identical to the full path's nextSeq discipline, and it
                // keeps the delta valid even when a fold left rows above
                // the trusted tip.
                messages = input.messages.map((m, i) => ({ ...m, seq: probe.maxSeq + 1 + i }));
                const tail = JSON.parse(s.tailJson) as { tailSeqs?: number[] | null };
                // Defense: the plan's tailSeqs prefix must be exactly the
                // trusted prefix the watermark read produced (same-tick by
                // construction; disagreement means a stale plan).
                const prefixOk =
                    Array.isArray(tail.tailSeqs) &&
                    tail.tailSeqs.length === delta.trustedTailSeqs.length + input.messages.length &&
                    delta.trustedTailSeqs.every((v, i) => tail.tailSeqs?.[i] === v);
                if (!prefixOk) return false;
                s.tailJson = JSON.stringify({
                    ...tail,
                    tailSeqs: [...delta.trustedTailSeqs, ...messages.map((m) => m.seq)],
                });
                watermark = messages.length > 0 ? messages[messages.length - 1].seq : delta.trustedSeq;
            } else {
                const full = this.remapPlanToAbsolute(input);
                messages = full.messages;
                watermark = full.watermark;
                // #3285: authoritative-set discipline for messages — same as
                // blocks / refs / dead_refs / ccr_entries below, but ONLY when
                // completeLog says the plan IS the whole log (the raw tail).
                // Envelope-only plans are pruned renders (bounded folded view,
                // #2960 ⑤; folded-resident re-renders, persist ②a caveat), and
                // sweeping on those would delete raw rows that earlier saves
                // interned beyond the render window. With a complete plan,
                // rows whose identity is absent are stale — foreign-writer
                // leftovers from a restart-handoff overlap (#3285/#2671 shared
                // directory) or below-boundary rewrites the sampled digest
                // caught (#3166). INSERT OR IGNORE alone can never remove
                // them, so without this sweep they ride every unified replay
                // forever (permanent DIGEST DRIFT even after the #3166
                // watermark-clear heal). Release their CAS refs and drop them.
                //
                // LANE EXCLUSION (#3248): the incremental lane consumes this
                // table POSITIONALLY — its baseSeq epoch is an absolute row
                // count recorded at resync, and rejected-branch rows must stay
                // in the table as an audit floor the served history slices
                // past. Sweeping them would invalidate the epoch (cold rebuild
                // serves an empty canonical → 409 loop). Lane-owned sessions
                // therefore opt out; they keep #3166-class orphans (bounded —
                // the boot watermark reset still re-establishes delta trust).
                if (opts?.completeLog === true && !this.hasLaneExt(s.sessionId)) {
                    const incomingIds = new Set<string>();
                    for (const m of messages) {
                        incomingIds.add(`${m.msgId}\u0000${m.identity ?? identityOfStoredContent(m.content)}`);
                    }
                    const staleRows = this.db
                        .prepare("SELECT seq, msg_id, identity, retired_at FROM messages WHERE session_id = ?")
                        .all(s.sessionId) as { seq: number; msg_id: string; identity: string; retired_at: number | null }[];
                    for (const row of staleRows) {
                        if (incomingIds.has(`${row.msg_id}\u0000${row.identity}`)) {
                            // #4390 rewind-redo: the identity came back —
                            // reactivate the tombstone at its original seq.
                            if (row.retired_at !== null) {
                                this.db
                                    .prepare("UPDATE messages SET retired_at = NULL WHERE session_id = ? AND seq = ?")
                                    .run(s.sessionId, row.seq);
                            }
                            continue;
                        }
                        // #4390 historian sweep: the row is absent from the
                        // authoritative set — RETIRE it, don't delete. The
                        // unified store is the durable record of everything
                        // the client ever sent; a rewind/undo that drops a
                        // message from the view must tombstone it, not
                        // destroy the bytes (epoch-gate replays #3644 and
                        // rewind-redo both need the row to still exist —
                        // reactivation above restores it at the same seq).
                        // Retired rows leave the unified replay (getMessages
                        // filters them) so drift healing and the DIGEST
                        // reconcile keep working exactly as the DELETE did.
                        // TEXT CAS refs are NOT released: retired rows still
                        // own their bytes. MEDIA refs ARE released (#4506):
                        // image bytes are bulky and low-value as history —
                        // keeping them until archive (365d default) is the
                        // unbounded leak #3762/#3901 called out. The
                        // re-ingest path below re-establishes mappings and
                        // refcounts if the row ever reactivates.
                        this.db
                            .prepare("UPDATE messages SET retired_at = ? WHERE session_id = ? AND seq = ? AND retired_at IS NULL")
                            .run(Date.now(), s.sessionId, row.seq);
                        const retiredMedia = this.db
                            .prepare("SELECT media_hash FROM message_media WHERE session_id = ? AND seq = ?")
                            .all(s.sessionId, row.seq) as { media_hash: string }[];
                        this.db.prepare("DELETE FROM message_media WHERE session_id = ? AND seq = ?").run(s.sessionId, row.seq);
                        for (const rm of retiredMedia) this.releaseContent(rm.media_hash);
                    }
                }
            }
            this.db
                .prepare(
                    `INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin,
                       status, created_at, updated_at, next_block_id, next_run_id,
                       meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq, orphans_json)
                     VALUES (@sessionId, @parentSessionId, @forkPointSeq, @protocol, @label, @title, @hostTitle, @namespace, @origin,
                       @status, @createdAt, @updatedAt, @nextBlockId, @nextRunId,
                       @metaJson, @statsJson, @metadataJson, @kstateJson, @tailJson, @ccrJson, @lastIngestedSeq, @orphansJson)
                     ON CONFLICT(session_id) DO UPDATE SET
                       parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
                       fork_point_seq = COALESCE(excluded.fork_point_seq, sessions.fork_point_seq),
                       protocol = excluded.protocol,
                       label = excluded.label,
                       title = excluded.title,
                       host_title = excluded.host_title,
                       namespace = excluded.namespace,
                       origin = excluded.origin,
                       status = excluded.status,
                       updated_at = excluded.updated_at,
                       next_block_id = excluded.next_block_id,
                       next_run_id = excluded.next_run_id,
                       meta_json = excluded.meta_json,
                       stats_json = excluded.stats_json,
                       metadata_json = excluded.metadata_json,
                       kstate_json = excluded.kstate_json,
                       tail_json = excluded.tail_json,
                       ccr_json = excluded.ccr_json,
                       last_ingested_seq = excluded.last_ingested_seq,
                       orphans_json = excluded.orphans_json`,
                )
                .run({
                    sessionId: s.sessionId,
                    parentSessionId: s.parentSessionId ?? null,
                    forkPointSeq: s.forkPointSeq ?? null,
                    protocol: s.protocol ?? null,
                    label: s.label ?? null,
                    title: s.title ?? null,
                    hostTitle: s.hostTitle ?? null,
                    namespace: s.namespace ?? "proxy",
                    origin: s.origin ?? null,
                    status: s.status ?? "active",
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    nextBlockId: s.nextBlockId,
                    nextRunId: s.nextRunId,
                    metaJson: s.metaJson,
                    statsJson: s.statsJson,
                    metadataJson: s.metadataJson,
                    kstateJson: s.kstateJson,
                    tailJson: s.tailJson,
                    ccrJson: s.ccrJson,
                    lastIngestedSeq: watermark,
                    // #4216/#4242: orphan journal rides the normal upsert with
                    // MERGE semantics (existing entries survive — LazyBlockContents
                    // means the live map may not carry trimmed entries).
                    orphansJson: this.mergeOrphansJson(s.sessionId, s.orphansJson ?? null),
                });

            // Identity index (#2960 R2.1): claim (namespace, conversation_id)
            // → session_id. ON CONFLICT DO NOTHING — first claimant wins; while
            // the v1 mapping is the identity a re-ingest is the same triple.
            this.db
                .prepare(
                    "INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES (?, ?, ?, ?) " +
                        "ON CONFLICT(namespace, conversation_id) DO NOTHING",
                )
                .run(s.namespace ?? "proxy", s.sessionId, s.sessionId, s.updatedAt);

            for (const m of messages) {
                const hash = this.putContent(m.content, m.contentHash);
                const res = this.db
                    .prepare(
                        "INSERT OR IGNORE INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .run(s.sessionId, m.seq, m.msgId, m.ref, m.refNum, m.role, m.kind, hash, m.identity ?? identityOfStoredContent(m.content));
                if (res.changes === 0) {
                    // Idempotent re-receipt: the CAS row is still referenced
                    // by the existing message row — undo our refcount bump.
                    this.releaseContent(hash);
                    // #4506: an existing row may be a tombstone REACTIVATING
                    // (its message_media mappings were released at retire).
                    // The same idempotent upsert below restores mapping +
                    // refcount; for ordinary re-ingests (mapping still there)
                    // the release-on-no-change undoes the bump — net zero.
                    if (m.media && m.media.length > 0) {
                        for (const md of m.media) {
                            this.putContent(md.bytes, md.hash);
                            const mmr = this.db
                                .prepare("INSERT OR IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)")
                                .run(s.sessionId, m.seq, md.hash);
                            if (mmr.changes === 0) this.releaseContent(md.hash);
                        }
                    }
                } else if (m.media && m.media.length > 0) {
                    // #3762: put the media bytes + mapping rows; refcount per
                    // message row that actually landed (INSERT OR IGNORE on
                    // the mapping keeps re-ingest of the same (seq, hash)
                    // from double-bumping).
                    for (const md of m.media) {
                        this.putContent(md.bytes, md.hash);
                        const mm = this.db
                            .prepare("INSERT OR IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)")
                            .run(s.sessionId, m.seq, md.hash);
                        if (mm.changes === 0) this.releaseContent(md.hash);
                    }
                }
            }

            // blocks: the incoming set is AUTHORITATIVE. Upsert alone leaves
            // rows for blocks that no longer exist (e.g. #2695 zombie reaping
            // via reapDestroyedSubstrate) — they would resurrect on every
            // unified load. Drop absent ids first, releasing their content
            // refs inside the same transaction (deleteSession discipline).
            const incomingBlockIds = new Set(input.blocks.map((b) => b.blockId));
            const staleBlocks = this.db
                .prepare("SELECT block_id, summary_hash, one_hash FROM blocks WHERE session_id = ?")
                .all(s.sessionId) as Array<{ block_id: string; summary_hash: string; one_hash: string | null }>;
            for (const stale of staleBlocks) {
                if (incomingBlockIds.has(stale.block_id)) continue;
                // referencing row first, then release (#4242 delete-on-zero)
                this.db.prepare("DELETE FROM blocks WHERE session_id = ? AND block_id = ?").run(s.sessionId, stale.block_id);
                this.releaseContent(stale.summary_hash);
                if (stale.one_hash !== null) this.releaseContent(stale.one_hash);
            }
            // #4316 layer 3: resolve each block's coverage to canonical seq
            // bounds from the append-only transcript. Final absolute seqs exist
            // only here (delta placeholders are renumbered in-transaction), so
            // the pure planner cannot know them. Coverage whose ids have no
            // transcript row (imported pre-fold) stores the -1 "no claim"
            // sentinel — a [0,0] would read back as a REAL claim over seq 0
            // and suppress the seq-0 message (PR #4725 N1); -1 keeps the
            // #4608 CASE guard honest (unknown < 0 → preserve stored bounds).
            const seqSpanById = new Map<string, [number, number]>();
            if (input.blocks.length > 0) {
                // point query over the covered ids only (PR #4725 N3): a
                // full-session scan per save taxed every session with blocks.
                const wanted = new Set<string>();
                for (const b of input.blocks) {
                    try {
                        const cov = JSON.parse(b.payloadJson) as { effectiveMessageIds?: string[]; directMessageIds?: string[] };
                        for (const id of [...(cov.effectiveMessageIds ?? []), ...(cov.directMessageIds ?? [])]) wanted.add(id);
                    } catch { /* malformed payload: no covered ids to resolve */ }
                }
                // LIVE rows only (#4801 review): block bounds describe what is
                // CURRENTLY covered in the unified replay — getMessages filters
                // retired rows, so a bound spanning a retired generation would
                // claim coverage over rows the replay never serves (a pinned-id
                // edit/rewind leaves the old generation tombstoned while its id
                // is re-covered at a new seq). An id whose rows are all retired
                // yields no span → boundsForCovered demotes it honestly; if that
                // empties the whole claim the -1 sentinel preserves stored bounds (#4608).
                const wantedIds = Array.from(wanted);
                for (let i = 0; i < wantedIds.length; i += SEQ_SPAN_QUERY_BATCH) {
                    const ids = wantedIds.slice(i, i + SEQ_SPAN_QUERY_BATCH);
                    const rows = this.db
                        .prepare(`SELECT msg_id, seq FROM messages WHERE session_id = ? AND msg_id IN (${ids.map(() => "?").join(", ")}) AND retired_at IS NULL`)
                        .all(s.sessionId, ...ids) as Array<{ msg_id: string; seq: number }>;
                    for (const r of rows) {
                        const cur = seqSpanById.get(r.msg_id);
                        if (!cur) seqSpanById.set(r.msg_id, [r.seq, r.seq]);
                        else {
                            if (r.seq < cur[0]) cur[0] = r.seq;
                            if (r.seq > cur[1]) cur[1] = r.seq;
                        }
                    }
                }
            }
            const boundsForCovered = (payloadJson: string): [number, number] => {
                let lo = Number.POSITIVE_INFINITY;
                let hi = -1;
                try {
                    const cov = JSON.parse(payloadJson) as { effectiveMessageIds?: string[]; directMessageIds?: string[] };
                    for (const id of [...(cov.effectiveMessageIds ?? []), ...(cov.directMessageIds ?? [])]) {
                        const sp = seqSpanById.get(id);
                        if (!sp) continue;
                        if (sp[0] < lo) lo = sp[0];
                        if (sp[1] > hi) hi = sp[1];
                    }
                } catch { /* malformed payload: keep the no-claim sentinel */ }
                return hi < 0 ? [-1, -1] : [lo, hi];
            };
            for (const b of input.blocks) {
                const [bStartSeq, bEndSeq] = boundsForCovered(b.payloadJson);
                const summaryHash = this.putContent(b.summary);
                const oneHash = b.one === null ? null : this.putContent(b.one);
                // Re-ingest of the same block id replaces the row (dry-run
                // idempotence). Refcount math must distinguish identical
                // re-ingest (bump then undo) from a true replacement (release
                // the old hash, keep the new bump) — otherwise identical
                // re-ingest drives the surviving refcount to zero.
                const existing = this.db
                    .prepare("SELECT summary_hash, one_hash FROM blocks WHERE session_id = ? AND block_id = ?")
                    .get(s.sessionId, b.blockId) as { summary_hash: string; one_hash: string | null } | undefined;
                if (existing) {
                    // #4608: preserve interval bounds across resaves. A later batch that
                    // no longer contains the covered raws (a post-fold client resend sees
                    // the folded view, not the raw tail) re-derives -1/-1 "unknown" from
                    // its own log; once real evidence exists it is durable — the upsert's
                    // CASE keeps the stored bounds when the incoming side is unknown.
                    // #4242: redirect the row BEFORE the undo/release so a
                    // released-to-zero old hash is no longer FK-referenced by
                    // this blocks row when the content DELETE fires. The
                    // identical-re-ingest undo (same hash) is a pure -1
                    // against the +1 bump and cannot reach zero while the row
                    // itself holds the reference.
                    // Re-saves bind the TRANSCRIPT-resolved bounds (same source
                    // as the fresh-insert branch below), never the plan-local
                    // b.startSeq/endSeq: those are positions in THIS plan's log,
                    // and once a covered id's old generation is tombstoned (an
                    // in-place edit lands the new one past max(seq)) they no
                    // longer coincide with absolute seqs — writing them would
                    // clobber the durable interval with plan-relative numbers.
                    this.db
                        .prepare(
                            `INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier,
                               summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                              ON CONFLICT(session_id, block_id) DO UPDATE SET
                                ord = excluded.ord,
                                start_seq = CASE WHEN excluded.start_seq >= 0 THEN excluded.start_seq ELSE blocks.start_seq END,
                                end_seq = CASE WHEN excluded.end_seq >= 0 THEN excluded.end_seq ELSE blocks.end_seq END,
                                start_ref = excluded.start_ref, end_ref = excluded.end_ref, tier = excluded.tier,
                                summary_hash = excluded.summary_hash, one_hash = excluded.one_hash,
                                supersedes_block_id = excluded.supersedes_block_id, active = excluded.active,
                                created_at = excluded.created_at, covered_hash = excluded.covered_hash,
                                payload_json = excluded.payload_json`,
                        )
                        .run(
                            b.blockId,
                            s.sessionId,
                            b.ord,
                            bStartSeq,
                            bEndSeq,
                            b.startRef,
                            b.endRef,
                            b.tier,
                            summaryHash,
                            oneHash,
                            b.supersedesBlockId,
                            b.active ? 1 : 0,
                            b.createdAt,
                            b.coveredHash,
                            b.payloadJson,
                        );
                    if (existing.summary_hash === summaryHash) this.releaseContent(summaryHash);
                    else this.releaseContent(existing.summary_hash);
                    if (existing.one_hash !== null) {
                        if (existing.one_hash === oneHash && oneHash !== null) this.releaseContent(oneHash);
                        else this.releaseContent(existing.one_hash);
                    }
                    continue;
                }
                this.db
                    .prepare(
                        `INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier,
                           summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(session_id, block_id) DO UPDATE SET
                           ord = excluded.ord,
                           start_seq = CASE WHEN excluded.start_seq >= 0 THEN excluded.start_seq ELSE blocks.start_seq END,
                           end_seq = CASE WHEN excluded.end_seq >= 0 THEN excluded.end_seq ELSE blocks.end_seq END,
                           start_ref = excluded.start_ref, end_ref = excluded.end_ref, tier = excluded.tier,
                           summary_hash = excluded.summary_hash, one_hash = excluded.one_hash,
                           supersedes_block_id = excluded.supersedes_block_id, active = excluded.active,
                           created_at = excluded.created_at, covered_hash = excluded.covered_hash,
                           payload_json = excluded.payload_json`,
                    )
                    .run(
                        b.blockId,
                        s.sessionId,
                        b.ord,
                        bStartSeq,
                        bEndSeq,
                        b.startRef,
                        b.endRef,
                        b.tier,
                        summaryHash,
                        oneHash,
                        b.supersedesBlockId,
                        b.active ? 1 : 0,
                        b.createdAt,
                        b.coveredHash,
                        b.payloadJson,
                    );
            }

            // dead_refs: tombstones can be LIFTED (backing message
            // reappears) — the array is authoritative, so rows at ords the
            // incoming set no longer covers are stale and must go.
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ? AND ord >= ?").run(s.sessionId, input.deadRefs.length);
            for (const d of input.deadRefs) {
                this.db
                    .prepare(
                        "INSERT INTO dead_refs (session_id, ord, ref, ref_num, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, ord) DO UPDATE SET ref = excluded.ref, ref_num = excluded.ref_num, recorded_at = excluded.recorded_at",
                    )
                    .run(s.sessionId, d.ord, d.ref, d.refNum, d.recordedAt);
            }

            // refs: the incoming array is AUTHORITATIVE — native compaction
            // and the #2695 zombie reap renumber byRaw/byRef (survivors move
            // to lower ords, pruned ids vanish). Upserting onto that shape
            // either hits the (session_id, ord) PK (ingest rolls back, 3-strike
            // self-disable — review #2690 blocking 1) or leaves ghost rows that
            // make the loaded map strictly larger than legacy (permanent
            // DIGEST DRIFT spam — blocking 2). Replace the whole set.
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(s.sessionId);
            for (const r of input.refs) {
                this.db
                    .prepare(
                        "INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, raw_id) DO UPDATE SET ord = excluded.ord, ref = excluded.ref, ref_num = excluded.ref_num",
                    )
                    .run(s.sessionId, r.ord, r.rawId, r.ref, r.refNum);
            }

            // ccr_entries: the content store is a map whose keys can be
            // dropped — full-replace keeps the table authoritative. Release
            // every old hash first, then re-insert (idempotent: identical
            // sets cancel out bump+release).
            const oldCcr = this.db
                .prepare("SELECT content_hash FROM ccr_entries WHERE session_id = ?")
                .all(s.sessionId) as { content_hash: string }[];
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(s.sessionId);
            for (const row of oldCcr) this.releaseContent(row.content_hash);
            for (const e of input.ccrEntries) {
                const hash = this.putContent(e.content);
                this.db
                    .prepare("INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)")
                    .run(s.sessionId, e.ord, e.key, hash);
            }
            return true;
        });
        if (ok) this.maybeCheckpointWal();
        return ok;
    }

    /** #3250: cadence-tick WAL reclamation (see WAL_CHECKPOINT_EVERY_INGESTS).
     *  Never throws into the ingest path — a failed checkpoint just leaves the
     *  WAL longer than ideal until the next tick. */
    private maybeCheckpointWal(): void {
        this.ingestCount += 1;
        if (this.ingestCount % WAL_CHECKPOINT_EVERY_INGESTS !== 0) return;
        try {
            // Log the result: operators tuning storage.walJournalSizeLimitBytes
            // need to see whether ticks are actually reclaiming frames.
            const row = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
            loggerLog(
                "debug",
                `[storage] periodic WAL checkpoint at ingest ${this.ingestCount}: busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed}`,
            );
        } catch (err) {
            loggerLog("debug", `[storage] periodic WAL checkpoint failed at ingest ${this.ingestCount}: ${String(err)}`);
        }
    }

    /** Full-ingest path of ingestSession, extracted for readability: the
     *  absolute-seq remap plus the #3133 watermark alignment decision.
     *  Mutates input.session.tailJson (pointer sequences become absolute). */
    private remapPlanToAbsolute(input: IngestSessionInput): { messages: MessageRow[]; watermark: number | null } {
        const s = input.session;
        // Absolute-seq remap (#2671 soak finding): planIngest assigns seq
        // RELATIVE to the current snapshot's log (pluginSnapshot first,
        // then tail). For a folded session whose tail slides every save
        // (and no pluginSnapshot to pin the prefix), plan seq 0 re-bases
        // to a DIFFERENT message each save — while messages is keyed
        // (session_id, seq) with INSERT OR IGNORE, so the FIRST row wins
        // forever and tail pointers resolve to stale turns. Remap to
        // stable absolute seqs: same identity (msgId + content hash)
        // keeps its old seq; new identities continue after max(seq).
        const existing = this.db
            .prepare("SELECT seq, msg_id, identity, content_hash, retired_at FROM messages WHERE session_id = ?")
            .all(s.sessionId) as { seq: number; msg_id: string; identity: string; content_hash: string; retired_at: number | null }[];
        const seqByIdentity = new Map<string, number>();
        const hashBySeq = new Map<number, string>();
        const retiredSeqs: number[] = [];
        let nextSeq = 0;
        for (const row of existing) {
            // #4390: identity join — same logical message keeps its seq even
            // when its bytes were re-minted with shifted wire positions.
            // Retired rows still claim their seq (INSERT OR IGNORE would
            // silently drop a re-mint over their PK) and reactivation below
            // clears the tombstone when the identity comes back.
            if (row.retired_at !== null) retiredSeqs.push(row.seq);
            seqByIdentity.set(`${row.msg_id}\u0000${row.identity}`, row.seq);
            hashBySeq.set(row.seq, row.content_hash);
            if (row.seq + 1 > nextSeq) nextSeq = row.seq + 1;
        }
        // #3133 watermark gate (full path): the watermark names the abs seq
        // backing the plan's LAST tail message. It need not be the table's
        // max — a fold's summary lands above surviving old rows — because
        // delta appends anchor at max(seq)+1, never at watermark+1. NULL
        // when the plan carries no tail (envelope-only imports): the next
        // save runs the full ingest.
        const planToAbs = new Map<number, number>();
        const repairs: { seq: number; msgId: string; from: string; to: string; content: string }[] = [];
        const messages = input.messages.map((m) => {
            // #3133: plan rows carry the intern-pass hash; only direct
            // callers without a planner pay the sha256 here.
            const key = `${m.msgId}\u0000${m.identity ?? identityOfStoredContent(m.content)}`;
            let abs = seqByIdentity.get(key);
            if (abs === undefined) {
                abs = nextSeq++;
                seqByIdentity.set(key, abs);
            } else {
                // #4390 review: identity match + changed bytes (a wireIndex
                // re-mint after head truncation, sidecar drift, or external
                // CAS corruption) — INSERT OR IGNORE would silently keep the
                // stored generation forever: the parity oracle then drifts on
                // every sampled save (stale wireIndex vs live view) and the
                // heal path can never converge. Adopt the fresher bytes at
                // the SAME seq instead: seq stability (D4-1) is preserved,
                // the replay matches the authoritative view again, and a
                // corrupted row heals on the next full ingest.
                const fresh = m.contentHash ?? sha256Hex(m.content);
                const stored = hashBySeq.get(abs);
                if (stored !== undefined && stored !== fresh) repairs.push({ seq: abs, msgId: m.msgId, from: stored, to: fresh, content: m.content });
            }
            planToAbs.set(m.seq, abs);
            return { ...m, seq: abs };
        });
        for (const r of repairs) {
            // #4793: a sibling row may already hold the target bytes for this
            // msg_id — e.g. an old generation stamped with an EMPTY identity
            // by a pre-#4390 build while the plan re-derives the real one,
            // or two generations of the same edited message. identity is a
            // pure function of stable content, so any live row holding r.to
            // for this msg_id is a second generation of the SAME logical
            // message. UNIQUE(session_id, msg_id, content_hash) spans the
            // whole table including retired rows, so the UPDATE below would
            // throw and roll back the entire ingest unless those blockers are
            // cleared first; three such throws then trip the shadow's
            // process-wide 3-strike disable (one stuck session degraded every
            // other session's index, banner "SQLite storage degraded"). Same
            // content_hash ⇒ same CAS blob ⇒ retiring the sibling loses no
            // information, and our row keeps its stable seq (#4390 D4-1).
            this.db
                .prepare("UPDATE messages SET retired_at = ? WHERE session_id = ? AND msg_id = ? AND content_hash = ? AND seq <> ? AND retired_at IS NULL")
                .run(Date.now(), s.sessionId, r.msgId, r.to, r.seq);
            // A retired duplicate still occupies the triple (the constraint
            // is not partial): it is byte-identical, so dropping the row and
            // its media mappings loses nothing. Rare path; common case stays
            // single-statement above.
            const leftovers = this.db
                .prepare("SELECT seq FROM messages WHERE session_id = ? AND msg_id = ? AND content_hash = ? AND seq <> ? AND retired_at IS NOT NULL")
                .all(s.sessionId, r.msgId, r.to, r.seq) as { seq: number }[];
            if (leftovers.length > 0) {
                const selMedia = this.db.prepare("SELECT media_hash FROM message_media WHERE session_id = ? AND seq = ?");
                const delMedia = this.db.prepare("DELETE FROM message_media WHERE session_id = ? AND seq = ?");
                const delRow = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?");
                for (const l of leftovers) {
                    const leftoverMedia = selMedia.all(s.sessionId, l.seq) as { media_hash: string }[];
                    delMedia.run(s.sessionId, l.seq);
                    delRow.run(s.sessionId, l.seq);
                    // Every deleted row owned one refcount on r.to (bumped at
                    // its insert) and each of its mapping rows owned one on
                    // its media hash. Deleting without releasing is a
                    // permanent over-count — #4800's delete-on-zero GC can
                    // then never reclaim the blob. Same per-row discipline as
                    // deleteSession() and the retire path above.
                    this.releaseContent(r.to);
                    for (const lm of leftoverMedia) this.releaseContent(lm.media_hash);
                }
            }
            this.putContent(r.content, r.to);
            this.db.prepare("UPDATE messages SET content_hash = ? WHERE session_id = ? AND seq = ?").run(r.to, s.sessionId, r.seq);
            this.releaseContent(r.from);
        }
        // #4390: a rewound message that comes back reactivates in place —
        // the tombstone clears, the original seq is reused, and the view
        // heals without a duplicate row even on completeLog-less saves.
        for (const seq of retiredSeqs) {
            const back = messages.some((m) => m.seq === seq);
            if (back) this.db.prepare("UPDATE messages SET retired_at = NULL WHERE session_id = ? AND seq = ?").run(s.sessionId, seq);
        }
        const remapSeqs = (seqs: number[] | null | undefined): number[] | null | undefined =>
            seqs === null || seqs === undefined ? seqs : seqs.map((p) => planToAbs.get(p) ?? p);
        const pluginSnapshotSeqs = remapSeqs(input.pluginSnapshotSeqs);
        const tailSeqs = remapSeqs(input.tailSeqs);
        const watermark = tailSeqs !== null && tailSeqs !== undefined && tailSeqs.length > 0 ? tailSeqs[tailSeqs.length - 1] : null;
        s.tailJson = JSON.stringify({
            ...(JSON.parse(s.tailJson) as Record<string, unknown>),
            ...(pluginSnapshotSeqs !== undefined ? { pluginSnapshotSeqs } : {}),
            ...(tailSeqs !== undefined ? { tailSeqs } : {}),
        });
        return { messages, watermark };
    }

    /** #3133: the session's ingest watermark — the absolute seq backing the
     *  LAST message of the tail as ingested by the most recent save, plus
     *  that save's trusted tailSeqs (same transaction wrote both). NULL (or
     *  a shape that disagrees with tail_json — foreign write, partial
     *  upgrade) means "no trusted prefix": the next save runs the full
     *  ingest. Point read on the sessions PK. */
    ingestWatermark(sessionId: string): { seq: number; tailSeqs: number[] } | null {
        const row = this.db
            .prepare("SELECT last_ingested_seq, tail_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { last_ingested_seq: number | null; tail_json: string } | undefined;
        if (!row) return null;
        const seq = row.last_ingested_seq;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
        const tail = JSON.parse(row.tail_json) as { tailSeqs?: number[] | null };
        const seqs = tail.tailSeqs;
        if (!Array.isArray(seqs) || seqs.length === 0 || seqs[seqs.length - 1] !== seq) return null;
        return { seq, tailSeqs: seqs };
    }

    /** #3756 snapshot render: the sessions row's tail_json view — the seq
     *  pointer list of the logical transcript view (lastMessages order at
     *  save time). Unlike ingestWatermark this does NOT require a trusted
     *  watermark; it just reads the pointer list. Null when absent/malformed
     *  — the render lane degrades to legacy. */
    tailSeqs(sessionId: string): number[] | null {
        const row = this.db
            .prepare("SELECT tail_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { tail_json: string } | undefined;
        if (!row) return null;
        try {
            const tail = JSON.parse(row.tail_json) as { tailSeqs?: number[] | null };
            return Array.isArray(tail.tailSeqs) ? tail.tailSeqs : null;
        } catch {
            return null;
        }
    }

    /** #3166 review (heal half of the sampled-verify backstop): drop the
     *  durable watermark so the next save takes the exact full path and
     *  re-points every tail slot. Called when the read-back digest proves
     *  the stored prefix no longer matches the record of truth — without it
     *  every same-length save would re-take the unverified empty delta
     *  against a stale watermark and the divergence would be permanent. */
    clearIngestWatermark(sessionId: string): void {
        this.db.prepare("UPDATE sessions SET last_ingested_seq = NULL WHERE session_id = ?").run(sessionId);
    }

    /** #3285: drop EVERY session's ingest watermark at once. A watermark
     *  vouches "the writer that set it verified this prefix" but carries no
     *  writer identity, so the trust must not survive a process handoff:
     *  under the multi-process shared-directory contract (#2671) a
     *  restart-handoff overlap (old instance still draining while the new
     *  one boots, both sharing index.db) leaves a foreign process's rows
     *  AND its watermark behind, and inheriting that trust lets the new
     *  process take unverified empty deltas against rows it never wrote.
     *  Called once at writer init (UnifiedShadow.maybeOpen); pure readers
     *  (export) must not call it. After the reset each session's first save
     *  takes the exact full path — an authoritative replace, see
     *  ingestSession — re-establishing trust from this process's own view.
     *  Cost: one full ingest per saved session per boot. */
    resetAllIngestWatermarks(): void {
        this.db.prepare("UPDATE sessions SET last_ingested_seq = NULL").run();
    }

    /** #3248 lane-ownership probe for the message sweep (#3285): every ext
     *  key the incremental lane persists is "inc:"-prefixed, so any such key
     *  marks a session whose messages table the lane consumes positionally. */
    private hasLaneExt(sessionId: string): boolean {
        return this.db.prepare("SELECT 1 FROM session_ext WHERE session_id = ? AND key LIKE 'inc:%' LIMIT 1").get(sessionId) !== undefined;
    }

    /** #3133 boundary probe: the identity of the messages row at
     *  (session_id, seq) plus the session's current max seq — both lookups
     *  ride the PRIMARY KEY (session_id, seq) / idx_messages_session (no
     *  full existing-rows scan, no seqByIdentity map). null when the row is
     *  missing. The identity half is the trust decision; the max-seq half
     *  is the ANCHOR delta appends continue after (max+1, the same
     *  strictly-above discipline as the full path's remap, so appends can
     *  never collide with an existing slot — rows above the watermark,
     *  e.g. a fold's summary, are expected and harmless). */
    probeIngestBoundary(sessionId: string, seq: number): { msgId: string; contentHash: string; maxSeq: number } | null {
        const row = this.db
            .prepare("SELECT msg_id, content_hash FROM messages WHERE session_id = ? AND seq = ?")
            .get(sessionId, seq) as { msg_id: string; content_hash: string } | undefined;
        if (!row) return null;
        const max = this.db
            .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ?")
            .get(sessionId) as { m: number | null };
        return { msgId: row.msg_id, contentHash: row.content_hash, maxSeq: max.m ?? -1 };
    }

    /** #3919: identity-only point read backing the delta path's head probe —
     *  msg_id at (session_id, seq), null when the row is missing. PK lookup;
     *  id-only by design (content-derived ids make a rewrite visible without
     *  re-serializing a potentially MB-sized row). */
    headRowMsgId(sessionId: string, seq: number): string | null {
        const row = this.db
            .prepare("SELECT msg_id FROM messages WHERE session_id = ? AND seq = ?")
            .get(sessionId, seq) as { msg_id: string } | undefined;
        return row ? row.msg_id : null;
    }

    /** #3301: message rows for the given ids — EVERY seq row matching an id
     *  (edits append; callers keep the latest per id) plus, when
     *  includeNeighbors, the seq±1 rows so split-form rc pairs stay adjacent
     *  for turn-key derivation. Content bytes resolved via CAS; rows whose
     *  blob is gone are skipped. Read-only. */
    messagesForIds(sessionId: string, msgIds: readonly string[], includeNeighbors: boolean): { seq: number; msgId: string; content: string }[] {
        if (msgIds.length === 0) return [];
        const CHUNK = 500;
        const rows = new Map<number, { seq: number; msgId: string; contentHash: string }>();
        const neighborSeqs = new Set<number>();
        for (let i = 0; i < msgIds.length; i += CHUNK) {
            const chunk = msgIds.slice(i, i + CHUNK);
            const ph = chunk.map(() => "?").join(",");
            for (const r of this.db
                .prepare(`SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ? AND msg_id IN (${ph})`)
                .all(sessionId, ...chunk) as { seq: number; msg_id: string; content_hash: string }[]) {
                if (!rows.has(r.seq)) rows.set(r.seq, { seq: r.seq, msgId: r.msg_id, contentHash: r.content_hash });
                if (includeNeighbors) {
                    neighborSeqs.add(r.seq - 1);
                    neighborSeqs.add(r.seq + 1);
                }
            }
        }
        if (neighborSeqs.size > 0) {
            const seqs = [...neighborSeqs];
            for (let i = 0; i < seqs.length; i += CHUNK) {
                const chunk = seqs.slice(i, i + CHUNK);
                const ph = chunk.map(() => "?").join(",");
                for (const r of this.db
                    .prepare(`SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ? AND seq IN (${ph})`)
                    .all(sessionId, ...chunk) as { seq: number; msg_id: string; content_hash: string }[]) {
                    if (!rows.has(r.seq)) rows.set(r.seq, { seq: r.seq, msgId: r.msg_id, contentHash: r.content_hash });
                }
            }
        }
        const out: { seq: number; msgId: string; content: string }[] = [];
        for (const r of [...rows.values()].sort((a, b) => a.seq - b.seq)) {
            const content = this.getContent(r.contentHash);
            if (content !== null) out.push({ seq: r.seq, msgId: r.msgId, content });
        }
        return out;
    }

    /** Deletes one session and releases every CAS refcount it holds
     *  (GC parity with the legacy path's file removal). Rows that other
     *  sessions also reference survive via their own refcounts. Checkpoints
     *  of the session: PINNED ones survive (their state blob keeps its
     *  refcount — replica GC protection, #2671 Phase 2); unpinned ones are
     *  swept here together with the session. */
    /** #4738: message bodies addressed by their ref number (the mNNNNN
     *  identity in the web UI). Storage outlives the resident `lastMessages`
     *  window — host-side native compaction prunes that window client-side,
     *  so "gone from the window" must not read as "gone". Unknown refs simply
     *  come back absent; retired rows (rewound/undo history) stay excluded,
     *  matching every other view-lane reader. */
    messageContentByRefNums(sessionId: string, refNums: readonly number[]): MessageRefContentRow[] {
        if (refNums.length === 0) return [];
        const nums = [...new Set(refNums)];
        const CHUNK = 500;
        const out: MessageRefContentRow[] = [];
        for (let i = 0; i < nums.length; i += CHUNK) {
            const chunk = nums.slice(i, i + CHUNK);
            const ph = chunk.map(() => "?").join(",");
            for (const r of this.db
                .prepare(`SELECT ref_num, role, kind, content_hash FROM messages WHERE session_id = ? AND retired_at IS NULL AND ref_num IN (${ph})`)
                .all(sessionId, ...chunk) as { ref_num: number; role: string; kind: string; content_hash: string }[]) {
                const base = this.getContent(r.content_hash);
                if (base !== null) out.push({ refNum: r.ref_num, role: r.role, kind: r.kind, content: this.hydrateMedia(base) });
            }
        }
        return out.sort((a, b) => a.refNum - b.refNum);
    }

    /** #3841 reap journal: targeted update for the orphan shape (#2695 reap —
     *  state.blocks loses the entry, blockContents keeps the text). The full
     *  ingest skips orphan-shaped records (envelope-served, owner-pinned
     *  semantics: imports 0, never gutted into the index), which used to
     *  leave the REAPED block rows in the table — a restart's viewFor rebuild
     *  resurrected them and the next save polluted the envelope. Instead:
     *  drop exactly the reaped rows (releasing their content refs,
     *  deleteSession discipline) and journal the orphan contents into
     *  sessions.orphans_json so loadLegacyView can rebuild blockContents
     *  without resurrecting state.blocks. Idempotent; unknown ids no-op. */
    reapBlocks(sessionId: string, reapedIds: Set<string>, orphanContents: Map<string, { one: unknown; full: unknown }>): void {
        if (reapedIds.size === 0 && orphanContents.size === 0) return;
        this.db.transaction(() => {
            for (const blockId of reapedIds) {
                const row = this.db
                    .prepare("SELECT summary_hash, one_hash FROM blocks WHERE session_id = ? AND block_id = ?")
                    .get(sessionId, blockId) as { summary_hash: string; one_hash: string | null } | undefined;
                if (!row) continue;
                this.db.prepare("DELETE FROM blocks WHERE session_id = ? AND block_id = ?").run(sessionId, blockId);
                this.releaseContent(row.summary_hash);
                if (row.one_hash !== null) this.releaseContent(row.one_hash);
            }
            if (orphanContents.size > 0) {
                const sess = this.db
                    .prepare("SELECT orphans_json FROM sessions WHERE session_id = ?")
                    .get(sessionId) as { orphans_json: string | null } | undefined;
                if (sess) {
                    let merged: Record<string, unknown> = {};
                    try {
                        const parsed = JSON.parse(sess.orphans_json ?? "{}") as unknown;
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) merged = parsed as Record<string, unknown>;
                    } catch {
                        // corrupt journal → start fresh rather than losing the reap
                    }
                    for (const [blockId, view] of orphanContents) merged[blockId] = view;
                    this.db.prepare("UPDATE sessions SET orphans_json = ? WHERE session_id = ?").run(JSON.stringify(merged), sessionId);
                }
            }
        });
    }

    deleteSession(sessionId: string): void {
        this.db.transaction(() => {
            const refs: string[] = [];
            for (const m of this.db
                .prepare("SELECT content_hash FROM messages WHERE session_id = ?")
                .all(sessionId) as { content_hash: string }[]) refs.push(m.content_hash);
            // #3762: media mappings ride the message sweep — one release per
            // mapping row, then the rows go.
            for (const mm of this.db
                .prepare("SELECT media_hash FROM message_media WHERE session_id = ?")
                .all(sessionId) as { media_hash: string }[]) refs.push(mm.media_hash);
            for (const b of this.db
                .prepare("SELECT summary_hash, one_hash FROM blocks WHERE session_id = ?")
                .all(sessionId) as { summary_hash: string; one_hash: string | null }[]) {
                refs.push(b.summary_hash);
                if (b.one_hash !== null) refs.push(b.one_hash);
            }
            for (const e of this.db
                .prepare("SELECT content_hash FROM ccr_entries WHERE session_id = ?")
                .all(sessionId) as { content_hash: string }[]) refs.push(e.content_hash);
            // Checkpoints: pinned replicas keep their rows + CAS refcounts; the
            // rest die with the session.
            for (const cp of this.db
                .prepare("SELECT cp_id, state_hash FROM checkpoints WHERE session_id = ? AND pinned = 0")
                .all(sessionId) as { cp_id: string; state_hash: string }[]) {
                this.db.prepare("DELETE FROM checkpoints WHERE cp_id = ?").run(cp.cp_id);
                refs.push(cp.state_hash);
            }
            this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM message_media WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM blocks WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM conversations WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
            for (const hash of refs) this.releaseContent(hash);
            // CAS rows at zero refcount are unreferenced garbage — collect.
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
        });
    }

    /** #3928: per-session storage footprint for `bili sessions ls`. Counts
     *  never cascade into each other: inline bytes cover only JSON columns,
     *  CAS bytes only content-addressed blobs; the CAS split by refcount
     *  mirrors exactly what deleteSession frees. */
    sessionStorageStats(sessionId: string): SessionStorageStats {
        const counts = this.db
            .prepare(
                "SELECT " +
                    "(SELECT COUNT(*) FROM messages WHERE session_id = ?) AS messages, " +
                    "(SELECT COUNT(*) FROM message_media WHERE session_id = ?) AS media, " +
                    "(SELECT COUNT(*) FROM blocks WHERE session_id = ?) AS blocks, " +
                    "(SELECT COUNT(*) FROM dead_refs WHERE session_id = ?) AS deadRefs, " +
                    "(SELECT COUNT(*) FROM refs WHERE session_id = ?) AS refs, " +
                    "(SELECT COUNT(*) FROM ccr_entries WHERE session_id = ?) AS ccrEntries, " +
                    "(SELECT COUNT(*) FROM session_ext WHERE session_id = ?) AS ext, " +
                    "(SELECT COUNT(*) FROM checkpoints WHERE session_id = ?) AS cps, " +
                    "(SELECT COUNT(*) FROM checkpoints WHERE session_id = ? AND pinned = 1) AS pinnedCps",
            )
            .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as {
            messages: number; media: number; blocks: number; deadRefs: number;
            refs: number; ccrEntries: number; ext: number; cps: number; pinnedCps: number;
        };
        const inlineBytes =
            ((this.db
                .prepare(
                    "SELECT COALESCE(SUM(LENGTH(meta_json)), 0) + COALESCE(SUM(LENGTH(stats_json)), 0) " +
                        "+ COALESCE(SUM(LENGTH(metadata_json)), 0) + COALESCE(SUM(LENGTH(kstate_json)), 0) " +
                        "+ COALESCE(SUM(LENGTH(tail_json)), 0) + COALESCE(LENGTH(ccr_json), 0) AS b " +
                        "FROM sessions WHERE session_id = ?",
                )
                .get(sessionId) as { b: number }).b ?? 0) +
            ((this.db
                .prepare("SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS b FROM blocks WHERE session_id = ?")
                .get(sessionId) as { b: number }).b ?? 0) +
            ((this.db
                .prepare("SELECT COALESCE(SUM(LENGTH(value_json)), 0) AS b FROM session_ext WHERE session_id = ?")
                .get(sessionId) as { b: number }).b ?? 0);
        const cas = this.db
            .prepare(
                "SELECT COALESCE(SUM(CASE WHEN refcount = 1 THEN byte_len ELSE 0 END), 0) AS exclusiveBytes, " +
                    "COALESCE(SUM(CASE WHEN refcount > 1 THEN 1 ELSE 0 END), 0) AS sharedBlobs " +
                    "FROM content WHERE hash IN (" +
                    "SELECT content_hash FROM messages WHERE session_id = ? " +
                    "UNION SELECT media_hash FROM message_media WHERE session_id = ? " +
                    "UNION SELECT summary_hash FROM blocks WHERE session_id = ? " +
                    "UNION SELECT one_hash FROM blocks WHERE session_id = ? AND one_hash IS NOT NULL " +
                    "UNION SELECT content_hash FROM ccr_entries WHERE session_id = ? " +
                    "UNION SELECT state_hash FROM checkpoints WHERE session_id = ?)",
            )
            .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as { exclusiveBytes: number; sharedBlobs: number };
        return {
            rows: {
                messages: counts.messages,
                media: counts.media,
                blocks: counts.blocks,
                deadRefs: counts.deadRefs,
                refs: counts.refs,
                ccrEntries: counts.ccrEntries,
                sessionExt: counts.ext,
                checkpoints: counts.cps,
                pinnedCheckpoints: counts.pinnedCps,
            },
            inlineBytes,
            casExclusiveBytes: cas.exclusiveBytes,
            casSharedBlobs: cas.sharedBlobs,
        };
    }

    /** #3928: zero-ref CAS garbage report — what `gc` / post-delete sweeps
     *  would release without running them (the gc dry-run plan row). */
    contentZeroRefReport(): { rows: number; bytesTotal: number } {
        const r = this.db
            .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(byte_len), 0) AS b FROM content WHERE refcount <= 0")
            .get() as { n: number; b: number };
        return { rows: r.n, bytesTotal: r.b };
    }

    /** #3928: read-only prediction of what gc(archiveAfterDays) WILL do —
     *  the `bili storage gc --dry-run` plan. Deliberately DB-driven only:
     *  unifiedGc itself sees just index.db, so a plan that also walked files
     *  would predict work the real run never does. days <= 0 means no
     *  age-sweep (same sentinel as gc), collection + vacuum still planned. */
    gcPlan(archiveAfterDays: number, now: number = Date.now()): GcPlan {
        let candidates: GcPlanCandidate[] = [];
        if (archiveAfterDays > 0) {
            const cutoff = now - archiveAfterDays * 86_400_000;
            candidates = (this.db
                .prepare("SELECT session_id, label, updated_at FROM sessions WHERE status = 'active' AND updated_at < ? ORDER BY updated_at")
                .all(cutoff) as Array<{ session_id: string; label: string | null; updated_at: number }>
            ).map((r) => ({ sessionId: r.session_id, label: r.label ?? undefined, updatedAt: r.updated_at }));
        }
        const zeroRef = this.contentZeroRefReport();
        const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size ?? 4096;
        return {
            cutoff: archiveAfterDays > 0 ? now - archiveAfterDays * 86_400_000 : null,
            candidates,
            zeroRefRows: zeroRef.rows,
            zeroRefBytes: zeroRef.bytesTotal,
            pageSize,
        };
    }

    /** #3928: physically shrink index.db after deletions. Order matters in
     *  WAL mode: VACUUM writes the compacted image to the WAL and leaves the
     *  main file at its old size; only a subsequent wal_checkpoint(TRUNCATE)
     *  flushes the compacted pages back and truncates both files
     *  (checkpoint-first leaves the size unchanged). Retries on SQLITE_BUSY
     *  with a short backoff — a live instance sharing this directory
     *  (#2671/#394) may hold a read transaction; busy_timeout already
     *  absorbs most contention. Throws when all attempts fail: the deletion
     *  itself is already committed, the caller reports the shrink as
     *  partial. */
    vacuum(mode: "full" | "incremental"): void {
        if (mode === "incremental") {
            this.db.exec("PRAGMA incremental_vacuum");
            return;
        }
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                this.db.exec("VACUUM");
                this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                return;
            } catch (err) {
                lastErr = err;
                const msg = String(err);
                if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw err;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }

    /** #3901/#3463: single append-only archive log — one JSON line per
     *  archived session, not one tiny file per session. */
    static readonly ARCHIVE_LOG_NAME = "archive.jsonl";

    /** #3901/#3463: archive one session. The full row bodies (messages,
     *  blocks, refs, dead refs, ccr, session_ext, unpinned checkpoints) are
     *  exported verbatim — content bodies included — as ONE JSON line
     *  appended to `<archiveDir>/archive.jsonl` (the single append-only log;
     *  a crash mid-append leaves at most one truncated line which the
     *  restore reader skips), then swept with the deleteSession refcount
     *  discipline. Unlike deleteSession the sessions row survives as a
     *  tombstone (status 'archived', label intact — the web list keeps
     *  showing it) and the conversations identity binding survives (identity
     *  is forever; a restore must land on the same session id). Pinned
     *  checkpoints keep their rows + refs. Idempotent: an already-archived
     *  session is a no-op returning the log path. */

    archiveSession(sessionId: string, opts: { archiveDir: string }): { ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number } {
        const row = this.getSessionRow(sessionId);
        if (!row) return { ok: false, reason: "not-found" };
        // #3901 review: sessions are small and numerous — a per-session file
        // per archive would spray tiny files across the archive dir. One
        // append-only JSONL holds every archived session, one line each.
        const exportPath = join(opts.archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        if (row.status === "archived") return { ok: true, exportPath };
        // --- read everything the session owns (before any mutation) ---
        const messages = (this.db.prepare("SELECT seq, msg_id, ref, ref_num, role, kind, content_hash FROM messages WHERE session_id = ? ORDER BY seq").all(sessionId) as Record<string, unknown>[]);
        const mediaMaps = (this.db.prepare("SELECT seq, media_hash FROM message_media WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        const blocks = (this.db.prepare("SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json FROM blocks WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const refsRows = (this.db.prepare("SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const deadRefs = (this.db.prepare("SELECT ord, ref, ref_num, recorded_at FROM dead_refs WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const ccr = (this.db.prepare("SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const ext = (this.db.prepare("SELECT key, value_json FROM session_ext WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        const checkpoints = (this.db.prepare("SELECT cp_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash FROM checkpoints WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        // --- collect the distinct CAS bodies referenced by those rows ---
        const wanted = new Set<string>();
        for (const m of messages) wanted.add(m.content_hash as string);
        for (const mm of mediaMaps) wanted.add(mm.media_hash as string);
        for (const b of blocks) { wanted.add(b.summary_hash as string); if (b.one_hash !== null && b.one_hash !== undefined) wanted.add(b.one_hash as string); }
        for (const e of ccr) wanted.add(e.content_hash as string);
        for (const cp of checkpoints) if (cp.pinned === 0) wanted.add(cp.state_hash as string);
        const content: Record<string, string> = {};
        for (const hash of wanted) {
            const c = this.db.prepare("SELECT bytes FROM content WHERE hash = ?").get(hash) as { bytes: Buffer | Uint8Array } | undefined;
            if (c) content[hash as string] = Buffer.from(c.bytes).toString("utf8");
        }
        mkdirSync(opts.archiveDir, { recursive: true });
        // One JSONL line per archived session: append-only (cheap, crash =
        // at worst one truncated line which the reader skips), restore
        // rewrites the file without the restored session's lines.
        appendFileSync(exportPath, JSON.stringify({ version: 1, sessionId, archivedAt: Date.now(), session: row, content, messages, mediaMaps, blocks, refs: refsRows, deadRefs, ccrEntries: ccr, sessionExt: ext, checkpoints }) + "\n");
        // --- sweep the row bodies (refcount discipline; pinned checkpoints survive) ---
        let contentRowsDeleted = 0;
        this.db.transaction(() => {
            const rel: string[] = [];
            for (const m of messages) rel.push(m.content_hash as string);
            for (const mm of mediaMaps) rel.push(mm.media_hash as string);
            for (const b of blocks) { rel.push(b.summary_hash as string); if (b.one_hash !== null && b.one_hash !== undefined) rel.push(b.one_hash as string); }
            for (const e of ccr) rel.push(e.content_hash as string);
            for (const cp of checkpoints) if (cp.pinned === 0) { rel.push(cp.state_hash as string); this.db.prepare("DELETE FROM checkpoints WHERE cp_id = ?").run(cp.cp_id); }
            this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM message_media WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM blocks WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId);
            this.db.prepare("UPDATE sessions SET status = 'archived' WHERE session_id = ?").run(sessionId);
            for (const hash of rel) this.releaseContent(hash);
            const zero = this.db.prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").get() as { n: number };
            contentRowsDeleted = zero.n;
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
        });
        loggerLog("info", `[#3901] archived ${sessionId} → ${exportPath} (${contentRowsDeleted} content rows collected)`);
        return { ok: true, exportPath, contentRowsDeleted };
    }

    /** #3901/#3463: byte-exact restore from an archive export. Re-puts the
     *  content bodies (same sha256 → same hashes), re-inserts every row,
     *  flips the tombstone back to 'active'. The conversations binding
     *  re-claims ON CONFLICT DO NOTHING (first claimant wins; the binding
     *  never left, so this is normally a no-op). */
    restoreArchived(sessionId: string, opts: { archiveDir: string }): { ok: boolean; reason?: string } {
        const exportPath = join(opts.archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        if (!existsSync(exportPath)) return { ok: false, reason: "export-missing" };
        let dump: {
            session: ReturnType<UnifiedStore["getSessionRow"]>;
            content: Record<string, string>;
            messages: Record<string, unknown>[];
            blocks: Record<string, unknown>[];
            refs: Record<string, unknown>[];
            deadRefs: Record<string, unknown>[];
            ccrEntries: Record<string, unknown>[];
            sessionExt: Record<string, unknown>[];
            checkpoints: Record<string, unknown>[];
        };
        // Scan the JSONL for the session's line (skip malformed/truncated
        // trailing lines — an archive append interrupted by a crash must not
        // block restoring OTHER sessions).
        let lineNo = -1;
        let rawLines: string[] = [];
        try {
            rawLines = readFileSync(exportPath, "utf8").split("\n");
            for (let i = 0; i < rawLines.length; i++) {
                if (!rawLines[i].trim()) continue;
                let candidate: { sessionId?: string };
                try {
                    candidate = JSON.parse(rawLines[i]) as { sessionId?: string };
                } catch {
                    continue;
                }
                if (candidate.sessionId === sessionId) { lineNo = i; break; }
            }
        } catch {
            return { ok: false, reason: "export-corrupt" };
        }
        if (lineNo === -1) return { ok: false, reason: "export-missing" };
        try {
            dump = JSON.parse(rawLines[lineNo]) as typeof dump;
        } catch {
            return { ok: false, reason: "export-corrupt" };
        }
        if (!dump.session || dump.session.sessionId !== sessionId) return { ok: false, reason: "export-mismatch" };
        const sess: NonNullable<typeof dump.session> = dump.session;
        this.db.transaction(() => {
            for (const [hash, body] of Object.entries(dump.content)) this.putContent(Buffer.from(body, "utf8"), hash);
            const insMsg = this.db.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            for (const m of dump.messages) insMsg.run(sessionId, m.seq, m.msg_id, m.ref ?? null, m.ref_num ?? null, m.role, m.kind ?? "message", m.content_hash);
            const insMedia = this.db.prepare("INSERT OR IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)");
            for (const mm of (dump as { mediaMaps?: Record<string, unknown>[] }).mediaMaps ?? []) insMedia.run(sessionId, mm.seq, mm.media_hash);
            const insBlock = this.db.prepare(`INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, block_id) DO NOTHING`);
            for (const b of dump.blocks) insBlock.run(b.block_id, sessionId, b.ord, b.start_seq, b.end_seq, b.start_ref ?? null, b.end_ref ?? null, b.tier, b.summary_hash, b.one_hash ?? null, b.supersedes_block_id ?? null, b.active, b.created_at, b.covered_hash, b.payload_json);
            const insRef = this.db.prepare("INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?)");
            for (const r of dump.refs) insRef.run(sessionId, r.ord, r.raw_id, r.ref, r.ref_num ?? null);
            const insDead = this.db.prepare("INSERT INTO dead_refs (session_id, ord, ref, ref_num, recorded_at) VALUES (?, ?, ?, ?, ?)");
            for (const d of dump.deadRefs) insDead.run(sessionId, d.ord, d.ref, d.ref_num, d.recorded_at);
            const insCcr = this.db.prepare("INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)");
            for (const e of dump.ccrEntries) insCcr.run(sessionId, e.ord, e.ccr_key, e.content_hash);
            const insExt = this.db.prepare("INSERT INTO session_ext (session_id, key, value_json) VALUES (?, ?, ?)");
            for (const x of dump.sessionExt) insExt.run(sessionId, x.key, x.value_json);
            const insCp = this.db.prepare("INSERT INTO checkpoints (cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cp_id) DO NOTHING");
            for (const cp of dump.checkpoints) insCp.run(cp.cp_id, sessionId, cp.seq_at, cp.block_set_hash, cp.kind, cp.created_at, cp.pinned, cp.label ?? null, cp.state_hash);
            this.db
                .prepare(`UPDATE sessions SET parent_session_id = ?, fork_point_seq = ?, protocol = ?, label = ?, title = ?, host_title = ?, namespace = ?, origin = ?,
                    created_at = ?, updated_at = ?, next_block_id = ?, next_run_id = ?, meta_json = ?, stats_json = ?, metadata_json = ?, kstate_json = ?, tail_json = ?, ccr_json = ?, last_ingested_seq = ?, orphans_json = ?, status = 'active' WHERE session_id = ?`)
                .run(
                    sess.parentSessionId ?? null, sess.forkPointSeq ?? null, sess.protocol ?? null, sess.label ?? null,
                    sess.title ?? null, sess.hostTitle ?? null, sess.namespace ?? "proxy", sess.origin ?? null,
                    sess.createdAt, sess.updatedAt, sess.nextBlockId, sess.nextRunId,
                    sess.metaJson, sess.statsJson, sess.metadataJson, sess.kstateJson, sess.tailJson, sess.ccrJson ?? null,
                    sess.lastIngestedSeq ?? null, sess.orphansJson ?? null, sessionId,
                );
        });
        // Drop the restored session's line(s) from the JSONL (a same-session
        // archive can theoretically appear more than once across reinstalls;
        // rewrite removes them all). Other sessions' lines are untouched.
        const kept: string[] = [];
        for (const l of rawLines) {
            if (!l.trim()) continue;
            try {
                const head = JSON.parse(l) as { sessionId?: string };
                if (head.sessionId === sessionId) continue;
            } catch { continue; }
            kept.push(l);
        }
        writeFileSync(exportPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
        loggerLog("info", `[#3901] restored archived session ${sessionId} from ${exportPath} (line removed from the archive log)`);
        return { ok: true };
    }

    /** #3901/#3463: age-sweep GC. Sessions whose updated_at is older than
     *  the retention cutoff are archived (export + sweep); zero-ref content
     *  rows left by any path are collected. `vacuum: 'full'` additionally
     *  rebuilds the database file (auto_vacuum=INCREMENTAL handles freed
     *  pages incrementally; a one-time VACUUM reclaims the initial bloat of
     *  databases created before that pragma). */
    gc(opts: { archiveAfterDays: number; archiveDir: string; now?: number; vacuum?: "full" | "incremental" }): { archived: number; contentRowsDeleted: number } {
        const now = opts.now ?? Date.now();
        let archived = 0;
        let contentRowsDeleted = 0;
        if (opts.archiveAfterDays > 0) {
            const cutoff = now - opts.archiveAfterDays * 86_400_000;
            const stale = this.db.prepare("SELECT session_id FROM sessions WHERE status = 'active' AND updated_at < ?").all(cutoff) as { session_id: string }[];
            for (const s of stale) {
                const r = this.archiveSession(s.session_id, { archiveDir: opts.archiveDir });
                if (r.ok) archived++;
                if (r.contentRowsDeleted) contentRowsDeleted += r.contentRowsDeleted;
            }
        }
        const zero = this.db.prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").get() as { n: number };
        if (zero.n > 0) {
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
            contentRowsDeleted += zero.n;
        }
        if (opts.vacuum === "full") {
            loggerLog("info", "[#3901] gc: running full VACUUM (this can take a while on large databases)");
            // #4390: delegate to vacuum() — a bare VACUUM leaves the compacted
            // image in the WAL; only the TRUNCATE checkpoint shrinks the files.
            this.vacuum("full");
        } else if (opts.vacuum === "incremental") {
            this.vacuum("incremental");
        }
        return { archived, contentRowsDeleted };
    }

    /** Test/ops helper: refcount of the content row whose serialized body
     *  contains `needle` (archive-gc tests use unique body texts; the CAS
     *  body is the full message JSON, so prefix matching would miss). */
    contentRefCountOfBody(needle: string): number {
        const row = this.db.prepare("SELECT refcount FROM content WHERE CAST(bytes AS TEXT) LIKE '%' || ? || '%'").get(needle) as { refcount: number } | undefined;
        return row ? row.refcount : 0;
    }

    /** Freezes one session record as a checkpoint row + CAS blob. The row
     *  owns exactly one refcount on the blob; identical consecutive states
     *  dedup to a single CAS entry (the CoW behind cheap repeated
     *  checkpoints). Single transaction: the checkpoint is either fully
     *  visible or not at all. */
    insertCheckpoint(cp: {
        cpId: string;
        sessionId: string;
        seqAt: number;
        blockSetHash: string;
        kind: "auto" | "manual" | "replica" | "fork_base";
        label?: string | null;
        pinned: boolean;
        createdAt: number;
        stateJson: string;
    }): void {
        this.db.transaction(() => {
            const stateHash = this.putContent(cp.stateJson);
            this.db
                .prepare(
                    "INSERT INTO checkpoints (cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .run(cp.cpId, cp.sessionId, cp.seqAt, cp.blockSetHash, cp.kind, cp.createdAt, cp.pinned ? 1 : 0, cp.label ?? null, stateHash);
        });
    }

    listCheckpoints(sessionId?: string): CheckpointRow[] {
        const cols = "cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label";
        return sessionId
            ? (this.db.prepare(`SELECT ${cols} FROM checkpoints WHERE session_id = ? ORDER BY created_at, cp_id`).all(sessionId) as CheckpointRow[])
            : (this.db.prepare(`SELECT ${cols} FROM checkpoints ORDER BY created_at, cp_id`).all() as CheckpointRow[]);
    }

    // ------------------------------------------------------------------
    // Extension namespaces (#3069 v4). Host/plugin/UI substrate — never
    // kernel session state (that lives in kstate_json). Guards: key and
    // namespace are non-empty printable strings <= 256 chars; the JSON
    // payload is capped so a runaway caller cannot balloon index.db.
    // ------------------------------------------------------------------

    setSessionExt(sessionId: string, key: string, value: unknown): void {
        validateExtKey(sessionId, "session id");
        validateExtKey(key, "key");
        const valueJson = serializeExtValue(value);
        this.db
            .prepare(
                "INSERT INTO session_ext (session_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT (session_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            )
            .run(sessionId, key, valueJson, Date.now());
    }

    getSessionExt(sessionId: string, key: string): unknown {
        validateExtKey(sessionId, "session id");
        validateExtKey(key, "key");
        const row = this.db
            .prepare("SELECT value_json FROM session_ext WHERE session_id = ? AND key = ?")
            .get(sessionId, key) as { value_json: string } | undefined;
        return row === undefined ? undefined : JSON.parse(row.value_json);
    }

    listSessionExt(sessionId: string): { key: string; value: unknown; updatedAt: number }[] {
        validateExtKey(sessionId, "session id");
        return (
            this.db
                .prepare("SELECT key, value_json, updated_at FROM session_ext WHERE session_id = ? ORDER BY key")
                .all(sessionId) as { key: string; value_json: string; updated_at: number }[]
        ).map((r) => ({ key: r.key, value: JSON.parse(r.value_json), updatedAt: r.updated_at }));
    }

    /** Deletes one key (or every key of the session when omitted). Returns
     *  the number of rows removed. The deleteSession sweep calls this table
     *  too — session-bound state dies with the session. */
    deleteSessionExt(sessionId: string, key?: string): number {
        validateExtKey(sessionId, "session id");
        if (key === undefined) {
            return Number(this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId).changes);
        }
        validateExtKey(key, "key");
        return Number(this.db.prepare("DELETE FROM session_ext WHERE session_id = ? AND key = ?").run(sessionId, key).changes);
    }

    setKv(namespace: string, key: string, value: unknown): void {
        validateExtKey(namespace, "namespace");
        validateExtKey(key, "key");
        const valueJson = serializeExtValue(value);
        this.db
            .prepare(
                "INSERT INTO kv_store (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT (namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            )
            .run(namespace, key, valueJson, Date.now());
    }

    getKv(namespace: string, key: string): unknown {
        validateExtKey(namespace, "namespace");
        validateExtKey(key, "key");
        const row = this.db
            .prepare("SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?")
            .get(namespace, key) as { value_json: string } | undefined;
        return row === undefined ? undefined : JSON.parse(row.value_json);
    }

    listKv(namespace?: string, keyPrefix?: string): { namespace: string; key: string; value: unknown; updatedAt: number }[] {
        const where: string[] = [];
        const args: unknown[] = [];
        if (namespace !== undefined) {
            validateExtKey(namespace, "namespace");
            where.push("namespace = ?");
            args.push(namespace);
        }
        if (keyPrefix !== undefined && keyPrefix !== "") {
            validateExtKey(keyPrefix, "key prefix");
            where.push("key LIKE ? ESCAPE '\\'");
            args.push(likeEscape(keyPrefix) + "%");
        }
        const sql =
            "SELECT namespace, key, value_json, updated_at FROM kv_store" +
            (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
            " ORDER BY namespace, key";
        return (
            this.db.prepare(sql).all(...(args as never[])) as { namespace: string; key: string; value_json: string; updated_at: number }[]
        ).map((r) => ({ namespace: r.namespace, key: r.key, value: JSON.parse(r.value_json), updatedAt: r.updated_at }));
    }

    /** Deletes one key of a namespace, or the whole namespace when the key
     *  is omitted ("retire a lane" = deleteKv("lane:18835")). Returns the
     *  number of rows removed. */
    deleteKv(namespace: string, key?: string): number {
        validateExtKey(namespace, "namespace");
        if (key === undefined) {
            return Number(this.db.prepare("DELETE FROM kv_store WHERE namespace = ?").run(namespace).changes);
        }
        validateExtKey(key, "key");
        return Number(this.db.prepare("DELETE FROM kv_store WHERE namespace = ? AND key = ?").run(namespace, key).changes);
    }

    /** Sessions-row updated_at (ms epoch) — the ingest freshness watermark
     *  load-side imports compare the legacy payload against. null when the
     *  index has never seen the id. */
    sessionUpdatedAt(sessionId: string): number | null {
        const row = this.db
            .prepare("SELECT updated_at FROM sessions WHERE session_id = ?")
            .get(sessionId) as { updated_at: number } | undefined;
        return row?.updated_at ?? null;
    }

    getCheckpoint(cpId: string): CheckpointRow | undefined {
        return this.db
            .prepare("SELECT cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label FROM checkpoints WHERE cp_id = ?")
            .get(cpId) as CheckpointRow | undefined;
    }

    /** The frozen record blob (state_hash → CAS bytes). Throws if the row or
     *  the blob is missing — callers treat that as a corrupt checkpoint. */
    checkpointState(cpId: string): { stateJson: string; byteLen: number } {
        const row = this.db.prepare("SELECT state_hash FROM checkpoints WHERE cp_id = ?").get(cpId) as
            | { state_hash: string }
            | undefined;
        if (!row) throw new Error(`checkpoint not found: ${cpId}`);
        const blob = this.db.prepare("SELECT bytes, byte_len FROM content WHERE hash = ?").get(row.state_hash) as
            | { bytes: Uint8Array; byte_len: number }
            | undefined;
        if (!blob) throw new Error(`checkpoint blob missing (CAS leak): ${cpId}`);
        return { stateJson: Buffer.from(blob.bytes).toString("utf8"), byteLen: blob.byte_len };
    }

    /** Drops a checkpoint row and releases its CAS refcount. Explicit delete
     *  overrides `pinned` — pinning protects against GC, not the operator. */
    deleteCheckpoint(cpId: string): boolean {
        return this.db.transaction((): boolean => {
            const row = this.db.prepare("SELECT state_hash FROM checkpoints WHERE cp_id = ?").get(cpId) as
                | { state_hash: string }
                | undefined;
            if (!row) return false;
            this.db.prepare("DELETE FROM checkpoints WHERE cp_id = ?").run(cpId);
            this.releaseContent(row.state_hash);
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
            return true;
        });
    }

    /** Asserts every projection column equals its verbatim fact. Throws on
     *  the first disagreement with a field-labeled message. */
    verifyProjections(sessionId: string): { ok: true; checks: number } | { ok: false; error: string } {
        const fail = (where: string, msg: string): { ok: false; error: string } => ({
            ok: false,
            error: `${sessionId}: ${where}: ${msg}`,
        });
        let checks = 0;
        const s = this.getSessionRow(sessionId);
        if (!s) return fail("sessions", "row missing");
        const meta = JSON.parse(s.metaJson) as Record<string, unknown>;
        checks++;
        if ((s.protocol ?? null) !== (meta.protocol ?? null)) return fail("sessions.protocol", `${s.protocol} vs ${String(meta.protocol)}`);
        if ((s.label ?? null) !== (meta.label ?? null)) return fail("sessions.label", `${s.label} vs ${String(meta.label)}`);
        if ((s.title ?? null) !== (meta.title ?? null)) return fail("sessions.title", `${s.title} vs ${String(meta.title)}`);
        if ((s.hostTitle ?? null) !== (meta.hostTitle ?? null)) return fail("sessions.hostTitle", `${s.hostTitle} vs ${String(meta.hostTitle)}`);

        const kstate = JSON.parse(s.kstateJson) as Record<string, unknown>;
        checks++;
        if (kstate.nextBlockId !== undefined || kstate.nextRunId !== undefined) {
            return fail("sessions.kstate_json", "must not carry nextBlockId/nextRunId (columns own them)");
        }

        // #4666: retired rows carry the same projections (tombstone-only) —
        // verifying them too closes the diagnostic gap where corruption on a
        // retired row was invisible.
        const messages = this.getMessages(sessionId, { includeRetired: true });
        const refByRaw = new Map(this.getRefs(sessionId).map((r) => [r.rawId, r.ref]));
        for (const m of messages) {
            checks++;
            if (m.ref !== (refByRaw.get(m.msgId) ?? null)) {
                return fail(`messages[${m.seq}].ref`, `${String(m.ref)} vs refs ledger ${String(refByRaw.get(m.msgId))}`);
            }
        }
        for (const m of messages) {
            checks++;
            const parsed = JSON.parse(m.content) as { id?: string; role?: string; contentType?: string };
            if (parsed.id !== m.msgId) return fail(`messages[${m.seq}].msg_id`, `${m.msgId} vs ${String(parsed.id)}`);
            if (parsed.role !== m.role) return fail(`messages[${m.seq}].role`, `${m.role} vs ${String(parsed.role)}`);
            if ((parsed.contentType ?? "message") !== m.kind) {
                return fail(`messages[${m.seq}].kind`, `${m.kind} vs ${String(parsed.contentType)}`);
            }
        }

        const blocks = this.getBlocks(sessionId);
        for (const b of blocks) {
            checks++;
            const payload = JSON.parse(b.payloadJson) as Record<string, unknown>;
            if (payload.blockId !== b.blockId) return fail(`blocks[${b.blockId}].blockId`, "id mismatch");
            if (payload.tier !== b.tier) return fail(`blocks[${b.blockId}].tier`, `${b.tier} vs ${String(payload.tier)}`);
            if ((payload.active ?? true) !== b.active) {
                return fail(`blocks[${b.blockId}].active`, `${b.active} vs ${String(payload.active)}`);
            }
            // NOTE: summary/one CAS views are blockContents facts, not
            // projections of the block payload (payload.summary is a plain
            // string) — comparing them would be comparing different facts.
        }
        return { ok: true, checks };
    }

    counts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const t of ["sessions", "messages", "refs", "blocks", "dead_refs", "ccr_entries", "content", "checkpoints"]) {
            const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
            out[t] = row.n;
        }
        return out;
    }

    contentDedupReport(): { rows: number; bytesTotal: number; refcounted: number } {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(byte_len),0) AS b, COALESCE(SUM(refcount),0) AS r FROM content")
            .get() as { n: number; b: number; r: number };
        return { rows: row.n, bytesTotal: row.b, refcounted: row.r };
    }

    listSessionIds(): string[] {
        return (this.db.prepare("SELECT session_id FROM sessions ORDER BY session_id").all() as { session_id: string }[]).map(
            (r) => r.session_id,
        );
    }

    /** Identity lookup (#2960 R2.1): resolve the durable (namespace,
     *  conversation id) pair to its sessions row key. Null when the pair was
     *  never claimed. */
    lookupConversation(namespace: string, conversationId: string): string | null {
        const row = this.db
            .prepare("SELECT session_id FROM conversations WHERE namespace = ? AND conversation_id = ?")
            .get(namespace, conversationId) as { session_id: string } | undefined;
        return row ? row.session_id : null;
    }

    /** All identity bindings, optionally filtered by namespace (test/web
     *  consumption face). */
    listConversationBindings(namespace?: string): { namespace: string; conversationId: string; sessionId: string; claimedAt: number }[] {
        const rows = (namespace === undefined
            ? this.db.prepare("SELECT namespace, conversation_id, session_id, claimed_at FROM conversations ORDER BY namespace, conversation_id").all()
            : this.db
                  .prepare(
                      "SELECT namespace, conversation_id, session_id, claimed_at FROM conversations WHERE namespace = ? ORDER BY conversation_id",
                  )
                  .all(namespace)
        ) as { namespace: string; conversation_id: string; session_id: string; claimed_at: number }[];
        return rows.map((r) => ({ namespace: r.namespace, conversationId: r.conversation_id, sessionId: r.session_id, claimedAt: r.claimed_at }));
    }

    /** Summary rows for the export/web list fast path (#2960 R2.1):
     *  one SQL over the sessions table + blocks aggregate — no legacy file
     *  parse, no Session hydration. Parity contract with the legacy walk
     *  (export.ts listSessions): display title = host_title ?? title;
     *  display time = latest block created_at; blocks = ALL blocks count. */
    sessionSummaries(): SessionSummaryRow[] {
        const rows = this.db
            .prepare(
                `SELECT s.session_id AS sessionId, s.host_title AS hostTitle, s.title AS title, s.label AS label,
                        s.protocol AS protocol, s.origin AS origin, s.namespace AS namespace, s.stats_json AS statsJson,
                        s.status AS status, s.updated_at AS updatedAt,
                        (SELECT COUNT(*) FROM blocks b WHERE b.session_id = s.session_id) AS blocks,
                        (SELECT MAX(b.created_at) FROM blocks b WHERE b.session_id = s.session_id) AS latestBlockAt
                  FROM sessions s`,
            )
            .all() as {
            sessionId: string;
            hostTitle: string | null;
            title: string | null;
            label: string | null;
            protocol: string | null;
            origin: string | null;
            namespace: string;
            statsJson: string;
            status: string;
            updatedAt: number;
            blocks: number;
            latestBlockAt: number | null;
        }[];
        return rows.map((r) => {
            let contextTokens: number | undefined;
            try {
                const v = (JSON.parse(r.statsJson) as { contextTokens?: unknown }).contextTokens;
                if (typeof v === "number" && Number.isFinite(v)) contextTokens = v;
            } catch {
                /* malformed stats: leave undefined, same as a missing field */
            }
            return {
                sessionId: r.sessionId,
                title: r.hostTitle ?? r.title ?? undefined,
                label: r.label ?? undefined,
                protocol: r.protocol ?? undefined,
                origin: r.origin ?? undefined,
                namespace: r.namespace,
                blocks: r.blocks,
                latestBlockAt: r.latestBlockAt ?? undefined,
                contextTokens,
                status: r.status,
                updatedAt: r.updatedAt,
            };
        });
    }

    /** #2960 R2.2: web list rows — sessions table + block aggregates in one
     *  SQL (payload json_extract for the first-block lead and active-block
     *  compressed-token sum). Replaces the bounded envelope-file decode the
     *  disk index performs per refresh. */
    webSummaryRows(): WebSummaryRow[] {
        const rows = this.db
            .prepare(
                `SELECT s.session_id AS sessionId, s.title AS title, s.host_title AS hostTitle, s.label AS label,
                        s.protocol AS protocol, s.origin AS origin, s.status AS status, s.updated_at AS updatedAt,
                        s.stats_json AS statsJson, s.metadata_json AS metadataJson,
                        (SELECT COUNT(*) FROM blocks b WHERE b.session_id = s.session_id) AS blocks,
                        (SELECT json_extract(b.payload_json, '$.topic') FROM blocks b
                          WHERE b.session_id = s.session_id
                            AND (json_extract(b.payload_json, '$.topic') IS NOT NULL
                                 OR json_extract(b.payload_json, '$.summary') IS NOT NULL)
                          ORDER BY b.ord LIMIT 1) AS firstTopic,
                        (SELECT json_extract(b.payload_json, '$.summary') FROM blocks b
                          WHERE b.session_id = s.session_id
                            AND (json_extract(b.payload_json, '$.topic') IS NOT NULL
                                 OR json_extract(b.payload_json, '$.summary') IS NOT NULL)
                          ORDER BY b.ord LIMIT 1) AS firstSummary,
                        (SELECT COALESCE(SUM(json_extract(b.payload_json, '$.compressedTokens')), 0)
                          FROM blocks b WHERE b.session_id = s.session_id AND b.active = 1) AS activeCompressed
                 FROM sessions s`,
            )
            .all() as Array<{
                sessionId: string;
                title: string | null;
                hostTitle: string | null;
                label: string | null;
                protocol: string | null;
                origin: string | null;
                status: string;
                updatedAt: number;
                statsJson: string;
                metadataJson: string;
                blocks: number;
                firstTopic: string | null;
                firstSummary: string | null;
                activeCompressed: number | null;
            }>;
        return rows.map((r) => ({
            sessionId: r.sessionId,
            title: r.title ?? undefined,
            hostTitle: r.hostTitle ?? undefined,
            label: r.label ?? undefined,
            protocol: r.protocol ?? undefined,
            origin: r.origin ?? undefined,
            status: r.status,
            updatedAt: r.updatedAt,
            statsJson: r.statsJson,
            metadataJson: r.metadataJson,
            blocks: r.blocks,
            firstTopic: r.firstTopic,
            firstSummary: r.firstSummary,
            activeCompressedTokens: r.activeCompressed ?? 0,
        }));
    }

    private getContent(hash: string): string | null {
        const row = this.db.prepare("SELECT bytes FROM content WHERE hash = ?").get(hash) as
            | { bytes: Buffer }
            | undefined;
        if (!row) return null;
        return Buffer.from(row.bytes).toString("utf8");
    }

    getSessionRow(sessionId: string): SessionRow | null {
        const row = this.db
            .prepare(
                `SELECT session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin, status,
                        created_at, updated_at, next_block_id, next_run_id,
                        meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq, orphans_json
                 FROM sessions WHERE session_id = ?`,
            )
            .get(sessionId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            sessionId: row.session_id as string,
            parentSessionId: (row.parent_session_id as string | null) ?? null,
            forkPointSeq: (row.fork_point_seq as number | null) ?? null,
            protocol: (row.protocol as string | null) ?? null,
            label: (row.label as string | null) ?? null,
            title: (row.title as string | null) ?? null,
            hostTitle: (row.host_title as string | null) ?? null,
            namespace: (row.namespace as string | undefined) ?? "proxy",
            origin: (row.origin as string | null | undefined) ?? null,
            status: row.status as string,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
            nextBlockId: row.next_block_id as number,
            nextRunId: row.next_run_id as number,
            metaJson: row.meta_json as string,
            statsJson: row.stats_json as string,
            metadataJson: row.metadata_json as string,
            kstateJson: row.kstate_json as string,
            tailJson: row.tail_json as string,
            ccrJson: (row.ccr_json as string | null) ?? null,
            lastIngestedSeq: (row.last_ingested_seq as number | null | undefined) ?? null,
            orphansJson: (row.orphans_json as string | null | null | undefined) ?? null,
        };
    }

    /** #4316 PR3/3: raw id → canonical seq for the ledger re-stamp. Only
     *  single-row msg_ids are returned: an id with several generations (an
     *  edit left both bytes in the log) has no single "the" seq — picking one
     *  would silently re-bind the citation to the wrong generation. Those
     *  stay on their legacy refs (kept honestly instead of re-bound wrongly). */
    /** #4316 PR3/3: live (non-retired) row count. */
    liveRowCount(sessionId: string): number {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL")
            .get(sessionId) as Record<string, unknown>;
        return (row.n as number) ?? 0;
    }

    /** #4730: highest live (non-retired) seq — the fork endpoint's inclusive
     *  throughSeq. NOT the live row count: tombstones keep their seq, so once
     *  any row is retired count < lastLiveSeq + 1 and count - 1 would silently
     *  drop the newest live rows from the cloned child. Null when the session
     *  has no live rows. */
    lastLiveSeq(sessionId: string): number | null {
        const row = this.db
            .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND retired_at IS NULL")
            .get(sessionId) as Record<string, unknown>;
        return (row.m as number | null) ?? null;
    }

    seqByRaw(sessionId: string): Map<string, number> {
        const rows = this.db
            .prepare(
                "SELECT msg_id, MIN(seq) AS seq, COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL GROUP BY msg_id",
            )
            .all(sessionId) as Record<string, unknown>[];
        const out = new Map<string, number>();
        for (const r of rows) {
            if ((r.n as number) === 1) out.set(r.msg_id as string, r.seq as number);
        }
        return out;
    }

    /** #4316 PR3/3: fork adoption clones the parent's rows wholesale so the
     *  child's cloned kernel refs keep pointing at the same ledger positions
     *  (owner decision 2026-10-22: fork copies every number). The child
     *  session row records the lineage; content/media CAS refcounts are
     *  bumped per copied row. Idempotent: replaying the same clone is a no-op.
     *  throughSeq is inclusive (store seq is 0-based; the endpoint passes the
     *  parent's last live seq — #4730). Returns false when the parent session
     *  has no row (never mirrored — nothing to clone), true otherwise
     *  (including zero-row clones and idempotent replays). */
    cloneSessionRows(parentId: string, childId: string, throughSeq: number): boolean {
        if (this.getSessionRow(parentId) === null) return false;
        this.db.transaction(() => {
            const parent = this.getSessionRow(parentId);
            if (parent === null) return;
            const existing = this.getSessionRow(childId);
            if (existing !== null) {
                // Idempotent replay — never duplicate rows on a retried fork.
                const already = this.db
                    .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
                    .get(childId) as Record<string, unknown>;
                if ((already.n as number) > 0) return;
            }
            this.db
                .prepare(
                    `INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at)
                     SELECT ?, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at FROM messages
                     WHERE session_id = ? AND seq <= ?`,
                )
                .run(childId, parentId, throughSeq);
            this.db
                .prepare(
                    `INSERT INTO message_media (session_id, seq, media_hash)
                     SELECT ?, seq, media_hash FROM message_media
                     WHERE session_id = ? AND seq <= ?`,
                )
                .run(childId, parentId, throughSeq);
            // One refcount bump per COPIED ROW — the same discipline as the
            // insert path (putContent per landed row) and every release path
            // (deleteSession/gc/retire release per row). DISTINCT here
            // under-counted when one session attached the same media bytes to
            // two messages (two mapping rows, one hash → +1 instead of +2):
            // deleting the child then the parent dropped the count to zero
            // while a third session still referenced the bytes, and the
            // zero-ref sweep deleted live media. (For message content the
            // serialized JSON embeds the message id, so distinct == per-row
            // there — but per-row is the invariant, not the optimization.)
            const hashes = this.db
                .prepare("SELECT content_hash AS h FROM messages WHERE session_id = ?")
                .all(childId) as Record<string, unknown>[];
            for (const row of hashes) this.putContentRef(row.h as string);
            const media = this.db
                .prepare("SELECT media_hash AS h FROM message_media WHERE session_id = ?")
                .all(childId) as Record<string, unknown>[];
            for (const row of media) this.putContentRef(row.h as string);
            this.db
                .prepare(
                    `INSERT INTO sessions (session_id, created_at, updated_at, parent_session_id, fork_point_seq)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(session_id) DO UPDATE SET
                       parent_session_id = excluded.parent_session_id,
                       fork_point_seq = excluded.fork_point_seq`,
                )
                .run(
                    childId,
                    Date.now(),
                    Date.now(),
                    parentId,
                    throughSeq,
                );
        });
        return true;
    }

    private putContentRef(hash: string): void {
        const res = this.db
            .prepare(
                "UPDATE content SET refcount = refcount + 1 WHERE hash = ?",
            )
            .run(hash);
        if (res.changes === 0) {
            // A dangling reference would otherwise be an uncounted clone row:
            // every later delete releases a ref nobody took (negative count →
            // delete-on-zero GC sweeps bytes other sessions still reference).
            throw new Error(`putContentRef: content row missing for hash ${hash.slice(0, 16)}… — refusing to fork with an uncounted ref`);
        }
    }

    /** #D5-5 render windowing: identity-only rows (seq + msg_id) — no
     *  content bytes, no media hydration. The render lane needs every row's
     *  POSITION and id (block anchoring, seam chain byId), but covered rows'
     *  BYTES never ride the outbound — loading them per request is pure read
     *  amplification on big folded sessions. */
    messageIdRows(sessionId: string): { seq: number; msgId: string }[] {
        const rows = this.db
            .prepare("SELECT seq, msg_id FROM messages WHERE session_id = ? AND retired_at IS NULL ORDER BY seq")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({ seq: r.seq as number, msgId: r.msg_id as string }));
    }

    /** #D5-5 render windowing: full rows (content + media) ONLY for seqs
     *  outside the covered intervals. Inclusive [start, end] pairs; overlaps
     *  are harmless (each pair contributes an outside-of-pair conjunct).
     *  Empty interval list = every live row. */
    uncoveredRows(sessionId: string, intervals: readonly [number, number][]): (MessageRow & { contentHash: string })[] {
        let sql = "SELECT seq, msg_id, ref, ref_num, role, kind, content_hash FROM messages WHERE session_id = ? AND retired_at IS NULL";
        const params: unknown[] = [sessionId];
        for (const [a, b] of intervals) {
            sql += " AND (seq < ? OR seq > ?)";
            params.push(a, b);
        }
        sql += " ORDER BY seq";
        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
        return rows.map((r) => ({
            seq: r.seq as number,
            msgId: r.msg_id as string,
            ref: (r.ref as string | null) ?? null,
            refNum: (r.ref_num as number | null) ?? null,
            role: r.role as string,
            kind: r.kind as string,
            contentHash: r.content_hash as string,
            content: this.hydrateMedia(this.getContent(r.content_hash as string) ?? ""),
        }));
    }

    getMessages(sessionId: string, opts?: { includeRetired?: boolean }): (MessageRow & { contentHash: string; retiredAt: number | null })[] {
        // #4390: retired rows (rewound/undo history) stay out of the unified
        // replay by default — they are history, not view. Callers that need
        // the full historian record (export/diagnostics) opt in.
        const rows = this.db
            .prepare(
                opts?.includeRetired === true
                    ? "SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, retired_at FROM messages WHERE session_id = ? ORDER BY seq"
                    : "SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, retired_at FROM messages WHERE session_id = ? AND retired_at IS NULL ORDER BY seq",
            )
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            seq: r.seq as number,
            msgId: r.msg_id as string,
            ref: (r.ref as string | null) ?? null,
            refNum: (r.ref_num as number | null) ?? null,
            role: r.role as string,
            kind: r.kind as string,
            contentHash: r.content_hash as string,
            retiredAt: (r.retired_at as number | null) ?? null,
            content: this.hydrateMedia(this.getContent(r.content_hash as string) ?? ""),
        }));
    }

    /** #3762: swap {"$media": hash} references back to the CAS bytes. Only
     *  touches content that carries the marker; key order is preserved by
     *  parse/stringify so the result is byte-identical to the pre-split
     *  serialization. A missing CAS row (corruption / manual surgery) falls
     *  back to the split form rather than throwing — visible, not silent. */
    private hydrateMedia(content: string): string {
        let out = content;
        if (out.includes("\"$media\"")) {
            try {
                const parsed = JSON.parse(out) as { imageBase64?: unknown };
                const slot = parsed.imageBase64;
                if (slot !== null && typeof slot === "object" && typeof (slot as { $media?: unknown }).$media === "string") {
                    const bytes = this.getContent((slot as { $media: string }).$media);
                    if (typeof bytes === "string" && bytes.length > 0) {
                        parsed.imageBase64 = bytes;
                        out = JSON.stringify(parsed);
                    }
                }
            } catch {
                // fall through: raw-sidecar pass below still runs
            }
        }
        // #4069: restore data-URL payloads swapped out of raw wire sidecars.
        if (out.includes(";base64,{$media:")) {
            out = out.replace(
                /data:([a-zA-Z0-9.+\/\-]+);base64,\{\$media:([0-9a-f]{64})\}/g,
                (all: string, mime: string, hash: string) => {
                    const bytes = this.getContent(hash);
                    return typeof bytes === "string" && bytes.length > 0 ? `data:${mime};base64,${bytes}` : all;
                },
            );
        }
        return out;
    }

    /** #3762 test/ops helper: refcount of the content row holding exactly
     *  these media bytes. */
    mediaRefCount(bytes: string): number {
        const row = this.db.prepare("SELECT refcount FROM content WHERE CAST(bytes AS TEXT) = ?").get(bytes) as { refcount: number } | undefined;
        return row ? row.refcount : 0;
    }

    getBlocks(sessionId: string): (BlockRow & { summaryHash: string; oneHash: string | null })[] {
        const rows = this.db
            .prepare(
                `SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash,
                        supersedes_block_id, active, created_at, covered_hash, payload_json
                 FROM blocks WHERE session_id = ? ORDER BY ord`,
            )
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            blockId: r.block_id as string,
            ord: r.ord as number,
            startSeq: r.start_seq as number,
            endSeq: r.end_seq as number,
            startRef: (r.start_ref as number | null) ?? null,
            endRef: (r.end_ref as number | null) ?? null,
            tier: r.tier as number,
            summaryHash: r.summary_hash as string,
            oneHash: (r.one_hash as string | null) ?? null,
            summary: this.getContent(r.summary_hash as string) ?? "",
            one: r.one_hash ? (this.getContent(r.one_hash as string) ?? null) : null,
            supersedesBlockId: (r.supersedes_block_id as string | null) ?? null,
            active: (r.active as number) === 1,
            createdAt: r.created_at as number,
            coveredHash: r.covered_hash as string,
            payloadJson: r.payload_json as string,
        }));
    }

    getDeadRefs(sessionId: string): { ord: number; ref: string; refNum: number; recordedAt: number }[] {
        const rows = this.db
            .prepare("SELECT ord, ref, ref_num, recorded_at FROM dead_refs WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            ref: r.ref as string,
            refNum: r.ref_num as number,
            recordedAt: r.recorded_at as number,
        }));
    }

    getRefs(sessionId: string): RefRow[] {
        const rows = this.db
            .prepare("SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            rawId: r.raw_id as string,
            ref: r.ref as string,
            refNum: (r.ref_num as number | null) ?? null,
        }));
    }

    getCcr(sessionId: string): MessageContentStore | null {
        const row = this.db
            .prepare("SELECT ccr_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { ccr_json: string | null } | undefined;
        if (!row || row.ccr_json === null) return null;
        try {
            const parsed = JSON.parse(row.ccr_json) as MessageContentStore;
            if (parsed && typeof parsed === "object" && parsed.version === 1
                && parsed.byHash && typeof parsed.byHash === "object"
                && parsed.byRef && typeof parsed.byRef === "object") {
                return parsed;
            }
        } catch {
            // fall through: a corrupt mirror degrades to the file path
        }
        return null;
    }

    getCcrEntries(sessionId: string): CcrEntryRow[] {
        const rows = this.db
            .prepare("SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            key: r.ccr_key as string,
            content: this.getContent(r.content_hash as string) ?? "",
        }));
    }
}
