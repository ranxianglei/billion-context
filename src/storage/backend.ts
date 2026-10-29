import type { SqliteEngineName } from "./driver.ts";
import type { MessageContentStore } from "acp-kernel";
import type { Mysql2Module } from "./mysql.js";
import { UnifiedStore } from "./store.ts";

/** #3931 / #3388 step 1 — the storage backend contract.
 *
 * The seam is at the OPERATION level, not the SQL-dialect level: each backend
 * implements the same set of storage operations natively, so per-backend
 * transaction/atomicity semantics survive (a dialect shim cannot preserve
 * `ingestSession`'s single-transaction CAS refcount discipline). The
 * interface is async because network backends (MySQL, step 2) are async;
 * the sqlite implementation below stays synchronous under the hood and
 * `Promise.resolve`-wraps its results — the hot-path cost is one microtask.
 *
 * `sqlite` is the default. `mysql` is IMPLEMENTED (#3388 step 2, #3931):
 * MysqlBackend implements the full contract against MySQL 8.0 (mysql2
 * driver — #3931 owner decision). Driver AND module load lazily inside
 * openBackend("mysql", dsn) through dynamic imports that survive bundling
 * as real runtime imports (#4008: a static import of the driver would hoist
 * to the top of dist and crash thin installs), so boots that do not select
 * mysql never resolve mysql2; the `indexPath` argument doubles as the DSN
 * for mysql, mirroring how SqliteBackend.open consumes the index path.
 */

export type {
    SessionRow,
    MessageRow,
    BlockRow,
    RefRow,
    CcrEntryRow,
    CheckpointRow,
    SessionSummaryRow,
    WebSummaryRow,
    IngestSessionInput,
} from "./store.js";
import type {
    SessionRow,
    MessageRow,
    BlockRow,
    RefRow,
    CcrEntryRow,
    CheckpointRow,
    SessionSummaryRow,
    WebSummaryRow,
    IngestSessionInput,
} from "./store.js";

/** Everything a storage backend must provide. Mirrors the operation surface
 *  the product consumes (persist/shadow hot path, web lists, export,
 *  checkpoints/replicas, GC/archive, incremental pointers). Engine
 *  introspection (engine/engineSource) stays backend-internal and is
 *  deliberately NOT part of the contract. */
export interface StorageBackend {
    // --- ingest / session lifecycle -------------------------------------
    ingestSession(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean },
    ): Promise<boolean>;
    sessionCounters(sessionId: string): Promise<{ requests: number; nextBlockId: number } | null>;
    sessionUpdatedAt(sessionId: string): Promise<number | null>;
    deleteSession(sessionId: string): Promise<void>;
    listSessionIds(): Promise<string[]>;
    lookupConversation(namespace: string, conversationId: string): Promise<string | null>;
    listConversationBindings(namespace?: string): Promise<{ namespace: string; conversationId: string; sessionId: string; claimedAt: number }[]>;

    // --- reads ------------------------------------------------------------
    getSessionRow(sessionId: string): Promise<SessionRow | null>;
    /** #4316 PR3/3: live (non-retired) row count. */
    liveRowCount(sessionId: string): Promise<number>;
    /** #4730: highest live seq — fork endpoint's inclusive throughSeq. */
    lastLiveSeq(sessionId: string): Promise<number | null>;
    /** #4316 PR3/3: raw id → canonical seq (single-row ids only). */
    seqByRaw(sessionId: string): Promise<Map<string, number> | null>;
    /** #4316 PR3/3: fork adoption row clone (idempotent). */
    cloneSessionRows(parentId: string, childId: string, throughSeq: number, initial?: IngestSessionInput): Promise<boolean>;
    getMessages(sessionId: string): Promise<(MessageRow & { contentHash: string })[]>;
    getBlocks(sessionId: string): Promise<(BlockRow & { summaryHash: string; oneHash: string | null })[]>;
    getDeadRefs(sessionId: string): Promise<{ ord: number; ref: string; refNum: number; recordedAt: number }[]>;
    getRefs(sessionId: string): Promise<RefRow[]>;
    getCcr(sessionId: string): Promise<MessageContentStore | null>;
    getCcrEntries(sessionId: string): Promise<CcrEntryRow[]>;

    // --- ingest watermark / pointers (#3253, #3798) ------------------------
    ingestWatermark(sessionId: string): Promise<{ seq: number; tailSeqs: number[] } | null>;
    tailSeqs(sessionId: string): Promise<number[] | null>;
    clearIngestWatermark(sessionId: string): Promise<void>;
    resetAllIngestWatermarks(): Promise<void>;
    probeIngestBoundary(sessionId: string, seq: number): Promise<{ msgId: string; contentHash: string; maxSeq: number } | null>;

    // --- reap journal (#3841) ----------------------------------------------
    reapBlocks(sessionId: string, reapedIds: Set<string>, orphanContents: Map<string, { one: unknown; full: unknown }>): Promise<void>;

    // --- archive / GC (#3463) ------------------------------------------------
    archiveSession(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number }>;
    restoreArchived(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; reason?: string }>;
    gc(opts: { archiveAfterDays: number; archiveDir: string; now?: number; vacuum?: "full" | "incremental" }): Promise<{ archived: number; contentRowsDeleted: number }>;

    // --- refcount introspection (GC + doctor) --------------------------------
    contentRefCountOfBody(needle: string): Promise<number>;
    mediaRefCount(bytes: string): Promise<number>;

    // --- checkpoints / replicas (#3014) ---------------------------------------
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
    }): Promise<void>;
    listCheckpoints(sessionId?: string): Promise<CheckpointRow[]>;
    getCheckpoint(cpId: string): Promise<CheckpointRow | undefined>;
    checkpointState(cpId: string): Promise<{ stateJson: string; byteLen: number }>;
    deleteCheckpoint(cpId: string): Promise<boolean>;

    // --- session_ext / kv --------------------------------------------------------
    setSessionExt(sessionId: string, key: string, value: unknown): Promise<void>;
    getSessionExt(sessionId: string, key: string): Promise<unknown>;
    listSessionExt(sessionId: string): Promise<{ key: string; value: unknown; updatedAt: number }[]>;
    deleteSessionExt(sessionId: string, key?: string): Promise<number>;
    setKv(namespace: string, key: string, value: unknown): Promise<void>;
    getKv(namespace: string, key: string): Promise<unknown>;
    listKv(namespace?: string, keyPrefix?: string): Promise<{ namespace: string; key: string; value: unknown; updatedAt: number }[]>;
    deleteKv(namespace: string, key?: string): Promise<number>;

    // --- summaries / diagnostics ----------------------------------------------------
    sessionSummaries(): Promise<SessionSummaryRow[]>;
    webSummaryRows(): Promise<WebSummaryRow[]>;
    verifyProjections(sessionId: string): Promise<{ ok: true; checks: number } | { ok: false; error: string }>;
    counts(): Promise<Record<string, number>>;
    contentDedupReport(): Promise<{ rows: number; bytesTotal: number; refcounted: number }>;

    close(): Promise<void>;
    /** One-time DDL + schema stamp for network backends (MySQL); a no-op
     *  for sqlite (create-on-open). Idempotent. */
    init?(): Promise<void>;
}

/** The sqlite backend: the existing UnifiedStore behind the async contract.
 *  Synchronous under the hood; `Promise.resolve` wrapping only. */
export class SqliteBackend implements StorageBackend {
    readonly store: UnifiedStore;

    constructor(store: UnifiedStore) {
        this.store = store;
    }

    static open(indexPath: string, engine?: SqliteEngineName): SqliteBackend {
        return new SqliteBackend(UnifiedStore.open(indexPath, engine));
    }

    ingestSession(input: IngestSessionInput, delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] }, opts?: { completeLog?: boolean }): Promise<boolean> {
        return Promise.resolve(this.store.ingestSession(input, delta, opts));
    }
    sessionCounters(sessionId: string): Promise<{ requests: number; nextBlockId: number } | null> {
        return Promise.resolve(this.store.sessionCounters(sessionId));
    }
    sessionUpdatedAt(sessionId: string): Promise<number | null> {
        return Promise.resolve(this.store.sessionUpdatedAt(sessionId));
    }
    deleteSession(sessionId: string): Promise<void> {
        return Promise.resolve(this.store.deleteSession(sessionId));
    }
    listSessionIds(): Promise<string[]> {
        return Promise.resolve(this.store.listSessionIds());
    }
    lookupConversation(namespace: string, conversationId: string): Promise<string | null> {
        return Promise.resolve(this.store.lookupConversation(namespace, conversationId));
    }
    listConversationBindings(namespace?: string): Promise<{ namespace: string; conversationId: string; sessionId: string; claimedAt: number }[]> {
        return Promise.resolve(this.store.listConversationBindings(namespace));
    }
    getSessionRow(sessionId: string): Promise<SessionRow | null> {
        return Promise.resolve(this.store.getSessionRow(sessionId));
    }
    liveRowCount(sessionId: string): Promise<number> {
        return Promise.resolve(this.store.liveRowCount(sessionId));
    }
    lastLiveSeq(sessionId: string): Promise<number | null> {
        return Promise.resolve(this.store.lastLiveSeq(sessionId));
    }
    seqByRaw(sessionId: string): Promise<Map<string, number> | null> {
        return Promise.resolve(this.store.seqByRaw(sessionId));
    }
    cloneSessionRows(parentId: string, childId: string, throughSeq: number, initial?: IngestSessionInput): Promise<boolean> {
        return Promise.resolve(this.store.cloneSessionRows(parentId, childId, throughSeq, initial));
    }
    getMessages(sessionId: string): Promise<(MessageRow & { contentHash: string })[]> {
        return Promise.resolve(this.store.getMessages(sessionId));
    }
    getBlocks(sessionId: string): Promise<(BlockRow & { summaryHash: string; oneHash: string | null })[]> {
        return Promise.resolve(this.store.getBlocks(sessionId));
    }
    getDeadRefs(sessionId: string): Promise<{ ord: number; ref: string; refNum: number; recordedAt: number }[]> {
        return Promise.resolve(this.store.getDeadRefs(sessionId));
    }
    getRefs(sessionId: string): Promise<RefRow[]> {
        return Promise.resolve(this.store.getRefs(sessionId));
    }
    getCcr(sessionId: string): Promise<MessageContentStore | null> {
        return Promise.resolve(this.store.getCcr(sessionId));
    }
    getCcrEntries(sessionId: string): Promise<CcrEntryRow[]> {
        return Promise.resolve(this.store.getCcrEntries(sessionId));
    }
    ingestWatermark(sessionId: string): Promise<{ seq: number; tailSeqs: number[] } | null> {
        return Promise.resolve(this.store.ingestWatermark(sessionId));
    }
    tailSeqs(sessionId: string): Promise<number[] | null> {
        return Promise.resolve(this.store.tailSeqs(sessionId));
    }
    clearIngestWatermark(sessionId: string): Promise<void> {
        return Promise.resolve(this.store.clearIngestWatermark(sessionId));
    }
    resetAllIngestWatermarks(): Promise<void> {
        return Promise.resolve(this.store.resetAllIngestWatermarks());
    }
    probeIngestBoundary(sessionId: string, seq: number): Promise<{ msgId: string; contentHash: string; maxSeq: number } | null> {
        return Promise.resolve(this.store.probeIngestBoundary(sessionId, seq));
    }
    reapBlocks(sessionId: string, reapedIds: Set<string>, orphanContents: Map<string, { one: unknown; full: unknown }>): Promise<void> {
        return Promise.resolve(this.store.reapBlocks(sessionId, reapedIds, orphanContents));
    }
    archiveSession(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number }> {
        return Promise.resolve(this.store.archiveSession(sessionId, opts));
    }
    restoreArchived(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; reason?: string }> {
        return Promise.resolve(this.store.restoreArchived(sessionId, opts));
    }
    gc(opts: { archiveAfterDays: number; archiveDir: string; now?: number; vacuum?: "full" | "incremental" }): Promise<{ archived: number; contentRowsDeleted: number }> {
        return Promise.resolve(this.store.gc(opts));
    }
    contentRefCountOfBody(needle: string): Promise<number> {
        return Promise.resolve(this.store.contentRefCountOfBody(needle));
    }
    mediaRefCount(bytes: string): Promise<number> {
        return Promise.resolve(this.store.mediaRefCount(bytes));
    }
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
    }): Promise<void> {
        return Promise.resolve(this.store.insertCheckpoint(cp));
    }
    listCheckpoints(sessionId?: string): Promise<CheckpointRow[]> {
        return Promise.resolve(this.store.listCheckpoints(sessionId));
    }
    getCheckpoint(cpId: string): Promise<CheckpointRow | undefined> {
        return Promise.resolve(this.store.getCheckpoint(cpId));
    }
    checkpointState(cpId: string): Promise<{ stateJson: string; byteLen: number }> {
        return Promise.resolve(this.store.checkpointState(cpId));
    }
    deleteCheckpoint(cpId: string): Promise<boolean> {
        return Promise.resolve(this.store.deleteCheckpoint(cpId));
    }
    setSessionExt(sessionId: string, key: string, value: unknown): Promise<void> {
        return Promise.resolve(this.store.setSessionExt(sessionId, key, value));
    }
    getSessionExt(sessionId: string, key: string): Promise<unknown> {
        return Promise.resolve(this.store.getSessionExt(sessionId, key));
    }
    listSessionExt(sessionId: string): Promise<{ key: string; value: unknown; updatedAt: number }[]> {
        return Promise.resolve(this.store.listSessionExt(sessionId));
    }
    deleteSessionExt(sessionId: string, key?: string): Promise<number> {
        return Promise.resolve(this.store.deleteSessionExt(sessionId, key));
    }
    setKv(namespace: string, key: string, value: unknown): Promise<void> {
        return Promise.resolve(this.store.setKv(namespace, key, value));
    }
    getKv(namespace: string, key: string): Promise<unknown> {
        return Promise.resolve(this.store.getKv(namespace, key));
    }
    listKv(namespace?: string, keyPrefix?: string): Promise<{ namespace: string; key: string; value: unknown; updatedAt: number }[]> {
        return Promise.resolve(this.store.listKv(namespace, keyPrefix));
    }
    deleteKv(namespace: string, key?: string): Promise<number> {
        return Promise.resolve(this.store.deleteKv(namespace, key));
    }
    sessionSummaries(): Promise<SessionSummaryRow[]> {
        return Promise.resolve(this.store.sessionSummaries());
    }
    webSummaryRows(): Promise<WebSummaryRow[]> {
        return Promise.resolve(this.store.webSummaryRows());
    }
    verifyProjections(sessionId: string): Promise<{ ok: true; checks: number } | { ok: false; error: string }> {
        return Promise.resolve(this.store.verifyProjections(sessionId));
    }
    counts(): Promise<Record<string, number>> {
        return Promise.resolve(this.store.counts());
    }
    contentDedupReport(): Promise<{ rows: number; bytesTotal: number; refcounted: number }> {
        return Promise.resolve(this.store.contentDedupReport());
    }
    close(): Promise<void> {
        return Promise.resolve(this.store.close());
    }
}

/** Names that validate in configuration. `mysql` validates but does not
 *  open — see openBackend. */
const REGISTERED_BACKENDS = ["sqlite", "mysql"] as const;

export function listBackendNames(): string[] {
    return [...REGISTERED_BACKENDS];
}

/** Opens a backend by name. `mysql` resolves to MysqlBackend: `indexPath`
 *  is the DSN (mysql://user:pass@host:port/db), the pool connects lazily,
 *  and `init()` (DDL + schema stamp) must run once before first use — the
 *  contract suite does this in `before`. Unknown names throw with the valid
 *  list. Async because the mysql driver + module are dynamically imported at
 *  open time (#3388 step-2 decision; #4008: the driver stays external to the
 *  bundle and must never be statically imported). */
export async function openBackend(name: string, indexPath: string, engine?: SqliteEngineName): Promise<StorageBackend> {
    if (name === "sqlite") return SqliteBackend.open(indexPath, engine);
    if (name === "mysql") {
        if (typeof indexPath !== "string" || indexPath.trim().length === 0) {
            throw new Error(
                `[storage] backend "mysql" needs a DSN — set BILI_MYSQL_DSN or storage.mysql.dsn (mysql://user:pass@host:3306/db); runs on "sqlite" until then (#3388/#3931)`,
            );
        }
        // #4008: literal dynamic import of an EXTERNAL specifier — it survives
        // the single-file bundle as a real runtime import and resolves only
        // now, never at module load. The pool itself still opens lazily; this
        // only moves driver resolution from boot time to open time.
        let driver: Mysql2Module;
        try {
            driver = await import("mysql2/promise");
        } catch (err) {
            throw new Error(
                `[storage] mysql backend selected but the mysql2 driver cannot be loaded (${err instanceof Error ? err.message : String(err)}) — installs without a node_modules tree cannot run the mysql backend; set storage.backend="sqlite" or install with dependencies (#4008)`,
            );
        }
        const { MysqlBackend } = await import("./mysql.js");
        return new MysqlBackend(indexPath, driver);
    }
    throw new Error(`[storage] unknown backend "${name}" — valid names: ${REGISTERED_BACKENDS.join(", ")}`);
}

/** The winning tier's raw value before validation ("" when neither tier set
 *  anything). Callers that judge the SELECTION (boot notices, export's open
 *  gate) use this — by the time resolveBackendName returns, unknown names
 *  are already collapsed to sqlite and invisible to it. */
export function selectedBackendRaw(env: { BILI_STORAGE_BACKEND?: string | undefined } | undefined, file: string | undefined): string {
    const envRaw = env?.BILI_STORAGE_BACKEND;
    const fromEnv = typeof envRaw === "string" ? envRaw.trim().toLowerCase() : "";
    if (fromEnv.length > 0) return fromEnv;
    return typeof file === "string" ? file.trim().toLowerCase() : "";
}

/** env BILI_MYSQL_DSN > file storage.mysql.dsn > "" (empty = mysql cannot
 *  open; the documented error above names both knobs). */
export function resolveMysqlDsn(env: { BILI_MYSQL_DSN?: string | undefined } | undefined, file: string | undefined): string {
    const fromEnv = env?.BILI_MYSQL_DSN;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
    if (typeof file === "string" && file.trim().length > 0) return file.trim();
    return "";
}

/** env BILI_STORAGE_BACKEND > file storage.backend > "sqlite". Unknown
 *  values fall back to the default (the complaint rides the selection
 *  notice; the hard error lives at open time for the paths that open). */
export function resolveBackendName(env: { BILI_STORAGE_BACKEND?: string | undefined } | undefined, file: string | undefined): string {
    const raw = selectedBackendRaw(env, file);
    if (raw.length > 0) return (REGISTERED_BACKENDS as readonly string[]).includes(raw) ? raw : "sqlite";
    return "sqlite";
}

/** One-line notice for non-sqlite selections (surfaced by the store's boot
 *  log; undefined when the selection needs no comment). */
export function backendSelectionNotice(name: string): string | undefined {
    if (!name || name === "sqlite") return undefined;
    if ((REGISTERED_BACKENDS as readonly string[]).includes(name)) {
        if (name === "mysql") {
            return `[storage] storage.backend="mysql" rides the StorageBackend contract (#3388/#3931) — saves ingest through the async shadow queue; replicas/ext/GC/export/fork speak the async twins; SYNC reads ride the JSON envelope (sync facades miss by design); writerOff stays sqlite-only`;
        }
        return `[storage] storage.backend="${name}" is registered but not implemented — the unified store stays on "sqlite"`;
    }
    return `[storage] storage.backend="${name}" is not a registered backend (valid: ${REGISTERED_BACKENDS.join(", ")}) — using "sqlite"`;
}
