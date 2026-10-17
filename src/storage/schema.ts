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
//      - v6: host message ids (#3464 R1) — messages gains `host_id` /
//        `host_slot` (the plugin-stamped host identity of the WIRE message
//        that produced the row; NULL on lanes without a host id channel)
//        plus partial UNIQUE index idx_messages_host(session_id, host_id,
//        host_slot) WHERE host_id IS NOT NULL — under a stamped lane the
//        host key is the row's identity, so a byte drift (marker strip,
//        protocol re-serialization) refreshes ONE row instead of minting a
//        twin. Both directions compatible: an older build opening a v6
//        file no-ops at the version gate (extra columns/index ignored); a
//        newer build upgrades a v5 file with two probe-guarded ALTERs and
//        one CREATE UNIQUE INDEX IF NOT EXISTS.
export const STORAGE_SCHEMA_VERSION = 6;

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
    ];
}

export const STORAGE_PRAGMAS = storagePragmas(WAL_JOURNAL_SIZE_LIMIT);

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
    last_ingested_seq   INTEGER
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
    host_id         TEXT,
    host_slot       INTEGER,
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

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(session_id, msg_id);
-- #3464 (R1): on stamped lanes the host key IS the row identity — one wire
-- message may refresh its bytes across resends (marker strip, re-serialization)
-- but must never mint a second row. Partial: NULL host_id rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_host ON messages(session_id, host_id, host_slot) WHERE host_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_dead_refs_session ON dead_refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_refs_session ON refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
`;

/** Applied inside one transaction whenever user_version < STORAGE_SCHEMA_VERSION. */
export function migrateSchema(db: {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
    transaction<T>(fn: () => T): T;
}): { from: number; to: number } {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const from = row?.user_version ?? 0;
    if (from >= STORAGE_SCHEMA_VERSION) return { from, to: from };
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
            // v6 host message ids (#3464 R1): two additive NULLable columns
            // on messages + the partial host-key uniqueness index. Same
            // probe-guarded ALTER discipline as v2/v5; the index create is
            // idempotent, so fresh-install DDL that already carries both
            // re-lands cleanly.
            const mcols = (db.prepare("PRAGMA table_info(messages)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!mcols.includes("host_id")) {
                db.exec("ALTER TABLE messages ADD COLUMN host_id TEXT");
            }
            if (!mcols.includes("host_slot")) {
                db.exec("ALTER TABLE messages ADD COLUMN host_slot INTEGER");
            }
            db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_host ON messages(session_id, host_id, host_slot) WHERE host_id IS NOT NULL");
        }
        db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    });
    return { from, to: STORAGE_SCHEMA_VERSION };
}

/** Test-only alias of the fresh-install DDL (unused-export gate: INTERNAL_ONLY
 *  symbols fail CI; this one is consumed by tests/storage-unified.test.ts to
 *  synthesize faithful pre-#2963 v1 databases for the schema-v2 migration
 *  proof — the column set must track the real DDL, not a hand-copied stub). */
export const STORAGE_DDL_V1_FOR_TESTS = STORAGE_DDL_V1;
