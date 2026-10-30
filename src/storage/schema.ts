/**
 * Unified storage schema v1 (#2671, 6-OVERALL-DESIGN.md §schema).
 *
 * Principles encoded here:
 *  - messages/content/blocks are append-only facts (UPDATE is a bug; the
 *    only legal mutations are inserts and the documented active/supersedes
 *    transitions on blocks, plus refcount maintenance on content).
 *  - The compression ledger (blocks) is the crown jewel: every state change
 *    to it is one transaction.
 *  - Views are NEVER stored as content. Phase 1 does carry VIEW POINTERS
 *    (blocks.ord, sessions.tail_json) so the legacy load view can be
 *    reconstructed byte-exactly while the content itself lives once.
 *
 * Phase 1 representation discipline ("verbatim fact + verified projection"):
 *  - blocks.payload_json / messages.content / sessions.{meta,stats,metadata,
 *    kstate,ccr}_json hold the VERBATIM serialized facts (exact bytes the
 *    legacy reader would parse back).
 *  - Every scalar column is a PROJECTION extracted from those facts for
 *    querying. The dry-run verifier asserts projection == fact, so the
 *    columns cannot silently drift while reads still come from facts.
 *    Later phases flip readers to the projections one field at a time,
 *    guarded by the same assertions.
 *
 * Deltas from the public design sketch, all documented in the PR:
 *  - dead_refs table: tombstones are ledger family (kernel state carries
 *    them; #2370) — the sketch omitted them.
 *  - sessions.meta_json/stats_json/metadata_json/kstate_json/ccr_json and
 *    blocks.payload_json: single-column carry for kernel internals and
 *    legacy bags. One column = the #2388 "cloner drops a field" bug class
 *    is structurally impossible; column-level normalization is deferred
 *    until a consumer needs to query inside a bag.
 *  - content.bytes BLOB: chunks/ file extraction (open design question #6)
 *    is deferred — under a few GiB the single-file layout is simpler and
 *    keeps ingest atomic. `algo` names the digest; layout can move later.
 */

// v1: initial release shape (dev window) — sessions WITHOUT the identity
//        provenance columns.
// v2: identity registry (#2960/#2963) — sessions gains `namespace` and
//        `origin` (NULL-safe, constant defaults). Fresh databases create the
//        v2 shape directly; dev-window v1 databases upgrade in place via
//        idempotent ALTER TABLE (column presence probed first, so a dev
//        build that already carried the columns in its V1 DDL also lands
//        cleanly). §7.4: persisted-format changes are human-gated — this
//        bump is the review finding ② follow-up on merged #2815.
//      - v3: conversations identity index (#2960 R2.1). Fresh databases
//        create the v3 shape directly; older libs backfill idempotently.
//      - v4: extension namespaces (#3069) — session_ext (per-session
//        arbitrary state, swept with the session) + kv_store (namespaced
//        key/value for lane-level and global host state, caller-managed
//        lifecycle). Both are host/plugin/UI substrate: kernel state stays
//        in kstate_json and NEVER migrates here (no digest parity churn —
//        these tables are outside the LegacySessionLike view). Fresh
//        databases create the v4 shape directly; the migration is two
//        idempotent CREATE TABLE IF NOT EXISTS statements.
//      - v5: per-session ingest watermark (#3133) — sessions gains
//        `last_ingested_seq`, the absolute seq backing the last tail
//        message of the most recent save (NULL = no trusted prefix, full
//        ingest). The trusted prefix length is re-read from the existing
//        tail_json tailSeqs written by the same transaction — no second
//        column. Point lookups and MAX(seq) stay on the pre-existing
//        PRIMARY KEY (session_id, seq) / idx_messages_session — no new
//        index. Both directions compatible: an older build opening a v5
//        file no-ops at the version gate (extra column ignored); a newer
//        build upgrades a v4 file with one idempotent ALTER TABLE.
export const STORAGE_SCHEMA_VERSION = 9;

/** #3250: cap for `journal_size_limit` (see STORAGE_PRAGMAS). Passive and
 *  auto checkpoints move frames into the main db and reset the write offset
 *  but NEVER shrink the WAL file — without this limit a long-lived process's
 *  index.db-wal stays at its historical high-water mark forever (field:
 *  55 MiB flat). With it, every completed checkpoint truncates the file back
 *  to the cap. 8 MiB sits well above any single-save burst while keeping
 *  disk use and crash-recovery replay bounded. Per-connection setting: each
 *  process that opens the shared index applies its own copy (#2671 topology).
 *  Tunable since #3250 via storage.walJournalSizeLimitBytes /
 *  BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES (resolved by src/knobs.ts). */
export const WAL_JOURNAL_SIZE_LIMIT = 8 * 1024 * 1024;

/** Connection pragmas for every index.db opener. The journal cap is
 *  per-opener (see WAL_JOURNAL_SIZE_LIMIT); the default list below is what
 *  short-lived openers (export fast path) and tests apply. */
export function storagePragmas(walJournalSizeLimitBytes: number): string[] {
    return [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA busy_timeout = 5000",
        "PRAGMA foreign_keys = ON",
        `PRAGMA journal_size_limit = ${walJournalSizeLimitBytes}`,
        // #3901/#3463: freed pages return to the pool incrementally so an
        // archive/GC sweep actually shrinks the file going forward. Databases
        // created before this pragma keep their original layout until a
        // one-time full VACUUM (gc({vacuum:"full"}) / ?vacuum=full).
        "PRAGMA auto_vacuum = INCREMENTAL",
    ];
}

export const STORAGE_PRAGMAS = storagePragmas(WAL_JOURNAL_SIZE_LIMIT);

import { identityOfStoredContent } from "./identity.js";
import { log as loggerLog } from "../logger.js";

const STORAGE_DDL_V1 = `CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    parent_session_id   TEXT,
    fork_point_seq      INTEGER,
    protocol            TEXT,
    label               TEXT,
    title               TEXT,
    host_title          TEXT,
    namespace           TEXT NOT NULL DEFAULT 'proxy',
    origin              TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    next_block_id       INTEGER NOT NULL DEFAULT 1,
    next_run_id         INTEGER NOT NULL DEFAULT 1,
    meta_json           TEXT NOT NULL DEFAULT '{}',
    stats_json          TEXT NOT NULL DEFAULT '{}',
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    kstate_json         TEXT NOT NULL DEFAULT '{}',
    tail_json           TEXT NOT NULL DEFAULT '{}',
    ccr_json            TEXT,
    last_ingested_seq   INTEGER,
    orphans_json        TEXT
);

CREATE TABLE IF NOT EXISTS content (
    hash        TEXT PRIMARY KEY,
    byte_len    INTEGER NOT NULL,
    refcount    INTEGER NOT NULL DEFAULT 0,
    algo        TEXT NOT NULL DEFAULT 'sha256',
    bytes       BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    session_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    msg_id          TEXT NOT NULL,
    ref             TEXT,
    ref_num         INTEGER,
    role            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'message',
    content_hash    TEXT NOT NULL REFERENCES content(hash),
    identity        TEXT NOT NULL DEFAULT '',
    retired_at      INTEGER,
    PRIMARY KEY (session_id, seq),
    UNIQUE (session_id, msg_id, content_hash)
);

CREATE TABLE IF NOT EXISTS blocks (
    block_id            TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    ord                 INTEGER NOT NULL,
    start_seq           INTEGER NOT NULL,
    end_seq             INTEGER NOT NULL,
    start_ref           INTEGER,
    end_ref             INTEGER,
    tier                INTEGER NOT NULL,
    summary_hash        TEXT NOT NULL REFERENCES content(hash),
    one_hash            TEXT REFERENCES content(hash),
    supersedes_block_id TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    covered_hash        TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    PRIMARY KEY (session_id, block_id)
);

CREATE TABLE IF NOT EXISTS dead_refs (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    ref             TEXT NOT NULL,
    ref_num         INTEGER NOT NULL,
    recorded_at     INTEGER NOT NULL,
    PRIMARY KEY (session_id, ord)
);

-- Kernel ref ledger, verbatim: one row per messageRefs.byRaw entry, ord =
-- JSON key order of the persisted map. Dead refs (ghost ids with no message
-- row anywhere) live here forever — Kernel Contract: numbers are never
-- reused and death never removes the mapping (#2362/#2370).
CREATE TABLE IF NOT EXISTS refs (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    raw_id          TEXT NOT NULL,
    ref             TEXT NOT NULL,
    ref_num         INTEGER,
    PRIMARY KEY (session_id, ord),
    UNIQUE (session_id, raw_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
    cp_id           TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    seq_at          INTEGER NOT NULL,
    block_set_hash  TEXT NOT NULL,
    kind            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    pinned          INTEGER NOT NULL DEFAULT 0,
    label           TEXT,
    -- Phase 2 (#2671): the full serialized session record this checkpoint
    -- freezes, in the content CAS. The row owns one refcount on the blob;
    -- pinned checkpoints therefore outlive deleteSession (GC protection).
    state_hash      TEXT NOT NULL REFERENCES content(hash)
);

CREATE TABLE IF NOT EXISTS ccr_entries (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    ccr_key         TEXT NOT NULL,
    content_hash    TEXT NOT NULL REFERENCES content(hash),
    PRIMARY KEY (session_id, ord)
);

-- Identity index (#2960 R2.1): the (namespace, conversation_id) pair is the
-- durable identity of a conversation; sessions.session_id is the row key it
-- currently resolves to. While the v1 mapping is the identity (row key ==
-- conversation id), the table exists to make the uniqueness contract
-- load-bearing and to give row-key decoupling (R1/Phase 3) a migration-free
-- landing zone. ON CONFLICT DO NOTHING on ingest: first claimant wins and a
-- same-id re-ingest is a no-op.
CREATE TABLE IF NOT EXISTS conversations (
    namespace        TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    claimed_at       INTEGER NOT NULL,
    PRIMARY KEY (namespace, conversation_id)
) WITHOUT ROWID;

-- Per-session arbitrary state (#3069 v4): the escape hatch for host /
-- plugin / UI state that must survive restarts but is NOT kernel session
-- state. Keys are namespaced by convention ("r3:...", "web:...",
-- "plugin:<name>:..."); values are inline JSON (small, frequently
-- rewritten — the content CAS is wrong for this shape). Rows are swept
-- with the session (no pin semantics; checkpoint the session instead).
CREATE TABLE IF NOT EXISTS session_ext (
    session_id      TEXT NOT NULL,
    key             TEXT NOT NULL,
    value_json      TEXT NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (session_id, key)
) WITHOUT ROWID;

-- Namespaced key/value store (#3069 v4): cross-session state (lane-level,
-- per-agent, global). Lifecycle is caller-managed — deleting a session
-- never touches kv_store rows; namespace owners clean up after themselves
-- (e.g. "lane:<id>:*" when a lane retires).
CREATE TABLE IF NOT EXISTS kv_store (
    namespace       TEXT NOT NULL,
    key             TEXT NOT NULL,
    value_json      TEXT NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

-- #3762 media CAS: one row per (message, media blob) reference. The message
-- content stores {"$media": hash} in the imageBase64 slot; the bytes live in
-- the content CAS, refcounted by these mapping rows. Swept with the session
-- (and on idempotent re-receipt undo, same discipline as messages.content).
CREATE TABLE IF NOT EXISTS message_media (
    session_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    media_hash      TEXT NOT NULL REFERENCES content(hash),
    PRIMARY KEY (session_id, seq, media_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(session_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_dead_refs_session ON dead_refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_refs_session ON refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
`;

/** Applied inside one transaction whenever user_version < STORAGE_SCHEMA_VERSION. */
export function migrateSchema(db: {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
    transaction<T>(fn: () => T): T;
}): { from: number; to: number } {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const from = row?.user_version ?? 0;
    if (from >= STORAGE_SCHEMA_VERSION) return { from, to: from };
    let needV8Backfill = false;
    db.transaction(() => {
        if (from < 1) db.exec(STORAGE_DDL_V1);
        if (from < 2) {
            // v2 identity columns — probe first: dev-window builds whose V1
            // DDL already carried them must not fail on duplicate columns.
            const cols = (db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!cols.includes("namespace")) {
                db.exec("ALTER TABLE sessions ADD COLUMN namespace TEXT NOT NULL DEFAULT 'proxy'");
            }
            if (!cols.includes("origin")) {
                db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT");
            }
        }
        if (from < 3) {
            // v3 identity index (#2960 R2.1): create + backfill from the
            // sessions rows themselves. Both statements are idempotent
            // (IF NOT EXISTS / OR IGNORE) so any dev-window lib that already
            // carried the table re-lands cleanly.
            db.exec("CREATE TABLE IF NOT EXISTS conversations (\n                namespace        TEXT NOT NULL,\n                conversation_id  TEXT NOT NULL,\n                session_id       TEXT NOT NULL,\n                claimed_at       INTEGER NOT NULL,\n                PRIMARY KEY (namespace, conversation_id)\n            ) WITHOUT ROWID");
            db.exec("INSERT OR IGNORE INTO conversations (namespace, conversation_id, session_id, claimed_at) " +
                "SELECT namespace, session_id, session_id, updated_at FROM sessions");
        }
        if (from < 4) {
            // v4 extension namespaces (#3069): host/plugin state substrate.
            // Idempotent CREATEs so any dev-window lib that already carried
            // the tables re-lands cleanly.
            db.exec("CREATE TABLE IF NOT EXISTS session_ext (\n                session_id      TEXT NOT NULL,\n                key             TEXT NOT NULL,\n                value_json      TEXT NOT NULL,\n                updated_at      INTEGER NOT NULL,\n                PRIMARY KEY (session_id, key)\n            ) WITHOUT ROWID");
            db.exec("CREATE TABLE IF NOT EXISTS kv_store (\n                namespace       TEXT NOT NULL,\n                key             TEXT NOT NULL,\n                value_json      TEXT NOT NULL,\n                updated_at      INTEGER NOT NULL,\n                PRIMARY KEY (namespace, key)\n            ) WITHOUT ROWID");
        }
        if (from < 7) {
            // v7 media CAS (#3762): message→media mapping table. Idempotent
            // CREATE — pre-v7 rows keep their inline bytes and read back
            // verbatim (lazy: no backfill rehash).
            db.exec("CREATE TABLE IF NOT EXISTS message_media (\n                session_id      TEXT NOT NULL,\n                seq             INTEGER NOT NULL,\n                media_hash      TEXT NOT NULL REFERENCES content(hash),\n                PRIMARY KEY (session_id, seq, media_hash)\n            ) WITHOUT ROWID");
        }
        if (from < 5) {
            // v5 ingest watermark (#3133): additive NULLable column on
            // sessions. Probe first — same duplicate-column discipline as v2
            // (a dev-window build that already carried it re-lands cleanly).
            const cols = (db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!cols.includes("last_ingested_seq")) {
                db.exec("ALTER TABLE sessions ADD COLUMN last_ingested_seq INTEGER");
            }
        }
        if (from < 6) {
            // v6 reap journal (#3841): nullable column holding the block
            // contents of REAPED blocks (#2695 reap keeps blockContents
            // while state.blocks loses the entry — the journal carries that
            // content across restarts so reaped blocks never resurrect).
            // NULL = the session has no reaped orphans (pre-v6 rows keep
            // old behavior).
            const cols = (db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!cols.includes("orphans_json")) {
                db.exec("ALTER TABLE sessions ADD COLUMN orphans_json TEXT");
            }
        }
        if (from < 8) {
            // v8 position-independent identity + historian tombstones
            // (#4390). identity: the cross-save JOIN key (stored-bytes
            // serialization minus id/wireIndex) — content_hash stays the
            // byte-faithful CAS key. retired_at: the authoritative-set sweep
            // tombstones absent rows instead of deleting them (rewind/undo
            // history survives; getMessages filters retired rows).
            // Probe-first: dev-window builds whose DDL already carried the
            // columns must not fail on duplicate ALTERs (v2 discipline).
            const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!msgCols.includes("identity")) {
                db.exec("ALTER TABLE messages ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
            }
            if (!msgCols.includes("retired_at")) {
                db.exec("ALTER TABLE messages ADD COLUMN retired_at INTEGER");
            }
            db.exec("CREATE INDEX IF NOT EXISTS idx_messages_identity ON messages (session_id, msg_id, identity)");
            // The identity backfill runs AFTER this transaction (see
            // migrateV8Identities below), one session per transaction:
            // v0.1.207 loaded EVERY message's content bytes into memory in a
            // single .all() here inside one transaction, so multi-GB stores
            // OOM'd on first open — and because the user_version bump sat in
            // the same transaction, every subsequent open re-ran the whole
            // migration and re-OMM'd: permanently unopenable stores (#4677).
            needV8Backfill = true;
        }
        if (from < 9) {
            // v9 zero-ref collection index (#4796): gc()'s sweep and the
            // dry-run count address content BY refcount — without this index
            // every run full-scans the CAS table. Field report: 766K rows /
            // ~20 GB, one uncommitted `DELETE ... WHERE refcount <= 0` ran
            // 8 hours with zero committed rows, its WAL frames could never
            // checkpoint, and the held write lock starved live proxies. The
            // index makes candidate selection an index range scan; building
            // it once on an already-bloated db costs about what open-time
            // quick_check pays on EVERY open (#4175). Idempotent CREATE so a
            // dev-window lib that already carried it re-lands cleanly.
            db.exec("CREATE INDEX IF NOT EXISTS idx_content_refcount ON content(refcount)");
        }
    });
    if (needV8Backfill) migrateV8Identities(db);
    db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    return { from, to: STORAGE_SCHEMA_VERSION };
}

/** Same v7 shape as the wireIndex-split generations the polluted formula
 *  minted: same (msg_id, identity) after the strip → keep the FIRST arrival
 *  (lowest seq), drop the later duplicates and hand their CAS refs back —
 *  but streamed one session per transaction (#4677): a crash between sessions
 *  leaves the done sessions committed and user_version still 7, so the next
 *  open skips them (no rows with identity = '') and resumes; memory holds one
 *  page window + one session's keeper keys, never the store's bytes. Rows
 *  whose content bytes are missing from the CAS get the ABSENT marker — a
 *  "absent:" prefix — a string no sha256 hex output can equal (it carries a
 *  ':' and is shorter than 64 hex chars), so their session terminates
 *  instead of rescanning forever; joins treat it exactly like the v0.1.207
 *  leftover '' (neither can match a live-computed identity). Printable on
 *  purpose: node:sqlite truncates bound strings at an embedded NUL, so the
 *  \u0000-shaped marker silently bound as '' — the row looked unmigrated
 *  forever and got rescanned on every open. */
const ABSENT_IDENTITY = "absent:";
const V8_BACKFILL_PAGE = 500;

function migrateV8Identities(db: {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
    transaction<T>(fn: () => T): T;
}): void {
    const sessions = db.prepare("SELECT DISTINCT session_id FROM messages WHERE identity = ''").all() as { session_id: string }[];
    if (sessions.length === 0) return;
    // Backfilling a multi-GB store takes minutes-to-hours — log start,
    // steady-state progress and completion so a slow first open reads as
    // "migrating", not "hung" (#4677 fix direction 4).
    loggerLog(
        "info",
        `[storage] schema v8 migration: streaming identity backfill over ${sessions.length} session(s), one transaction per session (resumable — committed sessions are not reprocessed after a crash)`,
    );
    const total = sessions.length;
    let done = 0;
    const page = db.prepare(
        "SELECT m.seq AS seq, m.msg_id AS msg_id, m.content_hash AS content_hash, c.bytes AS content " +
            "FROM messages m LEFT JOIN content c ON c.hash = m.content_hash " +
            "WHERE m.session_id = ? AND m.identity = '' AND m.seq > ? ORDER BY m.seq LIMIT ?",
    );
    const upd = db.prepare("UPDATE messages SET identity = ? WHERE session_id = ? AND seq = ?");
    const decRef = db.prepare("UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0");
    const delMedia = db.prepare("DELETE FROM message_media WHERE session_id = ? AND seq = ?");
    const mediaOf = db.prepare("SELECT media_hash FROM message_media WHERE session_id = ? AND seq = ?");
    const delMsg = db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?");
    try {
        for (const s of sessions) {
            const keep = new Set<string>();
            const updates: { seq: number; identity: string }[] = [];
            const drops: { seq: number; content_hash: string }[] = [];
            let cursor = -1;
            for (;;) {
                const rows = page.all(s.session_id, cursor, V8_BACKFILL_PAGE) as {
                    seq: number;
                    msg_id: string;
                    content_hash: string;
                    content: string | Uint8Array | null;
                }[];
                if (rows.length === 0) break;
                for (const r of rows) {
                    cursor = r.seq;
                    // node:sqlite returns BLOB as Uint8Array — normalize to utf8
                    // before hashing (JSON.parse would coerce it to a comma list
                    // and silently hash the wrong input).
                    const identity =
                        r.content == null
                            ? ABSENT_IDENTITY
                            : identityOfStoredContent(
                                  typeof r.content === "string" ? r.content : Buffer.from(r.content).toString("utf8"),
                              );
                    const key = `${r.msg_id}\u0000${identity}`;
                    if (keep.has(key)) drops.push({ seq: r.seq, content_hash: r.content_hash });
                    else {
                        keep.add(key);
                        updates.push({ seq: r.seq, identity });
                    }
                }
                if (rows.length < V8_BACKFILL_PAGE) break;
            }
            // One transaction per session: keepers get their identity, the later
            // duplicates hand their media mappings + message rows + CAS refs back
            // (delete referencing rows FIRST — the #4242 discipline; refcount may
            // reach 0, the next gc run collects those content rows). The > 0
            // floor on decRef mirrors the releaseContent guards so an
            // already-corrupt ledger cannot go negative during migration.
            db.transaction(() => {
                for (const u of updates) upd.run(u.identity, s.session_id, u.seq);
                for (const d of drops) {
                    for (const mm of mediaOf.all(s.session_id, d.seq) as { media_hash: string }[]) {
                        decRef.run(mm.media_hash);
                    }
                    delMedia.run(s.session_id, d.seq);
                    delMsg.run(s.session_id, d.seq);
                    decRef.run(d.content_hash);
                }
            });
            done += 1;
            if (done % 100 === 0 || done === total) {
                loggerLog("info", `[storage] schema v8 migration: ${done}/${total} session(s) backfilled`);
            }
        }
    } catch (err) {
        loggerLog(
            "error",
            `[storage] schema v8 migration failed after ${done}/${total} session(s) — committed sessions keep their progress and the migration resumes automatically on the next open (no data loss, no need to touch user_version by hand). Error: ${String(err)}`,
        );
        throw err;
    }
}

/** Test-only alias of the fresh-install DDL (unused-export gate: INTERNAL_ONLY
 *  symbols fail CI; this one is consumed by tests/storage-unified.test.ts to
 *  synthesize faithful pre-#2963 v1 databases for the schema-v2 migration
 *  proof — the column set must track the real DDL, not a hand-copied stub). */
export const STORAGE_DDL_V1_FOR_TESTS = STORAGE_DDL_V1;
