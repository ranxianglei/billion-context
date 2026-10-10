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

const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_PRAGMAS = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA foreign_keys = ON",
] as const;

const STORAGE_DDL_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    parent_session_id   TEXT,
    fork_point_seq      INTEGER,
    protocol            TEXT,
    label               TEXT,
    title               TEXT,
    host_title          TEXT,
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
    ccr_json            TEXT
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
    PRIMARY KEY (session_id, seq),
    UNIQUE (session_id, msg_id, content_hash)
);

CREATE TABLE IF NOT EXISTS blocks (
    block_id            TEXT PRIMARY KEY,
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
    payload_json        TEXT NOT NULL
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
    pinned          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    last_seen       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ccr_entries (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    ccr_key         TEXT NOT NULL,
    content_hash    TEXT NOT NULL REFERENCES content(hash),
    PRIMARY KEY (session_id, ord)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(session_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_dead_refs_session ON dead_refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_refs_session ON refs(session_id, ord);
`;

/** Applied inside one transaction whenever user_version < STORAGE_SCHEMA_VERSION. */
export function migrateSchema(db: {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown };
    transaction<T>(fn: () => T): T;
}): { from: number; to: number } {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const from = row?.user_version ?? 0;
    if (from >= STORAGE_SCHEMA_VERSION) return { from, to: from };
    db.transaction(() => {
        if (from < 1) db.exec(STORAGE_DDL_V1);
        db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    });
    return { from, to: STORAGE_SCHEMA_VERSION };
}
