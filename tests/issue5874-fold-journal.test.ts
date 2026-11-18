import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.BILI_PERSIST_ZSTD ??= "0";

import {
    STORAGE_SCHEMA_VERSION,
} from "../src/storage/schema.js";
import {
    foldInputHash,
    foldJournalRows,
    foldUnpins,
} from "../src/storage/snap.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.js";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.js";
import { UnifiedStore } from "../src/storage/store.js";

const open = (dir: string): UnifiedStore => UnifiedStore.open(join(dir, "snap.db"));

function msgIds(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `m${i + 1}`);
}

function plainSession(id: string, n: number): LegacySessionLike {
    const ids = msgIds(n);
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const lastMessages = ids.map((id, i) => ({
        id,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        contentType: "text" as const,
        text: `${id}-text`,
    }));
    for (const [i, id] of ids.entries()) {
        const ref = 1000 + i + 1;
        byRaw[id] = String(ref);
        byRef[String(ref)] = String(i + 1);
    }
    return {
        id,
        createdAt: 1000,
        lastSeen: 2000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw, byRef },
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** Production fold shape: the kernel keeps the covered ids in the transcript
 *  (tagged), so the folded log = the summary PLUS every original message —
 *  ids and content unchanged, the summary appended as a new identity. The
 *  fold row's bounds resolve against those still-live covered rows; a
 *  covered row only dies LATER (a second fold supersedes it), which is what
 *  the read-side unpin detector then sees. */
function foldBlock(ids: string[], covered: string[]): { session: LegacySessionLike; blockId: string; covered: string[] } {
    const blockId = "blk-f1";
    const session = plainSession("sess-fj", ids.length);
    session.state = {
        ...session.state,
        blocks: [
            {
                blockId,
                runId: "run-1",
                createdAt: 1000,
                tier: 1,
                active: true,
                summary: "summary of " + covered.join(","),
                effectiveMessageIds: [...covered],
                directMessageIds: [...covered],
                directBlockIds: [],
                compressedTokens: covered.length * 10,
                survivedCount: ids.length - covered.length,
                generation: "young",
            },
        ],
        nextBlockId: 2,
    };
    // The summary is a NEW message (next id in the space).
    const summaryId = `m${ids.length + 1}`;
    const byRaw = (session.state.messageRefs.byRaw as Record<string, string>);
    const byRef = (session.state.messageRefs.byRef as Record<string, string>);
    byRaw[summaryId] = String(1000 + ids.length + 1);
    byRef[String(1000 + ids.length + 1)] = summaryId;
    session.lastMessages = [
        ...(session.lastMessages ?? []),
        { id: summaryId, role: "assistant" as const, contentType: "text" as const, text: "summary" },
    ];
    return { session, blockId, covered };
}

function rawDb(path: string): SqliteDatabase {
    return openSqliteDatabase(path).db as unknown as SqliteDatabase;
}


const JSEQ_ROWS = (db: SqliteDatabase, sid: string) =>
    (db.prepare("SELECT jseq, block_id, start_seq, end_seq, input_hash FROM fold_journal WHERE session_id = ? ORDER BY jseq").all(sid) as unknown) as
        Array<{ jseq: number; block_id: string; start_seq: number; end_seq: number; input_hash: string }>;

/** The live seq range [min, max] of the given ids (#7064: the journal row's
 *  bounds REPLACE the covered-id list — the range is how the read side
 *  re-derives everything the id list used to say). */
const SEQ_RANGE = (db: SqliteDatabase, sid: string, ids: string[]): [number, number] => {
    const row = db.prepare(
        `SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM messages WHERE session_id = ? AND retired_at IS NULL AND msg_id IN (${ids.map(() => "?").join(",")})`,
    ).get(sid, ...ids) as { lo: number; hi: number };
    return [row.lo, row.hi];
};

const LIVE_IDS = (db: SqliteDatabase, sid: string) =>
    (db.prepare("SELECT msg_id FROM messages WHERE session_id = ? AND retired_at IS NULL ORDER BY seq").all(sid) as unknown) as Array<{ msg_id: string }>;

test("#5874 T1: fold_journal lands probe-first on fresh and l1-only v12 dbs (no version bump)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-t1-"));
    const path = join(dir, "fresh.db");
    // Probe-first DDL runs on the store open path, not the raw driver.
    const fresh = UnifiedStore.open(path);
    fresh.close();
    let db = rawDb(path);
    assert.ok(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fold_journal'").get() as { name: string } | undefined),
        "fresh db has fold_journal",
    );
    assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        STORAGE_SCHEMA_VERSION,
    );
    db.close();

    // An l1-only v12 db (written between the two landings) upgrades additively.
    const l1Path = join(dir, "l1-only.db");
    const l1 = rawDb(l1Path);
    l1.exec(
        "CREATE TABLE IF NOT EXISTS l1_world (\n" +
            "  sess_raw TEXT PRIMARY KEY,\n" +
            "  ledger_id TEXT NOT NULL,\n" +
            "  witness_probe TEXT NOT NULL,\n" +
            "  issued_at INTEGER NOT NULL,\n" +
            "  armed_at INTEGER,\n" +
            "  tail_json TEXT,\n" +
            "  head_json TEXT,\n" +
            "  count INTEGER,\n" +
            "  max_pos INTEGER,\n" +
            "  r3_latched_at INTEGER\n" +
            ")",
    );
    l1.exec("PRAGMA user_version = 12");
    l1.close();
    const l1st = UnifiedStore.open(l1Path);
    l1st.close();
    const db2 = rawDb(l1Path);
    assert.ok(
        (db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fold_journal'").get() as { name: string } | undefined),
        "probe-first adds fold_journal to the l1-only db",
    );
    assert.equal(
        (db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        12,
        "no version bump",
    );
    db2.close();
});

test("#5874 T2: a new fold block writes exactly one journal row; re-ingest is idempotent (+/-)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-t2-"));
    const path = join(dir, "snap.db");
    const store = open(dir);

    // Seed: the full conversation is ingested first.
    assert.ok(store.ingestSession(planIngest(plainSession("sess-fj", 6)), undefined, { completeLog: true }));
    let raw = rawDb(path);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM fold_journal").get() as { n: number }).n, 0);
    raw.close();

    // Fold: blk-f1 covers m1-m4; the folded log still carries every id.
    const { session, blockId, covered } = foldBlock(["m1", "m2", "m3", "m4", "m5", "m6"], ["m1", "m2", "m3", "m4"]);
    assert.ok(store.ingestSession(planIngest(session), undefined, { completeLog: true }));

    raw = rawDb(path);
    const rows = JSEQ_ROWS(raw, "sess-fj");
    assert.equal(rows.length, 1, "exactly one journal row");
    const r = rows[0];
    assert.equal(r.block_id, blockId);
    // #7064: no covered_ids column — the bounds ARE the coverage. The range
    // of the covered ids' live rows is exactly [r.start_seq, r.end_seq].
    const [lo, hi] = SEQ_RANGE(raw, "sess-fj", covered);
    assert.equal(r.start_seq, lo, "start_seq = min live seq of the covered ids");
    assert.equal(r.end_seq, hi, "end_seq = max live seq of the covered ids");
    assert.ok(r.input_hash.length >= 64, "input_hash is a sha256 digest");
    // Steady state: the covered rows stay LIVE (tagged in the transcript);
    // only the summary is new.
    assert.deepEqual(
        LIVE_IDS(raw, "sess-fj").map((x) => x.msg_id).sort(),
        ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].sort(),
    );
    raw.close();

    // Re-ingest the identical folded state: the UNIQUE(session_id, block_id)
    // keeps the FIRST fold row — no second row, no rewritten history.
    assert.ok(store.ingestSession(planIngest(session), undefined, { completeLog: true }));
    raw = rawDb(path);
    const again = JSEQ_ROWS(raw, "sess-fj");
    assert.equal(again.length, 1, "re-ingest is idempotent");
    assert.equal(again[0].input_hash, r.input_hash);
    assert.equal(again[0].jseq, r.jseq);
    raw.close();
});

test("#5874 T3: the stored input_hash re-derives over the RANGE and moves on a new generation (+/-) (#7064)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-t3-"));
    const path = join(dir, "snap.db");
    const store = open(dir);
    assert.ok(store.ingestSession(planIngest(plainSession("sess-fj", 6)), undefined, { completeLog: true }));

    const covered = ["m1", "m2", "m3", "m4"];
    const { session } = foldBlock(["m1", "m2", "m3", "m4", "m5", "m6"], covered);
    assert.ok(store.ingestSession(planIngest(session), undefined, { completeLog: true }));

    let raw = rawDb(path);
    const stored = (JSEQ_ROWS(raw, "sess-fj")[0]).input_hash;
    // Steady state (-): re-derivation over the STORED bounds (no id list
    // anywhere) matches the stored anchor byte for byte.
    const r0 = JSEQ_ROWS(raw, "sess-fj")[0];
    assert.equal(foldInputHash(raw, "sess-fj", r0.start_seq, r0.end_seq), stored, "hash stable at steady state (range re-derivation)");
    raw.close();

    // The user revises an EARLIER message (m2): same id, new bytes → the old
    // in-range generation is retired and the new one lands past the range —
    // the range aggregate must move, which is the unpin detector.
    const revised = plainSession("sess-fj", 7);
    (revised.lastMessages as unknown as Array<{ id: string; text: string }>).find((m) => m.id === "m2")!.text = "m2-REVISED";
    assert.ok(store.ingestSession(planIngest(revised), undefined, { completeLog: true }));

    raw = rawDb(path);
    const r1 = JSEQ_ROWS(raw, "sess-fj")[0];
    // #7064: the hash is a BYTE-FAITHFUL range fingerprint — it re-derives
    // over the covered rows as they are stored (no retired filter: a
    // retired row's bytes still belong to the fold's input record). The
    // EDIT signal is the unpin detector (foldUnpins), not the hash: the
    // rewrite retires the in-range m2 generation and mints the new one
    // PAST end_seq — a covered id re-emerging past the range unpins the
    // fold (its covered originals no longer render verbatim).
    const stillLiveInRange = raw.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL AND msg_id = 'm2' AND seq BETWEEN ? AND ?",
    ).get("sess-fj", r1.start_seq, r1.end_seq) as { n: number };
    assert.equal(stillLiveInRange.n, 0, "the in-range m2 generation is retired by the rewrite");
    const pastRange = raw.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL AND msg_id = 'm2' AND seq > ?",
    ).get("sess-fj", r1.end_seq) as { n: number };
    assert.ok(pastRange.n >= 1, "the new m2 generation lands past the range");
    const un = foldUnpins(raw, foldJournalRows(raw, "sess-fj"), new Set(["blk-f1"]));
    assert.ok(un.has("blk-f1"), "past-range re-emergence of a covered id unpins the fold");
    raw.close();
});

test("#5874 T4: foldUnpins — the four +/- verdicts (db range probes, #7064)", () => {
    // Build a store with a 6-message session and one active fold over m1-m2
    // (bounds 1..2). The journal comes straight out of the table — no id
    // lists anywhere (the range is the coverage).
    const dir = mkdtempSync(join(tmpdir(), "fj-t4-"));
    const path = join(dir, "snap.db");
    const store = open(dir);
    assert.ok(store.ingestSession(planIngest(plainSession("sess-fj", 6)), undefined, { completeLog: true }));
    const { session, blockId } = foldBlock(["m1", "m2", "m3", "m4", "m5", "m6"], ["m1", "m2"]);
    assert.ok(store.ingestSession(planIngest(session), undefined, { completeLog: true }));

    const db = rawDb(path);
    // The raw driver handle shares the file, but the store holds its own
    // connection — run the probes through the store's engine via the
    // exported helper (it takes any DbLike-shaped handle). foldJournalRows
    // maps the snake_case row to the camelCase FoldJournalRow surface.
    const journal = foldJournalRows(db, "sess-fj");
    // The raw driver handle shares the file, but the store holds its own
    // connection — run the probes through the store's engine via the
    // exported helper (it takes any DbLike-shaped handle).
    const retire = (id: string) =>
        db.prepare("UPDATE messages SET retired_at = 1 WHERE session_id = 'sess-fj' AND msg_id = ? AND retired_at IS NULL").run(id);
    const revive = (id: string) =>
        db.prepare("UPDATE messages SET retired_at = NULL WHERE session_id = 'sess-fj' AND msg_id = ?").run(id);
    const ACTIVE = new Set([blockId]);

    try {
        // Steady state of the PRODUCTION shape: the covered rows are still
        // live (tagged in the transcript) → the fold is UNPINNED (the
        // originals still render).
        assert.deepEqual(foldUnpins(db, journal, ACTIVE), new Set([blockId]), "covered rows live in-range → unpinned (still render)");

        // (+) the block died (superseded/reaped) → unpin regardless of the
        //  row state.
        assert.deepEqual(foldUnpins(db, journal, new Set<string>()), new Set([blockId]), "inactive block → unpinned");

        // PINNED state: the covered rows retire (a later log drops them) and
        // nothing re-emerges → everything stays pinned.
        retire("m1");
        retire("m2");
        assert.equal(foldUnpins(db, journal, ACTIVE).size, 0, "retired covered rows, no re-emergence → pinned");

        // (+2) a row is live AGAIN WITHIN the interval (a #4390 in-place
        //  reactivation — a rewind rewrote history back through the fold).
        revive("m2");
        assert.deepEqual(foldUnpins(db, journal, ACTIVE), new Set([blockId]), "in-range live row → unpinned");
        retire("m2");

        // (+3) a covered id re-emerges PAST end_seq — an edit produced a new
        //  generation for a message the fold claimed.
        const re = plainSession("sess-fj", 7);
        (re.lastMessages as unknown as Array<{ id: string; text: string }>).find((m) => m.id === "m1")!.text = "m1-REVISED";
        assert.ok(store.ingestSession(planIngest(re), undefined, { completeLog: true }));
        assert.deepEqual(foldUnpins(db, journal, ACTIVE), new Set([blockId]), "past-range live row for a range id → unpinned");
    } finally {
        db.close();
        store.close();
    }
});

test("#5874 T5: deleteSession cascades the journal (T6-style)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-t5-"));
    const path = join(dir, "snap.db");
    const store = open(dir);
    assert.ok(store.ingestSession(planIngest(plainSession("sess-fj", 4)), undefined, { completeLog: true }));
    const { session } = foldBlock(["m1", "m2", "m3", "m4"], ["m1", "m2", "m3", "m4"]);
    assert.ok(store.ingestSession(planIngest(session), undefined, { completeLog: true }));

    let raw = rawDb(path);
    assert.ok((raw.prepare("SELECT COUNT(*) AS n FROM fold_journal").get() as { n: number }).n >= 1);
    raw.close();

    store.deleteSession("sess-fj");
    raw = rawDb(path);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM fold_journal").get() as { n: number }).n, 0);
    raw.close();
});
