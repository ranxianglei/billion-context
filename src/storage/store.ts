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

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, unlinkSync, statSync, openSync, fsyncSync, fchmodSync, closeSync, renameSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { log as loggerLog } from "../logger.js";
import { openSqliteDatabase, type SqliteDatabase, type SqliteEngineName, type SqliteEngineSource } from "./driver.js";
import { migrateSchema, storagePragmas, WAL_JOURNAL_SIZE_LIMIT } from "./schema.js";
import { identityOfStoredContent, splitMediaContent } from "./identity.js";
import { hydrateSlimCcrStore } from "./slim.js";
import {
    egressAppendTurn,
    egressStateAt,
    egressFlowWalkBack,
    egressStateRead,
    egressStateView,
    egressFork,
    egressMaterializeState,
    egressMessageHighWater,
    EgressStateCorruptError,
    type EgressOp,
    type EgressViewRow,
} from "./egress-state.js";
import { egressPlaneGateOn } from "../knobs.js";
import {
    diffBlockSet,
    egressBlockAppend,
    egressBlockReplay,
    egressBlockView,
    egressPointFork,
    serializeKstateResidual,
    serializeKstateResidualFromKstateJson,
    type EgressBlockOp,
    type EgressBlockSnapshot,
} from "./egress-block.js";
import {
    snapL1Record,
    snapR3LatchedRead,
    snapR3LatchedReadOnSession,
    snapR3LatchClear,
    snapR3LatchClearOnSession,
    snapR3LatchWrite,
    snapR3LatchWriteOnSession,
    snapR3LatchedList,
    snapR3LatchedListOnSessions,
} from "./snap.js";
import { FoundationRejectError, stage0Decide, type Stage0Result } from "../snapshot/plane.js";
import { EGRESS_SYSTEM_MSGID, type EgressIdentityInput } from "./egress-record.js";
import {
    egressUsageAppend,
    egressUsageDelete,
    egressUsageRows,
    readUsageStats,
    writeUsageStats,
    writeUsageStatsBestEffort,
    USAGE_STAT_KEY,
    type EgressUsageEvent,
    type EgressUsageRow,
} from "./egress-usage.js";
import { recordIntegrityOutcome, recordSecondProcessOwner, recordBackupOutcome } from "./runtime-status.js";
import { integrityModeFor, writeIntegrityCache, scheduleBackgroundIntegrityCheck, backgroundIntegrityInflightForTests, noteIntegrityCheckRun } from "./integrity-check.js";
import { sqliteCorruptionDetail } from "./sqlite-errors.js";
import { listInstances, type RegistryEntry } from "../instance.js";
import type { MessageContentStore } from "acp-kernel";

/** #3250: run a PASSIVE wal_checkpoint every N successful ingests. The
 *  built-in autocheckpoint alone cannot guarantee reclamation in a long-lived
 *  process: while a foreign connection holds a read snapshot (dashboard /
 *  export / second lane sharing the directory — #2671 topology) WAL backfill
 *  is blocked at that snapshot and frames pile up. PASSIVE moves committed
 *  frames into the main db WITHOUT touching the WAL file (no floor reclaim
 *  under live peers — the #7156/#7674 discipline) and never blocks the
 *  ingest path; a failed checkpoint is logged and forgotten — the next tick
 *  retries. File-size reclamation is a separate concern: an explicit
 *  journal_size_limit (when configured) or an operator's ?vacuum=full. */
const WAL_CHECKPOINT_EVERY_INGESTS = 20;

/** PR #4725 N3: covered-seq span point queries chunk the msg_id IN (…) list
 *  to stay under SQLite's 999 bound-parameter limit (1 session id + 500). */
const SEQ_SPAN_QUERY_BATCH = 500;
/** Max bound parameters per generated statement (refs batching, #5744).
 *  Well under the conservative 999-parameter default some SQLite builds
 *  still ship with — see sqlite3.MAX_BIND_PARAMS. */
const REF_STMT_MAX_PARAMS = 700;

/** #4796: rows per batch of gc()'s zero-ref CAS sweep. Sized so one batch's
 *  page churn stays modest even when the store is dominated by multi-MB
 *  blobs (~22 KB field-measured orphan average → ~44 MB/batch): each batch
 *  commits and checkpoints independently, bounding its WAL growth and
 *  write-lock hold to one batch instead of the whole table. */
const GC_ZERO_REF_BATCH_SIZE = 2000;

/** #4796 follow-up: statement size of the lifecycle-scoped zero-ref sweep
 *  (collectZeroRefIn) — well under SQLite's variable-count limit; a
 *  session's distinct released hashes exceed it only pathologically, and
 *  the loop simply continues with the next chunk. */
const ZERO_REF_SWEEP_CHUNK = 500;

export function rewriteArchiveLog(file: string, text: string): void {
    const target = realpathSync(file);
    const tmp = `${target}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
        const mode = statSync(target).mode & 0o777;
        fd = openSync(tmp, "wx", mode);
        fchmodSync(fd, mode);
        writeFileSync(fd, text);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, target);
    } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(tmp); } catch { /* rename already consumed the temporary file */ }
    }
}
/** #4739 test instrumentation: message rows materialized by getMessages
 *  (including content decoding + media hydration). Production code never
 *  reads this; tests assert ordinary loads stop decoding the whole
 *  historical log. */
export const messageRowReads = { count: 0 };

export function sha256Hex(bytes: string | Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export interface SessionRow {
    sessionId: string;
    parentSessionId?: string | null;
    forkPointSeq?: number | null;
    /** #7658: the FLOW-clock watermark (MAX op_seq of the parent's
     *  egress_flow at fork time) the four egress tables were copied at.
     *  fork_point_seq carries the unified-message through-seq — NULL for
     *  egress-on parents whose unified leg is frozen, so the egress fork
     *  point needs its own carrier. NULL = no egress copy (egress-off or
     *  the MySQL lane, which has no egress tables). */
    forkEgressWatermark?: number | null;
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
     *  pluginSnapshotSeqs?: number[]|null} (loadLegacyView's contract).
     *  Content itself lives in messages. */
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
    /** #4313: immutable local time-of-occurrence (epoch ms). Ingest input:
     *  taken from the message's first-sight stamp when present, else the
     *  per-batch sampled now. Readers: NULL for pre-v10 rows (no backfill).
     *  Never UPDATEd once written — INSERT OR IGNORE keeps the first value. */
    ts?: number | null;
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

/** #6029: one stored message addressed by its STABLE msg_id (the content-derived
 *  identity). Unlike ref_num — frozen at index time — msg_id never moves under a
 *  restampRefsToLedger renumbering, so it is the correct join key for the web
 *  hydration lane once the live ref space has diverged from the stored numbers. */
export type MessageIdContentRow = { msgId: string; role: string; kind: string; content: string };

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
    /** #5744: sha256(summary) computed by the planner — lets ingest
     *  compare against the stored row BEFORE any CAS op, so an
     *  unchanged block costs neither a re-hash nor a refcount dance. */
    summaryHash: string;
    /** JSON of the one-line BlockView, or null (legacy #401 collapse). */
    one: string | null;
    /** #5744: sha256(one), or null with `one`. */
    oneHash: string | null;
    supersedesBlockId: string | null;
    active: boolean;
    createdAt: number;
    coveredHash: string;
    /** Verbatim serialized CompressionBlock (includes summary). */
    payloadJson: string;
    /** #7439 ruling 2: self-contained summary bytes (inline, no content JOIN). */
    summaryBytes?: string | null;
    /** #7439 ruling 2: msgid of the first message in the block. */
    startMsgid?: string | null;
    /** #7439 ruling 2: msgid of the last message in the block. */
    endMsgid?: string | null;
    /** #7439 follow-up (C6): kernel-attested coverage bounds in the 1-based
     *  flow display space (CoreMessage.ledgerSeq / refs #4316 L3). Bound when
     *  the kernel could prove the fold covered a single contiguous span of
     *  stamped messages; absent otherwise. Egress-on sessions bind block seq
     *  coordinates from these (ingestSession); eg-off never reads them. */
    provenStartSeq?: number;
    provenEndSeq?: number;
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
    /** #5744: sha256(content) from the planner — unchanged entries skip the
     *  CAS bump/release round-trips entirely on steady-state ingests. */
    contentHash: string;
    /** #6785 step 6: the original text behind entry.hash (the byHash half
     *  of the content store) — the slim ccr_json envelope has no bytes of
     *  its own, the CAS behind these rows is the content home. */
    origContent: string | null;
    /** null with origContent null — the entry HAS a hash but its byHash
     *  bytes are missing (the file lane stays authority); "" = hashless
     *  entry (no original exists) or a legitimate empty original. */
    origHash: string | null;
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
     /** #7595: raw stored fields for the display-title fallback (the export
      *  list + handoff need hostTitle separately from the merged `title`, and
      *  the first block's topic/summary to fall back to when `title` is the
      *  subagent dispatch boilerplate). `title` stays the merged
      *  `hostTitle ?? title` for existing consumers. */
     hostTitle?: string | null;
     firstTopic?: string | null;
     firstSummary?: string | null;
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
 *  CAS ownership follows the references deleteSession releases: several
 *  references within one session can own one blob, while a pinned checkpoint
 *  retains its reference even after that session is removed. */
export interface SessionStorageStats {
    rows: {
        sessions: number;
        conversations: number;
        messages: number;
        media: number;
        blocks: number;
        deadRefs: number;
        refs: number;
        ccrEntries: number;
        /** #6785 step 7: the reaped-block journal rows (orphan_blocks). */
        orphanBlocks: number;
        sessionExt: number;
        checkpoints: number;
        pinnedCheckpoints: number;
        /** #5874: the L1 identity entry this session owns (l1_world, keyed
         *  by the raw host session id). Zero for a never-observed session. */
        l1Entries: number;
        /** #6785 step 8: the row-backed CompressionState fields (state_fields). */
        stateFields: number;
    };
    /** Bytes held in inline JSON columns of this session's rows (sessions
     *  record + blocks payload_json + session_ext value_json) — everything
     *  except the content-addressed blobs. */
    inlineBytes: number;
    /** CAS payload bytes whose last references are released by deletion. */
    casExclusiveBytes: number;
    /** Number of the distinct CAS rows represented by casExclusiveBytes. */
    casExclusiveBlobs: number;
    /** Referenced CAS blobs retained by other sessions or pinned checkpoints. */
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
    /** #6785 step 8: the unbounded CompressionState fields as one row each
     *  (field → JSON value) — the kstate slim split. The kstateJson column
     *  keeps only the bounded fields; rows are upserted on change and a row
     *  for a field that becomes undefined is dropped (bounded ≤ 9). */
    stateFields?: Record<string, string>;
}

/** Extension-namespace guards (#3069): keys/namespaces are non-empty
 *  printable ASCII-range strings up to 256 chars — loose by design (callers
 *  namespace by convention like "r3:" / "web:" / "lane:"), hostile by
 *  accident is what we guard, not hostile by design. */
const EXT_KEY_MAX = 256;
const EXT_VALUE_MAX_BYTES = 4 * 1024 * 1024;

export function validateExtKey(value: string, what: string): void {
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

export function serializeExtValue(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new Error("[storage] extension values must be JSON-serializable (undefined/functions are not)");
    }
    if (Buffer.byteLength(json, "utf8") > EXT_VALUE_MAX_BYTES) {
        throw new Error(`[storage] extension value exceeds ${EXT_VALUE_MAX_BYTES} bytes — store large payloads in the content CAS instead`);
    }
    return json;
}

/** kv_store value hard cap (KDD #25, discussions/7735): kv_store is the
 *  small-config surface (install id, notices, host flags), NOT a blob
 *  store — every value must stay at 256 characters after serialization.
 *  The frozen whitelist holds the two KNOWN growing keys still in service
 *  (each with a retirement path — see docs/deprecations.md); adding an
 *  entry is a review event and must be registered there too. The 4 MB
 *  serializeExtValue ceiling above stays as the last-resort tripwire for
 *  the session_ext side of the API. */
export const KV_VALUE_MAX_CHARS = 256;
export const KV_VALUE_WHITELIST = new Set(["prefix-affinity|v1", "plugin-conversations|table"]);

export function assertKvValueSize(namespace: string, key: string, value: unknown): void {
    if (KV_VALUE_WHITELIST.has(`${namespace}|${key}`)) return;
    const json = JSON.stringify(value);
    const size = json === undefined ? 0 : json.length;
    if (size > KV_VALUE_MAX_CHARS) {
        throw new Error(`[storage] kv value too large: ${namespace}|${key} = ${size} chars (max ${KV_VALUE_MAX_CHARS} — eg-plane cap: retire the payload or add a registered whitelist entry, discussions/7735)`);
    }
}

/** Escapes LIKE metacharacters for the ESCAPE '\\' clause used by listKv. */
function likeEscape(prefix: string): string {
    return prefix.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/** #5874 A/B oracle: effectiveMessageIds from a blocks row's payload_json
 *  (the verbatim CompressionBlock the ingest stored). '' on any parse
 *  failure — a malformed payload just misses the base-set, it never kills
 *  the oracle (the throw path latches dead like any A/B failure). */
function effectiveIdsOfPayload(payload: string | null): string[] {
    if (!payload) return [];
    try {
        const p = JSON.parse(payload) as { effectiveMessageIds?: unknown };
        return Array.isArray(p.effectiveMessageIds) ? (p.effectiveMessageIds as string[]) : [];
    } catch {
        return [];
    }
}

/**
 * #4175: raised when PRAGMA quick_check fails at open. Migrations must never
 * run against a corrupt file, so this fires BEFORE migrateSchema (and from the
 * migration catch for large stores, where the scan was size-skipped); the
 * shadow layer catches it and STARTS WITHOUT THE INDEX — loud alarm, files
 * left EXACTLY in place (no automatic rename/repair/copy/rebuild; auto-
 * recovery from JSON withdrawn because full data recovery cannot be
 * guaranteed without operator involvement). A FAIL verdict is never cached —
 * every boot re-scans fresh; the operator's manual fix (back up, then move
 * index.db{-wal,-shm} aside by hand, start again) is named in the alarm.
 */
export class StorageIntegrityError extends Error {
    constructor(public readonly dbPath: string, public readonly detail: string) {
        super(`[storage] integrity quick_check failed for ${dbPath}: ${detail}`);
        this.name = "StorageIntegrityError";
    }
}

/** #4612: human-readable byte sizing for vacuum start/finish logs.
 *  */
function formatDbSize(bytes: number): string {
    if (bytes < 0) return "?";
    const units = ["B", "KiB", "MiB", "GiB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
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

/** @deprecated Public export surface only — no code path inside this repo
 *  throws it anymore (owner decision 2026-10-31: whatever lanes are involved,
 *  a second-writer condition NEVER blocks startup, it reports and coexists).
 *  Under the withdrawn #5046/B policy (2026-10-29→10-30) callers could opt
 *  into secondWriterPolicy:"degrade" and this error made the open REFUSE when
 *  a live foreign bili process held <db>.lock outside a proven cross-lane
 *  share (#3923/#3959). Owner decision 2026-10-31: multiple processes writing
 *  one index.db IS the supported topology (#5082/#5091) — SQLite WAL is
 *  multi-process safe on a local filesystem — so the condition went back to
 *  informational reporting plus the web/status surface; the genuine hazard,
 *  two instances writing the SAME session, alarms via the split-brain contest.
 *  Kept exported for external code that still imports/catches it. */
export class StorageSecondWriterError extends Error {
    readonly pid: number;
    readonly dbPath: string;
    constructor(pid: number, dbPath: string) {
        super(`another bili process (pid ${pid}) is already writing ${dbPath}`);
        this.name = "StorageSecondWriterError";
        this.pid = pid;
        this.dbPath = dbPath;
    }
}

/**
 * #2195 release-gate fix (e2e-fake-codex failure, 2026-11-13_release-v0.1.214):
 * true when the SQLite file header already declares WAL (header bytes 18-19
 * == 0x02). A plain file read — no database lock, so it is always safe,
 * unlike asking the engine via `PRAGMA journal_mode`.
 */
function dbFileIsAlreadyWal(dbPath: string): boolean {
    try {
        const head = readFileSync(dbPath);
        return head.length >= 100 && head[18] === 0x00 && head[19] === 0x02;
    } catch {
        return false; // file absent/unreadable → not WAL → let the pragma decide
    }
}

export class UnifiedStore {
    readonly engine: SqliteEngineName;
    /** Where the engine came from (#2833): builtin / host / self-downloaded — logged at enable so field diagnosis can tell which acquisition path a lane ran on. */
    readonly engineSource: SqliteEngineSource;
    private readonly db: SqliteDatabase;
    /** #3250: ingest counter driving the cadence-tick WAL checkpoint. */
    private ingestCount = 0;
    /** #5744: last periodic checkpoint result (plus its wall time) for the
     * slow-ingest warn line — lets an operator attribute a stall spike to a
     * checkpoint burst instead of guessing. Null until the first tick. */
    private lastWalTick: { busy: number; log: number; checkpointed: number; ms: number } | null = null;
    /** #4175: the live foreign pid found holding <db>.lock at open, if any. */
    private readonly foreignLockHolder: { pid: number } | null;
    private readonly lockPath: string | null;
    /** KDD #25: whether the legacy payload tables exist in THIS database
     *  (an egress-mode fresh store skips creating them — discussions/7735).
     *  Missing = "no data" for the legacy read getters below: the egress-on
     *  read path must work on a 7-table instance (fork endpoint, session
     *  load), not 503 on the first `no such table: messages`. Probed once
     *  at open (the group is created atomically, so one probe covers all
     *  twelve); fault → true (assume present = pre-gate behavior). */
    private legacyTablesPresent = true;
    private readonly dbPath: string;
    /** #4609: a check that RAN IN THIS LIFETIME (sync scan or background
     * verdict) said the file set is sound — a clean close then refreshes the
     * verdict cache onto the post-checkpoint stats so the next boot skips
     * the rescan. A boot-time CACHED-ok deliberately does NOT arm this
     * (#7156 review): re-stamping a verdict we never re-verified would
     * perpetuate a poisoned .chk forever (cache hit → close → re-stamp →
     * cache hit ...); without the re-stamp the post-close stat change forces
     * the next boot to rescan fresh. Never true while a check is still in
     * flight or failed. */
    private lastIntegrityOk = false;
    /** #7156 review: a live foreign writer was observed at any point in this
     * lifetime (boot, background-check completion, close). While true, NO ok
     * verdict may be cached: the file moved outside this process's verified
     * writes, so every cache write site defers to the next boot's fresh scan. */
    private sawForeignWriter = false;
    /** #5539 secondary finding: releaseContent runs once per released hash
     * (~3K/turn on busy sessions); per-call prepare() measured ~7x slower than
     * reuse in the field report (0.063 vs 0.009 ms/call). The db handle is
     * per-instance and readonly for the store's whole life, so a statement
     * prepared once stays valid until close(). */
    private releaseDecrement: ReturnType<SqliteDatabase["prepare"]> | null = null;
    private releaseDelete: ReturnType<SqliteDatabase["prepare"]> | null = null;

    private constructor(db: SqliteDatabase, engine: SqliteEngineName, engineSource: SqliteEngineSource, lockPath: string | null, foreignLockHolder: { pid: number } | null, dbPath: string) {
        this.db = db;
        this.engine = engine;
        this.engineSource = engineSource;
        this.lockPath = lockPath;
        this.foreignLockHolder = foreignLockHolder;
        this.dbPath = dbPath;
        // KDD #25: probe the legacy group ONCE per open (it is created
        // atomically, so one table answers for all twelve); a fault means
        // "assume present" (pre-gate behavior — every query stays live).
        try {
            this.legacyTablesPresent =
                (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get() as { 1?: number } | undefined) !== undefined;
        } catch {
            this.legacyTablesPresent = true;
        }
    }

    static open(
        path: string,
        engine?: SqliteEngineName,
        opts?: { walJournalSizeLimitBytes?: number; legacyTables?: boolean },
    ): UnifiedStore {
        mkdirSync(dirname(path), { recursive: true });
        const { db, engine: used, source } = openSqliteDatabase(path, engine);
        // The pre-migration quick_check below runs BEFORE the storagePragmas
        // loop installs the connection's busy handler — on a bare handle the
        // first statement throws raw SQLITE_BUSY the instant a concurrent
        // writer holds the lock. That is a real, reachable shape, not a lab
        // artifact: the launcher kills its proxy fire-and-forget on exit
        // (stopProxy is a bare SIGTERM, no wait-for-exit), so the NEXT launch's
        // opener routinely starts while the previous instance is still
        // draining its graceful flush against the SAME shared sessions dir
        // (one index.db per machine is the supported topology, #5082). The
        // e2e #2195 gate hit exactly this: the fresh proxy parked on the
        // startup-failure page ("database is locked") and the launcher burned
        // its 60 s health budget on a child whose only problem was a missing
        // busy handler. busy_timeout is a connection-level pragma that never
        // touches the file, so it is safe to install before the corruption
        // classification below; storagePragmas reapplies the same value
        // idempotently for the remaining opens.
        db.exec("PRAGMA busy_timeout = 5000");
        // #4175/#4609: integrity self-check, verdict-cached and size-gated.
        // An unchanged file set (index.db + -wal stats + schema version) skips
        // the rescan; a small store checks synchronously BEFORE migrations (a
        // corrupt file must never be migrated against — #4175's premise,
        // preserved wherever it is cheap); a large store checks in the
        // background post-open (#4609: a 14 GB quick_check costs ~260 s and
        // the 60 s native spawn budget killed the child mid-scan). A proven
        // failure throws StorageIntegrityError as an INTERNAL signal — the
        // shadow layer alarms loudly and starts WITHOUT the index (files left
        // exactly in place; owner chain 2026-10-30 final form). Only PASS
        // verdicts are cached (rescan skip); FAILs are never persisted, so a
        // stale FAIL left behind by an older version is treated as a miss and
        // re-scanned fresh. BILI_STORAGE_QUICK_CHECK=0 opts out of all
        // of it (no check, no cache IO).
        // #7156 review: read the ownership lock BEFORE any ok verdict is
        // cached (the claim below at #4175 happens AFTER the integrity block
        // and would overwrite this evidence). A live foreign holder means the
        // file may change outside this process's writes while our scan runs —
        // an ok verdict stamped in that window poisons every later boot
        // (cache hit skips the rescan; the incident's .chk ok at 19:19:23 was
        // written by exactly such a scan while the wedged predecessor was
        // still writing). Fail-open like the #4175 block: unreadable means
        // "no evidence".
        let foreignLockPidAtBoot: number | null = null;
        try {
            const bootLockPath = `${path}.lock`;
            if (existsSync(bootLockPath)) {
                const parsed = JSON.parse(readFileSync(bootLockPath, "utf8")) as { pid?: unknown };
                const pid = typeof parsed.pid === "number" ? parsed.pid : null;
                if (pid !== null && pid !== process.pid && processAlive(pid)) foreignLockPidAtBoot = pid;
            }
        } catch {
            /* unreadable lockfile: no evidence of a foreign writer */
        }
        let bootVerdictFresh = false; // this lifetime actually scanned ok (sync or background)
        const mode = integrityModeFor(path);
        if (mode.kind === "cached-ok") {
            recordIntegrityOutcome(path, true, 0, "verdict cache hit (file set unchanged since the last check)");
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
                // MOVE the file aside by hand (backed up first), and Windows
                // refuses to move a file this process still holds (EBUSY,
                // #4347 probe).
                // #5108/#4816: corruption-shaped THROWS (truncated file, garbage
                // header, broken overflow chain) must become StorageIntegrityError
                // like the verdict-row path does — the raw rethrow escaped the
                // shadow's integrity guard (#4175) and left the corrupt set in
                // place forever. Transient shapes (BUSY/IOERR/CANTOPEN) stay raw:
                // quarantining a locked-but-healthy index would be the bug.
                recordIntegrityOutcome(path, false, Date.now() - started, String(err).slice(0, 400));
                db.close();
                const detail = sqliteCorruptionDetail(err);
                if (detail !== null) {
                    // 2026-10-30 owner policy (final form): this FRESH in-boot
                    // finding throws to the shadow layer, which alarms and
                    // starts WITHOUT the index — files untouched, nothing
                    // cached as a boot-blocker; the next start re-scans and
                    // decides from fresh evidence.
                    throw new StorageIntegrityError(path, detail.slice(0, 400));
                }
                throw err;
            }
            const durationMs = Date.now() - started;
            recordIntegrityOutcome(path, verdict === "ok", durationMs, verdict === "ok" ? undefined : verdict.slice(0, 400));
            if (verdict !== "ok") {
                // Same policy as the throwing-scan branch above: throw the typed
                // signal (shadow layer alarms + starts without the index),
                // persist nothing — every future boot rechecks with its own
                // live scan.
                db.close();
                throw new StorageIntegrityError(path, verdict.slice(0, 400));
            }
            // #7156 review: never cache an ok verdict stamped while a live
            // foreign writer holds the lock — same reasoning as the boot-time
            // pre-read above; the next boot re-scans fresh instead of trusting
            // a scan that raced a second writer.
            if (foreignLockPidAtBoot === null) {
                writeIntegrityCache(path, true);
            } else {
                loggerLog("info", `[storage] quick_check passed for ${path}, but live foreign writer pid ${foreignLockPidAtBoot} holds ${path}.lock — NOT caching the ok verdict (the file may change outside this process's writes); the next boot re-scans fresh (#7156)`);
            }
            bootVerdictFresh = true;
        }
        // #4175: second-process-on-the-same-db detection. A live foreign pid
        // is surfaced (web wire + banner) as INFORMATIONAL ONLY. #5082: sharing
        // one index.db is the SUPPORTED topology — SQLite WAL is multi-process
        // safe on a local filesystem and the machine-global sessions dir is
        // deliberately shared — so coexistence with a live foreign writer never
        // blocks startup, whatever lane the foreign pid maps to (or none:
        // inline lanes never register). Owner decision 2026-10-31: the former
        // #5046/B refuse-to-start policy for risky double-write shapes was
        // withdrawn — no lane condition blocks anymore. The real hazard, two
        // instances writing the SAME session, has its own per-session alarm
        // (the #3923 split-brain contest). A dead pid means a stale lock:
        // take it over.
        const lockPath = `${path}.lock`;
        let foreignLockHolder: { pid: number } | null = null;
        try {
            if (existsSync(lockPath)) {
                const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
                const pid = typeof parsed.pid === "number" ? parsed.pid : null;
                if (pid !== null && pid !== process.pid && processAlive(pid)) {
                    foreignLockHolder = { pid };
                    // When stale entries share the pid (restarted instance),
                    // the newest startedAt is the live one.
                    const peer = listInstances()
                        .filter((e) => e.pid === pid)
                        .reduce<RegistryEntry | undefined>((best, e) => (best === undefined || (e.startedAt ?? 0) > (best.startedAt ?? 0) ? e : best), undefined);
                    // #5091/#5082 (owner decision 2026-10-31): reporting is
                    // INFORMATIONAL for every live foreign holder — whatever
                    // its lane identity (same lane, cross-lane, or unregistered
                    // inline/pre-#5046 marker). SQLite WAL multi-process open
                    // is safe on a local disk; the real hazard (two instances
                    // writing the SAME session) alarms separately (split-brain
                    // contest).
                    const peerOf = peer !== undefined ? ` (lane ${peer.lane ?? "?"}, instance ${peer.instanceId.slice(0, 8)})` : "";
                    loggerLog("info", `[storage] process pid ${pid}${peerOf} is also using ${path} — multiple instances sharing one sessions dir is the supported topology (#5082/#3923); two instances walking the SAME session alarm separately (split-brain contest)`);
                    recordSecondProcessOwner(pid, { lane: peer?.lane, instanceId: peer?.instanceId, benign: true });
                }
            }
            writeFileSync(lockPath, JSON.stringify({ pid: process.pid, boot: Date.now() }));
        } catch (err) {
            loggerLog("warn", `[storage] lockfile discipline skipped for ${path}: ${String(err)}`);
        }
        try {
            const limit = opts?.walJournalSizeLimitBytes ?? WAL_JOURNAL_SIZE_LIMIT;
            for (const pragma of storagePragmas(limit)) {
                if (pragma === "PRAGMA journal_mode = WAL") {
                    // The #2195 trap: `PRAGMA journal_mode` needs exclusive
                    // access and BYPASSES the connection's busy handler — it
                    // throws raw SQLITE_BUSY instantly while a peer holds a
                    // write transaction (repro: holder BEGIN IMMEDIATE +
                    // insert, fresh handle with busy_timeout=5000 installed →
                    // journal_mode throws at 0 ms, quick_check is fine).
                    // That peer is the normal one: stopProxy is fire-and-
                    // forget, so the previous proxy may still be draining its
                    // final flush on this same machine-global file when the
                    // next launch opens it (#5082). Two cases:
                    if (dbFileIsAlreadyWal(path)) {
                        // The store is ALREADY WAL (created WAL, never
                        // switched back) — skipping the pragma is a strict
                        // no-op and saves the exclusive acquisition entirely.
                        continue;
                    }
                    try {
                        db.exec(pragma);
                    } catch (err) {
                        const msg = String((err as { message?: unknown })?.message ?? err);
                        if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw err;
                        // The file is still in its legacy journal mode and a
                        // peer holds the write transaction, so the switch
                        // cannot run right now. #5082 owner decision
                        // 2026-10-31: a live foreign writer never blocks
                        // startup — defer the switch to the next open (the
                        // previous open already moved the file to WAL in the
                        // normal case) and continue in the current journal
                        // mode, which is safe multi-process, just less
                        // concurrent.
                        loggerLog("warn", `[storage] journal_mode=WAL deferred for ${path} — a peer holds the write lock (#5082); continuing in the current journal mode, switch retries on the next open`);
                        continue;
                    }
                }
                db.exec(pragma);
            }
            migrateSchema(db, {
                // egress-mode table creation gate (KDD #25, discussions/7735):
                // an eg-mode fresh database gets only the core trio plus the
                // egress groups — the 12 legacy tables are probed back in on
                // a later open once egressPlane is off (migrateSchema).
                // The on/off DECISION is made by the caller (UnifiedShadow
                // .maybeOpen): evaluating featureEnabled() here would run the
                // install-id bootstrap (rolloutInstallId's wx file race) in
                // the middle of a store open — a side effect that breaks
                // fresh-install id semantics (rollout-identity suites).
                // BILI_TEST_FORCE_FULL_DDL (TEST-ONLY escape hatch) lives at
                // that call site: suites asserting the LEGACY table shape
                // while egressPlane=1 simulate a pre-gate DB and set it.
                // Direct UnifiedStore.open callers default to the full set.
                legacyTables: opts?.legacyTables ?? true,
            });
        } catch (err) {
            // The handle we just opened must not leak when the file turns out
            // to be corrupt: the #2771 fallback tells operators to MOVE the
            // file aside by hand (backed up first) to reset the index — and
            // Windows refuses to move a file a live process still holds open.
            // Close, then rethrow — the shadow layer alarms and starts WITHOUT
            // the index (files left exactly in place; no cache writes at all).
            // #5108/#4816: large stores (> sync threshold) skip the pre-migration
            // scan, so a corruption can surface HERE first — classify it the same
            // way instead of letting an unexplained raw driver error out.
            db.close();
            const detail = sqliteCorruptionDetail(err);
            if (detail !== null) throw new StorageIntegrityError(path, detail.slice(0, 400));
            throw err;
        }
        const store = new UnifiedStore(db, used, source, lockPath, foreignLockHolder, path);
        if (foreignLockHolder !== null) store.noteForeignWriterSeen(foreignLockHolder.pid);
        if (bootVerdictFresh) store.noteIntegrityOk();
        // #3250: converge the frames an unclean exit left behind (SIGKILL /
        // power loss never reaches close()). Moving committed frames into the
        // main db now shortens the NEXT crash's recovery replay. Isolated from
        // the open contract above on purpose: under a multi-process shared
        // directory (#2671) a checkpoint can come back busy while a foreign
        // connection is mid-transaction — that must log, not fail the open;
        // the periodic and close-time passes retry. #7674: PASSIVE, not
        // TRUNCATE — a TRUNCATE reclaim fetches the WAL file and its -shm
        // index out from under live peers; a peer holding a stale view of
        // that index then writes into reclaimed offsets, the #7156 damage
        // shape (pages double-allocated, "2nd reference to page", index
        // pages corrupting before table pages). PASSIVE moves every frame it
        // can without touching the file: same replay shortening, no floor
        // reclaim. The file stays at its historical high-water mark
        // (bounded; shrink on demand with ?vacuum=full or an explicit
        // storage.walJournalSizeLimitBytes).
        try {
            db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
        } catch (err) {
            loggerLog("warn", `[storage] WAL checkpoint on open failed for ${path}: ${String(err)}`);
        }
        // #4609: a large store's cache-miss check runs post-open on a second
        // read-only connection — open() returns immediately; the verdict
        // lands in runtime-status as an ALARM ONLY (2026-10-30 owner policy:
        // a running store's background verdict never refuses future boots —
        // each next boot re-scans fresh; no automatic file moves, #4175).
        // #7156 review: the completion-side ok cache write is gated on the
        // same foreign-writer evidence as the close-time refresh — the
        // incident's .chk ok was written by THIS path (background quick_check
        // started 19:19:02 while the wedged predecessor was still writing).
        if (mode.kind === "async") scheduleBackgroundIntegrityCheck(
            path,
            (ok) => { if (ok) store.noteIntegrityOk(); },
            () => store.activeForeignWriter(),
            (pid) => store.noteForeignWriterSeen(pid),
        );
        return store;
    }

    /** #4609: mark this instance's file set as verified by a scan that ran IN
     * THIS LIFETIME (sync or background ok) so a clean close refreshes the
     * verdict cache onto the post-checkpoint stats. A boot-time cached ok
     * does NOT call this — see the field comment for why re-stamping an
     * unverified verdict would perpetuate a poisoned cache. */
    noteIntegrityOk(): void {
        this.lastIntegrityOk = true;
    }

    /** #7156 review: a live foreign writer was proven present at some point
     * in this lifetime — suppress every ok-verdict cache write from here on
     * (the file moved outside this process's verified writes; the next boot
     * re-scans fresh). Idempotent; the first sighting logs. */
    noteForeignWriterSeen(pid: number): void {
        if (this.sawForeignWriter) return;
        this.sawForeignWriter = true;
        loggerLog("info", `[storage] live foreign writer pid ${pid} observed in this lifetime — the ${this.dbPath} verdict cache will not be refreshed by this process; the next boot re-scans fresh (#7156)`);
    }

    /** Keep paged reads on one generation without taking the writer lock. */
    readSnapshot<T>(read: () => T): T {
        return this.db.readTransaction(read);
    }

    /** Async callers need a separate connection: an await must not let a
     *  normal save on this store join the reader's transaction. */
    async readSnapshotAsync<T>(read: (reader: UnifiedStore) => Promise<T>): Promise<T> {
        const { db, engine, source } = openSqliteDatabase(this.dbPath, this.engine);
        try {
            db.exec("PRAGMA query_only = ON; BEGIN DEFERRED");
            const reader = new UnifiedStore(db, engine, source, null, null, this.dbPath);
            return await read(reader);
        } finally {
            db.close(); // closing rolls back the read-only transaction
        }
    }

    close(): void {
        // #3250: converge the WAL before releasing the handle so a clean exit
        // leaves nothing for the next boot's recovery to replay. Same isolation
        // as open(): a checkpoint hiccup logs and never throws — callers treat
        // close() as best-effort shutdown work.
        // #7674: PASSIVE, not TRUNCATE. The dying process's FINAL checkpoint
        // was the proven #7156 vector — the incident's old sidecar ran its
        // shutdown checkpoint while its replacement was already writing, and
        // that truncate reclaimed the WAL under a live peer. PASSIVE moves
        // every committable frame into the main db without touching the WAL
        // file: the replay tail is converged, the floor is not reclaimed from
        // under a live successor.
        try {
            this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
        } catch (err) {
            loggerLog("warn", `[storage] WAL checkpoint on close failed: ${String(err)}`);
        }
        this.db.close();
        // #4609: a clean close of a VERIFIED store refreshes the PASS memo onto
        // post-checkpoint stats so the next boot skips the rescan. FAIL verdicts
        // are alarm-only by owner policy (2026-10-30) and are never cached,
        // so there is nothing else to carry here. Deferred while a background
        // check is still in flight (its own completion writes the cache).
        // #7156: the refresh must NOT run while a live foreign writer is present.
        // lastIntegrityOk is a boot-time flag that is never invalidated, so a
        // store that booted healthy but whose file was corrupted by a concurrent
        // second writer (the #7156 dual-writer incident: the wedged predecessor
        // shut down 7s AFTER its replacement had already opened index.db) would
        // otherwise stamp a FRESH ok verdict onto the corrupted file's stats at
        // close — and every boot after that skips the rescan (cache hit) and
        // dies on the first write. A live foreign writer means the file may have
        // moved outside this process's verified writes: skip the refresh so the
        // next boot re-scans fresh. A read-only foreign opener is a safe false
        // positive (it only costs one extra rescan, never a wrong verdict).
        if (!backgroundIntegrityInflightForTests(this.dbPath)) {
            if (this.lastIntegrityOk && !this.sawForeignWriter) {
                const foreign = this.activeForeignWriter();
                if (foreign === null) {
                    writeIntegrityCache(this.dbPath, true);
                } else {
                    loggerLog("info", `[storage] skipping the close-time integrity-cache refresh for ${this.dbPath}: live foreign writer pid ${foreign} present — the file may have changed outside this process's verified writes, so the next boot re-scans fresh (#7156)`);
                }
            } else if (this.lastIntegrityOk && this.sawForeignWriter) {
                loggerLog("info", `[storage] skipping the close-time integrity-cache refresh for ${this.dbPath}: a live foreign writer was seen during this lifetime — the file may have changed outside this process's verified writes, so the next boot re-scans fresh (#7156)`);
            }
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

    /** #4612: a live pid besides ours currently writing this db — the union of
     *  two evidence sources: (1) the foreign holder captured at open, re-validated
     *  for liveness (it may have exited since); (2) a fresh read of <db>.lock
     *  pointing at another live pid — every opener overwrites the lockfile with
     *  its own pid on open, so this catches an instance that started AFTER us.
     *  Null when no live foreign writer is provably present; an unreadable
     *  lockfile means "no evidence" (fail-open) — callers need proof of
     *  liveness to refuse, not certainty of absence. */
    activeForeignWriter(): number | null {
        if (this.foreignLockHolder !== null && processAlive(this.foreignLockHolder.pid)) {
            return this.foreignLockHolder.pid;
        }
        if (this.lockPath !== null) {
            try {
                if (existsSync(this.lockPath)) {
                    const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: unknown };
                    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
                    if (pid !== null && pid !== process.pid && processAlive(pid)) return pid;
                }
            } catch {
                /* unreadable lockfile: no evidence of a writer */
            }
        }
        return null;
    }

    private dbFileSize(): number {
        try {
            return statSync(this.dbPath).size;
        } catch {
            return -1;
        }
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
    /** #6785 step 7: the orphan journal moved OFF the sessions row — one
     *  row per block in orphan_blocks (immutable content; a refreshed view
     *  for the same id is an UPDATE). Keeps the #4242 merge semantics exactly:
     *  incoming entries win on key collision, entries the live session no
     *  longer carries (trimmed by LazyBlockContents) survive — the table is
     *  only ever INSERT/UPDATE, never DELETE within a session. The legacy
     *  orphans_json column migrates onto the table on first ingest and is
     *  then cleared, so the column stops growing and stops being re-written
     *  on every save. Returns null: the column is deprecated. */
    private applyOrphanBlocks(sessionId: string, incomingJson: string | null): null {
        const existing = this.db
            .prepare("SELECT block_id, one_json, full_json FROM orphan_blocks WHERE session_id = ?")
            .all(sessionId) as { block_id: string; one_json: string | null; full_json: string }[];
        const rowMap = new Map(existing.map((r) => [r.block_id, r]));
        const all: Record<string, unknown> = {};
        const col = this.getOrphansJson(sessionId);
        if (col !== null) {
            try {
                const parsed = JSON.parse(col) as Record<string, unknown>;
                if (parsed && typeof parsed === "object") Object.assign(all, parsed);
            } catch { /* corrupt journal → start fresh (the read path skips bad entries too) */ }
        }
        if (incomingJson !== null) {
            try {
                const parsed = JSON.parse(incomingJson) as Record<string, unknown>;
                if (parsed && typeof parsed === "object") Object.assign(all, parsed);
            } catch { /* corrupt incoming → keep existing only */ }
        }
        const upsert = this.db.prepare(
            "INSERT INTO orphan_blocks (session_id, block_id, one_json, full_json) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(session_id, block_id) DO UPDATE SET one_json = excluded.one_json, full_json = excluded.full_json",
        );
        for (const [blockId, view] of Object.entries(all)) {
            const one = (view as { one?: unknown }).one;
            const full = (view as { full?: unknown }).full;
            const oneJson = one === undefined ? null : JSON.stringify(one);
            const fullJson = JSON.stringify(full);
            const row = rowMap.get(blockId);
            if (row && row.one_json === oneJson && row.full_json === fullJson) continue;
            upsert.run(sessionId, blockId, oneJson, fullJson);
        }
        if (col !== null) {
            // Only the legacy migration step writes; steady-state columns are
            // already NULL (PR#6785 review: the unconditional UPDATE made
            // every ingest a sessions-row writer, contradicting the
            // steady-state zero-write design).
            this.db.prepare("UPDATE sessions SET orphans_json = NULL WHERE session_id = ?").run(sessionId);
        }
        return null;
    }

    /** #6785 step 8: row-backed CompressionState fields — one row per field,
     *  upserted only on change (a steady-state flush writes zero rows) and
     *  a row for a row-backed field that becomes undefined is DROPPED (the
     *  column-merge drop-undefined semantics, bounded ≤ 9). Legacy sessions
     *  with no incoming rows keep their column copy (the read path falls
     *  back to it); rows always win over the column on read. */
    private applyStateFields(sessionId: string, fields: Record<string, string>): void {
        const existing = this.db
            .prepare("SELECT field, value_json FROM state_fields WHERE session_id = ?")
            .all(sessionId) as { field: string; value_json: string }[];
        const upsert = this.db.prepare(
            "INSERT INTO state_fields (session_id, field, value_json) VALUES (?, ?, ?) " +
            "ON CONFLICT(session_id, field) DO UPDATE SET value_json = excluded.value_json",
        );
        for (const r of existing) {
            if (fields[r.field] === undefined) {
                this.db.prepare("DELETE FROM state_fields WHERE session_id = ? AND field = ?").run(sessionId, r.field);
            }
        }
        for (const [field, valueJson] of Object.entries(fields)) {
            const row = existing.find((r) => r.field === field);
            if (row && row.value_json === valueJson) continue;
            upsert.run(sessionId, field, valueJson);
        }
    }

    /** #6785 step 8: the unbounded CompressionState field rows (null when
     *  the session has none — legacy sessions read from the column). */
    getStateFields(sessionId: string): Record<string, string> | null {
        if (!this.legacyTablesPresent) return null; // KDD #25: missing legacy group = no data
        const rows = this.db
            .prepare("SELECT field, value_json FROM state_fields WHERE session_id = ?")
            .all(sessionId) as { field: string; value_json: string }[];
        if (rows.length === 0) return null;
        const out: Record<string, string> = {};
        for (const r of rows) out[r.field] = r.value_json;
        return out;
    }

    /** #6785 step 7: the merged orphan journal — orphan_blocks table rows
     *  plus legacy column entries the migration has not reached yet (defence
     *  in depth: after any ingest the column is NULL). null = no orphans
     *  anywhere (callers keep their "null ⇒ skip merge" semantics). */
    getOrphanViews(sessionId: string): Record<string, { one: unknown; full: unknown }> | null {
        if (!this.legacyTablesPresent) return null; // KDD #25: missing legacy group = no data
        const rows = this.db
            .prepare("SELECT block_id, one_json, full_json FROM orphan_blocks WHERE session_id = ?")
            .all(sessionId) as { block_id: string; one_json: string | null; full_json: string }[];
        let out: Record<string, { one: unknown; full: unknown }> | null = null;
        for (const r of rows) {
            if (out === null) out = {};
            out[r.block_id] = { one: r.one_json === null ? null : JSON.parse(r.one_json), full: JSON.parse(r.full_json) };
        }
        const col = this.getOrphansJson(sessionId);
        if (col !== null) {
            try {
                const parsed = JSON.parse(col) as Record<string, { one: unknown; full: unknown }>;
                if (parsed && typeof parsed === "object") {
                    for (const [id, view] of Object.entries(parsed)) {
                        if (out === null) out = {};
                        if (out[id] === undefined) out[id] = view;
                    }
                }
            } catch { /* corrupt legacy column → the table rows remain */ }
        }
        return out;
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
        if (this.releaseDecrement === null) {
            this.releaseDecrement = this.db.prepare(
                "UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0 RETURNING refcount",
            );
        }
        if (this.releaseDelete === null) {
            this.releaseDelete = this.db.prepare("DELETE FROM content WHERE hash = ? AND refcount <= 0");
        }
        const decrement = this.releaseDecrement;
        const remove = this.releaseDelete;
        decrement.all(hash).forEach((row) => {
            if ((row as { refcount: number }).refcount <= 0) {
                remove.run(hash);
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
    /**
     *  opts.envelopeImport (2026-11-21, #7156 incident follow-up): the plan
     *  came from a LEGACY ENVELOPE, not from this process's own state. An
     *  envelope is a pruned render, possibly written by ANOTHER process (a
     *  degraded zero-copy instance, an older build): its block ids collide
     *  with the stored lineage (b1..bN exist in both with different
     *  coverage), so the incoming block set is adopted ONLY when the index
     *  has no stored blocks for the session — otherwise the stored lineage
     *  wins and the envelope contributes its new messages only. Its stats
     *  are guarded the same way (lifetime counters must not regress to a
     *  foreign writer's partial counts). Organic saves pass the flag off and
     *  keep the authoritative-set discipline.
     */
    ingestSession(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean; envelopeImport?: boolean },
        reanchor?: { trustedTailSeqs: number[] },
    ): boolean {
        const s = input.session;
        const ok = this.db.transaction((): boolean => {
            let messages: MessageRow[];
            let watermark: number | null;
            if (reanchor) {
                // #7474 window re-anchor: the pf-window lane persists a
                // SLIDING tail window, so the delta planner's strict-append
                // assumption is structurally false and the full path paid
                // O(all session rows) per HIT turn. Resolve every window row
                // by ONE indexed identity point lookup instead (same
                // answer, O(window)); existing rows keep their seq, new
                // rows continue after max(seq) — byte-identical to what the
                // full path's remap would write for a window plan (which
                // also skips the sweep: completeLog is false). Every doubt
                // returns false → the exact full path.
                // The DEFENSE reads the STORED tail_json (the plan's
                // SessionRow carries the planner's placeholder seqs — the
                // stored row is the same-tick authority the watermark read
                // came from).
                const storedTailRow = this.db.prepare("SELECT tail_json FROM sessions WHERE session_id = ?").get(s.sessionId) as { tail_json: string } | undefined;
                if (!storedTailRow) return false;
                const tail = JSON.parse(storedTailRow.tail_json) as { tailSeqs?: number[] | null };
                const trusted = reanchor.trustedTailSeqs;
                if (
                    !Array.isArray(tail.tailSeqs) ||
                    tail.tailSeqs.length !== trusted.length ||
                    !trusted.every((v, i) => tail.tailSeqs?.[i] === v)
                ) {
                    return false;
                }
                const maxRow = this.db.prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ?").get(s.sessionId) as { m: number | null };
                let nextSeq = maxRow.m === null ? 0 : maxRow.m;
                const resolve = this.db.prepare(
                    "SELECT seq, content_hash, retired_at, ref FROM messages WHERE session_id = ? AND msg_id = ? AND identity = ?",
                );
                const mapped: { m: MessageRow; abs: number }[] = [];
                let anchored = 0;
                for (const m of input.messages) {
                    if (!m.contentHash) return false;
                    const row = resolve.get(s.sessionId, m.msgId, m.identity ?? identityOfStoredContent(m.content)) as
                        | { seq: number; content_hash: string; retired_at: number | null; ref: string | null }
                        | undefined;
                    if (row) {
                        // A tombstoned row is the #4390 rewind-redo case —
                        // the full path reactivates it in place; a pointer
                        // at a retired seq would drop the row from the view.
                        if (row.retired_at !== null) return false;
                        // #4793: stable identity + changed bytes is the
                        // repair case — only the full path adopts fresher
                        // bytes at the same seq. Never keep the stale
                        // generation silently.
                        if (row.content_hash !== m.contentHash) return false;
                        // #6947: minted-ref backfill at first join (the
                        // IS NULL re-check keeps it idempotent).
                        if (m.ref !== null && m.ref !== "BLOCKED" && m.refNum !== null && row.ref === null) {
                            this.db
                                .prepare("UPDATE messages SET ref = ?, ref_num = ? WHERE session_id = ? AND seq = ? AND ref IS NULL")
                                .run(m.ref, m.refNum, s.sessionId, row.seq);
                        }
                        mapped.push({ m, abs: row.seq });
                        anchored++;
                    } else {
                        mapped.push({ m, abs: ++nextSeq });
                    }
                }
                // Nothing anchored (first save / unknown session) — the full
                // path establishes the rows.
                if (anchored === 0) return false;
                messages = mapped.map((x) => ({ ...x.m, seq: x.abs }));
                // tailSeqs = the window's absolute seqs in ENVELOPE order —
                // exactly the shape the full path writes for a window plan;
                // the sweep never ran on those (no completeLog claim). Base on
                // the PLAN's tailJson (not the stored one) so tailFolded /
                // pluginSnapshotSeqs track the current view — the stored copy
                // is stale for a folded save and would drift the replay header
                // (#7474 reanchor must be byte-identical to the full path).
                const planTail = JSON.parse(s.tailJson) as Record<string, unknown>;
                s.tailJson = JSON.stringify({ ...planTail, tailSeqs: mapped.map((x) => x.abs) });
                watermark = mapped[mapped.length - 1].abs;
            } else if (delta) {
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
                        // #5756: a row that is ALREADY retired is pure
                        // bookkeeping — every reader checks only
                        // NULL/non-NULL, so re-stamping the tombstone and
                        // re-sweeping its (already-empty) media mappings
                        // costs O(history) statements per turn on stable
                        // sessions for no effect. First retirement still
                        // does the full work below; later sweeps skip the
                        // row entirely.
                        if (row.retired_at !== null) continue;
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
            // Lineage belongs to the first parent, including its nullable fork
            // point. Later metadata must not reparent or mix the stored pair.
            this.db
                .prepare(
                    `INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin,
                       status, created_at, updated_at, next_block_id, next_run_id,
                       meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq, orphans_json)
                     VALUES (@sessionId, @parentSessionId, @forkPointSeq, @protocol, @label, @title, @hostTitle, @namespace, @origin,
                       @status, @createdAt, @updatedAt, @nextBlockId, @nextRunId,
                       @metaJson, @statsJson, @metadataJson, @kstateJson, @tailJson, @ccrJson, @lastIngestedSeq, @orphansJson)
                     ON CONFLICT(session_id) DO UPDATE SET
                       parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
                       fork_point_seq = CASE WHEN sessions.parent_session_id IS NULL THEN excluded.fork_point_seq ELSE sessions.fork_point_seq END,
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
                       -- 2026-11-21 (#7156 incident): an ENVELOPE import must never
                       -- REGRESS the stored lifetime counters. The envelope's stats
                       -- come from whichever process last rendered it — a degraded
                       -- zero-copy instance carries only its own few requests, so a
                       -- blind overwrite replaced a 1563-request/169M-token row with
                       -- {"requests":2}. Counters are lifetime-monotonic within a
                       -- lineage, so a smaller incoming total names a partial or
                       -- foreign lineage: keep the stored row. Organic saves keep
                       -- the blind overwrite — the live writer IS the counter.
                       stats_json = CASE
                           WHEN @statsGuard = 1
                                AND json_valid(sessions.stats_json)
                                AND json_valid(excluded.stats_json)
                                AND json_extract(excluded.stats_json, '$.requests') IS NOT NULL
                                AND json_extract(sessions.stats_json, '$.requests')
                                    >= json_extract(excluded.stats_json, '$.requests')
                           THEN sessions.stats_json
                           ELSE excluded.stats_json
                       END,
                       metadata_json = CASE WHEN metadata_json IS excluded.metadata_json THEN sessions.metadata_json ELSE excluded.metadata_json END,
                       kstate_json = CASE WHEN kstate_json IS excluded.kstate_json THEN sessions.kstate_json ELSE excluded.kstate_json END,
                       tail_json = excluded.tail_json,
                       ccr_json = CASE WHEN ccr_json IS excluded.ccr_json THEN sessions.ccr_json ELSE excluded.ccr_json END,
                       last_ingested_seq = excluded.last_ingested_seq,
                       -- #6780: no same-value skip here (or for the #6325 columns): an unchanged
                       -- OVERFLOW blob (a JSON column big enough to spill onto overflow pages) is
                       -- copied onto fresh pages whenever ANY column of this row changes, so a
                       -- CASE-when skip only saves inline-size values. Moving the big blobs out of
                       -- the row (table-ization) is the real byte-cost fix.
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
                    statsGuard: opts?.envelopeImport === true ? 1 : 0,
                    lastIngestedSeq: watermark,
                    // #4216/#4242: orphan journal rides the normal upsert with
                    // MERGE semantics (existing entries survive — LazyBlockContents
                    // means the live map may not carry trimmed entries).
                    orphansJson: this.applyOrphanBlocks(s.sessionId, s.orphansJson ?? null),
                });

            // #6785 step 8: row-backed kstate fields ride the same tx (the
            // column keeps only the bounded fields — see splitKstate).
            this.applyStateFields(s.sessionId, input.stateFields ?? {});

            // Identity index (#2960 R2.1): claim (namespace, conversation_id)
            // → session_id. ON CONFLICT DO NOTHING — first claimant wins; while
            // the v1 mapping is the identity a re-ingest is the same triple.
            this.db
                .prepare(
                    "INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES (?, ?, ?, ?) " +
                        "ON CONFLICT(namespace, conversation_id) DO NOTHING",
                )
                .run(s.namespace ?? "proxy", s.sessionId, s.sessionId, s.updatedAt);

            // #4313: one wall-clock sample per save batch — rows without a
            //  per-message first-sight stamp all carry the same second.
            const batchTs = Date.now();
            for (const m of messages) {
                const hash = this.putContent(m.content, m.contentHash);
                const res = this.db
                    .prepare(
                        "INSERT OR IGNORE INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .run(s.sessionId, m.seq, m.msgId, m.ref, m.refNum, m.role, m.kind, hash, m.identity ?? identityOfStoredContent(m.content), typeof m.ts === "number" ? m.ts : batchTs);
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
            // #5744: ONE full-row read serves both the stale sweep and the
            // unchanged-row skip below (previously: 1 hash-only sweep read +
            // 1 point read per block per save).
            type StoredBlockRow = {
                block_id: string; ord: number; start_seq: number; end_seq: number;
                start_ref: number | null; end_ref: number | null; tier: number;
                summary_hash: string; one_hash: string | null; supersedes_block_id: string | null;
                active: number; created_at: number; covered_hash: string; payload_json: string;
                summary_bytes: Buffer | null; start_msgid: string | null; end_msgid: string | null;
            };
            const storedBlocks = new Map<string, StoredBlockRow>();
            for (const row of this.db
                .prepare(
                    "SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, " +
                    "summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json, " +
                    "summary_bytes, start_msgid, end_msgid " +
                    "FROM blocks WHERE session_id = ?",
                )
                .all(s.sessionId) as StoredBlockRow[]) {
                storedBlocks.set(row.block_id, row);
            }
            // #5898 review (P3): rebuild the O(1) membership set the
            // pre-#5744 code had — a per-stored-block Array.some over the
            // incoming blocks is O(stored×incoming) string compares on the
            // sync record() path that #5744 exists to make cheaper.
            const incomingBlockIds = new Set(input.blocks.map((b) => b.blockId));
            // 2026-11-21 (#7156 incident): see the ingestSession envelopeImport
            // contract — an envelope's block set must not delete or replace a
            // stored lineage it never saw (a 32-block coarse render erased a
            // 103-block fine lineage whose summaries existed nowhere else).
            const skipIncomingBlocks =
                opts?.envelopeImport === true && storedBlocks.size > 0 && input.blocks.length > 0;
            if (skipIncomingBlocks) {
                loggerLog(
                    "info",
                    `[storage] envelope import for ${s.sessionId}: preserving the stored block lineage (stored ${storedBlocks.size}, incoming ${input.blocks.length} block(s)) — the envelope is a pruned render, possibly from another writer (#7156, 2026-11-21)`,
                );
            }
            for (const [blockId, stale] of storedBlocks) {
                if (skipIncomingBlocks || incomingBlockIds.has(blockId)) continue;
                // referencing row first, then release (#4242 delete-on-zero)
                this.db.prepare("DELETE FROM blocks WHERE session_id = ? AND block_id = ?").run(s.sessionId, blockId);
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
            if (!skipIncomingBlocks && input.blocks.length > 0) {
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
            // #7439-2: msgid coordinates — ONE-TIME alignment with the egress
            // flow view, zero joins thereafter. Only sessions the flow has
            // recorded have coordinates (every other session stays NULL). The
            // view (bounded egress_state serving read) is read LAZILY and only
            // when some block actually needs (re-)stamping — steady-state
            // saves never pay it. A corrupt/absent flow degrades to NULL
            // (summary_bytes carries the read); it must never fail the save.
            let egressPos: Map<string, number> | null = null;
            const msgidBoundsForCovered = (payloadJson: string): [string | null, string | null] => {
                if (egressPos === null) {
                    try {
                        // #7574: coordinates come from the op log only while
                        // the plane is ON (see snapPinLiveIds).
                        egressPos = egressPlaneGateOn()
                            ? new Map(this.snapEgressPinLiveIds(s.sessionId).map((id, i) => [id, i] as const))
                            : new Map();
                    } catch {
                        egressPos = new Map();
                    }
                }
                let lo = -1;
                let hi = -1;
                let loId: string | null = null;
                let hiId: string | null = null;
                try {
                    const cov = JSON.parse(payloadJson) as { effectiveMessageIds?: string[]; directMessageIds?: string[] };
                    for (const id of [...(cov.effectiveMessageIds ?? []), ...(cov.directMessageIds ?? [])]) {
                        const p = egressPos.get(id);
                        if (p === undefined) continue;
                        if (lo < 0 || p < lo) { lo = p; loId = id; }
                        if (hi < 0 || p > hi) { hi = p; hiId = id; }
                    }
                } catch { /* malformed payload: keep the no-claim sentinel */ }
                return hi < 0 ? [null, null] : [loId, hiId];
            };
            const blocksUpsert = this.db.prepare(
                `INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier,
                   summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json,
                   summary_bytes, start_msgid, end_msgid)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(session_id, block_id) DO UPDATE SET
                    ord = excluded.ord,
                    start_seq = CASE WHEN excluded.start_seq >= 0 THEN excluded.start_seq ELSE blocks.start_seq END,
                    end_seq = CASE WHEN excluded.end_seq >= 0 THEN excluded.end_seq ELSE blocks.end_seq END,
                    start_ref = excluded.start_ref, end_ref = excluded.end_ref, tier = excluded.tier,
                    summary_hash = excluded.summary_hash, one_hash = excluded.one_hash,
                    supersedes_block_id = excluded.supersedes_block_id, active = excluded.active,
                    created_at = excluded.created_at, covered_hash = excluded.covered_hash,
                    payload_json = excluded.payload_json,
                    summary_bytes = COALESCE(excluded.summary_bytes, blocks.summary_bytes),
                    start_msgid = COALESCE(excluded.start_msgid, blocks.start_msgid),
                    end_msgid = COALESCE(excluded.end_msgid, blocks.end_msgid)`,
            );
            // #7577: collect the transcript-resolved coordinates per block so
            // the egress block recorder (below) can build self-contained
            // snapshots without re-reading the egress flow view.
            // #7439 follow-up (C6): for egress-on sessions the op log IS the
            // transcript — these sessions stop extending the frozen messages
            // table, so bounds bind to the flow's canonical 1-based message
            // numbers (the kernel's ledgerSeq/ref space; stamps come from
            // stampEgressSeqs, the same numbering). Parsed ONCE per save.
            let egressOn = false;
            try {
                egressOn = (JSON.parse(s.metadataJson) as Record<string, unknown>)["egressAuthority"] === true;
            } catch { /* metadataJson parse failure → not egress-on */ }
            let egressNum: Map<string, number> | null = null;
            const flowBoundsForCovered = (payloadJson: string): [number, number] => {
                if (egressNum === null) {
                    try {
                        egressNum = new Map(
                            egressStateView(this.db, s.sessionId)
                                .filter((r) => r.num > 0 && r.msgid !== EGRESS_SYSTEM_MSGID)
                                .map((r) => [r.msgid, r.num] as const),
                        );
                    } catch {
                        egressNum = new Map(); // corrupt/absent flow: no claim, never fail the save
                    }
                }
                let lo = Number.POSITIVE_INFINITY;
                let hi = -1;
                try {
                    const cov = JSON.parse(payloadJson) as { effectiveMessageIds?: string[]; directMessageIds?: string[] };
                    for (const id of [...(cov.effectiveMessageIds ?? []), ...(cov.directMessageIds ?? [])]) {
                        const n = egressNum.get(id);
                        if (n === undefined) continue;
                        if (n < lo) lo = n;
                        if (n > hi) hi = n;
                    }
                } catch { /* malformed payload: keep the no-claim sentinel */ }
                return hi < 0 ? [-1, -1] : [lo, hi];
            };
            const blockCoords = new Map<string, { startSeq: number; endSeq: number; startMsgid: string | null; endMsgid: string | null }>();
            for (const b of input.blocks) {
                if (skipIncomingBlocks) continue;
                let bStartSeq: number;
                let bEndSeq: number;
                if (egressOn) {
                    // Proven (kernel-attested, 1-based flow space) FIRST: a
                    // flow fold D's its covered ids in the SAME turn, so the
                    // flow read cannot see them — the kernel's own attested
                    // bound is the exact one. Then the flow view (pre-arm
                    // imported blocks whose covered messages are still live),
                    // then the honest no-claim sentinel.
                    const ps = b.provenStartSeq;
                    const pe = b.provenEndSeq;
                    const provenOk = typeof ps === "number" && typeof pe === "number"
                        && ps >= 1 && pe >= ps;
                    if (provenOk) {
                        bStartSeq = ps;
                        bEndSeq = pe;
                    } else {
                        [bStartSeq, bEndSeq] = flowBoundsForCovered(b.payloadJson);
                    }
                } else {
                    [bStartSeq, bEndSeq] = boundsForCovered(b.payloadJson);
                }
                // #5744: steady-state saves re-send every block byte-identical.
                // When the effective post-upsert row equals the stored row the
                // whole write (and its CAS bump/release dance, which nets to
                // zero anyway) is skipped — the ingest then costs no statement
                // per unchanged block. #4608 bound preservation makes "the
                // incoming -1 keeps the stored value" part of the equality.
                const ex = storedBlocks.get(b.blockId);
                // #7439-2 self-contained columns: a row already stamped with
                // UNCHANGED coverage carries its stored values forward (no
                // view read, no rewrite); anything else is (re-)computed.
                const selfContainedStale = ex !== undefined && ex.payload_json === b.payloadJson
                    && ex.summary_bytes !== null && ex.start_msgid !== null && ex.end_msgid !== null;
                let bStartMsgid: string | null;
                let bEndMsgid: string | null;
                if (selfContainedStale) {
                    bStartMsgid = ex.start_msgid;
                    bEndMsgid = ex.end_msgid;
                } else {
                    [bStartMsgid, bEndMsgid] = msgidBoundsForCovered(b.payloadJson);
                }
                blockCoords.set(b.blockId, { startSeq: bStartSeq, endSeq: bEndSeq, startMsgid: bStartMsgid, endMsgid: bEndMsgid });
                const incomingSummaryBytes = b.summaryBytes ?? b.summary;
                if (ex &&
                    ex.ord === b.ord &&
                    (bStartSeq < 0 || bStartSeq === ex.start_seq) &&
                    (bEndSeq < 0 || bEndSeq === ex.end_seq) &&
                    (ex.start_ref ?? null) === (b.startRef ?? null) &&
                    (ex.end_ref ?? null) === (b.endRef ?? null) &&
                    ex.tier === b.tier &&
                    ex.summary_hash === b.summaryHash &&
                    (ex.one_hash ?? null) === (b.oneHash ?? null) &&
                    (ex.supersedes_block_id ?? null) === b.supersedesBlockId &&
                    ex.active === (b.active ? 1 : 0) &&
                    ex.created_at === b.createdAt &&
                    ex.covered_hash === b.coveredHash &&
                    ex.payload_json === b.payloadJson &&
                    (ex.summary_bytes === null ? null : Buffer.from(ex.summary_bytes).toString("utf8")) === incomingSummaryBytes &&
                    (ex.start_msgid ?? null) === bStartMsgid &&
                    (ex.end_msgid ?? null) === bEndMsgid) {
                    continue;
                }
                const summaryHash = this.putContent(b.summary, b.summaryHash);
                const oneHash = b.one === null ? null : this.putContent(b.one, b.oneHash ?? undefined);
                // Re-ingest of the same block id replaces the row (dry-run
                // idempotence). Refcount math must distinguish identical
                // re-ingest (bump then undo) from a true replacement (release
                // the old hash, keep the new bump) — otherwise identical
                // re-ingest drives the surviving refcount to zero.
                // #4242: redirect the row BEFORE the undo/release so a
                // released-to-zero old hash is no longer FK-referenced by
                // this blocks row when the content DELETE fires. The
                // identical-re-ingest undo (same hash) is a pure -1
                // against the +1 bump and cannot reach zero while the row
                // itself holds the reference.
                // Re-saves bind the TRANSCRIPT-resolved bounds, never the
                // plan-local b.startSeq/endSeq: those are positions in THIS
                // plan's log, and once a covered id's old generation is
                // tombstoned (an in-place edit lands the new one past
                // max(seq)) they no longer coincide with absolute seqs —
                // writing them would clobber the durable interval with
                // plan-relative numbers.
                blocksUpsert.run(
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
                    incomingSummaryBytes,
                    bStartMsgid,
                    bEndMsgid,
                );
                if (ex) {
                    if (ex.summary_hash === summaryHash) this.releaseContent(summaryHash);
                    else this.releaseContent(ex.summary_hash);
                    if (ex.one_hash !== null) {
                        if (ex.one_hash === oneHash && oneHash !== null) this.releaseContent(oneHash);
                        else this.releaseContent(ex.one_hash);
                    }
                }
            }

            // #7577: EGRESS BLOCK LIFECYCLE LOG — record the block set for
            // egress-on sessions (dual clocks: the block table numbers itself;
            // each row carries the flow watermark pointer). Snapshots are
            // built from the incoming blocks + the transcript-resolved
            // coordinates collected above. Gated on the egress-on latch (set
            // by resolveEgressAuthority) AND a non-envelope save (envelope
            // imports preserve the stored lineage — the block flow is not
            // updated for them). A live block leaving the set emits a terminal
            // reaped U (D6), not a DELETE + orphan_blocks copy.
            if (!skipIncomingBlocks) {
                if (egressOn) {
                    const currentBlocks = new Map<string, EgressBlockSnapshot>();
                    for (const b of input.blocks) {
                        const coords = blockCoords.get(b.blockId);
                        if (!coords) continue;
                        currentBlocks.set(b.blockId, {
                            tier: b.tier,
                            startMsgid: coords.startMsgid,
                            startSeq: coords.startSeq,
                            endMsgid: coords.endMsgid,
                            endSeq: coords.endSeq,
                            supersedesBlockId: b.supersedesBlockId,
                            active: b.active,
                            reaped: false,
                            one: b.one,
                            full: b.summary,
                        });
                    }
                    const prevBlocks = this.egressBlockView(s.sessionId);
                    const blockOps = diffBlockSet(prevBlocks, currentBlocks);
                    if (blockOps.length > 0) {
                        const kstateResidual = serializeKstateResidualFromKstateJson(s.kstateJson);
                        this.egressBlockAppendOps(s.sessionId, blockOps, kstateResidual, Date.now());
                    }
                }
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
            // to lower ords, pruned ids vanish). A blind upsert onto that shape
            // would hit the (session_id, ord) PK (review #2690 blocking 1) or
            // leave ghost rows (blocking 2), which is why this used to
            // DELETE-all + re-insert EVERY row on EVERY save. That made the
            // store leg of an O(new messages) delta save O(full history):
            // ~H native statement executions per turn on a long session
            // (~97% of all per-save statements; the CDP profile behind #5744)
            // while touching zero history rows in the append-only steady
            // state. Now: one indexed read of the stored set, an in-memory
            // diff, and writes ONLY for what changed — vanished raw_ids are
            // deleted (ghosts can never outlive one save, so the loaded map
            // stays exactly the legacy one), untouched survivors are skipped,
            // and added/moved rows go out as multi-row upsert batches (a
            // first ingest of a 3k-message session costs ~20 statements,
            // not 3001; the compaction storm that motivated the old
            // replace-all now costs the same bounded batch budget).
            //
            // Load-bearing precondition (guaranteed by the producers, not
            // checked here): a surviving raw_id's ord never INCREASES between
            // saves — appends take higher ords, and the only renumberers
            // (native-compaction archive #395 and zombie reap #2695, both via
            // pruneRefsToLiveIds) preserve survivor key order and only drop
            // ids. The incremental upsert depends on that: a new ord crossing a
            // still-live neighbour's ord violates the (session_id, ord) PK
            // mid-batch and rolls the whole ingest back. If a future producer
            // can reorder survivors upward, add a delete-all fallback around
            // the write phase below.
            const oldRefs = new Map<string, { ord: number; ref: string; refNum: number | null }>();
            for (const row of this.db
                .prepare("SELECT raw_id, ord, ref, ref_num FROM refs WHERE session_id = ?")
                .all(s.sessionId) as Array<{ raw_id: string; ord: number; ref: string; ref_num: number | null }>) {
                oldRefs.set(row.raw_id, { ord: row.ord, ref: row.ref, refNum: row.ref_num });
            }
            const goneRefIds: string[] = [];
            const touchedRefs: RefRow[] = [];
            for (const r of input.refs) {
                const o = oldRefs.get(r.rawId);
                if (!o || o.ord !== r.ord || o.ref !== r.ref || o.refNum !== r.refNum) {
                    touchedRefs.push(r);
                } else {
                    oldRefs.delete(r.rawId); // matched and unmodified — consume it
                }
            }
            for (const rawId of oldRefs.keys()) goneRefIds.push(rawId);
            if (goneRefIds.length > 0) {
                const perChunk = REF_STMT_MAX_PARAMS - 1; // reserve the leading session_id slot
                for (let i = 0; i < goneRefIds.length; i += perChunk) {
                    const ids = goneRefIds.slice(i, i + perChunk);
                    this.db
                        .prepare(
                            "DELETE FROM refs WHERE session_id = ? AND raw_id IN (" + ids.map(() => "?").join(", ") + ")",
                        )
                        .run(s.sessionId, ...ids);
                }
            }
            if (touchedRefs.length > 0) {
                const colsPerRow = 5;
                const perChunk = Math.floor(REF_STMT_MAX_PARAMS / colsPerRow);
                for (let i = 0; i < touchedRefs.length; i += perChunk) {
                    const rows = touchedRefs.slice(i, i + perChunk);
                    const params: unknown[] = [];
                    for (const r of rows) params.push(s.sessionId, r.ord, r.rawId, r.ref, r.refNum);
                    this.db
                        .prepare(
                            "INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES " +
                                rows.map(() => "(?, ?, ?, ?, ?)").join(", ") +
                                " ON CONFLICT(session_id, raw_id) DO UPDATE SET ord = excluded.ord, ref = excluded.ref, ref_num = excluded.ref_num",
                        )
                        .run(...params);
                }
            }

            // ccr_entries: the content store is a map whose keys can be
            // dropped — the final state must be EXACTLY the incoming set.
            // #5744: steady state no longer pays DELETE-all + re-INSERT-all
            // (which also destroyed and recreated every CAS blob via
            // release-to-zero each save). Unchanged entries (same key → same
            // ord AND same content hash) are skipped entirely — no CAS
            // round-trips. Changed/absent rows are deleted FIRST (frees their
            // PK ords so renumbered swaps cannot collide), their old hashes
            // released while nothing references them anymore (#4242
            // redirect-then-release), then the changed+new entries are
            // put+inserted.
            const incomingCcr = new Map<string, CcrEntryRow>();
            for (const e of input.ccrEntries) incomingCcr.set(e.key, e);
            const storedCcr = this.db
                .prepare("SELECT ord, ccr_key, content_hash, orig_hash FROM ccr_entries WHERE session_id = ?")
                .all(s.sessionId) as Array<{ ord: number; ccr_key: string; content_hash: string; orig_hash: string | null }>;
            const changedCcrKeys: string[] = [];
            const unchangedCcrKeys = new Set<string>();
            const releasedOldCcrHashes: string[] = [];
            for (const row of storedCcr) {
                const inc = incomingCcr.get(row.ccr_key);
                if (!inc) {
                    changedCcrKeys.push(row.ccr_key);
                    releasedOldCcrHashes.push(row.content_hash);
                    if (row.orig_hash !== null) releasedOldCcrHashes.push(row.orig_hash);
                    continue;
                }
                // #6785 step 6: the orig half joins the unchanged test — a
                // pre-step-6 row (orig NULL) or an archived-restore row
                // re-puts its original on the next save and self-heals.
                if (row.ord !== inc.ord || row.content_hash !== inc.contentHash || row.orig_hash !== inc.origHash) {
                    changedCcrKeys.push(row.ccr_key);
                    releasedOldCcrHashes.push(row.content_hash);
                    if (row.orig_hash !== null) releasedOldCcrHashes.push(row.orig_hash);
                } else {
                    unchangedCcrKeys.add(row.ccr_key);
                }
            }
            if (changedCcrKeys.length > 0) {
                for (let i = 0; i < changedCcrKeys.length; i += SEQ_SPAN_QUERY_BATCH) {
                    const keys = changedCcrKeys.slice(i, i + SEQ_SPAN_QUERY_BATCH);
                    this.db
                        .prepare(`DELETE FROM ccr_entries WHERE session_id = ? AND ccr_key IN (${keys.map(() => "?").join(", ")})`)
                        .run(s.sessionId, ...keys);
                }
            }
            for (const hash of releasedOldCcrHashes) this.releaseContent(hash);
            for (const e of input.ccrEntries) {
                if (unchangedCcrKeys.has(e.key)) continue;
                const hash = this.putContent(e.content, e.contentHash);
                const orig = e.origContent === null ? null : this.putContent(e.origContent, e.origHash ?? undefined);
                this.db
                    .prepare("INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash, orig_hash) VALUES (?, ?, ?, ?, ?)")
                    .run(s.sessionId, e.ord, e.key, hash, orig);
            }
            return true;
        });
        if (ok) this.maybeCheckpointWal();
        return ok;
    }

    /** L1 witness probe: a sampled fingerprint of the FIRST live ids (the
     *  head of the id space is what survives rounds — the tail churns). */
    private snapWitnessProbe(sid: string): string {
        const rows = this.db
            .prepare("SELECT msg_id FROM messages WHERE session_id = ? AND retired_at IS NULL ORDER BY seq LIMIT 8")
            .all(sid) as { msg_id: string }[];
        return sha256Hex(rows.length ? rows.map((r) => r.msg_id).join("\u0000") : "empty");
    }


    // #5874 2×2 stage 0 (brief 19544722): the element world match lives at the
    // head of the chain, BEFORE protocol conversion. These accessors are the
    // storage side of that stage — the pure decision (snapshot/plane.ts) and
    // the kernel-input assembly (snapshot/assemble.ts) are lane-side.

    private snapSessRawOf(sid: string): string {
        // Raw host session id (P9: never truncated) → the l1_world key; the
        // conversation binding when the host supplied one, the sid otherwise.
        // (Same resolution as the save path below — stage 0 and the plane
        // commit must address the SAME l1 row.)
        // Identity consolidation (discussions/7591): an egress-on session's
        // conversations row is a self-claim (conversation_id = session_id —
        // the v1 identity map), so the answer is the sid itself and the
        // lookup is dropped entirely for those sessions.
        if (this.isEgressOnSession(sid)) return sid;
        return (
            (this.db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(sid) as { conversation_id: string } | undefined)
                ?.conversation_id ?? sid
        );
    }

    /** Identity consolidation (discussions/7591): whether this sid's
     *  session table is the identity authority — the row latched
     *  metadata.egressAuthority (the lane latches BEFORE the first ingest
     *  upsert, so the flag is present from the very first row) or, as the
     *  fallback for pre-flag edges, the egress op log already carries the
     *  session. Storage faults read NOT egress-on (the legacy path is the
     *  floor — a false negative costs one redundant l1 row, never an
     *  identity decision). */
    private isEgressOnSession(sid: string): boolean {
        try {
            const row = this.db
                .prepare("SELECT metadata_json FROM sessions WHERE session_id = ?")
                .get(sid) as { metadata_json: string | null } | undefined;
            if (row) {
                try {
                    const md = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>;
                    if (md["egressAuthority"] === true) return true;
                } catch { /* corrupt metadata_json — fall through to the flow probe */ }
            }
            return !!this.db.prepare("SELECT 1 FROM egress_flow WHERE session_id = ? LIMIT 1").get(sid);
        } catch {
            return false; // egress tables not probed in yet / fault — legacy path
        }
    }

    /** Identity consolidation (discussions/7591, GC half): the effective
     *  freshness of a session — the row's updated_at, or the last egress
     *  op when the op log is newer. Egress-on rows freeze updated_at after
     *  the arm turn (per-turn saves never land), so the plain column says
     *  "dead" for a session whose op log is the sole content authority and
     *  still being written. Storage fault → the plain column (the legacy
     *  behavior is the floor; the exclusion below is the safety net). */
    private egressAwareFreshness(sid: string, updatedAt: number): number {
        try {
            const r = this.db
                .prepare("SELECT MAX(created_at) AS m FROM egress_flow WHERE session_id = ?")
                .get(sid) as { m: number | null } | undefined;
            return r?.m != null && r.m > updatedAt ? r.m : updatedAt;
        } catch {
            return updatedAt;
        }
    }

    /** Stage 0 for one turn: ensure the l1 row exists (idempotent session-
     *  level v1 record), run the element world match on the stored envelope,
     *  and persist the new canon (every verdict except `diverge` — that one
     *  has zero side effects by construction). A session-level identity
     *  conflict ("red") throws — the lane maps it to the R3 hard 400 BEFORE
     *  any kernel side effect.
     */
    snapStage0(sid: string, incoming: string[], opts?: { resync?: boolean, seqs?: number[] | null }): Stage0Result {
        // Identity consolidation (discussions/7591): an egress-on session is
        // STATELESS here — no l1 row is ever read or written. The op log is
        // the authority (R1): the echo/anchor verdict is replay math against
        // the flow's live msgids, and the "cursor" moves only in the lane's
        // memory (the anchorAdvanced markDirty is a no-op for these
        // sessions — their saves never land). No ledger conflict can exist
        // (v1 identity map), so FoundationRejectError is unreachable here by
        // construction — the branch simply cannot throw it.
        if (this.isEgressOnSession(sid)) {
            const now = Date.now();
            const live = this.snapPinLiveIds(sid);
            const known = new Set(live);
            const seqs = opts?.seqs ?? null;
            // Two cursors (egress-state.nextSeqs semantics): op_seq orders
            // EVERY row (B/I/D/U) and is the seqs-carrier guard; log_seq
            // numbers I rows only and is never reused across folds (D rows
            // keep their log_seq gone). The message frontier is the highest
            // number EVER ISSUED — MAX(log_seq) over the rows, falling back
            // to the newest base's highWater once a compaction physically
            // removed the I rows it subsumes (#7574 leaves only the B row —
            // the exact rule nextSeqs applies, egressMessageHighWater).
            // live.length understates it after any fold, so derive positions
            // from it, not the live view (discussions/7591 review L1:
            // bookkeeping-only, but the persisted witness must stay truthful).
            // NOTE (review L2): the arm turn itself — runStage0 runs in the
            // lane BEFORE the egress flag is latched to the sessions row —
            // still takes the legacy path and may write one dead l1 row that
            // is never read again; we deliberately do NOT pre-latch (that
            // would move arm timing for zero functional gain).
            const fr = (this.db
                .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM egress_flow WHERE session_id = ?")
                .get(sid) as { o: number });
            const seqFrontier = fr.o;   // op-ordering cursor (seqs guard)
            const msgFrontier = egressMessageHighWater(this.db, sid);   // canonical message frontier (positions)
            const allKnown = incoming.length > 0 && incoming.every((id) => known.has(id));
            const seqsAtFrontier = seqs === null || seqs.every((s) => s <= seqFrontier);
            const newIds = incoming.filter((id) => !known.has(id));
            if (allKnown && seqsAtFrontier && !opts?.resync) {
                return {
                    decision: {
                        mode: "echo",
                        replay: true,
                        window: { tailIds: [], headIds: [], count: incoming.length, maxPos: msgFrontier },
                        newIdPos: [],
                        goneIds: [],
                        issuedAt: now,
                        witness: `echo: egress-on, all ${incoming.length} ids in the op log (msg frontier ${msgFrontier})`,
                    },
                    explainedGone: new Set<string>(),
                };
            }
            // anchor: fresh / grown / rewritten array — the flow ingest in
            // this same request is the persistence; the decision is pure
            // bookkeeping (D1: never reject).
            const newIdPos = newIds.map((id, i) => ({ id, pos: msgFrontier + i + 1 }));
            return {
                decision: {
                    mode: "anchor",
                    window: { tailIds: incoming.slice(-64), headIds: incoming.slice(0, 8), count: incoming.length, maxPos: msgFrontier + newIds.length },
                    newIdPos,
                    goneIds: [],
                    issuedAt: now,
                    witness: `anchor: egress-on, ${newIds.length}/${incoming.length} ids new (msg frontier ${msgFrontier})`,
                },
                explainedGone: new Set<string>(),
            };
        }
        const sessRaw = this.snapSessRawOf(sid);
        const now = Date.now();
        const l1 = snapL1Record(this.db, sessRaw, sid, this.snapWitnessProbe(sid), now);
        if (l1 === "red") {
            // PR#6785 review: an R3 LATCH PLACEHOLDER row is not a real
            // ledger — snapR3LatchWrite created it BEFORE the first stage-0
            // run with ledger_id = sessRaw (the real sid unknown; legitimate
            // rows never carry witness_probe "" because snapWitnessProbe
            // always hashes). After the operator unlatches
            // (POST /__bili/snapshot/r3-unlatch), the placeholder would keep
            // mapping sess_raw → a DIFFERENT ledger forever and 400 every
            // turn for a conversation-bound session (snapSessRawOf(sid) ≠
            // sid). Rebind it to the real sid instead (the mapping is the
            // identity anchor; a placeholder is no anchor yet).
            const row = this.db
                .prepare("SELECT ledger_id, witness_probe FROM l1_world WHERE sess_raw = ?")
                .get(sessRaw) as { ledger_id: string; witness_probe: string } | undefined;
            if (row && row.ledger_id === sessRaw && row.witness_probe === "") {
                this.db
                    .prepare("UPDATE l1_world SET ledger_id = ?, witness_probe = ? WHERE sess_raw = ?")
                    .run(sid, this.snapWitnessProbe(sid), sessRaw);
            } else {
                // Session-level identity conflict (R3): the raw host id maps
                // to a DIFFERENT ledger. Hard-reject BEFORE any kernel side
                // effect — snapL1Record wrote nothing on this path.
                throw new FoundationRejectError(`l1 ledger conflict: sess_raw=${sessRaw} maps to another ledger (R3)`);
            }
        }
        // The gone-set: stored messages whose ids legally vanish from the
        // envelope head because a LIVE fold block covers them (the covered
        // messages stay in the ledger — compression deactivates the coverage,
        // not the rows). Pure ledger math, no per-row state table.
        const goneRows = this.db
            .prepare("SELECT m.msg_id FROM messages m JOIN blocks b ON b.session_id = m.session_id AND m.seq >= b.start_seq AND m.seq <= b.end_seq WHERE m.session_id = ? AND m.retired_at IS NULL AND b.active = 1")
            .all(sid) as { msg_id: string }[];
        const explainedGone = new Set(goneRows.map((r) => r.msg_id));
        // The ledger frontier: the max live stamped seq (0 for an empty
        // ledger) — the M2 contiguity evidence anchors on it.
        const maxSeq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ? AND retired_at IS NULL").get(sid) as { m: number }).m;
        return stage0Decide({ db: this.db, sessRaw, ledgerId: sid, incoming, seqs: opts?.seqs ?? null, resync: opts?.resync, maxSeq, explainedGone, now, convBound: this.snapConvBound(sid) });
    }

    /** The stage-0 resync (brief red gate R4 / the resync ruling): clear the
     *  l1 element envelope so the NEXT turn re-issues it from the client's
     *  current array (one-round convergence). This turn runs the legacy full
     *  path and the normal in-request flush re-baselines the ledger. The l1
     *  identity row itself (the v1 mapping + witness + R3 latch) survives:
     *  a resync re-baselines the ENVELOPE, never the session identity.
     */
    snapStage0Reset(sid: string): void {
        // Identity consolidation (discussions/7591): egress-on sessions have
        // NO l1 cursor — there is nothing to reset; the op log is never
        // re-baselined by this path (the lane takes the legacy full path
        // this turn and the next pin re-anchors from the client's array).
        if (this.isEgressOnSession(sid)) return;
        const sessRaw = this.snapSessRawOf(sid);
        this.db
            .prepare("UPDATE l1_world SET tail_json = NULL, head_json = NULL, count = NULL, max_pos = NULL WHERE sess_raw = ?")
            .run(sessRaw);
    }

    /** D2 (#7064): whether this sid is CONVERSATION-BOUND — the host already
     *  declared a conversation identity (a conversations row for this sid),
     *  so the per-turn id verdict is skipped entirely and the R3 fault path
     *  (400 / latch) never fires for id mismatch: the session IS the
     *  identity. */
    snapConvBound(sid: string): boolean {
        // The claim INSERT at ingest time writes a `proxy`-namespace row for
        // EVERY session (conversation_id = session_id — a self-claim, not a
        // host identity). D2 applies only to HOST-namespace claims (the
        // agent registered a real conversation): namespace <> 'proxy'.
        const row = this.db
            .prepare("SELECT 1 FROM conversations WHERE session_id = ? AND namespace <> 'proxy' LIMIT 1")
            .get(sid);
        return row !== undefined;
    }

    /** #7064 §8: the ledger's LIVE stamped ids in seq order (0-based index ⇔
     *  ledger position). The incremental pin re-stamps a steady-state turn's
     *  prefix cores from this list — ingest is INSERT OR IGNORE on (session_id,
     *  seq), so a position's msg_id is written once and the kernel's ref space
     *  only stays stable when every presented id matches the ledger. Empty
     *  array = empty ledger (bootstrap: the full-list path must run). */
    snapMsgIdLiveIds(sid: string): string[] {
        const rows = this.db
            .prepare("SELECT msg_id FROM messages WHERE session_id = ? AND retired_at IS NULL ORDER BY seq")
            .all(sid) as { msg_id: string }[];
        return rows.map((r) => r.msg_id);
    }

    /** #7474 P2 (ruling 7439): the pin ledger of an egress-on session lives
     *  in the op log — egress_state is the materialized live view (7773), and
     *  these sessions stop growing the messages projection entirely, so the
     *  messages-row read would freeze at the arm turn. Order = pos = view
     *  order (the pin's 0-based index ⇔ position contract); the constant
     *  system row is not part of the msgid ledger. */
    snapEgressPinLiveIds(sid: string): string[] {
        const view = egressStateRead(this.db, sid);
        return view.filter((r) => r.msgid !== EGRESS_SYSTEM_MSGID).map((r) => r.msgid);
    }

    /** #7474 P2 (ruling 7439): ONE pin-ledger entry for both storage
     *  authorities — the egress op log when the session has one, the messages
     *  rows otherwise (identical output for every non-egress session). A
     *  corrupt op log degrades to the messages ledger: the tail-overlap check
     *  then mismatches and takes the full signal — never a reject.
     *
     *  #7574: the op log is the ledger only while the plane is ON for this
     *  install. Once it is switched off nothing maintains the log, while the
     *  first full ingest after the switch rebuilds the messages projection —
     *  so an off install that kept reading the log would answer every pin
     *  from a view frozen at the switch. Off = the messages ledger, exactly
     *  as on an install that never ran the plane. */
    snapPinLiveIds(sid: string): string[] {
        if (egressPlaneGateOn()) {
            try {
                const view = egressStateRead(this.db, sid);
                if (view.length > 0) {
                    return view.filter((r) => r.msgid !== EGRESS_SYSTEM_MSGID).map((r) => r.msgid);
                }
            } catch {
                // EgressStateCorruptError — degrade to the messages ledger below.
            }
        }
        return this.snapMsgIdLiveIds(sid);
    }


    /** #6181 M3: whether this sid's R3 breaker latch PERSISTED from a
     *  previous process (a restart must not re-arm a misbehaving host and
     *  re-400 the same broken envelope). */
    snapR3Latched(sid: string): boolean {
        try {
            // Identity consolidation (discussions/7591): the sessions row is
            // the carrier of record; the l1_world column is a legacy
            // READ-FALLBACK only (pre-migration latches stay readable until
            // that table is dropped — nothing NEW ever lands there).
            if (snapR3LatchedReadOnSession(this.db, sid)) return true;
            return snapR3LatchedRead(this.db, this.snapSessRawOf(sid));
        } catch {
            return false; // schema/column edge: treat as unlatched, the in-memory breaker still fires
        }
    }

    /** #6181 M3: persist the R3 breaker latch (best-effort — a failed
     *  write degrades to the in-memory latch, which still fires this
     *  process). Identity consolidation (discussions/7591, owner ruling
     *  2026-11-24): the carrier switch is GATED on egressPlane — when it is
     *  on, new latches land on the SESSIONS row (of record); when it is off,
     *  the legacy l1_world carrier (placeholder-row ritual) is used, so
     *  behavior is byte-identical to pre-migration until the switch flips.
     *  Read / clear / list stay dual-carrier (a superset, always correct). */
    snapR3Latch(sid: string): void {
        try {
            if (egressPlaneGateOn()) {
                snapR3LatchWriteOnSession(this.db, sid, Date.now());
            } else {
                // egressPlane off → legacy l1 carrier, byte-identical to
                // pre-migration: the l1 row is keyed by the SESSION RAW id
                // (conversation id for conv-bound sessions), matching the
                // `snapR3Latched` read path.
                snapR3LatchWrite(this.db, this.snapSessRawOf(sid), Date.now());
            }
        } catch { /* best-effort — see above */ }
    }

    /** #6785 review: operator escape hatch — clear the persisted R3 latch
     *  for one RAW host session id. Returns the ledger id the l1 row binds
     *  (the caller uses it to clear the in-memory breaker too) or null when
     *  no row exists / a fault. Keyed by sess_raw (the roster key), not by
     *  sid — the admin surface has the raw id, and the latch row predates
     *  the sid→raw resolution in its placeholder phase. Identity
     *  consolidation (discussions/7591): clears BOTH carriers — the
     *  sessions row (of record) and the legacy l1 row. */
    snapR3LatchClear(sessRaw: string): string | null {
        try {
            // discussions/7591 review M1: clear BOTH carriers unconditionally.
            // A session latched pre-migration (l1 row) and re-latched
            // post-migration (sessions row) holds a timestamp under the same
            // key in both tables; bailing out after the first hit would leave
            // the legacy read-fallback (snapR3Latched below) still latched and
            // pin the session on the legacy path until the l1 table is
            // dropped. Return non-null when EITHER carrier was latched — the
            // admin caller uses that to clear the in-memory breaker too.
            const fromSession = snapR3LatchClearOnSession(this.db, sessRaw);
            const fromL1 = snapR3LatchClear(this.db, sessRaw);
            return fromSession ?? fromL1;
        } catch {
            return null;
        }
    }

    /** #6785 review: the persisted-latch roster (an operator must be able
     *  to SEE which raw ids are stuck before clearing them). Empty on a
     *  fault — the roster is diagnostic, never load-bearing. Identity
     *  consolidation (discussions/7591): the union of both carriers
     *  (sessions row of record + legacy l1 fallback), deduped per raw id
     *  (the newer latch wins). */
    snapR3LatchedList(): Array<{ sessRaw: string; ledgerId: string; latchedAt: number }> {
        try {
            const byRaw = new Map<string, { sessRaw: string; ledgerId: string; latchedAt: number }>();
            for (const r of snapR3LatchedListOnSessions(this.db)) byRaw.set(r.sessRaw, r);
            for (const r of snapR3LatchedList(this.db)) {
                const have = byRaw.get(r.sessRaw);
                if (!have || r.latchedAt > have.latchedAt) byRaw.set(r.sessRaw, r);
            }
            return [...byRaw.values()].sort((a, b) => b.latchedAt - a.latchedAt);
        } catch {
            return [];
        }
    }

    /** #6785 review: the ledger sid a raw host session id conversational-
     *  binds to (null when the host supplied no conversation binding — the
     *  common case, where sid === raw). The unlatch route clears the
     *  in-memory breaker for BOTH ids: the latch row's ledger_id can still
     *  be the sessRaw placeholder (first fault before any stage-0 run),
     *  while the breaker itself is keyed by the real sid. */
    snapSidOfRaw(sessRaw: string): string | null {
        if (sessRaw.length === 0) return null;
        try {
            return (this.db.prepare("SELECT session_id FROM conversations WHERE conversation_id = ? LIMIT 1").get(sessRaw) as { session_id: string } | undefined)
                ?.session_id ?? null;
        } catch {
            return null;
        }
    }


    /** #6785 perf (proposal discussions/7398): EGRESS STATE LOG — op-log
     *  outbound view. The methods below are the store surface over
     *  src/storage/egress-state.ts (dual table: materialized live state +
     *  total append-only flow, 7773). Corruption throws EgressStateCorruptError
     *  — callers degrade the whole session per the ladder (never a partial
     *  view). */
    /** Record one turn (guarded, validated, appended, applied to the live
     *  view — one transaction; src/storage/egress-state.ts egressAppendTurn). */
    egressAppendTurn(sessionId: string, ops: EgressOp[], baseSeq: number, nowMs: number): EgressViewRow[] {
        return egressAppendTurn(this.db, sessionId, ops, nowMs, { baseSeq });
    }

    /** Minimal identity row for an egress-on session (KDD #25,
     *  discussions/7735). Landed from the egress seam on EVERY armed turn —
     *  idempotent upsert = self-healing, and updated_at advancing each turn
     *  keeps the session visible to the list/GC/stale sweeps that all scan
     *  FROM sessions. Payload columns (stats/kstate/tail/ccr/last_ingested_
     *  seq/orphans/next_*) are deliberately never touched: an egress-on row
     *  carries identity + metadata only, matching the #7591 freeze.
     *  Conflict semantics mirror the ingest upsert below: first PARENT wins
     *  (a point-fork child's parent + fork_point_seq, written by the fork
     *  path, survive every later identity pass); descriptive columns and
     *  updated_at are latest-wins.
     *  Same transaction: the arm turn's stage-0 ran BEFORE the egress latch
     *  and left one dead l1_world row ("one dead l1 row that is never read
     *  again" — the pre-#7735 NOTE); it is removed here with guards that
     *  never touch an armed row, an R3 breaker latch row (witness '' +
     *  r3_latched_at set), or any bound row. An eg-mode fresh DB has no
     *  l1_world table at all — the cleanup is best-effort there. */
    ensureEgressIdentity(input: EgressIdentityInput): void {
        // Snapshot the sess_raw resolution BEFORE the INSERT below: the
        // arm turn wrote its l1 row while this session was still legacy
        // (binding = host conversation id), and once the identity row lands
        // isEgressOnSession flips true and snapSessRawOf would return the
        // sid — the wrong key for the dead row. A fresh eg-mode DB has no
        // conversations table at all — fall back to the sid alone (there
        // can be no l1 row there either).
        let raws = new Set<string>([input.sessionId]);
        try {
            raws.add(this.snapSessRawOf(input.sessionId));
        } catch { /* no conversations table in a fresh eg db */ }
        this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO sessions (
                    session_id, parent_session_id, protocol, label, title, host_title,
                    namespace, origin, status, created_at, updated_at, meta_json, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
                    protocol = excluded.protocol,
                    label = excluded.label,
                    title = excluded.title,
                    host_title = excluded.host_title,
                    namespace = excluded.namespace,
                    origin = excluded.origin,
                    status = excluded.status,
                    updated_at = excluded.updated_at,
                    meta_json = excluded.meta_json,
                    metadata_json = excluded.metadata_json
            `).run(
                input.sessionId, input.parentSessionId, input.protocol, input.label,
                input.title, input.hostTitle, input.namespace, input.origin,
                input.createdAt, input.updatedAt, input.metaJson, input.metadataJson,
            );
            try {
                this.db.prepare(`
                    DELETE FROM l1_world
                    WHERE ledger_id = ? AND sess_raw IN (${[...raws].map(() => "?").join(", ")})
                      AND armed_at IS NULL AND r3_latched_at IS NULL AND witness_probe <> ''
                `).run(input.sessionId, ...raws);
            } catch {
                // eg-mode fresh DB: l1_world was never created — nothing to clean.
            }
        });
    }

    /** The serving read: state replay + comparison with the log; a damaged
     *  state COPY is rebuilt from the flow. Only a flow that does not replay
     *  throws EgressStateCorruptError. */
    egressStateView(sessionId: string): EgressViewRow[] {
        return egressStateRead(this.db, sessionId);
    }

    /** Rollback reconstruction at any op_seq (full history from 0 — there
     *  is no base row). */
    egressStateViewAt(sessionId: string, logSeq: number): EgressViewRow[] {
        return egressStateAt(this.db, sessionId, logSeq);
    }

    /** 7773 walk-back: one O(n) pass over the flow's FULL history returning
     *  the newest healthy NON-EMPTY prefix (seq + view), or null when no
     *  non-empty healthy prefix exists. */
    egressFlowWalkBack(sessionId: string): { seq: number; view: EgressViewRow[] } | null {
        return egressFlowWalkBack(this.db, sessionId);
    }

    /** Renumber (2026-11-25, egress-plane.md §10): the client's raw system
     *  (A) — the live system row's sys_in column (7773: the state row holds
     *  it directly; it was payload-embedded in the old op-copy shape).
     *  The incremental lane's sticky input stops living in the inc:system ext
     *  column for egress-on sessions (reads consult this first; the ext
     *  write stays for legacy). */
    egressSystemInput(sessionId: string): string | null {
        const row = this.db
            .prepare(
                "SELECT sys_in FROM egress_state WHERE session_id = ? AND msgid = 'egress-system' LIMIT 1",
            )
            .get(sessionId) as { sys_in?: string | null } | undefined;
        return typeof row?.sys_in === "string" && row.sys_in !== "" ? row.sys_in : null;
    }

    egressStateMaxSeq(sessionId: string): number {
        // op_seq is the row-ordering high-water (log_seq is the per-message
        // number and only I rows carry it — it is not the row cursor).
        const row = this.db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sessionId) as { mx: number };
        return Number(row.mx) || 0;
    }

    /** 7773: truncate the flow past op_seq — and REBUILD the materialized
     *  live state from the surviving flow, in ONE transaction (a crash
     *  between a flow truncate and a state rebuild would leave the twin
     *  check reporting corruption on every read). The returned count is the
     *  number of FLOW rows removed (the warn-log figure). The prefix is
     *  known-replayable by the caller (egressFlowWalkBack proved it). */
    egressStateTruncateAfter(sessionId: string, opSeq: number): number {
        return this.db.transaction(() => {
            const b = this.db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sessionId, opSeq);
            egressMaterializeState(this.db, sessionId, egressStateAt(this.db, sessionId, opSeq), Date.now());
            return Number(b.changes);
        });
    }

    /** Ruling 7439 (fork = whole-table copy): copy the parent's entire egress
     *  record (flow AND materialized state, every row) to the child session_id
     *  inside the CALLER's transaction — the child inherits the parent's full
     *  canonical number space and retired marks, so its next number continues
     *  where the parent stopped and nothing is ever re-issued across the
     *  fork. No-op (false) when the parent has no egress rows. */
    egressForkSession(parentId: string, childId: string): boolean {
        return egressFork(this.db, parentId, childId) > 0;
    }

    /** #7398: delete the session's egress op-log rows (state AND flow AND
     *  the usage event stream). Egress rows are self-contained (ruling
     *  7439-1: the bytes live in the rows) — there is no content-CAS to
     *  release. Runs inside the caller's sweep transaction. */
    deleteEgressOps(sessionId: string): void {
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM egress_flow WHERE session_id = ?").run(sessionId);
            // #7577: the block lifecycle log rides the same session — delete it too.
            this.deleteEgressBlockOps(sessionId);
            // egress_usage event stream + its materialized stats row.
            egressUsageDelete(this.db, sessionId);
            this.db.prepare("DELETE FROM session_ext WHERE session_id = ? AND key = ?").run(sessionId, USAGE_STAT_KEY);
        });
    }

    /** Egress usage event stream (8th egress table, owner ruling 2026-11-27):
     *  append-only S/F/M events — the restart-survival source of the cache
     *  ledger on 7+1-table instances. */
    egressUsageAppend(sessionId: string, events: readonly EgressUsageEvent[]): number {
        return egressUsageAppend(this.db, sessionId, events);
    }

    egressUsageRows(sessionId: string): EgressUsageRow[] {
        return egressUsageRows(this.db, sessionId);
    }

    /** The materialized stats row (session_ext "usage:stats", <=1024 chars —
     *  the fast read; the stream is truth). */
    readUsageStats(sessionId: string): string | null {
        return readUsageStats(this.db, sessionId);
    }

    writeUsageStats(sessionId: string, json: string): void {
        writeUsageStats(this.db, sessionId, json);
    }

    writeUsageStatsBestEffort(sessionId: string, json: string, log: (msg: string) => void): boolean {
        return writeUsageStatsBestEffort(this.db, sessionId, json, log);
    }


    /** #7577: EGRESS BLOCK LIFECYCLE LOG — the store surface over
     *  src/storage/egress-block.ts (dual table: materialized live block view +
     *  append-only flow, 7773). Corruption throws EgressBlockCorruptError —
     *  callers degrade per the degrade ladder. */
    egressBlockAppendOps(sessionId: string, ops: EgressBlockOp[], kstateJson: string | null, nowMs: number): number[] {
        return egressBlockAppend(this.db, sessionId, ops, kstateJson, nowMs);
    }

    egressBlockView(sessionId: string): Map<string, EgressBlockSnapshot> {
        return egressBlockView(this.db, sessionId);
    }

    /** Fork/rollback reconstruction of the block set at the block's OWN
     *  op_seq x (dual clocks — this is egress_block_flow's sequence, not the
     *  flow watermark), plus the kstate sidecar from the last row at/before
     *  x. */
    egressBlockReplay(sessionId: string, x: number): { blocks: Map<string, EgressBlockSnapshot>; kstate: string | null } {
        return egressBlockReplay(this.db, sessionId, x);
    }

    /** The block table's own op_seq high-water (dual clocks — diagnostic
     *  only; the point-fork watermark is the FLOW clock, egressStateMaxSeq,
     *  because every block row's flow_op_seq pointer <= the flow MAX). */
    egressBlockMaxSeq(sessionId: string): number {
        const block = this.db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_block_flow WHERE session_id = ?`).get(sessionId) as { mx: number };
        return Number(block.mx) || 0;
    }

    /** #7577 D5: point fork — copy the parent's egress + block op logs up to
     *  (and including) FLOW watermark wm to the child (one transaction; the
     *  child inherits the parent's number space). Block rows are selected by
     *  their flow_op_seq pointer. wm = egressStateMaxSeq is the whole-copy
     *  special case. */
    egressPointForkSession(parentId: string, childId: string, wm: number): boolean {
        return egressPointFork(this.db, parentId, childId, wm) > 0;
    }

    /** #7577 (b): tsStamps for an egress-on session is NOT persisted (the
     *  write path trims it — see ingest.ts KSTATE_TRIM_FIELDS); it is DERIVED
     *  from the live egress view, where each row's msgid IS the kernel raw
     *  message id and ts is the first-observed wall clock. Returns null when
     *  the session has no egress rows (egress-off) or a corrupt log. */
    egressTsStamps(sessionId: string): Record<string, number> | null {
        try {
            const view = egressStateView(this.db, sessionId);
            const out: Record<string, number> = {};
            for (const row of view) {
                if (row.ts !== undefined) out[row.msgid] = row.ts;
            }
            return Object.keys(out).length > 0 ? out : null;
        } catch {
            return null;
        }
    }

    /** Delete the session's block op-log rows (state AND flow). Runs inside
     *  the caller's sweep transaction. */
    deleteEgressBlockOps(sessionId: string): void {
        this.db.prepare("DELETE FROM egress_block_state WHERE session_id = ?").run(sessionId);
        this.db.prepare("DELETE FROM egress_block_flow WHERE session_id = ?").run(sessionId);
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
            const t0 = performance.now();
            const row = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
            const ms = Math.round(performance.now() - t0);
            this.lastWalTick = { busy: row.busy, log: row.log, checkpointed: row.checkpointed, ms };
            loggerLog(
                "debug",
                `[storage] periodic WAL checkpoint at ingest ${this.ingestCount}: busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed} took=${ms}ms`,
            );
        } catch (err) {
            loggerLog("debug", `[storage] periodic WAL checkpoint failed at ingest ${this.ingestCount}: ${String(err)}`);
        }
    }

    /** #5744: read-only WAL forensics for the slow-ingest warn line — current
     * WAL size plus the last periodic checkpoint's (busy, log, checkpointed)
     * triple and duration. A slow save whose window contains a multi-second
     * tick is a checkpoint burst, not per-row statement cost; the two must be
     * told apart from the log alone. Returns null when there is nothing to
     * report (no WAL file). Never throws into the caller. */
    walDiagnosticsSuffix(): string | null {
        let walBytes: number;
        try {
            walBytes = statSync(`${this.dbPath}-wal`).size;
        } catch {
            return null;
        }
        const tick = this.lastWalTick
            ? ` lastCheckpoint=(busy=${this.lastWalTick.busy} log=${this.lastWalTick.log} checkpointed=${this.lastWalTick.checkpointed} took=${this.lastWalTick.ms}ms)`
            : "";
        return `, ${formatDbSize(walBytes)} WAL${tick}`;
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
            .prepare("SELECT seq, msg_id, identity, content_hash, retired_at, ref FROM messages WHERE session_id = ?")
            .all(s.sessionId) as { seq: number; msg_id: string; identity: string; content_hash: string; retired_at: number | null; ref: string | null }[];
        const seqByIdentity = new Map<string, number>();
        const hashBySeq = new Map<number, string>();
        const storedRefBySeq = new Map<number, string | null>();
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
            storedRefBySeq.set(row.seq, row.ref);
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
        // #6947: rows written by the turn-final handoff write-back carry
        // ref=NULL — their ref is minted only when a LATER request re-sends
        // the message. This join hit is the first moment the minted ref can
        // reach the stored row; backfill NULL only (a non-null stored ref is
        // the frozen index-time projection and must never be rewritten).
        const refBackfills: { seq: number; ref: string; refNum: number }[] = [];
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
                // #6947: minted-ref backfill for turn-final write-back rows.
                // Never "BLOCKED" (a byRaw-only token, #ingest note) and never
                // over an already-stored ref.
                if (m.ref !== null && m.ref !== "BLOCKED" && m.refNum !== null && storedRefBySeq.get(abs) === null) {
                    refBackfills.push({ seq: abs, ref: m.ref, refNum: m.refNum });
                }
            }
            planToAbs.set(m.seq, abs);
            return { ...m, seq: abs };
        });
        for (const b of refBackfills) {
            // The ref IS NULL re-check inside the statement keeps the update
            // idempotent if two plan rows join the same stored row.
            this.db.prepare("UPDATE messages SET ref = ?, ref_num = ? WHERE session_id = ? AND seq = ? AND ref IS NULL").run(b.ref, b.refNum, s.sessionId, b.seq);
        }
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
        if (retiredSeqs.length > 0) {
            const presentedSeqs = new Set(messages.map((m) => m.seq));
            for (const seq of retiredSeqs) {
                if (presentedSeqs.has(seq)) this.db.prepare("UPDATE messages SET retired_at = NULL WHERE session_id = ? AND seq = ?").run(s.sessionId, seq);
            }
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

    /** #3285 (2026-11-21 per-session rework): watermark trust does not cross
     *  process boundaries — a watermark vouches "the writer that set it
     *  verified this prefix" but carries no writer identity, so under the
     *  multi-process shared-directory contract (#2671) a restart-handoff
     *  overlap leaves a foreign process's rows AND its watermark behind,
     *  and inheriting that trust lets the new process take unverified empty
     *  deltas against rows it never wrote.
     *  The 2026-10-31 implementation dropped EVERY session's watermark in one
     *  global write at open — it touched every other session and made open
     *  itself a write (the #7156 first-write hazard). The trust boundary is
     *  actually per-session: a process only needs to distrust watermarks it
     *  did not set, for the session it is about to save. So the invalidation
     *  moved here — first touch of a session in THIS process drops any
     *  foreign-set watermark for that ONE session (→ the next save takes the
     *  exact full path, re-establishing trust from this process's own view);
     *  later touches trust this process's own watermarks. Per (process,
     *  session) the trust decision is byte-identical to the global reset;
     *  untouched sessions keep their watermarks, and open performs no write. */
    private readonly ingestTouchedThisProcess = new Set<string>();
    primeIngestTrust(sessionId: string): void {
        if (this.ingestTouchedThisProcess.has(sessionId)) return;
        this.ingestTouchedThisProcess.add(sessionId);
        this.db.prepare("UPDATE sessions SET last_ingested_seq = NULL WHERE session_id = ?").run(sessionId);
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

    /** #6029: message bodies addressed by their STABLE msg_id — the restamp-proof
     *  twin of messageContentByRefNums. restampRefsToLedger renumbers the LIVE
     *  refs at cold load (the #5196 parked band lands on fresh high numbers), but
     *  messages.ref_num is frozen at index time, so a ref-number join silently
     *  misses every renumbered row. msg_id never moves under a restamp; unknown
     *  ids come back absent and retired rows stay excluded, exactly like the
     *  ref-number sibling. */
    messageContentByMsgIds(sessionId: string, msgIds: readonly string[]): MessageIdContentRow[] {
        if (msgIds.length === 0) return [];
        const ids = [...new Set(msgIds)];
        const CHUNK = 500;
        const out: MessageIdContentRow[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const ph = chunk.map(() => "?").join(",");
            for (const r of this.db
                .prepare(`SELECT msg_id, role, kind, content_hash FROM messages WHERE session_id = ? AND retired_at IS NULL AND msg_id IN (${ph})`)
                .all(sessionId, ...chunk) as { msg_id: string; role: string; kind: string; content_hash: string }[]) {
                const base = this.getContent(r.content_hash);
                if (base !== null) out.push({ msgId: r.msg_id, role: r.role, kind: r.kind, content: this.hydrateMedia(base) });
            }
        }
        return out;
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
            // #6785 step 7: the reaped-block journal lives in orphan_blocks
            // now (same merge semantics the column had — incoming entries win
            // on key collision, trimmed entries survive).
            this.applyOrphanBlocks(sessionId, orphanContents.size > 0 ? JSON.stringify(Object.fromEntries(orphanContents)) : null);
        });
    }

    deleteSession(sessionId: string): void {
        this.db.transaction(() => {
            const refs: string[] = [];
            // KDD #25: a 7-table instance (egressPlane on, legacy group not
            // created) has none of the CAS projection tables — skip the
            // legacy sweep (there is no legacy data to sweep) but ALWAYS
            // delete the egress op log + the identity row: an unguarded
            // leading query would roll the whole transaction back on the
            // missing table and silently keep every row of the session.
            if (this.legacyTablesPresent) {
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
                    .prepare("SELECT content_hash, orig_hash FROM ccr_entries WHERE session_id = ?")
                    .all(sessionId) as { content_hash: string; orig_hash: string | null }[]) {
                    refs.push(e.content_hash);
                    if (e.orig_hash !== null) refs.push(e.orig_hash);
                }
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
                this.db.prepare("DELETE FROM orphan_blocks WHERE session_id = ?").run(sessionId);
                this.db.prepare("DELETE FROM state_fields WHERE session_id = ?").run(sessionId);
                this.db.prepare("DELETE FROM dead_refs WHERE session_id = ?").run(sessionId);
                this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(sessionId);
                this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(sessionId);
                this.db.prepare("DELETE FROM conversations WHERE session_id = ?").run(sessionId);
                // #5874: the L1 identity entry rides the session (keyed by
                // ledger_id); no orphan may survive (T6).
                this.db.prepare("DELETE FROM l1_world WHERE ledger_id = ?").run(sessionId);
            }
            this.deleteEgressOps(sessionId);
            this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
            for (const hash of refs) this.releaseContent(hash);
            // #4796 follow-up: scoped collection over this session's own
            // released hashes (see collectZeroRefIn) — never the whole table.
            this.collectZeroRefIn(refs);
        });
    }

    /** #3928: per-session storage footprint for `bili sessions ls`. Counts
     *  never cascade into each other: inline bytes cover only JSON columns,
     *  CAS bytes only content-addressed blobs; the CAS split compares the
     *  global refcount with this deletion's per-hash release count. */
    sessionStorageStats(sessionId: string): SessionStorageStats {
        const counts = this.db
            .prepare(
                "SELECT " +
                    "(SELECT COUNT(*) FROM sessions WHERE session_id = ?) AS sessions, " +
                    "(SELECT COUNT(*) FROM conversations WHERE session_id = ?) AS conversations, " +
                    "(SELECT COUNT(*) FROM messages WHERE session_id = ?) AS messages, " +
                    "(SELECT COUNT(*) FROM message_media WHERE session_id = ?) AS media, " +
                    "(SELECT COUNT(*) FROM blocks WHERE session_id = ?) AS blocks, " +
                    "(SELECT COUNT(*) FROM dead_refs WHERE session_id = ?) AS deadRefs, " +
                    "(SELECT COUNT(*) FROM refs WHERE session_id = ?) AS refs, " +
                    "(SELECT COUNT(*) FROM ccr_entries WHERE session_id = ?) AS ccrEntries, " +
                    "(SELECT COUNT(*) FROM orphan_blocks WHERE session_id = ?) AS orphanBlocks, " +
                    "(SELECT COUNT(*) FROM session_ext WHERE session_id = ?) AS ext, " +
                    "(SELECT COUNT(*) FROM checkpoints WHERE session_id = ?) AS cps, " +
                    "(SELECT COUNT(*) FROM checkpoints WHERE session_id = ? AND pinned = 1) AS pinnedCps, " +
                    "(SELECT COUNT(*) FROM l1_world WHERE ledger_id = ?) AS l1Entries, " +
                    "(SELECT COUNT(*) FROM state_fields WHERE session_id = ?) AS stateFields",
            )
            .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as {
            sessions: number; conversations: number;
            messages: number; media: number; blocks: number; deadRefs: number;
            refs: number; ccrEntries: number; orphanBlocks: number; ext: number; cps: number; pinnedCps: number;
            l1Entries: number; stateFields: number;
        };
        const inlineBytes =
            ((this.db
                .prepare(
                    "SELECT COALESCE(SUM(LENGTH(CAST(meta_json AS BLOB))), 0) + COALESCE(SUM(LENGTH(CAST(stats_json AS BLOB))), 0) " +
                        "+ COALESCE(SUM(LENGTH(CAST(metadata_json AS BLOB))), 0) + COALESCE(SUM(LENGTH(CAST(kstate_json AS BLOB))), 0) " +
                        "+ COALESCE(SUM(LENGTH(CAST(tail_json AS BLOB))), 0) + COALESCE(SUM(LENGTH(CAST(ccr_json AS BLOB))), 0) " +
                        "+ COALESCE(SUM(LENGTH(CAST(orphans_json AS BLOB))), 0) AS b " +
                        "FROM sessions WHERE session_id = ?",
                )
                .get(sessionId) as { b: number }).b ?? 0) +
            ((this.db
                .prepare("SELECT COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS b FROM blocks WHERE session_id = ?")
                .get(sessionId) as { b: number }).b ?? 0) +
            ((this.db
                .prepare("SELECT COALESCE(SUM(LENGTH(CAST(value_json AS BLOB))), 0) AS b FROM session_ext WHERE session_id = ?")
                .get(sessionId) as { b: number }).b ?? 0);
        const cas = this.db
            .prepare(
                `WITH owned_refs(hash, released) AS (
                    SELECT content_hash, 1 FROM messages WHERE session_id = ?
                    UNION ALL SELECT media_hash, 1 FROM message_media WHERE session_id = ?
                    UNION ALL SELECT summary_hash, 1 FROM blocks WHERE session_id = ?
                    UNION ALL SELECT one_hash, 1 FROM blocks WHERE session_id = ? AND one_hash IS NOT NULL
                    UNION ALL SELECT content_hash, 1 FROM ccr_entries WHERE session_id = ?
                    UNION ALL SELECT orig_hash, 1 FROM ccr_entries WHERE session_id = ? AND orig_hash IS NOT NULL
                    UNION ALL SELECT state_hash, CASE WHEN pinned = 0 THEN 1 ELSE 0 END FROM checkpoints WHERE session_id = ?
                 ), releases AS (SELECT hash, SUM(released) AS n FROM owned_refs GROUP BY hash)
                 SELECT COALESCE(SUM(CASE WHEN r.n > 0 AND c.refcount <= r.n THEN c.byte_len ELSE 0 END), 0) AS exclusiveBytes,
                        COALESCE(SUM(CASE WHEN r.n > 0 AND c.refcount <= r.n THEN 1 ELSE 0 END), 0) AS exclusiveBlobs,
                        COALESCE(SUM(CASE WHEN c.refcount > r.n THEN 1 ELSE 0 END), 0) AS sharedBlobs
                   FROM releases r JOIN content c ON c.hash = r.hash`,
            )
            .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as { exclusiveBytes: number; exclusiveBlobs: number; sharedBlobs: number };
        return {
            rows: {
                sessions: counts.sessions,
                conversations: counts.conversations,
                messages: counts.messages,
                media: counts.media,
                blocks: counts.blocks,
                deadRefs: counts.deadRefs,
                refs: counts.refs,
                ccrEntries: counts.ccrEntries,
                orphanBlocks: counts.orphanBlocks,
                sessionExt: counts.ext,
                checkpoints: counts.cps,
                pinnedCheckpoints: counts.pinnedCps,
                l1Entries: counts.l1Entries,
                stateFields: counts.stateFields,
            },
            inlineBytes,
            casExclusiveBytes: cas.exclusiveBytes,
            casExclusiveBlobs: cas.exclusiveBlobs,
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
            const rows = (this.db
                .prepare("SELECT session_id, label, updated_at FROM sessions WHERE status = 'active' AND updated_at < ? ORDER BY updated_at")
                .all(cutoff) as Array<{ session_id: string; label: string | null; updated_at: number }>
            );
            for (const r of rows) {
                // Identity consolidation (discussions/7591): two guards —
                // (1) freshness: an egress-on row's updated_at froze at the
                // arm turn (per-turn saves never land), the op log IS the
                // activity; (2) ARCHIVABILITY: archiveSession exports the
                // messages/blocks projection and DELETEs the egress op log
                // without exporting it — for an egress-on session (op log =
                // sole content authority) that sweep is DATA LOSS. Excluded
                // until the archive format carries the op log (follow-up,
                // same release train as the l1/conversations DROP batch).
                const fresh = this.egressAwareFreshness(r.session_id, r.updated_at);
                if (fresh >= cutoff) continue;
                if (this.isEgressOnSession(r.session_id)) continue;
                candidates.push({ sessionId: r.session_id, label: r.label ?? undefined, updatedAt: r.updated_at });
            }
        }
        const zeroRef = this.legacyTablesPresent ? this.contentZeroRefReport() : { rows: 0, bytesTotal: 0 };
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
     *  partial. #7674 note: this stays TRUNCATE — vacuum is an explicit
     *  operator request, so the reclaim is a requested shrink, not the
     *  implicit engine-internal truncate that the corruption came from. */
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

    /** #5312: block-granularity archive log — one JSON line per archived fold
     *  block. Separate from the session log so a block archive never rewrites
     *  (or is rewritten by) whole-session exports. */
    static readonly BLOCK_ARCHIVE_LOG_NAME = "block-archive.jsonl";

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
        // Identity consolidation (discussions/7591): the GC age-sweep excludes
        // egress-on sessions; the MANUAL paths (unifiedArchiveSession —
        // `bili sessions archive`) share this chokepoint and would otherwise
        // hit the same data loss: the export carries the messages/blocks
        // projection (frozen at the arm turn for these sessions) while the
        // egress op log — the sole content authority — is neither exported
        // nor re-imported by restoreSession. Refuse until the archive format
        // carries the op log (follow-up, same batch as the l1/conversations
        // physical DROP).
        if (this.isEgressOnSession(sessionId)) return { ok: false, reason: "egress-on session: the archive format does not carry the egress op log yet — refusing (follow-up)" };
        // #3901 review: sessions are small and numerous — a per-session file
        // per archive would spray tiny files across the archive dir. One
        // append-only JSONL holds every archived session, one line each.
        const exportPath = join(opts.archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        if (row.status === "archived") return { ok: true, exportPath };
        // --- read everything the session owns (before any mutation) ---
        // #4665: carry the v8 row state (identity JOIN key + historian
        // tombstone) across archive/restore — dropping them made restored
        // rows re-mint on the next full ingest and resurrect retired rows.
        // #4313: ts rides along so restored rows keep their wall-clock stamps.
        const messages = (this.db.prepare("SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at, ts FROM messages WHERE session_id = ? ORDER BY seq").all(sessionId) as Record<string, unknown>[]);
        const mediaMaps = (this.db.prepare("SELECT seq, media_hash FROM message_media WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        const blocks = (this.db.prepare("SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json FROM blocks WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const refsRows = (this.db.prepare("SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const deadRefs = (this.db.prepare("SELECT ord, ref, ref_num, recorded_at FROM dead_refs WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const ccr = (this.db.prepare("SELECT ord, ccr_key, content_hash, orig_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord").all(sessionId) as Record<string, unknown>[]);
        const ext = (this.db.prepare("SELECT key, value_json, updated_at FROM session_ext WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        const checkpoints = (this.db.prepare("SELECT cp_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash FROM checkpoints WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        // #6785 step 7: the reaped-block journal rides the archive too.
        const orphans = (this.db.prepare("SELECT block_id, one_json, full_json FROM orphan_blocks WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        const stateFields = (this.db.prepare("SELECT field, value_json FROM state_fields WHERE session_id = ?").all(sessionId) as Record<string, unknown>[]);
        // --- collect the distinct CAS bodies referenced by those rows ---
        const wanted = new Set<string>();
        for (const m of messages) wanted.add(m.content_hash as string);
        for (const mm of mediaMaps) wanted.add(mm.media_hash as string);
        for (const b of blocks) { wanted.add(b.summary_hash as string); if (b.one_hash !== null && b.one_hash !== undefined) wanted.add(b.one_hash as string); }
        for (const e of ccr) { wanted.add(e.content_hash as string); if (e.orig_hash !== null && e.orig_hash !== undefined) wanted.add(e.orig_hash as string); }
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
        // Serialized here, appended as the LAST step inside the sweep
        // transaction below: a sweep that cannot start or fails midway
        // (write lock held by another process, constraint error) must not
        // leave a line behind for a session that is still active — that
        // stale line would shadow the next successful archive on restore,
        // and every failed attempt would add another full copy. The line
        // still reaches the log before COMMIT, so a committed sweep always
        // has its export.
        const archiveLine = JSON.stringify({ version: 1, sessionId, archivedAt: Date.now(), session: row, content, messages, mediaMaps, blocks, refs: refsRows, deadRefs, ccrEntries: ccr, sessionExt: ext, checkpoints, orphanBlocks: orphans, stateFields }) + "\n";
        // --- sweep the row bodies (refcount discipline; pinned checkpoints survive) ---
        let contentRowsDeleted = 0;
        this.db.transaction(() => {
            const rel: string[] = [];
            for (const m of messages) rel.push(m.content_hash as string);
            for (const mm of mediaMaps) rel.push(mm.media_hash as string);
            for (const b of blocks) { rel.push(b.summary_hash as string); if (b.one_hash !== null && b.one_hash !== undefined) rel.push(b.one_hash as string); }
            for (const e of ccr) { rel.push(e.content_hash as string); if (e.orig_hash !== null && e.orig_hash !== undefined) rel.push(e.orig_hash as string); }
            for (const cp of checkpoints) if (cp.pinned === 0) { rel.push(cp.state_hash as string); this.db.prepare("DELETE FROM checkpoints WHERE cp_id = ?").run(cp.cp_id); }
            this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM message_media WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM blocks WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM orphan_blocks WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM state_fields WHERE session_id = ?").run(sessionId);
            this.deleteEgressOps(sessionId);
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId);
            this.db.prepare("UPDATE sessions SET status = 'archived' WHERE session_id = ?").run(sessionId);
            for (const hash of rel) this.releaseContent(hash);
            // #4796 follow-up: scoped collection (see collectZeroRefIn) —
            // the reported count is what THIS archive collected.
            contentRowsDeleted = this.collectZeroRefIn(rel);
            appendFileSync(exportPath, archiveLine);
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
            orphanBlocks?: Record<string, unknown>[];
            stateFields?: Record<string, unknown>[];
        };
        // Scan the JSONL for the session's NEWEST line (#6317: a pre-fix
        // failed archive can leave stale lines behind; a later successful
        // archive appends the newest dump). Skip malformed/truncated
        // trailing lines — an archive append interrupted by a crash must not
        // block restoring OTHER sessions). Newest first: when the log holds
        // more than one line for this session (an archive whose sweep never
        // committed, then a later successful one), the last line appended is
        // the state the session was actually archived in.
        let lineNo = -1;
        let matchCount = 0;
        let rawLines: string[] = [];
        try {
            rawLines = readFileSync(exportPath, "utf8").split("\n");
            for (let i = rawLines.length - 1; i >= 0; i--) {
                if (!rawLines[i].trim()) continue;
                let candidate: unknown;
                try {
                    candidate = JSON.parse(rawLines[i]) as unknown;
                } catch {
                    continue;
                }
                // #6317: count ALL entries for this session. The reverse scan
                // meets the NEWEST line first — keep that; a plain
                // `lineNo = i` without break would end on the OLDEST.
                if (candidate && typeof candidate === "object" && "sessionId" in candidate && candidate.sessionId === sessionId) { if (lineNo === -1) lineNo = i; matchCount += 1; }
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
        if (matchCount > 1) {
            loggerLog("warn", `[#6317] archive log contained ${matchCount} entries for session ${sessionId}; restoring the newest entry and removing all entries`);
        }
        const sess: NonNullable<typeof dump.session> = dump.session;
        this.db.transaction(() => {
            const references = new Map<string, number>();
            const addRef = (hash: unknown): void => {
                if (typeof hash === "string") references.set(hash, (references.get(hash) ?? 0) + 1);
            };
            for (const m of dump.messages) addRef(m.content_hash);
            for (const mm of (dump as { mediaMaps?: Record<string, unknown>[] }).mediaMaps ?? []) addRef(mm.media_hash);
            for (const b of dump.blocks) {
                if (this.db.prepare("SELECT 1 FROM blocks WHERE session_id = ? AND block_id = ?").get(sessionId, b.block_id)) continue;
                addRef(b.summary_hash);
                addRef(b.one_hash);
            }
            for (const e of dump.ccrEntries) {
                addRef(e.content_hash);
                const eh = (e as { orig_hash?: unknown }).orig_hash;
                if (typeof eh === "string") addRef(eh);
            }
            for (const cp of dump.checkpoints) {
                if (!this.getCheckpoint(cp.cp_id as string)) addRef(cp.state_hash);
            }
            for (const [hash, count] of references) {
                const body = dump.content[hash] ?? this.getContent(hash);
                if (body === null || body === undefined) throw new Error(`archive content missing: ${hash}`);
                this.putContent(body, hash);
                if (count > 1) this.db.prepare("UPDATE content SET refcount = refcount + ? WHERE hash = ?").run(count - 1, hash);
            }
            const insMsg = this.db.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            for (const m of dump.messages) {
                // #4665: pre-fix dumps lack both fields — recompute identity
                // from the CAS body (same formula as the v8 migration
                // backfill); retire state is unrecoverable there → live.
                // #4313: ts passes through when present (NULL on older dumps).
                const stored = typeof m.content_hash === "string" ? dump.content[m.content_hash] : undefined;
                const identity = typeof m.identity === "string" && m.identity !== "" ? m.identity : stored !== undefined ? identityOfStoredContent(stored) : "";
                insMsg.run(sessionId, m.seq, m.msg_id, m.ref ?? null, m.ref_num ?? null, m.role, m.kind ?? "message", m.content_hash, identity, typeof m.retired_at === "number" ? m.retired_at : null, typeof m.ts === "number" ? m.ts : null);
            }
            const insMedia = this.db.prepare("INSERT OR IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)");
            for (const mm of (dump as { mediaMaps?: Record<string, unknown>[] }).mediaMaps ?? []) insMedia.run(sessionId, mm.seq, mm.media_hash);
            const insBlock = this.db.prepare(`INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, block_id) DO NOTHING`);
            for (const b of dump.blocks) insBlock.run(b.block_id, sessionId, b.ord, b.start_seq, b.end_seq, b.start_ref ?? null, b.end_ref ?? null, b.tier, b.summary_hash, b.one_hash ?? null, b.supersedes_block_id ?? null, b.active, b.created_at, b.covered_hash, b.payload_json);
            const insRef = this.db.prepare("INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?)");
            for (const r of dump.refs) insRef.run(sessionId, r.ord, r.raw_id, r.ref, r.ref_num ?? null);
            const insDead = this.db.prepare("INSERT INTO dead_refs (session_id, ord, ref, ref_num, recorded_at) VALUES (?, ?, ?, ?, ?)");
            for (const d of dump.deadRefs) insDead.run(sessionId, d.ord, d.ref, d.ref_num, d.recorded_at);
            const insCcr = this.db.prepare("INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash, orig_hash) VALUES (?, ?, ?, ?, ?)");
            for (const e of dump.ccrEntries) insCcr.run(sessionId, e.ord, e.ccr_key, e.content_hash, typeof (e as { orig_hash?: unknown }).orig_hash === "string" ? (e as { orig_hash: string }).orig_hash : null);
            const insExt = this.db.prepare("INSERT INTO session_ext (session_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)");
            for (const x of dump.sessionExt) {
                insExt.run(sessionId, x.key, x.value_json, typeof x.updated_at === "number" && Number.isFinite(x.updated_at) ? x.updated_at : Date.now());
            }
            const insCp = this.db.prepare("INSERT INTO checkpoints (cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cp_id) DO NOTHING");
            for (const cp of dump.checkpoints) insCp.run(cp.cp_id, sessionId, cp.seq_at, cp.block_set_hash, cp.kind, cp.created_at, cp.pinned, cp.label ?? null, cp.state_hash);
            // #6785 step 7: the journal round-trips through the archive.
            const insOrphan = this.db.prepare("INSERT INTO orphan_blocks (session_id, block_id, one_json, full_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, block_id) DO NOTHING");
            for (const o of dump.orphanBlocks ?? []) insOrphan.run(sessionId, o.block_id, o.one_json ?? null, o.full_json);
            const insStateField = this.db.prepare("INSERT INTO state_fields (session_id, field, value_json) VALUES (?, ?, ?) ON CONFLICT(session_id, field) DO NOTHING");
            for (const f of dump.stateFields ?? []) insStateField.run(sessionId, f.field, f.value_json);
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
        // Drop the restored session's line(s) from the JSONL. #6317: a
        // pre-fix failed archive can leave more than one line; restore now
        // already used the newest match and removes all matches, warning when
        // stale lines were present so the loss pattern is diagnosable.
        const kept: string[] = [];
        let ownLines = 0;
        for (const l of rawLines) {
            if (!l.trim()) continue;
            try {
                const head = JSON.parse(l) as { sessionId?: string };
                if (head.sessionId === sessionId) {
                    if (++ownLines === 2) loggerLog("warn", `[storage] archive log holds more than one line for session ${sessionId}: the newest was restored, older ones are dropped`);
                    continue;
                }
            } catch { continue; }
            kept.push(l);
        }
        rewriteArchiveLog(exportPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
        loggerLog("info", `[#3901] restored archived session ${sessionId} from ${exportPath} (line removed from the archive log)`);
        return { ok: true };
    }

    /** #5312: full historical transcript ids for a session — live AND retired
     *  rows. Unlike messageIdRows (live-only, render-lane) this returns every
     *  message identity ever ingested, the conservative basis for judging
     *  whether a fold block's covered ids ever belonged to THIS session. A
     *  legitimate fold's covered rows always persist here (retire-don't-delete,
     *  #4390), so only a genuinely foreign block reads zero intersection. */
    allMessageIds(sessionId: string): string[] {
        const rows = this.db.prepare("SELECT msg_id FROM messages WHERE session_id = ?").all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => r.msg_id as string);
    }

    /** #5312: reversibly archive ONE fold block out of a session's live set.
     *  Block-granularity mirror of archiveSession: capture the row verbatim
     *  plus its CAS bodies into `<archiveDir>/block-archive.jsonl` BEFORE
     *  releasing refs, so restoreBlock re-puts them byte-exact (same sha256 →
     *  same hashes). Unlike reapBlocks (orphan-gc) this is REVERSIBLE — content
     *  is preserved, not journaled-lossy. Idempotent: an already-absent block
     *  no-ops with reason 'not-found'. */
    archiveBlock(sessionId: string, blockId: string, opts: { archiveDir: string }): { ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number } {
        const row = this.db.prepare(
            "SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json FROM blocks WHERE session_id = ? AND block_id = ?",
        ).get(sessionId, blockId) as Record<string, unknown> | undefined;
        if (!row) return { ok: false, reason: "not-found" };
        const exportPath = join(opts.archiveDir, UnifiedStore.BLOCK_ARCHIVE_LOG_NAME);
        const wanted: string[] = [row.summary_hash as string];
        if (row.one_hash !== null && row.one_hash !== undefined) wanted.push(row.one_hash as string);
        const content: Record<string, string> = {};
        for (const hash of wanted) {
            const c = this.db.prepare("SELECT bytes FROM content WHERE hash = ?").get(hash) as { bytes: Buffer | Uint8Array } | undefined;
            if (c) content[hash] = Buffer.from(c.bytes).toString("utf8");
        }
        mkdirSync(opts.archiveDir, { recursive: true });
        const archiveLine = JSON.stringify({ version: 1, sessionId, blockId, archivedAt: Date.now(), block: row, content }) + "\n";
        let contentRowsDeleted = 0;
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM blocks WHERE session_id = ? AND block_id = ?").run(sessionId, blockId);
            this.releaseContent(row.summary_hash as string);
            if (row.one_hash !== null && row.one_hash !== undefined) this.releaseContent(row.one_hash as string);
            const zero = this.db.prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").get() as { n: number };
            contentRowsDeleted = zero.n;
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
            // Publish only after the sweep, while append failures can still roll it back.
            appendFileSync(exportPath, archiveLine);
        });
        loggerLog("info", `[#5312] archived block ${blockId} from ${sessionId} → ${exportPath} (${contentRowsDeleted} content rows collected)`);
        return { ok: true, exportPath, contentRowsDeleted };
    }

    /** #5312: inverse of archiveBlock — re-put the block's CAS bodies and
     *  re-insert its row from the block archive log, then drop the restored
     *  line(s). A live twin, if any, stays authoritative (first claimant wins,
     *  matching restoreArchived) and the CAS bodies are NOT re-put: doing so
     *  would inflate each body's refcount by 1 permanently (slow content-table
     *  leak; #5312 review, non-blocking finding 1). putContent still precedes
     *  the insert on the conflict-free path because the blocks row carries a
     *  foreign key onto content; ON CONFLICT DO NOTHING stays as belt-and-
     *  braces behind the explicit twin probe. */
    restoreBlock(sessionId: string, blockId: string, opts: { archiveDir: string }): { ok: boolean; reason?: string } {
        const exportPath = join(opts.archiveDir, UnifiedStore.BLOCK_ARCHIVE_LOG_NAME);
        if (!existsSync(exportPath)) return { ok: false, reason: "export-missing" };
        let rawLines: string[];
        try { rawLines = readFileSync(exportPath, "utf8").split("\n"); } catch { return { ok: false, reason: "export-corrupt" }; }
        let lineNo = -1;
        for (let i = rawLines.length - 1; i >= 0; i--) {
            if (!rawLines[i].trim()) continue;
            let head: unknown;
            try { head = JSON.parse(rawLines[i]) as unknown; } catch { continue; }
            if (head && typeof head === "object" && "sessionId" in head && "blockId" in head && head.sessionId === sessionId && head.blockId === blockId) { lineNo = i; break; }
        }
        if (lineNo === -1) return { ok: false, reason: "not-found" };
        let dump: { block: Record<string, unknown>; content: Record<string, string> };
        try { dump = JSON.parse(rawLines[lineNo]) as typeof dump; } catch { return { ok: false, reason: "export-corrupt" }; }
        this.db.transaction(() => {
            // Twin probe FIRST: a pre-existing live block keeps authority and we
            // must not touch content refcounts (the reviewed leak path). The FK
            // blocks→content is why the conflict-free path still puts content
            // before its insert.
            const twin = this.db.prepare(
                "SELECT 1 AS one FROM blocks WHERE session_id = ? AND block_id = ?",
            ).get(sessionId, blockId);
            if (twin) return;
            for (const hash of [dump.block.summary_hash, dump.block.one_hash]) {
                if (typeof hash !== "string") continue;
                const body = dump.content[hash];
                if (body === undefined) throw new Error(`archive content missing: ${hash}`);
                this.putContent(body, hash);
            }
            this.db.prepare(
                `INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, block_id) DO NOTHING`,
            ).run(
                dump.block.block_id as string, sessionId, dump.block.ord as number, dump.block.start_seq as number, dump.block.end_seq as number,
                (dump.block.start_ref as number | null) ?? null, (dump.block.end_ref as number | null) ?? null, dump.block.tier as number,
                dump.block.summary_hash as string, (dump.block.one_hash as string | null) ?? null, (dump.block.supersedes_block_id as string | null) ?? null,
                dump.block.active as number, dump.block.created_at as number, dump.block.covered_hash as string, dump.block.payload_json as string,
            );
        });
        const kept: string[] = [];
        for (const l of rawLines) {
            if (!l.trim()) continue;
            try {
                const head = JSON.parse(l) as { sessionId?: string; blockId?: string };
                if (head.sessionId === sessionId && head.blockId === blockId) continue;
            } catch { continue; }
            kept.push(l);
        }
        rewriteArchiveLog(exportPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
        loggerLog("info", `[#5312] restored block ${blockId} into ${sessionId} from ${exportPath}`);
        return { ok: true };
    }

    /** #3901/#3463: age-sweep GC. Sessions whose updated_at is older than
     *  the retention cutoff are archived (export + sweep); zero-ref content
     *  rows left by any path are collected. `vacuum: 'full'` additionally
     *  rebuilds the database file. `vacuum: 'incremental'` hands the
     *  freelist back without the rewrite, but only on a file whose header
     *  says auto_vacuum=INCREMENTAL (see storagePragmas); on a file created
     *  with auto_vacuum=0 it is a no-op until one full VACUUM converts it. */
    gc(opts: { archiveAfterDays: number; archiveDir: string; now?: number; vacuum?: "full" | "incremental" }): { archived: number; contentRowsDeleted: number } {
        // #4612: full VACUUM is an O(db-size) atomic rewrite under the exclusive
        // write lock with no intermediate progress. Running it against a db that
        // another live process is writing starves that process until its storage
        // layer degrades (field report: shadow 3-strike during a 14-min run on a
        // 14 GB db). Refuse up front with an actionable error instead of silently
        // contending. Incremental / no-vacuum sweeps are short transactions — the
        // existing busy_timeout handling covers them.
        if (opts.vacuum === "full") {
            const writer = this.activeForeignWriter();
            if (writer !== null) {
                throw new Error(`[#4612] gc full VACUUM refused: another process (pid ${writer}) is actively writing this database — the rewrite holds the exclusive write lock across the whole pass and would starve the peer's writes until its storage layer degrades; stop the other process (or wait for it to exit) and retry, or use vacuum:"incremental"`);
            }
        }
        const now = opts.now ?? Date.now();
        let archived = 0;
        let contentRowsDeleted = 0;
        if (opts.archiveAfterDays > 0) {
            const cutoff = now - opts.archiveAfterDays * 86_400_000;
            const stale = this.db.prepare("SELECT session_id, updated_at FROM sessions WHERE status = 'active' AND updated_at < ?").all(cutoff) as { session_id: string; updated_at: number }[];
            for (const s of stale) {
                // Identity consolidation (discussions/7591): same two guards
                // as gcPlan — egress-aware freshness (the op log is the
                // activity), and egress-on exclusion (archiveSession would
                // delete the op log WITHOUT exporting it — data loss until
                // the archive format carries it).
                if (this.egressAwareFreshness(s.session_id, s.updated_at) >= cutoff) continue;
                if (this.isEgressOnSession(s.session_id)) continue;
                const r = this.archiveSession(s.session_id, { archiveDir: opts.archiveDir });
                if (r.ok) archived++;
                if (r.contentRowsDeleted) contentRowsDeleted += r.contentRowsDeleted;
            }
        }
        // KDD #25: the CAS lives in the legacy group — a 7-table instance
        // has no content table, so the sweep (the report below it) is
        // skipped, not a crash that aborts the whole gc run.
        if (this.legacyTablesPresent) {
            const zero = this.db.prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").get() as { n: number };
            if (zero.n > 0) {
                loggerLog("info", `[#4796] gc: collecting ${zero.n} zero-ref content rows in batches of ${GC_ZERO_REF_BATCH_SIZE}`);
                contentRowsDeleted += this.collectZeroRefContent(GC_ZERO_REF_BATCH_SIZE);
            }
        }
        if (opts.vacuum === "full") {
            const sizeBefore = this.dbFileSize();
            let walPart = "";
            try {
                walPart = `, ${formatDbSize(statSync(`${this.dbPath}-wal`).size)} WAL`;
            } catch {
                /* no WAL file present */
            }
            loggerLog("info", `[#4612] gc: full VACUUM starting — ${formatDbSize(sizeBefore)} main file${walPart}; atomic rewrite holding the exclusive write lock until done (no intermediate progress)`);
            const startedAt = Date.now();
            // #4390: delegate to vacuum() — a bare VACUUM leaves the compacted
            // image in the WAL; only the TRUNCATE checkpoint shrinks the files.
            this.vacuum("full");
            loggerLog("info", `[#4612] gc: full VACUUM finished in ${((Date.now() - startedAt) / 1000).toFixed(1)} s — ${formatDbSize(sizeBefore)} -> ${formatDbSize(this.dbFileSize())}`);
        } else if (opts.vacuum === "incremental") {
            this.vacuum("incremental");
        }
        return { archived, contentRowsDeleted };
    }

    /** #4796: batched zero-ref CAS collection — the working half of the fix
     *  (the other half is schema v9's idx_content_refcount). One giant
     *  `DELETE FROM content WHERE refcount <= 0` never commits on a bloated
     *  store: uncommitted deletes stay invisible to every other connection
     *  (field: "ran 8 hours, zero rows changed"), the uncommitted tx's WAL
     *  frames cannot checkpoint (journal_size_limit applies to committed
     *  frames only), and the exclusive write lock is held until the process
     *  dies. Batching turns the sweep into small autocommit statements —
     *  each batch commits and checkpoints independently, so progress
     *  survives a crash (the next run resumes where this one died) and the
     *  write lock is held per batch, not per table.
     *
     *  Deliberately NOT wrapped in an explicit transaction: an explicit tx
     *  pins the read snapshot at the SELECT, so a concurrent writer that
     *  re-references a row between select and delete would be invisible to
     *  us and we would delete freshly-referenced bytes. Each statement runs
     *  in autocommit mode against the latest committed state, and the DELETE
     *  re-filters `refcount <= 0` under its own snapshot — a row that got a
     *  reference back between the two statements is skipped, not deleted. */
    private collectZeroRefContent(batchSize: number): number {
        let deleted = 0;
        let batchNo = 0;
        for (;;) {
            const hashes = this.db
                .prepare("SELECT hash FROM content WHERE refcount <= 0 ORDER BY hash LIMIT ?")
                .all(batchSize) as Array<{ hash: string }>;
            if (hashes.length === 0) break;
            batchNo += 1;
            const ph = hashes.map(() => "?").join(", ");
            const r = this.db.prepare(`DELETE FROM content WHERE refcount <= 0 AND hash IN (${ph})`).run(...hashes.map((h) => h.hash));
            deleted += Number(r.changes);
            // Best-effort shrink between batches: committed frames move into
            // the main db and the WAL file truncates back to the cap
            // (#3250 discipline). This stays TRUNCATE under #7674: gc is an
            // explicit operator action (?gc=full / admin), so the reclaim is
            // a requested shrink, not the implicit engine-internal truncate
            // the corruption came from. A busy checkpoint loses nothing — the
            // next batch retries.
            try {
                this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
            } catch { /* best-effort; retried by the next batch */ }
            if (batchNo % 10 === 0 || hashes.length < batchSize) {
                loggerLog("info", `[#4796] gc: collected ${deleted} zero-ref content rows so far (batch ${batchNo})`);
            }
        }
        return deleted;
    }

    /** #4796 follow-up (PR #4800 review): lifecycle-scoped zero-ref
     *  collection. deleteSession/archiveSession/deleteCheckpoint used to
     *  finish with a full-table `DELETE ... WHERE refcount <= 0` — on a
     *  bloated store that re-created the exact pathology of the old gc
     *  sweep (one giant commit inside the lifecycle transaction: unbounded
     *  WAL growth, long write-lock hold) while adding nothing these ops
     *  need: every hash they release already went through releaseContent's
     *  delete-on-zero. This collects only within the operation's own
     *  released-hash set — bounded work, same-transaction atomicity kept —
     *  which also catches a pre-existing orphan row the op happens to
     *  touch. Orphans from other sources stay for gc(). */
    private collectZeroRefIn(hashes: Iterable<string>): number {
        const list = [...new Set(hashes)];
        let deleted = 0;
        for (let i = 0; i < list.length; i += ZERO_REF_SWEEP_CHUNK) {
            const chunk = list.slice(i, i + ZERO_REF_SWEEP_CHUNK);
            const ph = chunk.map(() => "?").join(", ");
            deleted += Number(this.db.prepare(`DELETE FROM content WHERE refcount <= 0 AND hash IN (${ph})`).run(...chunk).changes);
        }
        return deleted;
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

    /** #4949: circuit-breaker re-enable probe — one REAL committed write
     *  through the production transaction path (proves lock acquisition +
     *  disk space, not just connectivity). A single fixed kv key keeps the
     *  trace constant; the row doubles as a liveness marker. Throws on failure. */
    probeWritable(): void {
        this.db.transaction(() => {
            this.setKv("__bili", "writability-probe", { probedAt: Date.now() });
        });
    }

    setKv(namespace: string, key: string, value: unknown): void {
        // KDD #25: the 256-char cap is eg-plane discipline only (the egress
        // plane is SQLite-only; legacy mode keeps the historical 4 MB budget —
        // pre-existing legacy keys may already hold large values).
        if (egressPlaneGateOn()) assertKvValueSize(namespace, key, value);
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
            where.push("key LIKE ? ESCAPE '\\' AND instr(key, ?) = 1");
            args.push(likeEscape(keyPrefix) + "%", keyPrefix);
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

    sessionIdentity(sessionId: string): { protocol?: string; origin?: string } | null {
        const row = this.db
            .prepare("SELECT protocol, origin FROM sessions WHERE session_id = ?")
            .get(sessionId) as { protocol: string | null; origin: string | null } | undefined;
        return row ? { protocol: row.protocol ?? undefined, origin: row.origin ?? undefined } : null;
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
            this.collectZeroRefIn([row.state_hash]);
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
     *  display time = latest block created_at; blocks = ALL blocks count.
     *  The first-block topic/summary lead (#7595) mirrors webSummaryRows'
     *  filter exactly — only blocks that actually carry a topic or summary
     *  count, so a leading block with neither defers to the next block
     *  (the MySQL sibling query carries the same filter). */
    sessionSummaries(): SessionSummaryRow[] {
        const rows = this.db
            .prepare(
                `WITH bl AS (
                     SELECT b.session_id, b.ord,
                            CASE WHEN json_valid(b.payload_json) THEN b.payload_json END AS payload
                     FROM blocks b
                 )
                 SELECT s.session_id AS sessionId, s.host_title AS hostTitle, s.title AS title, s.label AS label,
                        s.protocol AS protocol, s.origin AS origin, s.namespace AS namespace, s.stats_json AS statsJson,
                        s.status AS status, s.updated_at AS updatedAt,
                        (SELECT COUNT(*) FROM bl WHERE bl.session_id = s.session_id) AS blocks,
                        (SELECT MAX(b.created_at) FROM blocks b WHERE b.session_id = s.session_id) AS latestBlockAt,
                        (SELECT json_extract(bl.payload, '$.topic') FROM bl
                          WHERE bl.session_id = s.session_id
                            AND (json_extract(bl.payload, '$.topic') IS NOT NULL
                                 OR json_extract(bl.payload, '$.summary') IS NOT NULL)
                          ORDER BY bl.ord LIMIT 1) AS firstTopic,
                        (SELECT json_extract(bl.payload, '$.summary') FROM bl
                          WHERE bl.session_id = s.session_id
                            AND (json_extract(bl.payload, '$.topic') IS NOT NULL
                                 OR json_extract(bl.payload, '$.summary') IS NOT NULL)
                          ORDER BY bl.ord LIMIT 1) AS firstSummary
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
            firstTopic: string | null;
            firstSummary: string | null;
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
                // #7595: raw fields for the display-title fallback (merged
                // `title` above is unchanged for existing consumers).
                hostTitle: r.hostTitle ?? undefined,
                firstTopic: r.firstTopic ?? undefined,
                firstSummary: r.firstSummary ?? undefined,
            };
        });
    }

    /** #2960 R2.2: web list rows — sessions table + block aggregates in one
     *  SQL (payload json_extract for the first-block lead and active-block
     *  compressed-token sum). Replaces the bounded envelope-file decode the
     *  disk index performs per refresh. */
    webSummaryRows(): WebSummaryRow[] {
        // #7156: a corrupt/empty payload_json (e.g. left by an interrupted
        // .recover) made json_extract throw "malformed JSON" and fail the WHOLE
        // .all() — the panel then silently fell back to 0 historical sessions.
        // Guard each extract with json_valid so a bad row degrades to NULL
        // (skipped by the filters, ignored by SUM) instead of killing the list.
        const rows = this.db
            .prepare(
                `WITH bl AS (
                     SELECT b.session_id, b.ord, b.active,
                            CASE WHEN json_valid(b.payload_json) THEN b.payload_json END AS payload
                     FROM blocks b
                 )
                 SELECT s.session_id AS sessionId, s.title AS title, s.host_title AS hostTitle, s.label AS label,
                        s.protocol AS protocol, s.origin AS origin, s.status AS status, s.updated_at AS updatedAt,
                        s.stats_json AS statsJson, s.metadata_json AS metadataJson,
                        (SELECT COUNT(*) FROM bl WHERE bl.session_id = s.session_id) AS blocks,
                        (SELECT json_extract(bl.payload, '$.topic') FROM bl
                          WHERE bl.session_id = s.session_id
                            AND (json_extract(bl.payload, '$.topic') IS NOT NULL
                                 OR json_extract(bl.payload, '$.summary') IS NOT NULL)
                          ORDER BY bl.ord LIMIT 1) AS firstTopic,
                        (SELECT json_extract(bl.payload, '$.summary') FROM bl
                          WHERE bl.session_id = s.session_id
                            AND (json_extract(bl.payload, '$.topic') IS NOT NULL
                                 OR json_extract(bl.payload, '$.summary') IS NOT NULL)
                          ORDER BY bl.ord LIMIT 1) AS firstSummary,
                        (SELECT COALESCE(SUM(json_extract(bl.payload, '$.compressedTokens')), 0)
                          FROM bl WHERE bl.session_id = s.session_id AND bl.active = 1) AS activeCompressed
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

    /** Scalar drift arbitration without reading or decoding block CAS views.
     *  Count rows even when the session header is absent, as getBlocks does. */
    activeBlockCount(sessionId: string): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = ? AND active = 1")
            .get(sessionId) as { n: number };
        return row.n;
    }

    /** Small arbitration fields for lazy reads; no serialized session surfaces. */
    getLoadHeader(sessionId: string): { requests: number; nextBlockId: number; activeBlockCount: number; mappedRefCount: number } | null {
        const row = this.db.prepare(`
            SELECT next_block_id, stats_json,
                (SELECT COUNT(*) FROM blocks WHERE session_id = ? AND active = 1) AS active_blocks,
                (SELECT COUNT(DISTINCT ref) FROM refs WHERE session_id = ? AND ref <> 'BLOCKED') AS mapped_refs
            FROM sessions WHERE session_id = ?
        `).get(sessionId, sessionId, sessionId) as {
            next_block_id: number; stats_json: string; active_blocks: number; mapped_refs: number;
        } | undefined;
        if (!row) return null;
        try {
            const stats = JSON.parse(row.stats_json) as { requests?: unknown };
            return {
                requests: Number(stats.requests ?? 0),
                nextBlockId: row.next_block_id,
                activeBlockCount: row.active_blocks,
                mappedRefCount: row.mapped_refs,
            };
        } catch {
            return null;
        }
    }

    getMetadataJson(sessionId: string): string | null {
        const row = this.db.prepare("SELECT metadata_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { metadata_json: string } | undefined;
        return row?.metadata_json ?? null;
    }

    getOrphansJson(sessionId: string): string | null {
        const row = this.db.prepare("SELECT orphans_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { orphans_json: string | null } | undefined;
        return row?.orphans_json ?? null;
    }

    /** #4739: one bounded page of block-content CAS bytes for batched view
     *  decoding (storage-bounded-load / issue4739-storage-read-snapshot pin
     *  this shape). */
    getBlockContents(sessionId: string, opts: { limit: number; offset?: number }): Pick<BlockRow, "blockId" | "summary" | "one">[] {
        const rows = this.db.prepare(`SELECT b.block_id, b.one_hash, COALESCE(b.summary_bytes, s.bytes) AS summary_bytes, o.bytes AS one_bytes
            FROM (SELECT block_id, ord, summary_hash, one_hash, summary_bytes FROM blocks
                WHERE session_id = ? ORDER BY ord, block_id LIMIT ? OFFSET ?) b
            LEFT JOIN content s ON s.hash = b.summary_hash
            LEFT JOIN content o ON o.hash = b.one_hash
            ORDER BY b.ord, b.block_id`)
            .all(sessionId, opts.limit, opts.offset ?? 0) as { block_id: string; one_hash: string | null; summary_bytes: Buffer | null; one_bytes: Buffer | null }[];
        return rows.map((row) => ({
            blockId: row.block_id,
            summary: row.summary_bytes === null ? "" : Buffer.from(row.summary_bytes).toString("utf8"),
            one: row.one_hash && row.one_bytes !== null ? Buffer.from(row.one_bytes).toString("utf8") : null,
        }));
    }
    getSessionRow(sessionId: string): SessionRow | null {
        const row = this.db
            .prepare(
                `SELECT session_id, parent_session_id, fork_point_seq, fork_egress_watermark, protocol, label, title, host_title, namespace, origin, status,
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
            forkEgressWatermark: (row.fork_egress_watermark as number | null) ?? null,
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
     *  (including zero-row clones and idempotent replays). With initial, the
     *  child must be new and its snapshot is ingested in this same transaction,
     *  so neither ledger rows nor a half-initialized child survive failure.
     *  An unmirrored parent with initial still creates that snapshot and
     *  returns true, without inventing ledger lineage or copied rows. */
    cloneSessionRows(parentId: string, childId: string, throughSeq: number, initial?: IngestSessionInput): boolean {
        if (initial && initial.session.sessionId !== childId) throw new Error("cloneSessionRows: initial session does not match child");
        if (parentId === childId) throw new Error("cloneSessionRows: conflicting fork lineage (child equals parent)");
        return this.db.transaction(() => {
            const existing = this.getSessionRow(childId);
            if (initial && existing !== null) throw new Error("cloneSessionRows: conflicting fork lineage (child already exists)");
            const parent = this.getSessionRow(parentId);
            if (parent === null) {
                // #7658: an egress-on-from-birth parent has NO unified
                // sessions row — #7474 P2 froze every unified leg
                // (persist.ts egressProjectionFrozen), so ingestSession
                // never ran — but its egress op log IS the ledger (ruling
                // 7439). The legacy-only early return below would silently
                // drop the R-B whole-table copy and the lineage pair: the
                // child would re-bootstrap from client bytes, re-issue the
                // number space, and lose the retired marks and the parent
                // link. Detect it by the flow watermark.
                if (this.egressStateMaxSeq(parentId) === 0) {
                    // A legacy-only parent has no ledger to clone. Still
                    // create the prepared child atomically rather than
                    // falling back to an unchecked upsert after releasing
                    // this transaction.
                    if (!initial) return false;
                    if (!this.ingestSession(initial, undefined, { completeLog: true })) throw new Error("cloneSessionRows: initial child ingest failed");
                    return true;
                }
                // Materialize a minimal parent skeleton row (the same
                // pattern as the #7591 R3-latch upsert in snap.ts) so the
                // child's lineage pair points at a durable row. The JSON
                // columns keep their DDL defaults ('{}'): an egress-on
                // parent's unified leg is frozen (persist.ts
                // egressProjectionFrozen), so no full ingest ever fills
                // them — the egress op log is the parent's authority and
                // the skeleton row is a lineage anchor only. The upsert
                // never reparents an existing pair (COALESCE).
                this.db.prepare(`INSERT OR IGNORE INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)`).run(parentId, Date.now(), Date.now());
            }
            if (existing !== null) {
                // The pair, not the presence of messages, identifies a replay.
                // Empty clones are completed clones too; never reparent them.
                if (existing.parentSessionId !== null || existing.forkPointSeq !== null) {
                    if (existing.parentSessionId === parentId && existing.forkPointSeq === throughSeq) return true;
                    throw new Error("cloneSessionRows: conflicting fork lineage");
                }
                const already = this.db
                    .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
                    .get(childId) as Record<string, unknown>;
                if ((already.n as number) > 0) throw new Error("cloneSessionRows: conflicting fork lineage (child already has messages)");
            }
            this.db
                .prepare(
                    `INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at, ts)
                     SELECT ?, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at, ts FROM messages
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
            // Ruling 7439 (fork = whole-table copy): the egress op log is
            // self-contained (bytes + canonical numbers in its own tables),
            // so the fork copies BOTH tables wholesale in this same
            // transaction — the child inherits the parent's full number
            // space and retired marks, nothing is re-issued across the
            // fork, and no other logic changes. No-op when the parent has
            // no egress rows (proxy-mode / egress-off sessions).
            // #7577 (dual clocks, owner ruling 2026-11-24): the watermark is
            // the FLOW clock (egressStateMaxSeq — the flow table keeps its
            // exclusive number pool). The point fork copies ALL FOUR tables
            // (egress_state, egress_flow, egress_block_state, egress_block_flow):
            // block rows align on wm via their flow_op_seq pointer, so the
            // child inherits the parent's block set as of that flow point.
            this.egressPointForkSession(parentId, childId, this.egressStateMaxSeq(parentId));
            // #7658: record the egress fork point next to the (often NULL)
            // unified fork_point_seq — the FLOW watermark the four tables
            // were copied at. NULL when the parent has no egress rows.
            const egressWatermark = this.egressStateMaxSeq(parentId) > 0 ? this.egressStateMaxSeq(parentId) : null;
            this.db
                .prepare(
                    `INSERT INTO sessions (session_id, created_at, updated_at, parent_session_id, fork_point_seq, fork_egress_watermark)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(session_id) DO UPDATE SET
                       parent_session_id = excluded.parent_session_id,
                       fork_point_seq = excluded.fork_point_seq,
                       fork_egress_watermark = excluded.fork_egress_watermark`,
                )
                .run(
                    childId,
                    Date.now(),
                    Date.now(),
                    parentId,
                    throughSeq,
                    egressWatermark,
                );
            if (initial && !this.ingestSession(initial, undefined, { completeLog: true })) throw new Error("cloneSessionRows: initial child ingest failed");
            return true;
        });
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
    messageIdRows(sessionId: string): { seq: number; msgId: string; ts: number | null }[] {
        const rows = this.db
            .prepare("SELECT seq, msg_id, ts FROM messages WHERE session_id = ? AND retired_at IS NULL ORDER BY seq")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({ seq: r.seq as number, msgId: r.msg_id as string, ts: (r.ts as number | null) ?? null }));
    }

    /** #D5-5 render windowing: full rows (content + media) ONLY for seqs
     *  outside the covered intervals. Inclusive [start, end] pairs; overlaps
     *  are merged before querying the uncovered gaps in bounded batches.
     *  Empty interval list = every live row. */
    uncoveredRows(sessionId: string, intervals: readonly [number, number][]): (MessageRow & { contentHash: string })[] {
        const merged: [number, number][] = [];
        for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
            if (start > end) continue;
            const last = merged.at(-1);
            if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
            else merged.push([start, end]);
        }
        const gaps: Array<[number | undefined, number | undefined]> = [];
        let lower: number | undefined;
        for (const [start, end] of merged) {
            gaps.push([lower, start]);
            lower = end;
        }
        gaps.push([lower, undefined]);
        const rows: Record<string, unknown>[] = [];
        for (let offset = 0; offset < gaps.length; offset += 200) {
            const params: unknown[] = [sessionId];
            const clauses = gaps.slice(offset, offset + 200).map(([lo, hi]) => {
                const bounds: string[] = [];
                if (lo !== undefined) { bounds.push("seq > ?"); params.push(lo); }
                if (hi !== undefined) { bounds.push("seq < ?"); params.push(hi); }
                return bounds.length > 0 ? `(${bounds.join(" AND ")})` : "1";
            });
            const sql = "SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, ts FROM messages WHERE session_id = ? AND retired_at IS NULL"
                + ` AND (${clauses.join(" OR ")}) ORDER BY seq`;
            for (const row of this.db.prepare(sql).all(...params) as Record<string, unknown>[]) rows.push(row);
        }
        return Array.from(this.messageContents(rows), ([r, content]) => ({
            seq: r.seq as number,
            msgId: r.msg_id as string,
            ref: (r.ref as string | null) ?? null,
            refNum: (r.ref_num as number | null) ?? null,
            role: r.role as string,
            kind: r.kind as string,
            contentHash: r.content_hash as string,
            ts: (r.ts as number | null) ?? null,
            content: this.hydrateMedia(content),
        }));
    }

    /** Fetch bodies for captured message rows in bounded batches. Keeping
     *  the metadata query separate avoids holding a whole history's BLOBs
     *  alongside all of its decoded strings. Hashes preserve row identity. */
    private *messageContents(rows: readonly Record<string, unknown>[]): Generator<readonly [Record<string, unknown>, string]> {
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            const hashes = [...new Set(chunk.map((row) => row.content_hash as string))];
            const contents = this.db.prepare(`SELECT hash, bytes FROM content WHERE hash IN (${hashes.map(() => "?").join(",")})`)
                .all(...hashes) as { hash: string; bytes: Uint8Array }[];
            const byHash = new Map(contents.map((row) => [row.hash, row.bytes]));
            for (const row of chunk) {
                const bytes = byHash.get(row.content_hash as string);
                yield [row, bytes === undefined ? "" : Buffer.from(bytes).toString("utf8")];
            }
        }
    }

    getMessages(sessionId: string, opts?: { includeRetired?: boolean; seqs?: readonly number[]; fromSeqExclusive?: number }): (MessageRow & { contentHash: string; retiredAt: number | null })[] {
        // #4390: retired rows (rewound/undo history) stay out of the unified
        // replay by default — they are history, not view. Callers that need
        // the full historian record (export/diagnostics) opt in.
        // #5155: fromSeqExclusive narrows the scan to rows appended after a
        // recorded pointer — hot-path pointer upkeep must not walk the table.
        if (!this.legacyTablesPresent) return []; // KDD #25: missing legacy group = no data
        if (opts?.seqs?.length === 0) return [];
        const seqFilter = opts?.seqs ? ` AND seq IN (${opts.seqs.map(() => "?").join(",")})` : "";
        const afterClause = !opts?.seqs && opts?.fromSeqExclusive !== undefined ? " AND seq > ?" : "";
        const retiredFilter = opts?.includeRetired === true ? "" : " AND retired_at IS NULL";
        const params: unknown[] = [sessionId];
        if (opts?.seqs) params.push(...opts.seqs);
        if (!opts?.seqs && opts?.fromSeqExclusive !== undefined) params.push(opts.fromSeqExclusive);
        const rows = this.db
            .prepare(
                `SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, retired_at, ts FROM messages WHERE session_id = ?${retiredFilter}${seqFilter}${afterClause} ORDER BY seq`,
            )
            .all(...params) as Record<string, unknown>[];
        return Array.from(this.messageContents(rows), ([r, content]) => {
            messageRowReads.count++;
            return {
            seq: r.seq as number,
            msgId: r.msg_id as string,
            ref: (r.ref as string | null) ?? null,
            refNum: (r.ref_num as number | null) ?? null,
            role: r.role as string,
            kind: r.kind as string,
            contentHash: r.content_hash as string,
            retiredAt: (r.retired_at as number | null) ?? null,
            ts: (r.ts as number | null) ?? null,
            content: this.hydrateMedia(content),
            };
        });
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

    getBlocks(sessionId: string, opts?: { limit: number; offset?: number }): (BlockRow & { summaryHash: string; oneHash: string | null })[] {
        if (!this.legacyTablesPresent) return []; // KDD #25: missing legacy group = no data
        const rows = this.db
            .prepare(
                `SELECT b.block_id, b.ord, b.start_seq, b.end_seq, b.start_ref, b.end_ref, b.tier, b.summary_hash, b.one_hash,
                        b.supersedes_block_id, b.active, b.created_at, b.covered_hash, b.payload_json,
                        COALESCE(b.summary_bytes, s.bytes) AS summary_bytes, o.bytes AS one_bytes
                 FROM (SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash,
                              supersedes_block_id, active, created_at, covered_hash, payload_json, summary_bytes
                       FROM blocks WHERE session_id = ? ORDER BY ord, block_id${opts ? " LIMIT ? OFFSET ?" : ""}) b
                 LEFT JOIN content s ON s.hash = b.summary_hash
                 LEFT JOIN content o ON o.hash = b.one_hash
                 ORDER BY b.ord, b.block_id`,
            )
            .all(sessionId, ...(opts ? [opts.limit, opts.offset ?? 0] : [])) as Record<string, unknown>[];
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
            summary: r.summary_bytes === null ? "" : Buffer.from(r.summary_bytes as Buffer).toString("utf8"),
            one: r.one_hash && r.one_bytes !== null ? Buffer.from(r.one_bytes as Buffer).toString("utf8") : null,
            supersedesBlockId: (r.supersedes_block_id as string | null) ?? null,
            active: (r.active as number) === 1,
            createdAt: r.created_at as number,
            coveredHash: r.covered_hash as string,
            payloadJson: r.payload_json as string,
        }));
    }

    getDeadRefs(sessionId: string): { ord: number; ref: string; refNum: number; recordedAt: number }[] {
        if (!this.legacyTablesPresent) return []; // KDD #25: missing legacy group = no data
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
        if (!this.legacyTablesPresent) return []; // KDD #25: missing legacy group = no data
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
            const parsed = JSON.parse(row.ccr_json) as MessageContentStore & { ccrSlim?: number };
            // #6785 step 6: slim envelope — the column keeps key→hash only;
            // the bytes come back through the CAS via ccr_entries (same
            // reconstruction as the view leg, one definition in slim.ts).
            // A slim row with an empty ledger degrades to the file path.
            if (parsed.ccrSlim === 1) {
                const entries = this.getCcrEntries(sessionId);
                return hydrateSlimCcrStore(parsed, entries);
            }
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
        if (!this.legacyTablesPresent) return []; // KDD #25: missing legacy group = no data
        const rows = this.db
            .prepare("SELECT ord, ccr_key, content_hash, orig_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            key: r.ccr_key as string,
            content: this.getContent(r.content_hash as string) ?? "",
            contentHash: r.content_hash as string,
            // #6785 step 6: null (not "") marks pre-step-6 rows — callers
            // degrade to the full envelope / file lane instead of
            // reconstructing an empty original.
            origContent: r.orig_hash === null || r.orig_hash === undefined ? null : this.getContent(r.orig_hash as string) ?? null,
            origHash: r.orig_hash === null || r.orig_hash === undefined ? null : (r.orig_hash as string),
        }));
    }
}
