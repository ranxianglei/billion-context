import { parseLegacyEnvelopeToWindow } from "../snapshot/identity.js";

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
//      - v10: immutable per-message local time-of-occurrence (#4313) —
//        messages gains nullable `ts` (epoch ms, stamped once at ingest,
//        never updated). No backfill: pre-feature rows stay NULL and keep
//        rendering without the tag's time attribute. Same both-directions
//        compatibility as v5 (older build ignores, newer build ALTERs).
//      - v11: FK child indexes on content.hash (#5539) — every column that
//        REFERENCES content(hash) gains its own index: messages(content_hash),
//        blocks(one_hash), blocks(summary_hash), ccr_entries(content_hash),
//        message_media(media_hash), checkpoints(state_hash). With
//        foreign_keys=ON, deleting a parent content row must prove no child
//        row still references it; without an index on the child column
//        SQLite full-scans the whole child table once PER deleted parent row.
//        releaseContent() removes one parent per released hash (~3K/turn on a
//        busy session), so every turn paid ~3K × 6 full scans — field report
//        #5539: 20–35 s/turn at ~18K messages, 4–5 s after adding the five
//        child indexes he listed (checkpoints.state_hash is this fix's sixth,
//        same mechanism, missed by the field audit). Same idempotent-CREATE
//        discipline as v9 (#4796); building them once costs about what
//        open-time quick_check pays on EVERY open (#4175). Additive-only: an
//        older build opening a v11 file ignores the extra indexes.
//      - v12: snapshot foundation v2 (#5874 P0, pure-incremental redesign
//        after the owner ruling) — ONE additive table (l1_world, the
//        stage-0 identity ledger; the original four-table plane was retired
//        before merge — superseded by docs/pr-6785-unified-storage-and-flows.md).
//        No backfill. Additive-only: an older build opening a v12 file
//        ignores the extra tables. (The fold-journal / egress-snapshot /
//        scope-rev tables that once lived here were retired before merge —
//        discussions/7439; the egress op-log below is self-contained.)
//        Applied PROBE-FIRST (table-existence check), NOT version-gated:
//        the unmerged fastpath re-land (#5855) numbers its two table groups
//        v12/v13 and landed them into a SHARED database first (field,
//        2026-11-08: user_version 13 + pf_* present, l1_world absent →
//        stage-0 died with "no such table: l1_world"). The probe makes
//        both merge orderings coexist; whichever branch lands second in
//        master still renumbers its constant mechanically (hygiene only —
//        the DDL shapes are independent).
export const STORAGE_SCHEMA_VERSION = 12;

/** #3250 → #7674: default for `journal_size_limit` is now UNLIMITED (0).
 *  The old 8 MiB default made the engine truncate the WAL file internally
 *  after every completed checkpoint — a reclaim that bypasses every
 *  JS-side guard and comes back to fetch frames out from under live peer
 *  connections sharing the directory (#2671 topology: five daemons, kill-9
 *  handovers). That floor-reclaim is the #7156 damage shape (pages
 *  double-allocated in the tail, "2nd reference to page", index pages
 *  corrupting before table pages): three field events on this host
 *  (2026-11-19, 2026-11-21, 2026-11-23) plus the #7156 incident itself,
 *  all on a growing multi-GB index with peers. The engine never shrinks a
 *  WAL it did not truncate, so without the limit the file sits at its
 *  historical high-water mark (field: 55 MiB flat — bounded, harmless,
 *  what opencode runs: 13 concurrent writers, 9.55 GB db, 4.7 MB WAL,
 *  zero corruption). Explicit reclamation stays available: operators set
 *  a positive cap via storage.walJournalSizeLimitBytes /
 *  BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES (resolved by src/knobs.ts) or
 *  shrink on demand with ?vacuum=full. */
export const WAL_JOURNAL_SIZE_LIMIT = 0;

/** Connection pragmas for every index.db opener. The journal cap is
 *  per-opener and only issued when positive (0 = unlimited, the SQLite
 *  default); the default list below is what short-lived openers (export
 *  fast path) and tests apply. */
export function storagePragmas(walJournalSizeLimitBytes: number): string[] {
    const pragmas = [
        // #3901/#3463: with auto_vacuum=INCREMENTAL, freed pages can be handed
        // back to the filesystem by `PRAGMA incremental_vacuum`
        // (gc({vacuum:"incremental"})) without the offline full rewrite.
        // MUST stay FIRST: SQLite only honours auto_vacuum while the database
        // file is still empty, and switching to WAL already writes page 1 —
        // set after journal_mode, a brand-new index.db silently stays at
        // auto_vacuum=0 and incremental_vacuum reclaims nothing. On an
        // existing file the pragma only arms the mode for this connection's
        // next full VACUUM: a database created with auto_vacuum=0 keeps that
        // layout until a one-time gc({vacuum:"full"}) / ?vacuum=full.
        "PRAGMA auto_vacuum = INCREMENTAL",
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA busy_timeout = 5000",
        "PRAGMA foreign_keys = ON",
    ];
    if (walJournalSizeLimitBytes > 0) {
        pragmas.push(`PRAGMA journal_size_limit = ${walJournalSizeLimitBytes}`);
    }
    return pragmas;
}

export const STORAGE_PRAGMAS = storagePragmas(WAL_JOURNAL_SIZE_LIMIT);

import { identityOfStoredContent } from "./identity.js";
import { log as loggerLog } from "../logger.js";

/** egress-mode table creation gate (KDD #25, discussions/7735). The CORE
 *  group — sessions (identity rows + R3 latch + point-fork children),
 *  session_ext (pf:state), kv_store (small config rows) — is created on
 *  EVERY instance; the LEGACY group (the 9 unified-projection tables) is
 *  created unless the store opens in egress mode (featureEnabled(
 *  "egressPlane")). Both groups are pure CREATE ... IF NOT EXISTS with the
 *  v12 (#5874) probe-first convergence: nothing is ever dropped, and a
 *  later open with the gate flipped recreates whatever is missing. */
const STORAGE_DDL_V1_CORE = `CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    parent_session_id   TEXT,
    fork_point_seq      INTEGER,
    fork_egress_watermark INTEGER,
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
    orphans_json        TEXT,
    r3_latched_at       INTEGER
);

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
`;

const STORAGE_DDL_V1_LEGACY = `CREATE TABLE IF NOT EXISTS content (
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
    ts              INTEGER,
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
    summary_bytes       BLOB,
    start_msgid         TEXT,
    end_msgid           TEXT,
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
    -- #6785 step 6: the ORIGINAL text behind entry.hash (byHash half of the
    -- content store). NULL only on pre-step-6 rows — their full ccr_json
    -- envelope still carries the text. See src/storage/slim.ts.
    orig_hash       TEXT REFERENCES content(hash),
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

-- #6785 review: the stage-0 plane resolves the conversation binding per turn
-- (store.ts snapSessRawOf: WHERE session_id = ?) — the PK cannot serve it.
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);

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
-- FK child indexes (#5539): with foreign_keys=ON, every DELETE from the
-- content parent proves no child row still references it by scanning each
-- child table UNLESS the child's ref column is indexed. releaseContent()
-- removes one parent per released hash (~3K/turn), so unindexed = ~3K × 6
-- full scans per turn (field: 20–35 s/turn at ~18K messages).
CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(content_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_one_hash ON blocks(one_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_summary_hash ON blocks(summary_hash);
CREATE INDEX IF NOT EXISTS idx_ccr_entries_content_hash ON ccr_entries(content_hash);
-- #6785 step 6: orig_hash is the SECOND FK child column of content(hash) —
-- #5539's discipline applies to it too, or every parent delete full-scans
-- ccr_entries (MySQL twin: idx_ccr_entries_orig_hash).
CREATE INDEX IF NOT EXISTS idx_ccr_entries_orig_hash ON ccr_entries(orig_hash);
CREATE INDEX IF NOT EXISTS idx_message_media_media_hash ON message_media(media_hash);
CREATE INDEX IF NOT EXISTS idx_checkpoints_state_hash ON checkpoints(state_hash);
-- v9's refcount sweep index (#4796) rides the legacy group too, so an
-- egress-mode fresh DB that later converges back to legacy (flag off)
-- gets it in the same probe pass instead of full-scanning on first gc().
CREATE INDEX IF NOT EXISTS idx_content_refcount ON content(refcount);
`;

/** The full v1 shape (core + legacy). INTERNAL_ONLY — migrateSchema uses
 *  _CORE/_LEGACY directly and the only consumer is the test alias below
 *  (STORAGE_DDL_V1_FOR_TESTS); the egress-mode open path splits it (see
 *  migrateSchema's opts). */
const STORAGE_DDL_V1 = STORAGE_DDL_V1_CORE + "\n" + STORAGE_DDL_V1_LEGACY;

/** #5874 snapshot foundation v2 (pure-incremental, 2026-11-15 owner ruling) —
 *  one additive table for the stage-0 identity ledger. The original four-table
 *  plane (snap_rows/snap_log/snap_ckpt, #5874 v1) was RETIRED before merge in
 *  favor of the pure-incremental skeleton: the per-position materialized state
 *  is re-derived from the append-only substrate (messages × blocks × refs ×
 *  fold journal) instead of being stored as its own updatable table. This DDL
 *  stays ADDITIVE + probe-first exactly as the plane's did (T1): fresh
 *  installs and in-place upgrades converge on the same shape, rollback is
 *  DROP + user_version rewind, and a sibling branch that consumed a version
 *  number after v11 (real-world 2026-11-08: #5855 landed the pf_* planes)
 *  coexists without renumbering.
 *
 *  l1_world: stage-0 identity ledger — the raw host session id (sess_raw)
 *  maps to the proxy's ledger identity (ledger_id = sessions.session_id).
 *  witness_probe is the sampled id fingerprint the arm decision was based on
 *  (composite-probe evidence). issued_at precedes armed_at until one full
 *  echo round validates the mapping (the "one round of arming" the proposal
 *  charges for a fresh identity). envelope_json/envelope_checksum carry the
 *  per-element msgid ENVELOPE ({id, pos} canon, #6181 §4.0) — the committed
 *  element-level world M2 delta inbound (src/snapshot/identity.ts matchWorld)
 *  reads/writes; the R3 breaker latch (r3_latched_at, #6181 M3) persists so a
 *  proxy restart does not re-arm a misbehaving host's envelope.
 *
 *  #7064 msgid-storage slimming (owner ruling 2026-11-17): the per-element
 *  world is a BOOKKEEPING CURSOR, not a full canon — tail_json/head_json
 *  hold the last/first id windows of the previous turn's host array
 *  (WORLD_TAIL_K/WORLD_HEAD_K, src/snapshot/identity.ts), count its length,
 *  max_pos the append-only pos frontier. The full {id,pos} envelope
 *  (envelope_json/envelope_checksum) is GONE: D1 (an id verdict never
 *  diverges) and D2 (conversation-bound sessions skip the verdict) made the
 *  full canon unnecessary. Pre-slimming rows migrate on first open
 *  (probe below). */
const L1WORLD_DDL_V12 = `-- #5874 snapshot foundation v2 (P0 schema, l1_world identity ledger).
CREATE TABLE IF NOT EXISTS l1_world (
    sess_raw       TEXT PRIMARY KEY,
    ledger_id      TEXT NOT NULL,
    witness_probe  TEXT NOT NULL,
    issued_at      INTEGER NOT NULL,
    armed_at       INTEGER,
    tail_json      TEXT,
    head_json      TEXT,
    count          INTEGER,
    max_pos        INTEGER,
    r3_latched_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_l1_ledger ON l1_world(ledger_id);
`;

/** #6785 step 7: the ORPHAN BLOCKS table. The orphan journal (#4216/#4242:
 *  blockContents entries whose block was reaped out of state.blocks) used to
 *  accumulate in sessions.orphans_json — an ever-growing JSON blob re-merged
 *  and re-written on every save of the session. It is now ONE ROW PER BLOCK
 *  (immutable content; a refreshed view for the same id is an UPDATE), the
 *  same table-ization as #6325's kstate/ccr columns. The column becomes a
 *  one-time migration source (legacy rows move onto the table on first
 *  ingest, then the column is cleared). Probed separately (probe-first,
 *  no version bump). */
const ORPHAN_BLOCKS_DDL = `-- #6785 step 7: one row per reaped block's retained contents.
CREATE TABLE IF NOT EXISTS orphan_blocks (
    session_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    one_json TEXT,
    full_json TEXT NOT NULL,
    PRIMARY KEY (session_id, block_id)
);
`;

/** #6785 step 8: one row per UNBOUNDED CompressionState field (the kstate
 *  slim split). The sessions.kstate_json column keeps only the bounded
 *  fields; these rows carry the rest (tokenSnapshot, tsStamps, viewLatches,
 *  absorbed, rules, …). The field set is FROZEN in src/storage/slim.ts
 *  (ROW_BACKED_KSTATE_FIELDS) and pinned by tests/issue5874-state-fields.
 *  Probe-first, no version bump. */
const STATE_FIELDS_DDL = `-- #6785 step 8: unbounded CompressionState fields off the sessions row.
CREATE TABLE IF NOT EXISTS state_fields (
    session_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (session_id, field)
);
`;

/** #6785 perf (proposal discussions/7398 + revised design discussions/7439,
 *  owner design 2026-11-20/21, MATERIALIZED form discussions/7773 owner
 *  ruling 2026-11-26): the EGRESS STATE LOG — the op-log view of the
 *  outbound conversation. DUAL TABLES:
 *  egress_flow is the RECORD — every I/D/U op in order, append-only,
 *  physically NEVER deleted (the B base row never existed in the 7773
 *  ruling: not written, not read, no letter in this CHECK); growth
 *  optimization is a separate, deferred project (#7475 family), nothing
 *  here ever prunes it. egress_state is the MATERIALIZED live view — one
 *  row per LIVE message (PK (session_id, msgid), pos = its position in the
 *  current view); I inserts (suffix shifts), U edits in place, D physically
 *  deletes the range. Serving reads are `ORDER BY pos` DIRECT reads — no
 *  replay, no compaction, no base concept. SELF-CONTAINED BYTES (ruling
 *  7439-1): the `bytes` column holds the message's final core JSON; replay
 *  needs only the flow table. TWO NUMBER COLUMNS on the state row (7773
 *  dual clocks of citation): log_seq = the number the I op assigned,
 *  IMMUTABLE (the row's anchor to its I twin in the flow — same msgid AND
 *  same I-time log_seq); num = the row's CURRENT canonical number (a U with
 *  an explicit num changes it; 0 = demoted/uncited — the system row is 0 by
 *  construction, outside the citation space). The number frontier is the
 *  flow's MAX(log_seq) — the ONLY source (the flow is never pruned). The
 *  state PK covers (session_id, msgid), so no separate state index. The
 *  flow index serves +U targeting and -D endpoint resolution.
 *  Probe-first, no version bump (the tables never shipped). */
const EGRESS_STATE_DDL = `-- #6785 perf (proposals discussions/7398 + 7439, materialized at 7773): op-log outbound view (flow record + materialized live state), self-contained bytes, canonical per-message numbers.
CREATE TABLE IF NOT EXISTS egress_state (
    session_id TEXT NOT NULL,
    msgid TEXT NOT NULL,
    pos INTEGER NOT NULL,
    log_seq INTEGER NOT NULL,
    num INTEGER NOT NULL,
    ref TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    type TEXT NOT NULL,
    role TEXT,
    ts INTEGER,
    sys_in TEXT,
    bytes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, msgid)
);
CREATE TABLE IF NOT EXISTS egress_flow (
    session_id TEXT NOT NULL,
    op_seq INTEGER NOT NULL,
    log_seq INTEGER,
    row_type TEXT NOT NULL CHECK (row_type IN ('I','D','U')),
    msgid TEXT,
    payload TEXT NOT NULL,
    bytes TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, op_seq)
);
CREATE INDEX IF NOT EXISTS idx_egress_flow_msgid ON egress_flow (session_id, msgid);
`;

/** #7577 (follow-up to #7439, owner design 2026-11-23): the BLOCK LIFECYCLE
 *  log — the op-log of the fold blocks, symmetric to the message egress log.
 *  egress_block_flow is append-only (row types I block-born / U
 *  block-state-change / D reaped — the D row carries the TERMINAL full
 *  snapshot, re-lettered from the old terminal-U at discussions/7773; there
 *  is no B base row and no compaction; NEVER deleted) and carries the
 *  bounded kstate residual snapshot in `kstate_json` on every row (D4: no
 *  fifth table — the sidecar rides the block-change rows, whose count = fold
 *  count, 2-3 orders of magnitude below the message count).
 *  egress_block_state is the MATERIALIZED live view (7773): one row per
 *  LIVE block (PK (session_id, block_id), pos = its position in the current
 *  set) — I inserts, U edits in place, D physically deletes the row;
 *  serving reads are `ORDER BY pos` DIRECT reads, no replay.
 *  SELF-CONTAINED BYTES (D2,
 *  ruling 7439-1): the one/full block content is inlined in the payload —
 *  zero content-CAS refs, zero hash columns. DUAL CLOCKS (owner ruling
 *  2026-11-24): the block tables number THEMSELVES (op_seq dense within
 *  egress_block_flow); flow_op_seq is the pointer to the flow clock (its
 *  MAX at write time) used for cross-table alignment at point forks — the
 *  original shared-clock design was rejected in review because it broke the
 *  flow's density invariant on the first fold. Probe-first, no version
 *  bump (the tables never shipped, like the egress pair). */
const EGRESS_BLOCK_DDL = `-- #7577: block lifecycle log (flow + materialized live state), self-contained bytes, kstate sidecar.
-- Dual clocks (owner ruling 2026-11-24): the block tables number THEMSELVES
-- (op_seq dense within egress_block_flow); flow_op_seq is the pointer to the
-- egress_flow clock (its MAX at write time) used for cross-table alignment at
-- point forks. egress_flow keeps its own exclusive number pool — untouched.
CREATE TABLE IF NOT EXISTS egress_block_flow (
    session_id TEXT NOT NULL,
    op_seq INTEGER NOT NULL,
    flow_op_seq INTEGER NOT NULL DEFAULT 0,
    row_type TEXT NOT NULL CHECK (row_type IN ('I','U','D')),
    block_id TEXT,
    payload TEXT NOT NULL,
    kstate_json TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, op_seq)
);
CREATE INDEX IF NOT EXISTS idx_egress_block_flow_block ON egress_block_flow (session_id, block_id);
CREATE TABLE IF NOT EXISTS egress_block_state (
    session_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    pos INTEGER NOT NULL,
    op_seq INTEGER NOT NULL,
    flow_op_seq INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, block_id)
);
`;

/** egress-mode table creation gate (KDD #25, discussions/7735).
 *  INTERNAL_ONLY — callers pass an object literal (structural typing);
 *  no other module imports the name. */
interface MigrateSchemaOptions {
    /** When false, the 9 legacy unified-projection tables are NOT created
     *  on a fresh database (only the core trio sessions/session_ext/
     *  kv_store plus the probed l1/orphan/state/egress groups follow the
     *  gates below). Already-created tables are NEVER dropped, and an
     *  open with the gate true recreates any missing legacy table — a
     *  fresh eg DB that later turns egressPlane off converges on the next
     *  open (probe-first, #5874 discipline). */
    legacyTables?: boolean;
}

/** Applied inside one transaction whenever user_version < STORAGE_SCHEMA_VERSION. */
export function migrateSchema(db: {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
    transaction<T>(fn: () => T): T;
}, opts: MigrateSchemaOptions = {}): { from: number; to: number } {
    const legacy = opts.legacyTables ?? true;
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const from = row?.user_version ?? 0;
    // #6785 review fix (owner): DROP COLUMN needs SQLite ≥ 3.35. The host
    // better-sqlite3 v7 in the engine ladder can carry SQLite 3.32 — there
    // the redundant columns simply STAY (every reader probes table_info and
    // every INSERT/UPDATE names its columns explicitly, so a kept column is
    // inert). Never throw from a migration because the host engine is old.
    let dropColumnOk = false;
    try {
        const v = (db.prepare("PRAGMA sqlite_version").get() as { sqlite_version: string } | undefined)?.sqlite_version ?? "";
        const m = v.match(/^(\d+)\.(\d+)/);
        if (m) dropColumnOk = Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 35);
    } catch { /* leave false — keep the columns */ }
    // v12 (#5874) is PROBE-FIRST, not version-gated. A sibling branch may
    // have consumed the version numbers after v11 for its own additive DDL
    // while ours was still unmerged — real-world 2026-11-08: #5855 landed
    // v12+v13 (the pf_* planes) into a SHARED database, and this branch's
    // old `if (from < 12)` block was skipped by the early return below, so
    // the plane died on first save with "no such table: l1_world". The DDL
    // is pure CREATE ... IF NOT EXISTS (no backfill, no rewrite of existing
    // rows), so it is safe to run at ANY from-version; probing for the
    // table itself (the discipline v2/v5/v6/v8 already use) makes both
    // merge orderings coexist without renumbering — the final master
    // version number stays a mechanical merge-time hygiene step.
    const hasL1World = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'l1_world'")
        .get();
    if (legacy && !hasL1World) db.transaction(() => db.exec(L1WORLD_DDL_V12));
    // #6785 step 7: orphan blocks — own probe (a db written between the
    // egress_snapshot and orphan_blocks landings picks it up here; fresh dbs
    // pass through — same discipline, no version bump).
    const hasOrphanBlocks = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orphan_blocks'")
        .get();
    if (legacy && !hasOrphanBlocks) db.exec(ORPHAN_BLOCKS_DDL);
    // #6785 step 8: kstate rows — own probe (same discipline, no bump).
    const hasStateFields = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_fields'")
        .get();
    if (legacy && !hasStateFields) db.exec(STATE_FIELDS_DDL);
    // egress-mode convergence (KDD #25, discussions/7735): an eg-mode fresh
    // DB skipped the legacy group at v1 time (and never takes the versioned
    // steps again once user_version reached the current one), so a flag-off
    // open must recreate the WHOLE missing group in one pass. The probe
    // asks for every table of the group; one exec converges any partial
    // state too (pure CREATE IF NOT EXISTS, #5874 discipline).
    const hasAllLegacyTables = ["content", "messages", "blocks", "dead_refs", "refs", "checkpoints", "ccr_entries", "conversations", "message_media"].every(
        (name) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined,
    );
    if (legacy && !hasAllLegacyTables) db.exec(STORAGE_DDL_V1_LEGACY);
    // #6785 perf (proposal discussions/7398): the egress state log — own
    // probe (same discipline, no version bump).
    const hasEgressState = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'egress_state'")
        .get();
    // #7574 item 10: the group is TWO tables + TWO indexes, so it is applied
    // inside ONE transaction. Executed bare (the driver autocommits each
    // statement of the batch separately) a crash after the first CREATE left
    // egress_state without egress_flow, and this table probe then said
    // "already there" on every later open — the half-built pair stayed
    // half-built forever. The probe now asks for BOTH tables, so a library
    // interrupted by the old code converges on its next open.
    const hasEgressFlow = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'egress_flow'")
        .get();
    if (!hasEgressState || !hasEgressFlow) db.transaction(() => db.exec(EGRESS_STATE_DDL));
    // 7439 ruling (canonical message number): a dev DB created with the
    // pre-numbering row shape (log_seq primary key, no op_seq column) is
    // replaced in place — the two tables NEVER shipped in any release, so
    // there is no user data and no migration path; a fresh recreate is the
    // whole migration.
    const egressCols = (db.prepare("PRAGMA table_info(egress_state)").all() as unknown as { name?: unknown }[])
        .map((c) => c.name);
    const egressFlowSql = String((db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'egress_flow'")
        .get() as { sql?: unknown } | undefined)?.sql ?? "");
    // 7773: the OLD shapes are (a) the pre-7773 op-copy state shape
    // (egress_state with an op_seq column — it was an op mirror, now it is
    // the materialized live view), (b) an interrupted state table that has
    // neither op_seq nor pos, and (c) any flow table whose row_type CHECK
    // still names the retired 'B'. The two tables NEVER shipped in any
    // release, so a fresh recreate is the whole migration for every variant
    // (the group is probed as a pair above, so the flow CHECK is replaced
    // together with the state shape whenever the state is old — the sql
    // check stays for a DB where only the flow row survived). The NEW shape
    // is recognized by the ABSENCE of op_seq plus the presence of pos —
    // that is the exact opposite of the old op-copy shape, never "old".
    const egressOldShape = (egressCols.length > 0 && (egressCols.includes("op_seq") || !egressCols.includes("pos")))
        || egressFlowSql.includes("('B','I','D','U')");
    if (egressOldShape) {
        // #7574 item 10: drop + recreate is one step (same transaction rule).
        db.transaction(() => {
            db.exec("DROP TABLE IF EXISTS egress_flow");
            db.exec("DROP TABLE IF EXISTS egress_state");
            db.exec("DROP INDEX IF EXISTS idx_egress_state_msgid");
            db.exec(EGRESS_STATE_DDL);
        });
    }
    // #7577: the block lifecycle log — own probe (same discipline, no bump).
    const hasEgressBlockFlow = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'egress_block_flow'")
        .get();
    const blockCols = hasEgressBlockFlow
        ? (db.prepare("PRAGMA table_info(egress_block_flow)").all() as unknown as { name?: unknown }[]).map((c) => c.name)
        : [];
    const blockStateCols = (db.prepare("PRAGMA table_info(egress_block_state)").all() as unknown as { name?: unknown }[])
        .map((c) => c.name);
    const blockFlowSql = String((db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'egress_block_flow'")
        .get() as { sql?: unknown } | undefined)?.sql ?? "");
    // 7773 old shapes: the shared-clock dev layout (no flow_op_seq), the
    // pre-7773 state replica (no pos column), or a flow whose row_type
    // CHECK still names the retired 'B'. Never-shipped dev tables; a dev DB
    // with any of them is dropped and recreated (one step, same #7574
    // rule). Data loss is the accepted dev cost.
    if (!hasEgressBlockFlow || !blockCols.includes("flow_op_seq") || (blockStateCols.length > 0 && !blockStateCols.includes("pos")) || blockFlowSql.includes("'B'")) {
        db.transaction(() => {
            db.exec("DROP TABLE IF EXISTS egress_block_flow");
            db.exec("DROP TABLE IF EXISTS egress_block_state");
            db.exec(EGRESS_BLOCK_DDL);
        });
    }
    // 2×2 (#5874 brief, element-level world): the L1 world carries the
    // per-element msgid ENVELOPE ({id, pos} canon, §4.0) in addition to the
    // session-level witness_probe. Pure additive probe-first ALTER (a dev
    // window that created l1_world before this column exists upgrades with
    // one ALTER; a fresh DB already has it from the DDL above). The 2×2
    // stage-0 (src/snapshot/identity.ts matchWorld) reads/writes these; the
    // session-level v1 path (#5901) leaves them NULL and is unaffected.
    const l1Cols = (db.prepare("PRAGMA table_info(l1_world)").all() as unknown as { name?: unknown }[])
        .map((c) => c.name);
    if (l1Cols.length > 0) {
        if (!l1Cols.includes("tail_json")) db.exec("ALTER TABLE l1_world ADD COLUMN tail_json TEXT");
        if (!l1Cols.includes("head_json")) db.exec("ALTER TABLE l1_world ADD COLUMN head_json TEXT");
        if (!l1Cols.includes("count")) db.exec("ALTER TABLE l1_world ADD COLUMN count INTEGER");
        if (!l1Cols.includes("max_pos")) db.exec("ALTER TABLE l1_world ADD COLUMN max_pos INTEGER");
        // #7064 slimming migration: a pre-slimming row's full envelope
        // (envelope_json) reshapes onto the window columns once — the
        // checksum column is dropped with it (D1: no verdict reads it).
        // Rows whose JSON does not parse degrade to a BLANK cursor (the
        // next turn re-issues the world; D1: bookkeeping, never a reject).
        if (l1Cols.includes("envelope_json")) {
            const legacy = (db.prepare(
                "SELECT sess_raw, envelope_json FROM l1_world WHERE envelope_json IS NOT NULL AND (tail_json IS NULL OR count IS NULL)"
            ).all() as unknown as { sess_raw: string, envelope_json: string | null }[]);
            for (const row of legacy) {
                let tail = "[]";
                let head = "[]";
                let count = 0;
                let maxPos = 0;
                try {
                    const win = parseLegacyEnvelopeToWindow(row.envelope_json ?? "[]");
                    tail = JSON.stringify(win.tailIds);
                    head = JSON.stringify(win.headIds);
                    count = win.count;
                    maxPos = win.maxPos;
                } catch {
                    // blank cursor — world re-issues on the next turn
                }
                db.prepare(
                    "UPDATE l1_world SET tail_json = ?, head_json = ?, count = ?, max_pos = ? WHERE sess_raw = ?"
                ).run(tail, head, count, maxPos, row.sess_raw);
            }
            // #6785 review fix (owner): on a < 3.35 host the reshaped data
            // stays in the NEW columns and the legacy columns are kept
            // (inert — readers probe table_info; the legacy SELECT above is
            // re-run only while rows still lack tail_json, which it now has).
            if (dropColumnOk) {
                db.exec("ALTER TABLE l1_world DROP COLUMN envelope_json");
                if (l1Cols.includes("envelope_checksum")) db.exec("ALTER TABLE l1_world DROP COLUMN envelope_checksum");
            }
        }
        // #6181 M3: the R3 breaker latch PERSISTS (a proxy restart must not
        // re-arm a misbehaving host's sid and re-400 the same broken
        // envelope); NULL/0 = not latched, else the epoch-ms of the latch.
        if (!l1Cols.includes("r3_latched_at")) db.exec("ALTER TABLE l1_world ADD COLUMN r3_latched_at INTEGER");
    }
    // #7439 step 6: blocks self-contained — the summary bytes and msgid
    // coordinates move INTO the blocks table (zero cross-table pointers).
    // PROBE-FIRST, not version-gated: the blocks table is a master table
    // (pre-existing), so a probe-first ALTER is the safe pattern.
    const blocksCols = (db.prepare("PRAGMA table_info(blocks)").all() as unknown as { name?: unknown }[])
        .map((c) => (typeof c?.name === "string" ? c.name : ""));
    if (blocksCols.length > 0) {
        if (!blocksCols.includes("summary_bytes")) db.exec("ALTER TABLE blocks ADD COLUMN summary_bytes BLOB");
        if (!blocksCols.includes("start_msgid")) db.exec("ALTER TABLE blocks ADD COLUMN start_msgid TEXT");
        if (!blocksCols.includes("end_msgid")) db.exec("ALTER TABLE blocks ADD COLUMN end_msgid TEXT");
    }
    // #6785 step 6: ccr_entries.orig_hash — PROBE-FIRST, not version-gated:
    // a db whose user_version is already at the current version (the #5855
    // field build wrote v12/v13 into shared databases) takes the early
    // return below and would never pick the column up if the probe sat
    // inside the transaction. Every pre-existing db must get it, so probe
    // unconditionally; a fresh db's table does not exist yet at this point
    // (PRAGMA table_info → empty) and the base DDL above already carries
    // the column. Pre-step-6 rows keep NULL; their full ccr_json envelope
    // remains the read authority (slim.ts). The index rides the same probe
    // (#5539 FK-child discipline; a lib that already carried the column but
    // not the key converges on the idempotent CREATE).
    const ccrCols = (db.prepare("PRAGMA table_info(ccr_entries)").all() as unknown as { name?: unknown }[])
        .map((c) => (typeof c?.name === "string" ? c.name : ""));
    if (ccrCols.length > 0) {
        if (!ccrCols.includes("orig_hash")) {
            db.exec("ALTER TABLE ccr_entries ADD COLUMN orig_hash TEXT REFERENCES content(hash)");
        }
        db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_entries_orig_hash ON ccr_entries(orig_hash)");
    }
    // 身份表收拢 (discussions/7591): the R3 breaker latch moves onto the
    // sessions row — the l1_world row it used to latch is a dead carrier
    // once egress-on stops writing that table. PROBE-FIRST, not version-
    // gated (same discipline as the ccr/blocks probes above): a db whose
    // user_version already sits at the current version still picks the
    // column up here; a fresh db already carries it from the base DDL.
    // NULL/0 = not latched, else the epoch-ms of the latch.
    const sessionCols = (db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name?: unknown }[])
        .map((c) => (typeof c?.name === "string" ? c.name : ""));
    if (sessionCols.length > 0 && !sessionCols.includes("r3_latched_at")) {
        db.exec("ALTER TABLE sessions ADD COLUMN r3_latched_at INTEGER");
    }
    // #7658: the egress fork point (FLOW-clock watermark the four egress
    // tables were copied at) — probe-first, same discipline as r3_latched_at.
    if (sessionCols.length > 0 && !sessionCols.includes("fork_egress_watermark")) {
        db.exec("ALTER TABLE sessions ADD COLUMN fork_egress_watermark INTEGER");
    }
    if (from >= STORAGE_SCHEMA_VERSION) return { from, to: from };
    let needV8Backfill = false;
    db.transaction(() => {
        if (from < 1) {
            db.exec(STORAGE_DDL_V1_CORE);
            if (legacy) db.exec(STORAGE_DDL_V1_LEGACY);
        }
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
        if (from < 3 && legacy) {
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
        if (from < 7 && legacy) {
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
        if (from < 8 && legacy) {
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
        if (from < 9 && legacy) {
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
        if (from < 10 && legacy) {
            // v10 (#4313): immutable message wall-clock stamp. Nullable, no
            // backfill — pre-feature rows read NULL and render without the
            // time attribute (legacy bytes unchanged). Probe-first like v8.
            const tsCols = (db.prepare("PRAGMA table_info(messages)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!tsCols.includes("ts")) {
                db.exec("ALTER TABLE messages ADD COLUMN ts INTEGER");
            }
        }
        // #6785 step 6: ccr_entries.orig_hash — probe-first, moved ABOVE the
        // version early return (a #5855-era db already at user_version 12
        // must pick the column up; the in-transaction probe it was at never
        // ran there). See the probe-first note before the early return.
        if (from < 11 && legacy) {
            // v11 (#5539): FK child indexes on content.hash — see the header
            // note and the DDL comment above for the mechanism and field
            // evidence. Idempotent CREATEs, same discipline as v9; a
            // dev-window lib that already carried them re-lands cleanly.
            db.exec("CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(content_hash)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_one_hash ON blocks(one_hash)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_summary_hash ON blocks(summary_hash)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_entries_content_hash ON ccr_entries(content_hash)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_message_media_media_hash ON message_media(media_hash)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_checkpoints_state_hash ON checkpoints(state_hash)");
        }
        // v12 (#5874 P0): snapshot-table compression foundation — ensured
        // PROBE-FIRST above (coexists with sibling-branch DDL that consumed
        // the v12/v13 numbers, see the note before the early return).
        // Pure additivity: no backfill, no rewrite of existing rows.
        // Rollback = DROP the tables and set user_version back
        // (T1 pins the byte-identical behavior in both directions).
    });
    if (needV8Backfill) migrateV8Identities(db);
    db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    // #7574: idx_conversations_session ships inside STORAGE_DDL_V1, so only
    // a database BORN on a current build ever had it — a library that
    // climbed to its user_version from an earlier release took the versioned
    // steps above and never the v1 DDL, so every conversations(session_id)
    // lookup stayed a full scan. Probe the index itself and create it on the
    // first open that misses it (the table exists on every path: v1 DDL on a
    // fresh file, the `from < 3` step, or already).
    const hasConversations = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
        .get();
    const hasConversationsIndex = hasConversations ? db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_session'")
        .get() : undefined;
    if (hasConversations && hasConversationsIndex === undefined) {
        db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id)");
    }
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
