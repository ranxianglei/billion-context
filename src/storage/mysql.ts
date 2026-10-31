/**
 * MySQL backend for the storage contract (#3388 step 2, #3931).
 *
 * Implements the same StorageBackend operation surface as the sqlite
 * store, against MySQL 8.0 (mysql2 driver per the 2026-10-20 owner decision
 * — see the #3931 comment). The driver stays EXTERNAL to the bundle (#4008):
 * openBackend("mysql", dsn) loads it lazily and injects it into the
 * constructor, so boots that do not select mysql never resolve it.
 *
 * Representation discipline mirrors src/storage/schema.ts: verbatim facts
 * (payload_json / content bytes / *_json bags) are the truth; scalar
 * columns are projections. JSON columns stay LONGTEXT — MySQL's JSON type
 * normalizes key order and would break the byte-exact digest contract.
 *
 * The DDL is the v8 shape directly for fresh installs. A legacy v7 library
 * upgrades in place at init(): probe information_schema + idempotent
 * ALTERs, then a STREAMING data step under a server-side named lock —
 * identity backfill plus duplicate-row collapse, one session per
 * transaction with 500-row pages (#4666; parity with the sqlite v8
 * migration step, itself reworked for #4677's whole-table OOM class) —
 * gated on the bili_meta schema_version stamp so a crash mid-migration
 * re-runs instead of stranding legacy rows at identity='' forever. The
 * lock serializes concurrently-booting instances against the same library:
 * without it two processes would scan the same dirty groups and
 * double-delete rows / double-refund CAS refs.
 *
 * Concurrency: one mysql2 connection pool per backend instance; every
 * multi-statement operation rides a dedicated-connection transaction.
 * The CAS refcount bump is a single atomic statement (INSERT ... ON
 * DUPLICATE KEY UPDATE refcount = refcount + 1), so single-row CAS
 * discipline survives multi-writer deployments; full ingestSession
 * serialization relies on InnoDB row locks inside its transaction, which
 * matches the sqlite BEGIN IMMEDIATE discipline for the current
 * one-writer-per-session topology (see #3931 step 3 for the multi-writer
 * hardening plan).
 */

import type { Pool, PoolConnection, PoolOptions } from "mysql2/promise";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log as loggerLog } from "../logger.js";
import { sha256Hex, viewPointerSeqs } from "./store.js";
import { identityOfStoredContent } from "./identity.js";
import type { MessageContentStore } from "acp-kernel";
import type { StorageBackend, StorageReadView } from "./backend.js";
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
    SessionViewRows,
} from "./store.js";

/** The mysql2/promise driver module, injected by openBackend() at open time.
 *  THIS FILE MUST NEVER HOLD A TOP-LEVEL VALUE IMPORT OF THE DRIVER (#4008):
 *  under tsup's single-file bundle (splitting:false) any value import here
 *  hoists to the top of dist/index.js and resolves at MODULE LOAD — crashing
 *  every install without a node_modules tree with ERR_MODULE_NOT_FOUND even
 *  when sqlite is selected. Type imports erase at compile time and are safe.
 *  Same discipline as the jimp lazy load (src/image-rescale.ts, #3516). */
export type Mysql2Module = typeof import("mysql2/promise");

/** v9 (#4796): zero-ref collection index. Existing stamped-v8 libraries
 *  re-enter the probe-first DDL block below exactly once on first open;
 *  migrateV8Identities() is a no-op there (no identity='' rows left). */
const MYSQL_SCHEMA_VERSION = 9;

/** Parity constants with the sqlite v8 streaming backfill
 *  (src/storage/schema.ts, #4677): same page size, same printable absent
 *  marker. The printable form exists because node:sqlite truncates bound
 *  strings at an embedded NUL (the \u0000-shaped marker silently bound as
 *  ''); MySQL accepts either, but the STORED value must stay identical
 *  across backends so one library shape reads the same on both. */
const ABSENT_IDENTITY = "absent:";
const V8_BACKFILL_PAGE = 500;
/** Seconds each GET_LOCK attempt waits for the other instance's data step
 *  to finish before retrying — a waiter loops until it acquires the lock;
 *  the migration is resumable, so the latecomer then finds nothing left. */
const MIGRATION_LOCK_POLL_S = 30;

/** PR #4725 N3 (mirror of store.ts): covered-seq span point queries chunk the
 *  msg_id IN (…) list at the same 500 batch size for cross-backend parity. */
const SEQ_SPAN_QUERY_BATCH = 500;

/** #4796: rows per batch of gc()'s zero-ref CAS sweep (mysql counterpart of
 *  GC_ZERO_REF_BATCH_SIZE in store.ts): one giant DELETE holds every row
 *  lock and all undo until commit; LIMIT-bound autocommit batches commit
 *  independently, so a crash resumes and the lock/undo footprint stays
 *  bounded to one batch. */
const MYSQL_GC_ZERO_REF_BATCH = 2000;

/** #4796 follow-up: statement size of the lifecycle-scoped zero-ref sweep
 *  (collectZeroRefIn) — same rationale as the sqlite twin; chunked so each
 *  IN-list stays a comfortable parameter count. */
const MYSQL_ZERO_REF_SWEEP_CHUNK = 500;

/** Fresh-install DDL: the schema.ts v7 shape in MySQL dialect. LONGTEXT for
 *  every verbatim JSON/bytes column (byte-exact round-trip; the JSON type
 *  re-orders keys), BIGINT for ms-epoch timestamps and seqs, VARCHAR keys
 *  sized to their guards. No literal defaults on LONGTEXT columns (MySQL
 *  forbids them), except the five sessions json columns: expression
 *  defaults mirroring the sqlite twin's column defaults (#4924), which the
 *  fork row clone's 5-column sessions INSERT relies on. */
const MYSQL_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id        VARCHAR(255) NOT NULL PRIMARY KEY,
    parent_session_id VARCHAR(255) NULL,
    fork_point_seq    BIGINT NULL,
    protocol          VARCHAR(64) NULL,
    label             TEXT NULL,
    title             TEXT NULL,
    host_title        TEXT NULL,
    namespace         VARCHAR(64) NOT NULL DEFAULT 'proxy',
    origin            TEXT NULL,
    status            VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at        BIGINT NOT NULL,
    updated_at        BIGINT NOT NULL,
    next_block_id     BIGINT NOT NULL DEFAULT 1,
    next_run_id       BIGINT NOT NULL DEFAULT 1,
    meta_json         LONGTEXT NOT NULL DEFAULT ('{}'),
    stats_json        LONGTEXT NOT NULL DEFAULT ('{}'),
    metadata_json     LONGTEXT NOT NULL DEFAULT ('{}'),
    kstate_json       LONGTEXT NOT NULL DEFAULT ('{}'),
    tail_json         LONGTEXT NOT NULL DEFAULT ('{}'),
    ccr_json          LONGTEXT NULL,
    last_ingested_seq BIGINT NULL,
    orphans_json      LONGTEXT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS content (
    hash     VARCHAR(64) NOT NULL PRIMARY KEY,
    byte_len BIGINT NOT NULL,
    refcount BIGINT NOT NULL DEFAULT 0,
    algo     VARCHAR(16) NOT NULL DEFAULT 'sha256',
    bytes    LONGTEXT NOT NULL,
    KEY idx_content_refcount (refcount)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    session_id   VARCHAR(255) NOT NULL,
    seq          BIGINT NOT NULL,
    msg_id       VARCHAR(255) NOT NULL,
    ref          VARCHAR(64) NULL,
    ref_num      BIGINT NULL,
    role         VARCHAR(64) NOT NULL,
    kind         VARCHAR(64) NOT NULL DEFAULT 'message',
    content_hash VARCHAR(64) NOT NULL,
    identity     VARCHAR(64) NOT NULL DEFAULT '',
    retired_at   BIGINT NULL,
    PRIMARY KEY (session_id, seq),
    UNIQUE KEY uq_messages_identity (session_id, msg_id, content_hash),
    KEY idx_messages_session (session_id, seq),
    KEY idx_messages_msg_id (session_id, msg_id),
    KEY idx_messages_identity (session_id, msg_id, identity)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS blocks (
    block_id            VARCHAR(64) NOT NULL,
    session_id          VARCHAR(255) NOT NULL,
    ord                 BIGINT NOT NULL,
    start_seq           BIGINT NOT NULL,
    end_seq             BIGINT NOT NULL,
    start_ref           BIGINT NULL,
    end_ref             BIGINT NULL,
    tier                BIGINT NOT NULL,
    summary_hash        VARCHAR(64) NOT NULL,
    one_hash            VARCHAR(64) NULL,
    supersedes_block_id VARCHAR(64) NULL,
    active              TINYINT NOT NULL DEFAULT 1,
    created_at          BIGINT NOT NULL,
    covered_hash        VARCHAR(64) NOT NULL,
    payload_json        LONGTEXT NOT NULL,
    PRIMARY KEY (session_id, block_id),
    KEY idx_blocks_session (session_id, ord)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS dead_refs (
    session_id  VARCHAR(255) NOT NULL,
    ord         BIGINT NOT NULL,
    ref         VARCHAR(64) NOT NULL,
    ref_num     BIGINT NOT NULL,
    recorded_at BIGINT NOT NULL,
    PRIMARY KEY (session_id, ord),
    KEY idx_dead_refs_session (session_id, ord)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS refs (
    session_id VARCHAR(255) NOT NULL,
    ord        BIGINT NOT NULL,
    raw_id     VARCHAR(255) NOT NULL,
    ref        VARCHAR(64) NOT NULL,
    ref_num    BIGINT NULL,
    PRIMARY KEY (session_id, ord),
    UNIQUE KEY uq_refs_raw (session_id, raw_id),
    KEY idx_refs_session (session_id, ord)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS checkpoints (
    cp_id          VARCHAR(255) NOT NULL PRIMARY KEY,
    session_id     VARCHAR(255) NOT NULL,
    seq_at         BIGINT NOT NULL,
    block_set_hash VARCHAR(64) NOT NULL,
    kind           VARCHAR(16) NOT NULL,
    created_at     BIGINT NOT NULL,
    pinned         TINYINT NOT NULL DEFAULT 0,
    label          TEXT NULL,
    state_hash     VARCHAR(64) NOT NULL,
    KEY idx_checkpoints_session (session_id, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS ccr_entries (
    session_id  VARCHAR(255) NOT NULL,
    ord         BIGINT NOT NULL,
    ccr_key     VARCHAR(255) NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    PRIMARY KEY (session_id, ord)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
    namespace       VARCHAR(64) NOT NULL,
    conversation_id VARCHAR(255) NOT NULL,
    session_id      VARCHAR(255) NOT NULL,
    claimed_at      BIGINT NOT NULL,
    PRIMARY KEY (namespace, conversation_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS session_ext (
    session_id VARCHAR(255) NOT NULL,
    ext_key    VARCHAR(256) NOT NULL,
    value_json LONGTEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (session_id, ext_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS kv_store (
    namespace  VARCHAR(256) NOT NULL,
    kv_key     VARCHAR(256) NOT NULL,
    value_json LONGTEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, kv_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS message_media (
    session_id VARCHAR(255) NOT NULL,
    seq        BIGINT NOT NULL,
    media_hash VARCHAR(64) NOT NULL,
    PRIMARY KEY (session_id, seq, media_hash)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS bili_meta (
    meta_key   VARCHAR(64) NOT NULL PRIMARY KEY,
    meta_value VARCHAR(256) NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
`;

type Row = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nullableNum(v: unknown): number | null {
    return v === null || v === undefined ? null : num(v);
}

function str(v: unknown): string {
    return typeof v === "string" ? v : String(v ?? "");
}

function nullableStr(v: unknown): string | null {
    return v === null || v === undefined ? null : str(v);
}

export class MysqlBackend implements StorageBackend {
    private readonly pool: Pool;

    constructor(dsnOrOpts: string | PoolOptions, driver: Mysql2Module) {
        this.pool = typeof dsnOrOpts === "string"
            ? driver.createPool(dsnOrOpts)
            : driver.createPool(dsnOrOpts);
    }

    /** Applies the DDL + schema-version stamp. Idempotent. */
    async init(): Promise<void> {
        const conn = await this.pool.getConnection();
        try {
            const multi = MYSQL_DDL.trim();
            for (const stmt of multi.split(";")) {
                const s = stmt.trim();
                if (s.length === 0) continue;
                await conn.query(s);
            }
            const [metaRows] = (await conn.query(
                "SELECT meta_value FROM bili_meta WHERE meta_key = 'schema_version'",
            )) as unknown as Row[][];
            // meta_value is VARCHAR(256): the driver hands the stamp back as a
            // string, so the number-only num() coercion would yield 0 and fire
            // the v8 data step on EVERY boot instead of exactly once (#4666).
            // Parse the decimal string explicitly.
            const rawStamp = (metaRows[0] as Row | undefined)?.meta_value;
            const parsedStamp = Number(rawStamp);
            const current = Number.isFinite(parsedStamp) ? parsedStamp : 0;
            if (current < MYSQL_SCHEMA_VERSION) {
                // #4390 v8: position-independent identity + historian
                // tombstones. CREATE TABLE IF NOT EXISTS does not upgrade an
                // existing v7 table — probe information_schema and ALTER
                // idempotently (MySQL has no ADD COLUMN IF NOT EXISTS). The
                // data step below is gated on the STAMP, not column presence:
                // a crash between these DDLs and the backfill must re-run on
                // the next boot instead of leaving legacy rows at
                // identity='' forever (#4666). Every step is idempotent, so a
                // partial re-run converges.
                const [cols] = (await conn.query(
                    "SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'",
                )) as unknown as Row[][];
                const have = new Set((cols as unknown as { col?: unknown }[]).map((r) => String(r.col ?? "")));
                if (!have.has("identity")) {
                    await conn.query("ALTER TABLE messages ADD COLUMN identity VARCHAR(64) NOT NULL DEFAULT ''");
                    await conn.query("ALTER TABLE messages ADD INDEX idx_messages_identity (session_id, msg_id, identity)");
                }
                if (!have.has("retired_at")) {
                    await conn.query("ALTER TABLE messages ADD COLUMN retired_at BIGINT NULL");
                }
                // #4796 (v9): zero-ref collection index — gc()'s sweep and the
                // dry-run count address content BY refcount; without this index
                // every run full-scans the CAS table (field: 766K rows / ~20 GB).
                // Same probe-first pattern as the v8 columns above; fresh
                // installs pick the key up from the CREATE TABLE DDL.
                const [idxRows] = (await conn.query(
                    "SELECT INDEX_NAME AS idx FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content'",
                )) as unknown as Row[][];
                const haveIdx = new Set((idxRows as unknown as { idx?: unknown }[]).map((r) => String(r.idx ?? "")));
                if (!haveIdx.has("idx_content_refcount")) {
                    await conn.query("ALTER TABLE content ADD INDEX idx_content_refcount (refcount)");
                }
                // MySQL DDL commits implicitly, so the ALTERs above are
                // already durable when the data step starts. It streams one
                // session per transaction under a cross-process named lock
                // (see migrateV8Identities) and either fully lands or resumes
                // from the committed sessions on the next boot.
                await this.migrateV8Identities();
            }
            // Stamp advances but never downgrades: a future library stamped
            // higher than this build keeps its stamp.
            await conn.query(
                "INSERT INTO bili_meta (meta_key, meta_value) VALUES ('schema_version', ?) " +
                    "ON DUPLICATE KEY UPDATE meta_value = GREATEST(CAST(meta_value AS UNSIGNED), CAST(? AS UNSIGNED))",
                [String(MYSQL_SCHEMA_VERSION), String(MYSQL_SCHEMA_VERSION)],
            );
        } finally {
            conn.release();
        }
    }

    /** The v8 data step (#4666; parity with schema.ts' migrateV8Identities,
     *  the #4677 rework): stream unbackfilled messages one session per
     *  transaction, 500-row seq-cursor pages — memory holds one page window
     *  plus one session's keeper keys, never the library's bytes, so
     *  multi-GB libraries upgrade without OOMing the process (#4806). Within
     *  each session's ordered scan the FIRST arrival of a (msg_id, identity)
     *  key is kept and later generations dropped, handing their media
     *  mappings + message rows + CAS refs back (delete referencing rows
     *  FIRST — the #4242 discipline; the refcount > 0 floor mirrors
     *  releaseContent so an already-corrupt ledger cannot go negative — gc
     *  collects the <= 0 rows). A crash between sessions leaves the done
     *  sessions committed and the stamp still below v8, so the next boot
     *  skips them (no identity='' rows left) and resumes. Rows whose content
     *  bytes are missing from the CAS get the ABSENT marker so their session
     *  terminates instead of rescanning forever — joins treat it exactly
     *  like the pre-v8 '' leftover.
     *
     *  Runs under a server-side NAMED LOCK: two bili processes booting
     *  against the same library concurrently would otherwise both scan the
     *  same dirty groups and double-delete rows / double-refund refs (the
     *  UNIQUE(session_id, msg_id, content_hash) key cannot catch
     *  different-hash generations of one logical message). Named locks are
     *  connection-scoped and released automatically when the connection
     *  dies, so a crashed migrator cannot strand the lock; the name is
     *  scoped to this database via DATABASE() so unrelated libraries on the
     *  same server do not serialize against each other. */
    private async migrateV8Identities(): Promise<void> {
        const conn = await this.pool.getConnection();
        let locked = false;
        try {
            for (;;) {
                const [rows] = (await conn.query(
                    "SELECT GET_LOCK(CONCAT('bili_v8_upgrade_', DATABASE()), ?) AS ok",
                    [MIGRATION_LOCK_POLL_S],
                )) as unknown as Row[][];
                // GET_LOCK answers 1 (acquired) / 0 (timed out) / NULL (error);
                // the driver may deliver the integer as a string, so normalize
                // before comparing — NULL must fail loudly, not loop forever.
                const rawOk = (rows[0] as Row | undefined)?.ok;
                if (rawOk === null || rawOk === undefined) {
                    throw new Error(`mysql schema v8 upgrade: GET_LOCK failed (${String(rawOk)})`);
                }
                const ok = Number(rawOk);
                if (Number.isNaN(ok)) {
                    throw new Error(`mysql schema v8 upgrade: GET_LOCK returned ${String(rawOk)}`);
                }
                if (ok === 1) {
                    locked = true;
                    break;
                }
                loggerLog(
                    "info",
                    "[storage] mysql schema v8 upgrade: another instance holds the migration lock — waiting for it to finish",
                );
            }
            const [sessRows] = (await conn.query(
                "SELECT DISTINCT session_id FROM messages WHERE identity = '' ORDER BY session_id",
            )) as unknown as Row[][];
            const total = (sessRows as Row[]).length;
            if (total === 0) return;
            loggerLog(
                "info",
                `[storage] mysql schema v8 migration: streaming identity backfill over ${total} session(s), one transaction per session (resumable — committed sessions are not reprocessed after a crash)`,
            );
            let done = 0;
            try {
                for (const sRow of sessRows as Row[]) {
                    const sid = str(sRow.session_id);
                    const seen = new Set<string>();
                    const updates: { seq: number; identity: string }[] = [];
                    const drops: { seq: number; contentHash: string }[] = [];
                    let cursor = -1;
                    for (;;) {
                        const [pageRows] = (await conn.query(
                            "SELECT m.seq AS seq, m.msg_id AS msg_id, m.content_hash AS content_hash, c.bytes AS body " +
                                "FROM messages m LEFT JOIN content c ON c.hash = m.content_hash " +
                                "WHERE m.session_id = ? AND m.identity = '' AND m.seq > ? ORDER BY m.seq LIMIT ?",
                            [sid, cursor, V8_BACKFILL_PAGE],
                        )) as unknown as Row[][];
                        const rows = pageRows as Row[];
                        if (rows.length === 0) break;
                        for (const r of rows) {
                            cursor = num(r.seq);
                            const body = r.body;
                            const identity = body == null
                                ? ABSENT_IDENTITY
                                : identityOfStoredContent(typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8"));
                            const key = `${str(r.msg_id)}\u0000${identity}`;
                            if (seen.has(key)) drops.push({ seq: num(r.seq), contentHash: str(r.content_hash) });
                            else {
                                seen.add(key);
                                updates.push({ seq: num(r.seq), identity });
                            }
                        }
                        if (rows.length < V8_BACKFILL_PAGE) break;
                    }
                    // One transaction per session, on THIS connection — the
                    // named lock lives here, and this.tx's pool checkout
                    // cannot share a connection mid-transaction.
                    await conn.beginTransaction();
                    try {
                        for (const u of updates) {
                            await conn.query("UPDATE messages SET identity = ? WHERE session_id = ? AND seq = ?", [u.identity, sid, u.seq]);
                        }
                        for (const d of drops) {
                            const [media] = (await conn.query(
                                "SELECT media_hash FROM message_media WHERE session_id = ? AND seq = ?",
                                [sid, d.seq],
                            )) as unknown as Row[][];
                            for (const mm of media as Row[]) {
                                await conn.query("UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0", [str(mm.media_hash)]);
                            }
                            await conn.query("DELETE FROM message_media WHERE session_id = ? AND seq = ?", [sid, d.seq]);
                            await conn.query("DELETE FROM messages WHERE session_id = ? AND seq = ?", [sid, d.seq]);
                            await conn.query("UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0", [d.contentHash]);
                        }
                        await conn.commit();
                    } catch (err) {
                        try {
                            await conn.rollback();
                        } catch {
                            /* connection-level failure — surfaces below */
                        }
                        throw err;
                    }
                    done += 1;
                    if (done % 100 === 0 || done === total) {
                        loggerLog("info", `[storage] mysql schema v8 migration: ${done}/${total} session(s) backfilled`);
                    }
                }
            } catch (err) {
                loggerLog(
                    "error",
                    `[storage] mysql schema v8 migration failed after ${done}/${total} session(s) — committed sessions keep their progress and the migration resumes automatically on the next open (no data loss, no need to touch the schema_version stamp by hand). Error: ${String(err)}`,
                );
                throw err;
            }
            // #4924 CI: the fork row clone's 5-column sessions INSERT relies on
            // column defaults exactly like the sqlite twin (schema.ts gives the
            // json columns DEFAULT '{}') — but tables created by the pre-#4924
            // DDL have none, so MySQL strict mode rejected the clone with
            // ER_NO_DEFAULT_FOR_FIELD. Align existing tables idempotently
            // (CREATE TABLE IF NOT EXISTS never upgrades them).
            const [scols] = (await conn.query(
                "SELECT COLUMN_NAME AS col, COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'",
            )) as unknown as Row[][];
            const sdflt = new Map((scols as unknown as { col?: unknown; dflt?: unknown }[]).map((r) => [String(r.col ?? ""), r.dflt]));
            for (const col of ["meta_json", "stats_json", "metadata_json", "kstate_json", "tail_json"]) {
                if (sdflt.has(col) && sdflt.get(col) === null) {
                    await conn.query(`ALTER TABLE sessions MODIFY COLUMN ${col} LONGTEXT NOT NULL DEFAULT ('{}')`);
                }
            }
        } finally {
            if (locked) {
                try {
                    await conn.query("SELECT RELEASE_LOCK(CONCAT('bili_v8_upgrade_', DATABASE()))");
                } catch {
                    /* best-effort — the lock auto-releases when the connection closes */
                }
            }
            conn.release();
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    /** Serialized transaction on a dedicated connection. */
    private async tx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            const out = await fn(conn);
            await conn.commit();
            return out;
        } catch (err) {
            try {
                await conn.rollback();
            } catch {
                /* connection-level failure — release below handles it */
            }
            throw err;
        } finally {
            conn.release();
        }
    }

    // --- content CAS -------------------------------------------------------

    /** Atomic refcount-aware CAS insert-or-bump. */
    private async putContent(c: PoolConnection | Pool, content: string, precomputedHash?: string): Promise<string> {
        const bytes = Buffer.from(content, "utf8");
        const hash = precomputedHash ?? sha256Hex(bytes);
        await c.query(
            "INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?) " +
                "ON DUPLICATE KEY UPDATE refcount = refcount + 1",
            [hash, bytes.byteLength, content],
        );
        return hash;
    }

    private async releaseContent(c: PoolConnection | Pool, hash: string | null): Promise<void> {
        if (!hash) return;
        // #3987 / #4242: delete-on-zero, same discipline as the sqlite twin —
        // orphans must not structurally accumulate on either backend.
        await c.query("UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0", [hash]);
        await c.query("DELETE FROM content WHERE hash = ? AND refcount <= 0", [hash]);
    }

    private async getContent(c: PoolConnection | Pool, hash: string): Promise<string | null> {
        const [rows] = await c.query("SELECT bytes FROM content WHERE hash = ?", [hash]);
        const list = rows as Row[];
        if (list.length === 0) return null;
        return str(list[0].bytes);
    }

    // --- ingest ------------------------------------------------------------

    async ingestSession(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean },
    ): Promise<boolean> {
        return this.ingestSessionOn(input, delta, opts);
    }

    private async ingestSessionOn(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean },
        connection?: PoolConnection,
    ): Promise<boolean> {
        const s = { ...input.session, tailJson: input.session.tailJson };
        const ingest = async (c: PoolConnection): Promise<boolean> => {
            let messages: MessageRow[];
            let watermark: number | null;
            if (delta) {
                const probe = await this.probeIngestBoundaryOn(c, s.sessionId, delta.trustedSeq);
                if (!probe || probe.msgId !== delta.boundaryMsgId || probe.contentHash !== delta.boundaryHash) {
                    return false;
                }
                for (const m of input.messages) {
                    if (!m.contentHash) return false;
                    // #4390: identity join; retired rows count as existing
                    // (rewind-redo falls back to the full path).
                    const [hit] = (await c.query(
                        "SELECT 1 FROM messages WHERE session_id = ? AND msg_id = ? AND identity = ? LIMIT 1",
                        [s.sessionId, m.msgId, m.identity ?? identityOfStoredContent(m.content)],
                    )) as unknown as Row[][];
                    if (hit.length > 0) return false;
                }
                messages = input.messages.map((m, i) => ({ ...m, seq: probe.maxSeq + 1 + i }));
                const tail = JSON.parse(s.tailJson) as { tailSeqs?: number[] | null };
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
                // Remapping mutates tailJson; persist the same session object
                // it updates, not the caller's separate plan-space snapshot.
                const full = await this.remapPlanToAbsoluteOn(c, { ...input, session: s });
                messages = full.messages;
                watermark = full.watermark;
                if (opts?.completeLog === true && !(await this.hasLaneExtOn(c, s.sessionId))) {
                    const incomingIds = new Set<string>();
                    for (const m of messages) {
                        incomingIds.add(`${m.msgId}\u0000${m.identity ?? identityOfStoredContent(m.content)}`);
                    }
                    const staleRows = (await c.query(
                        "SELECT seq, msg_id, identity, retired_at FROM messages WHERE session_id = ?",
                        [s.sessionId],
                    )) as unknown as Row[][];
                    for (const row of staleRows[0]) {
                        if (incomingIds.has(`${row.msg_id}\u0000${row.identity}`)) {
                            // #4390 rewind-redo: reactivate the tombstone in place.
                            if (row.retired_at !== null && row.retired_at !== undefined) {
                                await c.query("UPDATE messages SET retired_at = NULL WHERE session_id = ? AND seq = ?", [
                                    s.sessionId,
                                    num(row.seq),
                                ]);
                            }
                            continue;
                        }
                        // #4390 historian sweep: retire, don't delete —
                        // TEXT CAS refs stay owned by the retired row; MEDIA
                        // refs release (#4506 — same rationale as sqlite twin).
                        await c.query(
                            "UPDATE messages SET retired_at = ? WHERE session_id = ? AND seq = ? AND retired_at IS NULL",
                            [Date.now(), s.sessionId, num(row.seq)],
                        );
                        const retiredMedia = (await c.query(
                            "SELECT media_hash FROM message_media WHERE session_id = ? AND seq = ?",
                            [s.sessionId, num(row.seq)],
                        )) as unknown as Row[][];
                        await c.query("DELETE FROM message_media WHERE session_id = ? AND seq = ?", [s.sessionId, num(row.seq)]);
                        for (const rm of retiredMedia[0]) await this.releaseContent(c, String(rm.media_hash));
                    }
                }
            }
            // Preserve the established lineage as a pair. MySQL evaluates
            // assignments left-to-right: inspect the OLD parent for the fork
            // point before assigning the parent, or first-time lineage loses
            // its fork point. Later metadata cannot reparent a cloned child.
            await c.query(
                `INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin,
                   status, created_at, updated_at, next_block_id, next_run_id,
                   meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   fork_point_seq = IF(parent_session_id IS NULL, VALUES(fork_point_seq), fork_point_seq),
                   parent_session_id = COALESCE(parent_session_id, VALUES(parent_session_id)),
                   protocol = VALUES(protocol),
                   label = VALUES(label),
                   title = VALUES(title),
                   host_title = VALUES(host_title),
                   namespace = VALUES(namespace),
                   origin = VALUES(origin),
                   status = VALUES(status),
                   updated_at = VALUES(updated_at),
                   next_block_id = VALUES(next_block_id),
                   next_run_id = VALUES(next_run_id),
                   meta_json = VALUES(meta_json),
                   stats_json = VALUES(stats_json),
                   metadata_json = VALUES(metadata_json),
                   kstate_json = VALUES(kstate_json),
                   tail_json = VALUES(tail_json),
                   ccr_json = VALUES(ccr_json),
                   last_ingested_seq = VALUES(last_ingested_seq)`,
                [
                    s.sessionId,
                    s.parentSessionId ?? null,
                    s.forkPointSeq ?? null,
                    s.protocol ?? null,
                    s.label ?? null,
                    s.title ?? null,
                    s.hostTitle ?? null,
                    s.namespace ?? "proxy",
                    s.origin ?? null,
                    s.status ?? "active",
                    s.createdAt,
                    s.updatedAt,
                    s.nextBlockId,
                    s.nextRunId,
                    s.metaJson,
                    s.statsJson,
                    s.metadataJson,
                    s.kstateJson,
                    s.tailJson,
                    s.ccrJson ?? null,
                    watermark,
                ],
            );
            await c.query(
                "INSERT IGNORE INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES (?, ?, ?, ?)",
                [s.namespace ?? "proxy", s.sessionId, s.sessionId, s.updatedAt],
            );
            for (const m of messages) {
                const hash = await this.putContent(c, m.content, m.contentHash);
                const [res] = (await c.query(
                    "INSERT IGNORE INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [s.sessionId, m.seq, m.msgId, m.ref, m.refNum, m.role, m.kind, hash, m.identity ?? identityOfStoredContent(m.content)],
                )) as unknown as [{ affectedRows: number }, unknown];
                if (res.affectedRows === 0) {
                    await this.releaseContent(c, hash);
                    // #4506: tombstone reactivation — restore media mappings
                    // + refcounts the retire released (idempotent upsert).
                    if (m.media && m.media.length > 0) {
                        for (const md of m.media) {
                            await this.putContent(c, md.bytes, md.hash);
                            const [mm] = (await c.query(
                                "INSERT IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)",
                                [s.sessionId, m.seq, md.hash],
                            )) as unknown as [{ affectedRows: number }, unknown];
                            if (mm.affectedRows === 0) await this.releaseContent(c, md.hash);
                        }
                    }
                } else if (m.media && m.media.length > 0) {
                    for (const md of m.media) {
                        await this.putContent(c, md.bytes, md.hash);
                        const [mm] = (await c.query(
                            "INSERT IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)",
                            [s.sessionId, m.seq, md.hash],
                        )) as unknown as [{ affectedRows: number }, unknown];
                        if (mm.affectedRows === 0) await this.releaseContent(c, md.hash);
                    }
                }
            }
            const incomingBlockIds = new Set(input.blocks.map((b) => b.blockId));
            const staleBlocks = (await c.query(
                "SELECT block_id, summary_hash, one_hash FROM blocks WHERE session_id = ?",
                [s.sessionId],
            )) as unknown as Row[][];
            for (const stale of staleBlocks[0]) {
                if (incomingBlockIds.has(str(stale.block_id))) continue;
                await this.releaseContent(c, str(stale.summary_hash));
                if (stale.one_hash !== null && stale.one_hash !== undefined) await this.releaseContent(c, str(stale.one_hash));
                await c.query("DELETE FROM blocks WHERE session_id = ? AND block_id = ?", [s.sessionId, stale.block_id]);
            }
            // #4316 layer 3 (mirror of store.ts): resolve coverage to canonical
            // seq bounds from the append-only transcript; unresolvable stores
            // the -1 "no claim" sentinel (PR #4725 N1) — a [0,0] would pass
            // the #4608 IF(>=0) guard and overwrite real bounds with a bogus
            // claim over seq 0. Point query over the covered ids only
            // (PR #4725 N3): a full-session scan taxed every save.
            const seqSpanById = new Map<string, [number, number]>();
            if (input.blocks.length > 0) {
                const wanted = new Set<string>();
                for (const b of input.blocks) {
                    try {
                        const cov = JSON.parse(b.payloadJson) as { effectiveMessageIds?: string[]; directMessageIds?: string[] };
                        for (const id of [...(cov.effectiveMessageIds ?? []), ...(cov.directMessageIds ?? [])]) wanted.add(id);
                    } catch { /* malformed payload: no covered ids to resolve */ }
                }
                const wantedIds = Array.from(wanted);
                for (let i = 0; i < wantedIds.length; i += SEQ_SPAN_QUERY_BATCH) {
                    const ids = wantedIds.slice(i, i + SEQ_SPAN_QUERY_BATCH);
                    // LIVE rows only (mirror of store.ts): block bounds describe
                    // the CURRENT replay — getMessages filters retired rows, so
                    // a tombstoned generation must never widen the stored span.
                    // No live rows for a covered id → -1 sentinel → the upsert's
                    // IF(VALUES(start_seq)>=0,...) preserves stored bounds (#4608).
                    const spanRows = (await c.query(
                        `SELECT msg_id, seq FROM messages WHERE session_id = ? AND msg_id IN (${ids.map(() => "?").join(", ")}) AND retired_at IS NULL`,
                        [s.sessionId, ...ids],
                    )) as unknown as Row[][];
                    for (const r of spanRows[0]) {
                        const msgId = str(r.msg_id);
                        const seq = Number(r.seq);
                        const cur = seqSpanById.get(msgId);
                        if (!cur) seqSpanById.set(msgId, [seq, seq]);
                        else {
                            if (seq < cur[0]) cur[0] = seq;
                            if (seq > cur[1]) cur[1] = seq;
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
                const summaryHash = await this.putContent(c, b.summary);
                const oneHash = b.one === null ? null : await this.putContent(c, b.one);
                const [existingRows] = (await c.query(
                    "SELECT summary_hash, one_hash FROM blocks WHERE session_id = ? AND block_id = ?",
                    [s.sessionId, b.blockId],
                )) as unknown as Row[][];
                const existing = existingRows[0];
                if (existing) {
                    if (str(existing.summary_hash) === summaryHash) await this.releaseContent(c, summaryHash);
                    else await this.releaseContent(c, str(existing.summary_hash));
                    if (existing.one_hash !== null && existing.one_hash !== undefined) {
                        const exOne = str(existing.one_hash);
                        if (exOne === oneHash && oneHash !== null) await this.releaseContent(c, oneHash);
                        else await this.releaseContent(c, exOne);
                    }
                }
                await c.query(
                    `INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier,
                       summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       ord = VALUES(ord),
                        // #4608: keep durable interval evidence when a later batch can no
                       // longer re-derive it (post-fold client resends carry no covered raws)
                       start_seq = IF(VALUES(start_seq) >= 0, VALUES(start_seq), start_seq),
                       end_seq = IF(VALUES(end_seq) >= 0, VALUES(end_seq), end_seq),
                       start_ref = VALUES(start_ref), end_ref = VALUES(end_ref), tier = VALUES(tier),
                       summary_hash = VALUES(summary_hash), one_hash = VALUES(one_hash),
                       supersedes_block_id = VALUES(supersedes_block_id), active = VALUES(active),
                       created_at = VALUES(created_at), covered_hash = VALUES(covered_hash),
                       payload_json = VALUES(payload_json)`,
                    [
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
                    ],
                );
            }
            await c.query("DELETE FROM dead_refs WHERE session_id = ? AND ord >= ?", [s.sessionId, input.deadRefs.length]);
            for (const d of input.deadRefs) {
                await c.query(
                    "INSERT INTO dead_refs (session_id, ord, ref, ref_num, recorded_at) VALUES (?, ?, ?, ?, ?) " +
                        "ON DUPLICATE KEY UPDATE ref = VALUES(ref), ref_num = VALUES(ref_num), recorded_at = VALUES(recorded_at)",
                    [s.sessionId, d.ord, d.ref, d.refNum, d.recordedAt],
                );
            }
            await c.query("DELETE FROM refs WHERE session_id = ?", [s.sessionId]);
            for (const r of input.refs) {
                await c.query(
                    "INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?) " +
                        "ON DUPLICATE KEY UPDATE ord = VALUES(ord), ref = VALUES(ref), ref_num = VALUES(ref_num)",
                    [s.sessionId, r.ord, r.rawId, r.ref, r.refNum],
                );
            }
            const oldCcr = (await c.query(
                "SELECT content_hash FROM ccr_entries WHERE session_id = ?",
                [s.sessionId],
            )) as unknown as Row[][];
            for (const row of oldCcr[0]) await this.releaseContent(c, str(row.content_hash));
            await c.query("DELETE FROM ccr_entries WHERE session_id = ?", [s.sessionId]);
            for (const e of input.ccrEntries) {
                const hash = await this.putContent(c, e.content);
                await c.query(
                    "INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)",
                    [s.sessionId, e.ord, e.key, hash],
                );
            }
            return true;
        };
        return connection ? ingest(connection) : this.tx(ingest);
    }

    private async hasLaneExtOn(c: PoolConnection, sessionId: string): Promise<boolean> {
        const [rows] = (await c.query(
            "SELECT 1 FROM session_ext WHERE session_id = ? AND ext_key LIKE 'inc:%' LIMIT 1",
            [sessionId],
        )) as unknown as Row[][];
        return rows.length > 0;
    }

    private async remapPlanToAbsoluteOn(
        c: PoolConnection,
        input: IngestSessionInput,
    ): Promise<{ messages: MessageRow[]; watermark: number | null }> {
        const s = input.session;
        const [rows] = (await c.query(
            "SELECT seq, msg_id, identity, content_hash, retired_at FROM messages WHERE session_id = ?",
            [s.sessionId],
        )) as unknown as Row[][];
        const seqByIdentity = new Map<string, number>();
        const hashBySeq = new Map<number, string>();
        const retiredSeqs: number[] = [];
        let nextSeq = 0;
        for (const row of rows) {
            // #4390: identity join — position-independent; retired rows keep
            // claiming their seq until reactivation clears the tombstone.
            if (row.retired_at !== null && row.retired_at !== undefined) retiredSeqs.push(num(row.seq));
            seqByIdentity.set(`${row.msg_id}\u0000${row.identity}`, num(row.seq));
            hashBySeq.set(num(row.seq), str(row.content_hash));
            if (num(row.seq) + 1 > nextSeq) nextSeq = num(row.seq) + 1;
        }
        const planToAbs = new Map<number, number>();
        const repairs: { seq: number; msgId: string; from: string; to: string; content: string }[] = [];
        const messages = input.messages.map((m) => {
            const key = `${m.msgId}\u0000${m.identity ?? identityOfStoredContent(m.content)}`;
            let abs = seqByIdentity.get(key);
            if (abs === undefined) {
                abs = nextSeq++;
                seqByIdentity.set(key, abs);
            } else {
                // #4390 review: same semantics as the sqlite lane — an
                // identity match with changed bytes must adopt the fresher
                // bytes at the same seq (stale-wireIndex parity drift and
                // CAS-corruption healing), never keep the stored generation.
                const fresh = m.contentHash ?? sha256Hex(m.content);
                const stored = hashBySeq.get(abs);
                if (stored !== undefined && stored !== fresh) repairs.push({ seq: abs, msgId: m.msgId, from: stored, to: fresh, content: m.content });
            }
            planToAbs.set(m.seq, abs);
            return { ...m, seq: abs };
        });
        for (const r of repairs) {
            // #4793: mirror of the sqlite lane — a sibling row may already hold
            // the target bytes for this msg_id (old generation stamped EMPTY
            // identity by a pre-#4390 build, or two generations of one edited
            // message). Same content_hash ⇒ same CAS blob ⇒ retiring it loses
            // nothing; otherwise the UPDATE below throws UNIQUE and three
            // throws trip the shadow's process-wide disable. A retired
            // duplicate still occupies the triple (constraint is not partial)
            // and is byte-identical, so it is dropped outright.
            await c.query(
                "UPDATE messages SET retired_at = ? WHERE session_id = ? AND msg_id = ? AND content_hash = ? AND seq <> ? AND retired_at IS NULL",
                [Date.now(), s.sessionId, r.msgId, r.to, r.seq],
            );
            const [leftovers] = (await c.query(
                "SELECT seq FROM messages WHERE session_id = ? AND msg_id = ? AND content_hash = ? AND seq <> ? AND retired_at IS NOT NULL",
                [s.sessionId, r.msgId, r.to, r.seq],
            )) as unknown as Row[][];
            for (const l of leftovers) {
                const [lMedia] = (await c.query(
                    "SELECT media_hash FROM message_media WHERE session_id = ? AND seq = ?",
                    [s.sessionId, num(l.seq)],
                )) as unknown as Row[][];
                await c.query("DELETE FROM message_media WHERE session_id = ? AND seq = ?", [s.sessionId, num(l.seq)]);
                await c.query("DELETE FROM messages WHERE session_id = ? AND seq = ?", [s.sessionId, num(l.seq)]);
                // Per-row refcount release, mirroring the SQLite twin: the
                // deleted row owned one ref on r.to and each mapping row one
                // on its media hash — skip this and the blobs are permanently
                // over-counted (zero-ref GC can never reclaim them).
                await this.releaseContent(c, r.to);
                for (const lm of lMedia) await this.releaseContent(c, String(lm.media_hash));
            }
            await this.putContent(c, r.content, r.to);
            await c.query("UPDATE messages SET content_hash = ? WHERE session_id = ? AND seq = ?", [r.to, s.sessionId, r.seq]);
            await this.releaseContent(c, r.from);
        }
        // #4390 rewind-redo: reactivate in place (no duplicate row).
        for (const seq of retiredSeqs) {
            if (messages.some((m) => m.seq === seq)) {
                await c.query("UPDATE messages SET retired_at = NULL WHERE session_id = ? AND seq = ?", [s.sessionId, seq]);
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

    private async probeIngestBoundaryOn(
        c: PoolConnection,
        sessionId: string,
        seq: number,
    ): Promise<{ msgId: string; contentHash: string; maxSeq: number } | null> {
        const [rows] = (await c.query(
            "SELECT msg_id, content_hash FROM messages WHERE session_id = ? AND seq = ?",
            [sessionId, seq],
        )) as unknown as Row[][];
        if (rows.length === 0) return null;
        const [maxRows] = (await c.query(
            "SELECT MAX(seq) AS m FROM messages WHERE session_id = ?",
            [sessionId],
        )) as unknown as Row[][];
        const m = maxRows[0]?.m;
        return { msgId: str(rows[0].msg_id), contentHash: str(rows[0].content_hash), maxSeq: m === null || m === undefined ? -1 : num(m) };
    }

    async sessionCounters(sessionId: string): Promise<{ requests: number; nextBlockId: number } | null> {
        const [rows] = (await this.pool.query(
            "SELECT next_block_id, stats_json FROM sessions WHERE session_id = ?",
            [sessionId],
        )) as unknown as Row[][];
        if (rows.length === 0) return null;
        try {
            const stats = JSON.parse(str(rows[0].stats_json)) as { requests?: unknown };
            return {
                requests: typeof stats.requests === "number" ? stats.requests : 0,
                nextBlockId: num(rows[0].next_block_id),
            };
        } catch {
            return null;
        }
    }

    async sessionUpdatedAt(sessionId: string): Promise<number | null> {
        const [rows] = (await this.pool.query(
            "SELECT updated_at FROM sessions WHERE session_id = ?",
            [sessionId],
        )) as unknown as Row[][];
        return rows.length > 0 ? num(rows[0].updated_at) : null;
    }

    async ingestWatermark(sessionId: string): Promise<{ seq: number; tailSeqs: number[] } | null> {
        const [rows] = (await this.pool.query(
            "SELECT last_ingested_seq, tail_json FROM sessions WHERE session_id = ?",
            [sessionId],
        )) as unknown as Row[][];
        if (rows.length === 0) return null;
        const seq = rows[0].last_ingested_seq;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
        const tail = JSON.parse(str(rows[0].tail_json)) as { tailSeqs?: number[] | null };
        const seqs = tail.tailSeqs;
        if (!Array.isArray(seqs) || seqs.length === 0 || seqs[seqs.length - 1] !== seq) return null;
        return { seq, tailSeqs: seqs };
    }

    async tailSeqs(sessionId: string): Promise<number[] | null> {
        const [rows] = (await this.pool.query(
            "SELECT tail_json FROM sessions WHERE session_id = ?",
            [sessionId],
        )) as unknown as Row[][];
        if (rows.length === 0) return null;
        try {
            const tail = JSON.parse(str(rows[0].tail_json)) as { tailSeqs?: number[] | null };
            return Array.isArray(tail.tailSeqs) ? tail.tailSeqs : null;
        } catch {
            return null;
        }
    }

    async probeIngestBoundary(sessionId: string, seq: number): Promise<{ msgId: string; contentHash: string; maxSeq: number } | null> {
        const conn = await this.pool.getConnection();
        try {
            return await this.probeIngestBoundaryOn(conn, sessionId, seq);
        } finally {
            conn.release();
        }
    }

    async clearIngestWatermark(sessionId: string): Promise<void> {
        await this.pool.query("UPDATE sessions SET last_ingested_seq = NULL WHERE session_id = ?", [sessionId]);
    }

    async resetAllIngestWatermarks(): Promise<void> {
        await this.pool.query("UPDATE sessions SET last_ingested_seq = NULL");
    }

    async reapBlocks(
        sessionId: string,
        reapedIds: Set<string>,
        orphanContents: Map<string, { one: unknown; full: unknown }>,
    ): Promise<void> {
        if (reapedIds.size === 0 && orphanContents.size === 0) return;
        await this.tx(async (c) => {
            for (const blockId of reapedIds) {
                const [rows] = (await c.query(
                    "SELECT summary_hash, one_hash FROM blocks WHERE session_id = ? AND block_id = ?",
                    [sessionId, blockId],
                )) as unknown as Row[][];
                if (rows.length === 0) continue;
                await this.releaseContent(c, str(rows[0].summary_hash));
                if (rows[0].one_hash !== null && rows[0].one_hash !== undefined) await this.releaseContent(c, str(rows[0].one_hash));
                await c.query("DELETE FROM blocks WHERE session_id = ? AND block_id = ?", [sessionId, blockId]);
            }
            if (orphanContents.size > 0) {
                const [sess] = (await c.query(
                    "SELECT orphans_json FROM sessions WHERE session_id = ?",
                    [sessionId],
                )) as unknown as Row[][];
                if (sess.length > 0) {
                    let merged: Record<string, unknown> = {};
                    try {
                        const parsed = JSON.parse(str(sess[0].orphans_json ?? "{}")) as unknown;
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) merged = parsed as Record<string, unknown>;
                    } catch {
                        /* corrupt journal → start fresh */
                    }
                    for (const [blockId, view] of orphanContents) merged[blockId] = view;
                    await c.query("UPDATE sessions SET orphans_json = ? WHERE session_id = ?", [JSON.stringify(merged), sessionId]);
                }
            }
        });
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.tx(async (c) => {
            const refs: string[] = [];
            const msgRows = (await c.query("SELECT content_hash FROM messages WHERE session_id = ?", [sessionId])) as unknown as Row[][];
            for (const m of msgRows[0]) refs.push(str(m.content_hash));
            const mediaRows = (await c.query("SELECT media_hash FROM message_media WHERE session_id = ?", [sessionId])) as unknown as Row[][];
            for (const mm of mediaRows[0]) refs.push(str(mm.media_hash));
            const blockRows = (await c.query("SELECT summary_hash, one_hash FROM blocks WHERE session_id = ?", [sessionId])) as unknown as Row[][];
            for (const b of blockRows[0]) {
                refs.push(str(b.summary_hash));
                if (b.one_hash !== null && b.one_hash !== undefined) refs.push(str(b.one_hash));
            }
            const ccrRows = (await c.query("SELECT content_hash FROM ccr_entries WHERE session_id = ?", [sessionId])) as unknown as Row[][];
            for (const e of ccrRows[0]) refs.push(str(e.content_hash));
            const cpRows = (await c.query("SELECT cp_id, state_hash FROM checkpoints WHERE session_id = ? AND pinned = 0", [sessionId])) as unknown as Row[][];
            for (const cp of cpRows[0]) {
                await c.query("DELETE FROM checkpoints WHERE cp_id = ?", [cp.cp_id]);
                refs.push(str(cp.state_hash));
            }
            await c.query("DELETE FROM messages WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM message_media WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM blocks WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM dead_refs WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM refs WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM ccr_entries WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM conversations WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM session_ext WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
            for (const hash of refs) await this.releaseContent(c, hash);
            // #4796 follow-up: scoped collection over this session's own
            // released hashes (see collectZeroRefIn) — never the whole table.
            await this.collectZeroRefIn(c, refs);
        });
    }

    async listSessionIds(): Promise<string[]> {
        const [rows] = (await this.pool.query("SELECT session_id FROM sessions ORDER BY session_id")) as unknown as Row[][];
        return rows.map((r) => str(r.session_id));
    }

    async lookupConversation(namespace: string, conversationId: string): Promise<string | null> {
        const [rows] = (await this.pool.query(
            "SELECT session_id FROM conversations WHERE namespace = ? AND conversation_id = ?",
            [namespace, conversationId],
        )) as unknown as Row[][];
        return rows.length > 0 ? str(rows[0].session_id) : null;
    }

    async listConversationBindings(namespace?: string): Promise<{ namespace: string; conversationId: string; sessionId: string; claimedAt: number }[]> {
        const rows = (namespace === undefined
            ? await this.pool.query("SELECT namespace, conversation_id, session_id, claimed_at FROM conversations ORDER BY namespace, conversation_id")
            : await this.pool.query(
                  "SELECT namespace, conversation_id, session_id, claimed_at FROM conversations WHERE namespace = ? ORDER BY conversation_id",
                  [namespace],
              )) as unknown as Row[][];
        return rows[0].map((r) => ({
            namespace: str(r.namespace),
            conversationId: str(r.conversation_id),
            sessionId: str(r.session_id),
            claimedAt: num(r.claimed_at),
        }));
    }

    /** #4316 PR3/3 — MySQL twin of UnifiedStore.liveRowCount. */
    async liveRowCount(sessionId: string): Promise<number> {
        const [rows] = (await this.pool.query(
            "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL",
            [sessionId],
        )) as unknown as Row[][];
        return num(rows[0].n);
    }

    /** #4730 — MySQL twin of UnifiedStore.lastLiveSeq: highest live seq (NOT
     *  the live count — tombstones keep their seq, so count - 1 would drop
     *  the newest live rows at fork). Null when no live rows. */
    async lastLiveSeq(sessionId: string): Promise<number | null> {
        const [rows] = (await this.pool.query(
            "SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND retired_at IS NULL",
            [sessionId],
        )) as unknown as Row[][];
        const m = rows[0].m;
        return m === null || m === undefined ? null : num(m);
    }

    /** #4316 PR3/3 — MySQL twin of UnifiedStore.seqByRaw. */
    async seqByRaw(sessionId: string): Promise<Map<string, number> | null> {
        const [rows] = (await this.pool.query(
            "SELECT msg_id, MIN(seq) AS seq, COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL GROUP BY msg_id",
            [sessionId],
        )) as unknown as Row[][];
        const out = new Map<string, number>();
        for (const r of rows) {
            if (num(r.n) === 1) out.set(str(r.msg_id), num(r.seq));
        }
        return out;
    }

    /** #4316 PR3/3 — MySQL twin of UnifiedStore.cloneSessionRows. */
    async cloneSessionRows(parentId: string, childId: string, throughSeq: number, initial?: IngestSessionInput): Promise<boolean> {
        if (initial && initial.session.sessionId !== childId) throw new Error("cloneSessionRows: initial session does not match child");
        if (parentId === childId) throw new Error("cloneSessionRows: conflicting fork lineage (child equals parent)");
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            // Strict initial creation must reserve the child BEFORE checking
            // for an unmirrored parent: otherwise legacy fallback could write
            // over an unrelated persisted child. If no parent is mirrored,
            // initialize the prepared snapshot under this same reservation.
            const claimChild = async (): Promise<void> => {
                try {
                    await conn.query(
                        `INSERT INTO sessions (session_id, created_at, updated_at)
                         VALUES (?, ?, ?)${initial ? "" : " ON DUPLICATE KEY UPDATE session_id = VALUES(session_id)"}`,
                        [childId, Date.now(), Date.now()],
                    );
                } catch (err) {
                    if (initial && (err as { code?: string }).code === "ER_DUP_ENTRY") {
                        throw new Error("cloneSessionRows: conflicting fork lineage (child already exists)", { cause: err });
                    }
                    throw err;
                }
            };
            if (initial) await claimChild();
            const [parents] = (await conn.query(
                "SELECT session_id FROM sessions WHERE session_id = ?",
                [parentId],
            )) as unknown as Row[][];
            if (parents.length === 0) {
                if (initial && !await this.ingestSessionOn(initial, undefined, { completeLog: true }, conn)) throw new Error("cloneSessionRows: initial child ingest failed");
                await conn.commit();
                return initial !== undefined;
            }
            // The insert/no-op takes the child's unique-key lock even when no
            // child existed. A competing clone waits, then the locking read
            // sees the committed pair rather than a repeatable-read snapshot.
            if (!initial) await claimChild();
            const [children] = (await conn.query(
                "SELECT parent_session_id, fork_point_seq FROM sessions WHERE session_id = ? FOR UPDATE",
                [childId],
            )) as unknown as Row[][];
            const existing = children[0];
            if (existing.parent_session_id != null || existing.fork_point_seq != null) {
                if (nullableStr(existing.parent_session_id) !== parentId || nullableNum(existing.fork_point_seq) !== throughSeq) {
                    throw new Error("cloneSessionRows: conflicting fork lineage");
                }
                await conn.commit();
                return true;
            }
            const [alreadyRows] = (await conn.query(
                "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?",
                [childId],
            )) as unknown as Row[][];
            if (num(alreadyRows[0].n) > 0) throw new Error("cloneSessionRows: conflicting fork lineage (child already has messages)");
            await conn.query(
                `INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at)
                 SELECT ?, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at FROM messages
                 WHERE session_id = ? AND seq <= ?`,
                [childId, parentId, throughSeq],
            );
            await conn.query(
                `INSERT INTO message_media (session_id, seq, media_hash)
                 SELECT ?, seq, media_hash FROM message_media
                 WHERE session_id = ? AND seq <= ?`,
                [childId, parentId, throughSeq],
            );
            // Per COPIED ROW, not DISTINCT — same under-count fix as the
            // SQLite twin: two mapping rows sharing one media_hash must bump
            // twice or the zero-ref sweep deletes bytes a later delete path
            // still releases twice.
            const [hashes] = (await conn.query(
                "SELECT content_hash AS h FROM messages WHERE session_id = ?",
                [childId],
            )) as unknown as Row[][];
            for (const row of hashes) {
                const [res] = (await conn.query("UPDATE content SET refcount = refcount + 1 WHERE hash = ?", [row.h])) as unknown as [{ affectedRows: number }, unknown];
                if (res.affectedRows === 0) throw new Error(`cloneSessionRows: content row missing for hash ${String(row.h).slice(0, 16)}… — refusing to fork with an uncounted ref`);
            }
            const [media] = (await conn.query(
                "SELECT media_hash AS h FROM message_media WHERE session_id = ?",
                [childId],
            )) as unknown as Row[][];
            for (const row of media) {
                const [res] = (await conn.query("UPDATE content SET refcount = refcount + 1 WHERE hash = ?", [row.h])) as unknown as [{ affectedRows: number }, unknown];
                if (res.affectedRows === 0) throw new Error(`cloneSessionRows: media content row missing for hash ${String(row.h).slice(0, 16)}… — refusing to fork with an uncounted ref`);
            }
            await conn.query(
                `INSERT INTO sessions (session_id, created_at, updated_at, parent_session_id, fork_point_seq)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE parent_session_id = VALUES(parent_session_id), fork_point_seq = VALUES(fork_point_seq)`,
                [childId, Date.now(), Date.now(), parentId, throughSeq],
            );
            if (initial && !await this.ingestSessionOn(initial, undefined, { completeLog: true }, conn)) throw new Error("cloneSessionRows: initial child ingest failed");
            await conn.commit();
            return true;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    async getSessionRow(sessionId: string): Promise<SessionRow | null> {
        return this.getSessionRowOn(this.pool, sessionId);
    }

    async readSnapshot<T>(read: (reader: StorageReadView) => Promise<T>): Promise<T> {
        const conn = await this.pool.getConnection();
        try {
            await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
            return await read({
                getSessionRow: (id) => this.getSessionRowOn(conn, id),
                getMessages: (id, opts) => this.getMessagesOn(conn, id, opts),
                getBlocks: (id, opts) => this.getBlocksOn(conn, id, opts),
                getDeadRefs: (id) => this.getDeadRefsOn(conn, id),
                getRefs: (id) => this.getRefsOn(conn, id),
            });
        } finally {
            try {
                await conn.rollback();
            } finally {
                conn.release();
            }
        }
    }

    private async getSessionRowOn(conn: Pool | PoolConnection, sessionId: string): Promise<SessionRow | null> {
        const [rows] = (await conn.query(
            `SELECT session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin, status,
                    created_at, updated_at, next_block_id, next_run_id,
                    meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq, orphans_json
             FROM sessions WHERE session_id = ?`,
            [sessionId],
        )) as unknown as Row[][];
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            sessionId: str(r.session_id),
            parentSessionId: nullableStr(r.parent_session_id),
            forkPointSeq: nullableNum(r.fork_point_seq),
            protocol: nullableStr(r.protocol),
            label: nullableStr(r.label),
            title: nullableStr(r.title),
            hostTitle: nullableStr(r.host_title),
            namespace: typeof r.namespace === "string" ? r.namespace : "proxy",
            origin: nullableStr(r.origin),
            status: str(r.status ?? "active"),
            createdAt: num(r.created_at),
            updatedAt: num(r.updated_at),
            nextBlockId: num(r.next_block_id, 1),
            nextRunId: num(r.next_run_id, 1),
            metaJson: str(r.meta_json ?? "{}"),
            statsJson: str(r.stats_json ?? "{}"),
            metadataJson: str(r.metadata_json ?? "{}"),
            kstateJson: str(r.kstate_json ?? "{}"),
            tailJson: str(r.tail_json ?? "{}"),
            ccrJson: nullableStr(r.ccr_json),
            lastIngestedSeq: nullableNum(r.last_ingested_seq),
            orphansJson: nullableStr(r.orphans_json),
        };
    }

    /** #4739: bounded view bundle (messages only at tail/pluginSnapshot
     *  pointer seqs). Per-statement reads like today's viewForAsync — no
     *  cross-query snapshot — which is safe here because ingest writes each
     *  session row and its pointed-at message rows in ONE transaction, so
     *  every pointer ever read resolves to rows that already exist. The
     *  sqlite lane carries the explicit read-transaction instead. */
    async sessionViewRows(sessionId: string): Promise<SessionViewRows> {
        const session = await this.getSessionRow(sessionId);
        if (!session) return null;
        const pointers = viewPointerSeqs(session.tailJson);
        const messages: (MessageRow & { contentHash: string })[] = [];
        const CHUNK = 500;
        for (let i = 0; i < pointers.length; i += CHUNK) {
            const chunk = [...new Set(pointers.slice(i, i + CHUNK))];
            if (chunk.length === 0) continue;
            const [rows] = (await this.pool.query(
                `SELECT seq, msg_id, ref, ref_num, role, kind, content_hash FROM messages
                 WHERE session_id = ? AND retired_at IS NULL AND seq IN (${chunk.map(() => "?").join(", ")})`,
                [sessionId, ...chunk],
            )) as unknown as Row[][];
            for (const r of rows) {
                const contentHash = str(r.content_hash);
                messages.push({
                    seq: num(r.seq),
                    msgId: str(r.msg_id),
                    ref: nullableStr(r.ref),
                    refNum: nullableNum(r.ref_num),
                    role: str(r.role),
                    kind: str(r.kind),
                    contentHash,
                    content: await this.hydrateMediaAsync((await this.getContent(this.pool, contentHash)) ?? "", this.pool),
                });
            }
        }
        messages.sort((a, b) => a.seq - b.seq);
        return {
            session,
            messages,
            blocks: await this.getBlocks(sessionId),
            deadRefs: await this.getDeadRefs(sessionId),
            refs: await this.getRefs(sessionId),
        };
    }

    async getMessages(sessionId: string, opts?: { includeRetired?: boolean; seqs?: readonly number[] }): Promise<(MessageRow & { contentHash: string; retiredAt: number | null })[]> {
        return this.getMessagesOn(this.pool, sessionId, opts);
    }

    private async getMessagesOn(conn: Pool | PoolConnection, sessionId: string, opts?: { includeRetired?: boolean; seqs?: readonly number[] }): Promise<(MessageRow & { contentHash: string; retiredAt: number | null })[]> {
        // #4390: retired rows stay out of the replay by default.
        if (opts?.seqs?.length === 0) return [];
        const seqFilter = opts?.seqs ? ` AND seq IN (${opts.seqs.map(() => "?").join(",")})` : "";
        const retiredFilter = opts?.includeRetired === true ? "" : " AND retired_at IS NULL";
        const [rows] = (await conn.query(
            `SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, retired_at FROM messages WHERE session_id = ?${retiredFilter}${seqFilter} ORDER BY seq`,
            [sessionId, ...(opts?.seqs ?? [])],
        )) as unknown as Row[][];
        const out: (MessageRow & { contentHash: string; retiredAt: number | null })[] = [];
        for (const r of rows) {
            const contentHash = str(r.content_hash);
            out.push({
                seq: num(r.seq),
                msgId: str(r.msg_id),
                ref: nullableStr(r.ref),
                refNum: nullableNum(r.ref_num),
                role: str(r.role),
                kind: str(r.kind),
                contentHash,
                retiredAt: nullableNum(r.retired_at),
                content: await this.hydrateMediaAsync((await this.getContent(conn, contentHash)) ?? "", conn),
            });
        }
        return out;
    }

    private async hydrateMediaAsync(content: string, conn: Pool | PoolConnection): Promise<string> {
        let out = content;
        if (out.includes('"$media"')) {
            try {
                const parsed = JSON.parse(out) as { imageBase64?: unknown };
                const slot = parsed.imageBase64;
                if (slot !== null && typeof slot === "object" && typeof (slot as { $media?: unknown }).$media === "string") {
                    const bytes = await this.getContent(conn, (slot as { $media: string }).$media);
                    if (typeof bytes === "string" && bytes.length > 0) {
                        parsed.imageBase64 = bytes;
                        out = JSON.stringify(parsed);
                    }
                }
            } catch {
                // fall through: raw-sidecar pass below still runs
            }
        }
        // #4069: restore data-URL payloads swapped out of raw wire sidecars
        // (mysql twin of UnifiedStore.hydrateMedia).
        if (out.includes(";base64,{$media:")) {
            const markerRe = /data:([a-zA-Z0-9.+\/\-]+);base64,\{\$media:([0-9a-f]{64})\}/g;
            const hits: { mime: string; hash: string }[] = [];
            for (const m of out.matchAll(markerRe)) hits.push({ mime: m[1], hash: m[2] });
            if (hits.length > 0) {
                const cache = new Map<string, string | null>();
                for (const h of new Set(hits.map((x) => x.hash))) {
                    cache.set(h, await this.getContent(conn, h));
                }
                out = out.replace(markerRe, (all: string, mime: string, hash: string) => {
                    const bytes = cache.get(hash);
                    return typeof bytes === "string" && bytes.length > 0 ? `data:${mime};base64,${bytes}` : all;
                });
            }
        }
        return out;
    }

    async getBlocks(sessionId: string, opts?: { limit: number; offset?: number }): Promise<(BlockRow & { summaryHash: string; oneHash: string | null })[]> {
        return this.getBlocksOn(this.pool, sessionId, opts);
    }

    private async getBlocksOn(conn: Pool | PoolConnection, sessionId: string, opts?: { limit: number; offset?: number }): Promise<(BlockRow & { summaryHash: string; oneHash: string | null })[]> {
        const [rows] = (await conn.query(
            `SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash,
                    supersedes_block_id, active, created_at, covered_hash, payload_json
             FROM blocks WHERE session_id = ? ORDER BY ord, block_id${opts ? " LIMIT ? OFFSET ?" : ""}`,
            [sessionId, ...(opts ? [opts.limit, opts.offset ?? 0] : [])],
        )) as unknown as Row[][];
        const out: (BlockRow & { summaryHash: string; oneHash: string | null })[] = [];
        for (const r of rows) {
            out.push({
                blockId: str(r.block_id),
                ord: num(r.ord),
                startSeq: num(r.start_seq),
                endSeq: num(r.end_seq),
                startRef: nullableNum(r.start_ref),
                endRef: nullableNum(r.end_ref),
                tier: num(r.tier),
                summaryHash: str(r.summary_hash),
                oneHash: nullableStr(r.one_hash),
                summary: (await this.getContent(conn, str(r.summary_hash))) ?? "",
                one: r.one_hash === null || r.one_hash === undefined ? null : ((await this.getContent(conn, str(r.one_hash))) ?? null),
                supersedesBlockId: nullableStr(r.supersedes_block_id),
                active: num(r.active) === 1,
                createdAt: num(r.created_at),
                coveredHash: str(r.covered_hash),
                payloadJson: str(r.payload_json),
            });
        }
        return out;
    }

    async getDeadRefs(sessionId: string): Promise<{ ord: number; ref: string; refNum: number; recordedAt: number }[]> {
        return this.getDeadRefsOn(this.pool, sessionId);
    }

    private async getDeadRefsOn(conn: Pool | PoolConnection, sessionId: string): Promise<{ ord: number; ref: string; refNum: number; recordedAt: number }[]> {
        const [rows] = (await conn.query(
            "SELECT ord, ref, ref_num, recorded_at FROM dead_refs WHERE session_id = ? ORDER BY ord",
            [sessionId],
        )) as unknown as Row[][];
        return rows.map((r) => ({
            ord: num(r.ord),
            ref: str(r.ref),
            refNum: num(r.ref_num),
            recordedAt: num(r.recorded_at),
        }));
    }

    async getRefs(sessionId: string): Promise<RefRow[]> {
        return this.getRefsOn(this.pool, sessionId);
    }

    private async getRefsOn(conn: Pool | PoolConnection, sessionId: string): Promise<RefRow[]> {
        const [rows] = (await conn.query(
            "SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord",
            [sessionId],
        )) as unknown as Row[][];
        return rows.map((r) => ({
            ord: num(r.ord),
            rawId: str(r.raw_id),
            ref: str(r.ref),
            refNum: nullableNum(r.ref_num),
        }));
    }

    async getCcr(sessionId: string): Promise<MessageContentStore | null> {
        const [rows] = (await this.pool.query(
            "SELECT ccr_json FROM sessions WHERE session_id = ?",
            [sessionId],
        )) as unknown as Row[][];
        if (rows.length === 0 || rows[0].ccr_json === null || rows[0].ccr_json === undefined) return null;
        try {
            const parsed = JSON.parse(str(rows[0].ccr_json)) as MessageContentStore;
            if (parsed && typeof parsed === "object" && parsed.version === 1
                && parsed.byHash && typeof parsed.byHash === "object"
                && parsed.byRef && typeof parsed.byRef === "object") {
                return parsed;
            }
        } catch {
            /* corrupt mirror → null */
        }
        return null;
    }

    async getCcrEntries(sessionId: string): Promise<CcrEntryRow[]> {
        const [rows] = (await this.pool.query(
            "SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord",
            [sessionId],
        )) as unknown as Row[][];
        const out: CcrEntryRow[] = [];
        for (const r of rows) {
            out.push({ ord: num(r.ord), key: str(r.ccr_key), content: (await this.getContent(this.pool, str(r.content_hash))) ?? "" });
        }
        return out;
    }

    // --- archive / GC ------------------------------------------------------

    static readonly ARCHIVE_LOG_NAME = "archive.jsonl";

    async archiveSession(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number }> {
        const row = await this.getSessionRow(sessionId);
        if (!row) return { ok: false, reason: "not-found" };
        const exportPath = join(opts.archiveDir, MysqlBackend.ARCHIVE_LOG_NAME);
        if (row.status === "archived") return { ok: true, exportPath };
        const q = async (sql: string): Promise<Row[]> => ((await this.pool.query(sql, [sessionId])) as unknown as Row[][])[0];
        // #4665: carry the v8 row state (identity JOIN key + historian
        // tombstone) across archive/restore — sqlite twin, same reason.
        const messages = await q("SELECT seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at FROM messages WHERE session_id = ? ORDER BY seq");
        const mediaMaps = await q("SELECT seq, media_hash FROM message_media WHERE session_id = ?");
        const blocks = await q("SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json FROM blocks WHERE session_id = ? ORDER BY ord");
        const refsRows = await q("SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord");
        const deadRefs = await q("SELECT ord, ref, ref_num, recorded_at FROM dead_refs WHERE session_id = ? ORDER BY ord");
        const ccr = await q("SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord");
        const ext = await q("SELECT ext_key AS `key`, value_json FROM session_ext WHERE session_id = ?");
        const checkpoints = await q("SELECT cp_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash FROM checkpoints WHERE session_id = ?");
        const wanted = new Set<string>();
        for (const m of messages) wanted.add(str(m.content_hash));
        for (const mm of mediaMaps) wanted.add(str(mm.media_hash));
        for (const b of blocks) {
            wanted.add(str(b.summary_hash));
            if (b.one_hash !== null && b.one_hash !== undefined) wanted.add(str(b.one_hash));
        }
        for (const e of ccr) wanted.add(str(e.content_hash));
        for (const cp of checkpoints) if (num(cp.pinned) === 0) wanted.add(str(cp.state_hash));
        const content: Record<string, string> = {};
        for (const hash of wanted) {
            const c = await this.getContent(this.pool, hash);
            if (c !== null) content[hash] = c;
        }
        mkdirSync(opts.archiveDir, { recursive: true });
        appendFileSync(exportPath, JSON.stringify({ version: 1, sessionId, archivedAt: Date.now(), session: row, content, messages, mediaMaps, blocks, refs: refsRows, deadRefs, ccrEntries: ccr, sessionExt: ext, checkpoints }) + "\n");
        let contentRowsDeleted = 0;
        await this.tx(async (c) => {
            const rel: string[] = [];
            for (const m of messages) rel.push(str(m.content_hash));
            for (const mm of mediaMaps) rel.push(str(mm.media_hash));
            for (const b of blocks) {
                rel.push(str(b.summary_hash));
                if (b.one_hash !== null && b.one_hash !== undefined) rel.push(str(b.one_hash));
            }
            for (const e of ccr) rel.push(str(e.content_hash));
            for (const cp of checkpoints) {
                if (num(cp.pinned) === 0) {
                    rel.push(str(cp.state_hash));
                    await c.query("DELETE FROM checkpoints WHERE cp_id = ?", [cp.cp_id]);
                }
            }
            await c.query("DELETE FROM messages WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM message_media WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM blocks WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM dead_refs WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM refs WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM ccr_entries WHERE session_id = ?", [sessionId]);
            await c.query("DELETE FROM session_ext WHERE session_id = ?", [sessionId]);
            await c.query("UPDATE sessions SET status = 'archived' WHERE session_id = ?", [sessionId]);
            for (const hash of rel) await this.releaseContent(c, hash);
            // #4796 follow-up: scoped collection (see collectZeroRefIn) —
            // the reported count is what THIS archive collected.
            contentRowsDeleted = await this.collectZeroRefIn(c, rel);
        });
        loggerLog("info", `[#3931] archived ${sessionId} → ${exportPath} (${contentRowsDeleted} content rows collected)`);
        return { ok: true, exportPath, contentRowsDeleted };
    }

    async restoreArchived(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; reason?: string }> {
        const exportPath = join(opts.archiveDir, MysqlBackend.ARCHIVE_LOG_NAME);
        if (!existsSync(exportPath)) return { ok: false, reason: "export-missing" };
        let dump: {
            session: SessionRow;
            content: Record<string, string>;
            messages: Record<string, unknown>[];
            blocks: Record<string, unknown>[];
            refs: Record<string, unknown>[];
            deadRefs: Record<string, unknown>[];
            ccrEntries: Record<string, unknown>[];
            sessionExt: Record<string, unknown>[];
            checkpoints: Record<string, unknown>[];
        };
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
                if (candidate.sessionId === sessionId) {
                    lineNo = i;
                    break;
                }
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
        const sess = dump.session;
        await this.tx(async (c) => {
            for (const [hash, body] of Object.entries(dump.content)) await this.putContent(c, body, hash);
            for (const m of dump.messages) {
                // #4665: pre-fix dumps lack both fields — recompute identity
                // from the CAS body (same formula as the v8 migration
                // backfill); retire state is unrecoverable there → live.
                const stored = typeof m.content_hash === "string" ? dump.content[m.content_hash] : undefined;
                const identity = typeof m.identity === "string" && m.identity !== "" ? m.identity : stored !== undefined ? identityOfStoredContent(stored) : "";
                await c.query(
                    "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [sessionId, m.seq, m.msg_id, m.ref ?? null, m.ref_num ?? null, m.role, m.kind ?? "message", m.content_hash, identity, typeof m.retired_at === "number" ? m.retired_at : null],
                );
            }
            for (const mm of (dump as { mediaMaps?: Record<string, unknown>[] }).mediaMaps ?? []) {
                await c.query("INSERT IGNORE INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)", [sessionId, mm.seq, mm.media_hash]);
            }
            for (const b of dump.blocks) {
                await c.query(
                    `INSERT IGNORE INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier,
                       summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [b.block_id, sessionId, b.ord, b.start_seq, b.end_seq, b.start_ref ?? null, b.end_ref ?? null, b.tier, b.summary_hash, b.one_hash ?? null, b.supersedes_block_id ?? null, b.active, b.created_at, b.covered_hash, b.payload_json],
                );
            }
            for (const r of dump.refs) {
                await c.query("INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?)", [sessionId, r.ord, r.raw_id, r.ref, r.ref_num ?? null]);
            }
            for (const d of dump.deadRefs) {
                await c.query("INSERT INTO dead_refs (session_id, ord, ref, ref_num, recorded_at) VALUES (?, ?, ?, ?, ?)", [sessionId, d.ord, d.ref, d.ref_num, d.recorded_at]);
            }
            for (const e of dump.ccrEntries) {
                await c.query("INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)", [sessionId, e.ord, e.ccr_key, e.content_hash]);
            }
            for (const x of dump.sessionExt) {
                await c.query(
                    "INSERT INTO session_ext (session_id, ext_key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                        "ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)",
                    [sessionId, x.key, x.value_json, Date.now()],
                );
            }
            for (const cp of dump.checkpoints) {
                await c.query(
                    "INSERT IGNORE INTO checkpoints (cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [cp.cp_id, sessionId, cp.seq_at, cp.block_set_hash, cp.kind, cp.created_at, cp.pinned, cp.label ?? null, cp.state_hash],
                );
            }
            await c.query(
                `UPDATE sessions SET parent_session_id = ?, fork_point_seq = ?, protocol = ?, label = ?, title = ?, host_title = ?, namespace = ?, origin = ?,
                    created_at = ?, updated_at = ?, next_block_id = ?, next_run_id = ?, meta_json = ?, stats_json = ?, metadata_json = ?, kstate_json = ?, tail_json = ?, ccr_json = ?, last_ingested_seq = ?, orphans_json = ?, status = 'active' WHERE session_id = ?`,
                [
                    sess.parentSessionId ?? null, sess.forkPointSeq ?? null, sess.protocol ?? null, sess.label ?? null,
                    sess.title ?? null, sess.hostTitle ?? null, sess.namespace ?? "proxy", sess.origin ?? null,
                    sess.createdAt, sess.updatedAt, sess.nextBlockId, sess.nextRunId,
                    sess.metaJson, sess.statsJson, sess.metadataJson, sess.kstateJson, sess.tailJson, sess.ccrJson ?? null,
                    sess.lastIngestedSeq ?? null, sess.orphansJson ?? null, sessionId,
                ],
            );
        });
        const kept: string[] = [];
        for (const l of rawLines) {
            if (!l.trim()) continue;
            try {
                const head = JSON.parse(l) as { sessionId?: string };
                if (head.sessionId === sessionId) continue;
            } catch {
                continue;
            }
            kept.push(l);
        }
        writeFileSync(exportPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
        loggerLog("info", `[#3931] restored archived session ${sessionId} from ${exportPath} (line removed from the archive log)`);
        return { ok: true };
    }

    async gc(opts: { archiveAfterDays: number; archiveDir: string; now?: number; vacuum?: "full" | "incremental" }): Promise<{ archived: number; contentRowsDeleted: number }> {
        const now = opts.now ?? Date.now();
        let archived = 0;
        let contentRowsDeleted = 0;
        if (opts.archiveAfterDays > 0) {
            const cutoff = now - opts.archiveAfterDays * 86_400_000;
            const [stale] = (await this.pool.query(
                "SELECT session_id FROM sessions WHERE status = 'active' AND updated_at < ?",
                [cutoff],
            )) as unknown as Row[][];
            for (const s of stale) {
                const r = await this.archiveSession(str(s.session_id), { archiveDir: opts.archiveDir });
                if (r.ok) archived++;
                if (r.contentRowsDeleted) contentRowsDeleted += r.contentRowsDeleted;
            }
        }
        const [zero] = (await this.pool.query("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0")) as unknown as Row[][];
        if (num(zero[0].n) > 0) {
            loggerLog("info", `[#4796] gc: collecting ${num(zero[0].n)} zero-ref content rows in batches of ${MYSQL_GC_ZERO_REF_BATCH}`);
            contentRowsDeleted += await this.collectZeroRefContent(MYSQL_GC_ZERO_REF_BATCH);
        }
        if (opts.vacuum === "full") {
            loggerLog("info", "[#3931] gc: running OPTIMIZE TABLE (mysql counterpart of the sqlite full VACUUM)");
            await this.pool.query("OPTIMIZE TABLE sessions");
            await this.pool.query("OPTIMIZE TABLE messages");
            await this.pool.query("OPTIMIZE TABLE content");
        }
        return { archived, contentRowsDeleted };
    }

    /** #4796: batched zero-ref CAS collection — mysql counterpart of
     *  UnifiedStore.collectZeroRefContent. Each DELETE is a standalone
     *  autocommit statement re-filtering `refcount <= 0` under its own
     *  latest state: a row concurrently re-referenced between batches is
     *  skipped, not deleted. */
    private async collectZeroRefContent(batchSize: number): Promise<number> {
        let deleted = 0;
        let batchNo = 0;
        for (;;) {
            const [result] = (await this.pool.query(
                "DELETE FROM content WHERE refcount <= 0 LIMIT ?",
                [batchSize],
            )) as unknown as Array<{ affectedRows?: number }>;
            const changes = num(result.affectedRows ?? 0);
            if (changes === 0) break;
            batchNo += 1;
            deleted += changes;
            if (batchNo % 10 === 0 || changes < batchSize) {
                loggerLog("info", `[#4796] gc: collected ${deleted} zero-ref content rows so far (batch ${batchNo})`);
            }
        }
        return deleted;
    }

    /** #4796 follow-up (PR #4800 review): lifecycle-scoped zero-ref
     *  collection — mysql counterpart of UnifiedStore.collectZeroRefIn.
     *  deleteSession/archiveSession/deleteCheckpoint used to finish with a
     *  full-table `DELETE ... WHERE refcount <= 0` inside their lifecycle
     *  transaction (the same giant-commit pathology as the old gc sweep on
     *  a bloated store). Their own releases already went through
     *  releaseContent's delete-on-zero, so this only re-asserts the
     *  invariant over the operation's released-hash set — bounded work,
     *  atomicity kept. Orphans from other sources stay for gc(). */
    private async collectZeroRefIn(c: PoolConnection | Pool, hashes: string[]): Promise<number> {
        const list = [...new Set(hashes)];
        let deleted = 0;
        for (let i = 0; i < list.length; i += MYSQL_ZERO_REF_SWEEP_CHUNK) {
            const chunk = list.slice(i, i + MYSQL_ZERO_REF_SWEEP_CHUNK);
            const ph = chunk.map(() => "?").join(", ");
            const [result] = (await c.query(
                `DELETE FROM content WHERE refcount <= 0 AND hash IN (${ph})`,
                chunk,
            )) as unknown as Array<{ affectedRows?: number }>;
            deleted += num(result.affectedRows ?? 0);
        }
        return deleted;
    }

    async contentRefCountOfBody(needle: string): Promise<number> {
        const [rows] = (await this.pool.query(
            "SELECT refcount FROM content WHERE bytes LIKE CONCAT('%', ?, '%') LIMIT 1",
            [needle],
        )) as unknown as Row[][];
        return rows.length > 0 ? num(rows[0].refcount) : 0;
    }

    async mediaRefCount(bytes: string): Promise<number> {
        const [rows] = (await this.pool.query("SELECT refcount FROM content WHERE bytes = ? LIMIT 1", [bytes])) as unknown as Row[][];
        return rows.length > 0 ? num(rows[0].refcount) : 0;
    }

    // --- checkpoints -------------------------------------------------------

    async insertCheckpoint(cp: {
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
        await this.tx(async (c) => {
            const stateHash = await this.putContent(c, cp.stateJson);
            await c.query(
                "INSERT INTO checkpoints (cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [cp.cpId, cp.sessionId, cp.seqAt, cp.blockSetHash, cp.kind, cp.createdAt, cp.pinned ? 1 : 0, cp.label ?? null, stateHash],
            );
        });
    }

    async listCheckpoints(sessionId?: string): Promise<CheckpointRow[]> {
        const cols = "cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label";
        const rows = (sessionId === undefined
            ? await this.pool.query(`SELECT ${cols} FROM checkpoints ORDER BY created_at, cp_id`)
            : await this.pool.query(`SELECT ${cols} FROM checkpoints WHERE session_id = ? ORDER BY created_at, cp_id`, [sessionId])) as unknown as Row[][];
        return rows[0].map((r) => ({
            cp_id: str(r.cp_id),
            session_id: str(r.session_id),
            seq_at: num(r.seq_at),
            block_set_hash: str(r.block_set_hash),
            kind: str(r.kind) as CheckpointRow["kind"],
            created_at: num(r.created_at),
            pinned: num(r.pinned),
            label: nullableStr(r.label),
        }));
    }

    async getCheckpoint(cpId: string): Promise<CheckpointRow | undefined> {
        const [rows] = (await this.pool.query(
            "SELECT cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label FROM checkpoints WHERE cp_id = ?",
            [cpId],
        )) as unknown as Row[][];
        if (rows.length === 0) return undefined;
        const r = rows[0];
        return {
            cp_id: str(r.cp_id),
            session_id: str(r.session_id),
            seq_at: num(r.seq_at),
            block_set_hash: str(r.block_set_hash),
            kind: str(r.kind) as CheckpointRow["kind"],
            created_at: num(r.created_at),
            pinned: num(r.pinned),
            label: nullableStr(r.label),
        };
    }

    async checkpointState(cpId: string): Promise<{ stateJson: string; byteLen: number }> {
        const [rows] = (await this.pool.query("SELECT state_hash FROM checkpoints WHERE cp_id = ?", [cpId])) as unknown as Row[][];
        if (rows.length === 0) throw new Error(`checkpoint not found: ${cpId}`);
        const [blobs] = (await this.pool.query("SELECT bytes, byte_len FROM content WHERE hash = ?", [rows[0].state_hash])) as unknown as Row[][];
        if (blobs.length === 0) throw new Error(`checkpoint blob missing (CAS leak): ${cpId}`);
        return { stateJson: str(blobs[0].bytes), byteLen: num(blobs[0].byte_len) };
    }

    async deleteCheckpoint(cpId: string): Promise<boolean> {
        return this.tx(async (c): Promise<boolean> => {
            const [rows] = (await c.query("SELECT state_hash FROM checkpoints WHERE cp_id = ?", [cpId])) as unknown as Row[][];
            if (rows.length === 0) return false;
            await c.query("DELETE FROM checkpoints WHERE cp_id = ?", [cpId]);
            await this.releaseContent(c, str(rows[0].state_hash));
            await this.collectZeroRefIn(c, [str(rows[0].state_hash)]);
            return true;
        });
    }

    // --- session_ext / kv --------------------------------------------------

    async setSessionExt(sessionId: string, key: string, value: unknown): Promise<void> {
        const valueJson = JSON.stringify(value);
        await this.pool.query(
            "INSERT INTO session_ext (session_id, ext_key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                "ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)",
            [sessionId, key, valueJson, Date.now()],
        );
    }

    async getSessionExt(sessionId: string, key: string): Promise<unknown> {
        const [rows] = (await this.pool.query(
            "SELECT value_json FROM session_ext WHERE session_id = ? AND ext_key = ?",
            [sessionId, key],
        )) as unknown as Row[][];
        return rows.length === 0 ? undefined : JSON.parse(str(rows[0].value_json));
    }

    async listSessionExt(sessionId: string): Promise<{ key: string; value: unknown; updatedAt: number }[]> {
        const [rows] = (await this.pool.query(
            "SELECT ext_key, value_json, updated_at FROM session_ext WHERE session_id = ? ORDER BY ext_key",
            [sessionId],
        )) as unknown as Row[][];
        return rows.map((r) => ({ key: str(r.ext_key), value: JSON.parse(str(r.value_json)), updatedAt: num(r.updated_at) }));
    }

    async deleteSessionExt(sessionId: string, key?: string): Promise<number> {
        if (key === undefined) {
            const [r] = (await this.pool.query("DELETE FROM session_ext WHERE session_id = ?", [sessionId])) as unknown as [{ affectedRows: number }, unknown];
            return r.affectedRows;
        }
        const [r] = (await this.pool.query("DELETE FROM session_ext WHERE session_id = ? AND ext_key = ?", [sessionId, key])) as unknown as [{ affectedRows: number }, unknown];
        return r.affectedRows;
    }

    async setKv(namespace: string, key: string, value: unknown): Promise<void> {
        const valueJson = JSON.stringify(value);
        await this.pool.query(
            "INSERT INTO kv_store (namespace, kv_key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                "ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)",
            [namespace, key, valueJson, Date.now()],
        );
    }

    async getKv(namespace: string, key: string): Promise<unknown> {
        const [rows] = (await this.pool.query(
            "SELECT value_json FROM kv_store WHERE namespace = ? AND kv_key = ?",
            [namespace, key],
        )) as unknown as Row[][];
        return rows.length === 0 ? undefined : JSON.parse(str(rows[0].value_json));
    }

    async listKv(namespace?: string, keyPrefix?: string): Promise<{ namespace: string; key: string; value: unknown; updatedAt: number }[]> {
        const where: string[] = [];
        const args: unknown[] = [];
        if (namespace !== undefined) {
            where.push("namespace = ?");
            args.push(namespace);
        }
        if (keyPrefix !== undefined && keyPrefix !== "") {
            where.push("kv_key LIKE CONCAT(?, '%')");
            args.push(keyPrefix.replace(/[\\%_]/g, (ch) => "\\" + ch));
        }
        const sql =
            "SELECT namespace, kv_key, value_json, updated_at FROM kv_store" +
            (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
            " ORDER BY namespace, kv_key";
        const [rows] = (await this.pool.query(sql, args)) as unknown as Row[][];
        return rows.map((r) => ({ namespace: str(r.namespace), key: str(r.kv_key), value: JSON.parse(str(r.value_json)), updatedAt: num(r.updated_at) }));
    }

    async deleteKv(namespace: string, key?: string): Promise<number> {
        if (key === undefined) {
            const [r] = (await this.pool.query("DELETE FROM kv_store WHERE namespace = ?", [namespace])) as unknown as [{ affectedRows: number }, unknown];
            return r.affectedRows;
        }
        const [r] = (await this.pool.query("DELETE FROM kv_store WHERE namespace = ? AND kv_key = ?", [namespace, key])) as unknown as [{ affectedRows: number }, unknown];
        return r.affectedRows;
    }

    // --- summaries / diagnostics -------------------------------------------

    async sessionSummaries(): Promise<SessionSummaryRow[]> {
        const [rows] = (await this.pool.query(
            `SELECT s.session_id AS sessionId, s.host_title AS hostTitle, s.title AS title, s.label AS label,
                    s.protocol AS protocol, s.origin AS origin, s.namespace AS namespace, s.stats_json AS statsJson,
                    s.updated_at AS updatedAt, s.status AS status,
                    (SELECT COUNT(*) FROM blocks b WHERE b.session_id = s.session_id) AS blocks,
                    (SELECT MAX(b.created_at) FROM blocks b WHERE b.session_id = s.session_id) AS latestBlockAt
              FROM sessions s`,
        )) as unknown as Row[][];
        return rows.map((r) => {
            let contextTokens: number | undefined;
            try {
                const v = (JSON.parse(str(r.statsJson)) as { contextTokens?: unknown }).contextTokens;
                if (typeof v === "number" && Number.isFinite(v)) contextTokens = v;
            } catch {
                /* malformed stats: undefined */
            }
            return {
                sessionId: str(r.sessionId),
                title: r.hostTitle !== null && r.hostTitle !== undefined ? str(r.hostTitle) : r.title !== null && r.title !== undefined ? str(r.title) : undefined,
                label: r.label !== null && r.label !== undefined ? str(r.label) : undefined,
                protocol: r.protocol !== null && r.protocol !== undefined ? str(r.protocol) : undefined,
                origin: r.origin !== null && r.origin !== undefined ? str(r.origin) : undefined,
                namespace: str(r.namespace ?? "proxy"),
                blocks: num(r.blocks),
                latestBlockAt: r.latestBlockAt !== null && r.latestBlockAt !== undefined ? num(r.latestBlockAt) : undefined,
                contextTokens,
                updatedAt: num(r.updatedAt),
                status: str(r.status ?? "active"),
            };
        });
    }

    async webSummaryRows(): Promise<WebSummaryRow[]> {
        const [rows] = (await this.pool.query(
            `SELECT s.session_id AS sessionId, s.title AS title, s.host_title AS hostTitle, s.label AS label,
                    s.protocol AS protocol, s.origin AS origin, s.updated_at AS updatedAt, s.status AS status,
                    s.stats_json AS statsJson, s.metadata_json AS metadataJson,
                    (SELECT COUNT(*) FROM blocks b WHERE b.session_id = s.session_id) AS blocks,
                    (SELECT JSON_UNQUOTE(JSON_EXTRACT(b.payload_json, '$.topic')) FROM blocks b
                      WHERE b.session_id = s.session_id
                        AND (JSON_EXTRACT(b.payload_json, '$.topic') IS NOT NULL
                             OR JSON_EXTRACT(b.payload_json, '$.summary') IS NOT NULL)
                      ORDER BY b.ord LIMIT 1) AS firstTopic,
                    (SELECT JSON_UNQUOTE(JSON_EXTRACT(b.payload_json, '$.summary')) FROM blocks b
                      WHERE b.session_id = s.session_id
                        AND (JSON_EXTRACT(b.payload_json, '$.topic') IS NOT NULL
                             OR JSON_EXTRACT(b.payload_json, '$.summary') IS NOT NULL)
                      ORDER BY b.ord LIMIT 1) AS firstSummary,
                    (SELECT COALESCE(SUM(CAST(JSON_EXTRACT(b.payload_json, '$.compressedTokens') AS DOUBLE)), 0)
                      FROM blocks b WHERE b.session_id = s.session_id AND b.active = 1) AS activeCompressed
             FROM sessions s`,
        )) as unknown as Row[][];
        return rows.map((r) => ({
            sessionId: str(r.sessionId),
            title: r.title !== null && r.title !== undefined ? str(r.title) : undefined,
            hostTitle: r.hostTitle !== null && r.hostTitle !== undefined ? str(r.hostTitle) : undefined,
            label: r.label !== null && r.label !== undefined ? str(r.label) : undefined,
            protocol: r.protocol !== null && r.protocol !== undefined ? str(r.protocol) : undefined,
            origin: r.origin !== null && r.origin !== undefined ? str(r.origin) : undefined,
            updatedAt: num(r.updatedAt),
            statsJson: str(r.statsJson),
            metadataJson: str(r.metadataJson),
            blocks: num(r.blocks),
            firstTopic: nullableStr(r.firstTopic),
            firstSummary: nullableStr(r.firstSummary),
            activeCompressedTokens: num(r.activeCompressed),
            status: str(r.status ?? "active"),
        }));
    }

    async verifyProjections(sessionId: string): Promise<{ ok: true; checks: number } | { ok: false; error: string }> {
        const fail = (where: string, msg: string): { ok: false; error: string } => ({
            ok: false,
            error: `${sessionId}: ${where}: ${msg}`,
        });
        let checks = 0;
        const s = await this.getSessionRow(sessionId);
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
        const messages = await this.getMessages(sessionId, { includeRetired: true });
        const refByRaw = new Map((await this.getRefs(sessionId)).map((r) => [r.rawId, r.ref]));
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
        const blocks = await this.getBlocks(sessionId);
        for (const b of blocks) {
            checks++;
            const payload = JSON.parse(b.payloadJson) as Record<string, unknown>;
            if (payload.blockId !== b.blockId) return fail(`blocks[${b.blockId}].blockId`, "id mismatch");
            if (payload.tier !== b.tier) return fail(`blocks[${b.blockId}].tier`, `${b.tier} vs ${String(payload.tier)}`);
            if ((payload.active ?? true) !== b.active) {
                return fail(`blocks[${b.blockId}].active`, `${b.active} vs ${String(payload.active)}`);
            }
        }
        return { ok: true, checks };
    }

    async counts(): Promise<Record<string, number>> {
        const out: Record<string, number> = {};
        for (const t of ["sessions", "messages", "refs", "blocks", "dead_refs", "ccr_entries", "content", "checkpoints"]) {
            const [rows] = (await this.pool.query(`SELECT COUNT(*) AS n FROM ${t}`)) as unknown as Row[][];
            out[t] = num(rows[0].n);
        }
        return out;
    }

    async contentDedupReport(): Promise<{ rows: number; bytesTotal: number; refcounted: number }> {
        const [rows] = (await this.pool.query(
            "SELECT COUNT(*) AS n, COALESCE(SUM(byte_len),0) AS b, COALESCE(SUM(refcount),0) AS r FROM content",
        )) as unknown as Row[][];
        return { rows: num(rows[0].n), bytesTotal: num(rows[0].b), refcounted: num(rows[0].r) };
    }
}
