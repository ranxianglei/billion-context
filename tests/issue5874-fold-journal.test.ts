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
    foldUnpins,
    type FoldJournalRow,
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
    (db.prepare("SELECT jseq, block_id, start_seq, end_seq, covered_ids, input_hash FROM fold_journal WHERE session_id = ? ORDER BY jseq").all(sid) as unknown) as
        Array<{ jseq: number; block_id: string; start_seq: number; end_seq: number; covered_ids: string; input_hash: string }>;

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
            "  envelope_json TEXT,\n" +
            "  envelope_checksum TEXT,\n" +
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
    assert.equal(r.start_seq, 0);
    assert.equal(r.end_seq, 3);
    assert.deepEqual(JSON.parse(r.covered_ids), covered);
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

test("#5874 T3: the stored input_hash re-derives over retired rows and moves on a new generation (+/-)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-t3-"));
    const path = join(dir, "snap.db");
    const store = open(dir);
    assert.ok(store.ingestSession(planIngest(plainSession("sess-fj", 6)), undefined, { completeLog: true }));

    const covered = ["m1", "m2", "m3", "m4"];
    const { session } = foldBlock(["m1", "m2", "m3", "m4", "m5", "m6"], covered);
    assert.ok(store.ingestSession(planIngest(session), undefined, { completeLog: true }));

    let raw = rawDb(path);
    const stored = (JSEQ_ROWS(raw, "sess-fj")[0]).input_hash;
    // Steady state (-): re-derivation matches the stored anchor byte for
    // byte — the aggregate spans ALL generations of the covered ids.
    assert.equal(foldInputHash(raw, "sess-fj", covered), stored, "hash stable at steady state");
    raw.close();

    // The user revises an EARLIER message (m2): same id, new bytes → a new
    // identity lands a SECOND generation row for m2 — the aggregate must
    // move, which is the unpin detector.
    const revised = plainSession("sess-fj", 7);
    (revised.lastMessages as unknown as Array<{ id: string; text: string }>).find((m) => m.id === "m2")!.text = "m2-REVISED";
    assert.ok(store.ingestSession(planIngest(revised), undefined, { completeLog: true }));

    raw = rawDb(path);
    const moved = foldInputHash(raw, "sess-fj", covered);
    assert.notEqual(moved, stored, "hash moves when a covered id gains a new generation");
    raw.close();
});

test("#5874 T4: foldUnpins — the four +/- verdicts (pure)", () => {
    const mkRow = (blockId: string, ids: string[], startSeq: number, endSeq: number): FoldJournalRow => ({
        sessionId: "s",
        jseq: 1,
        blockId,
        startSeq,
        endSeq,
        coveredIds: ids,
        inputHash: "h",
        createdAt: 1,
    });
    const journal = [mkRow("blk", ["m1", "m2"], 1, 2)];
    const allRetired: Array<{ msgId: string; seq: number }> = [];
    const ACTIVE = new Set(["blk"]);

    // (-) steady state: active block, every covered row retired → stays pinned.
    assert.equal(foldUnpins(journal, allRetired, ACTIVE).size, 0);

    // (+1) the block died (superseded/reaped) → unpin: the ids were never
    // replaced in history; they are live again and the summary is gone.
    assert.deepEqual(foldUnpins(journal, allRetired, new Set<string>()), new Set(["blk"]));

    // (+2) a covered id is live AGAIN WITHIN the interval — the #4390 in-place
    // reactivation: a rewind rewrote history back through the fold.
    const inInterval = [{ msgId: "m2", seq: 2 }];
    assert.deepEqual(foldUnpins(journal, inInterval, ACTIVE), new Set(["blk"]));

    // (+3) a covered id re-emerges past end_seq — an edit produced a new
    // generation for a message the fold claimed.
    const pastEnd = [{ msgId: "m1", seq: 9 }];
    assert.deepEqual(foldUnpins(journal, pastEnd, ACTIVE), new Set(["blk"]));
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
