/**
 * blocks self-contained read/write side (discussions/7439 ruling 2, PR #7553):
 * the blocks table carries its own `summary_bytes` (+ the one-time msgid
 * coordinate pair `start_msgid`/`end_msgid`) so a block is readable WITHOUT
 * the global content table:
 *   1. fresh-install regression: a brand-new database's base DDL carries the
 *      three columns (the probe-first ALTER is a no-op on a fresh db), so the
 *      FIRST fold ingest cannot hit "no such column";
 *   2. the reader prefers the inline bytes; a corrupted content row no longer
 *      breaks block reads; legacy rows (NULL inline) keep the content-table
 *      read;
 *   3. msgid coordinates: a session the egress flow recorded gets
 *      start_msgid/end_msgid = the covered ids' min/max position in the flow
 *      view; a session with no flow stays NULL;
 *   4. backfill + steady state: a legacy row re-stamps on the next ingest,
 *      after which the inline bytes win over the content table again.
 * Both directions asserted (#3617): inline bytes win AND the legacy
 * fallback still reads from content.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.js";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import type { BlockRow, IngestSessionInput } from "../src/storage/store.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.js";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-blocks-selfcontained-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";
// msgid coordinates are taken from the op log only while the plane is on (#7574)
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";

const SUMMARY_TEXT = "self-contained summary body " + "z".repeat(48);
const SENTINEL = "content table corrupted sentinel";

interface Db {
    prepare(q: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}

function openStore(): { store: UnifiedStore; db: Db; close: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-blocks-"));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db as unknown as Db;
    return {
        store, db,
        close: () => { try { (store as unknown as { close(): void }).close(); } catch { /* best effort */ } fs.rmSync(dir, { recursive: true, force: true }); },
    };
}

function blockRow(covered: string[]): BlockRow {
    const payloadJson = JSON.stringify({ effectiveMessageIds: covered, directMessageIds: [], summary: SUMMARY_TEXT });
    return {
        blockId: "blk0",
        ord: 0,
        startSeq: -1,
        endSeq: -1,
        startRef: null,
        endRef: null,
        tier: 1,
        summary: SUMMARY_TEXT,
        summaryHash: sha256Hex(SUMMARY_TEXT),
        one: null,
        oneHash: null,
        supersedesBlockId: null,
        active: true,
        createdAt: 1_000,
        coveredHash: sha256Hex("cov0"),
        payloadJson,
    };
}

function ingestInput(sessionId: string, covered: string[]): IngestSessionInput {
    return {
        session: {
            sessionId,
            createdAt: 1_000,
            updatedAt: 2_000,
            nextBlockId: 2,
            nextRunId: 1,
            metaJson: "{}",
            statsJson: "{}",
            metadataJson: "{}",
            kstateJson: "{}",
            tailJson: "{}",
            ccrJson: null,
        },
        messages: [],
        blocks: [blockRow(covered)],
        deadRefs: [],
        refs: [],
        ccrEntries: [],
    };
}

function blockRowRaw(db: Db, sessionId: string): { summary_bytes: unknown; start_msgid: unknown; end_msgid: unknown; summary_hash: string } {
    return db.prepare("SELECT summary_bytes, start_msgid, end_msgid, summary_hash FROM blocks WHERE session_id = ? AND block_id = 'blk0'").get(sessionId) as never;
}

function opsFor(store: UnifiedStore): EgressOpLogStore {
    return {
        egressAppendTurn: (s, o, baseSeq, nowMs) => store.egressAppendTurn(s, o, baseSeq, nowMs),
        egressStateView: (s) => store.egressStateView(s),
        egressStateViewAt: (s, x) => store.egressStateViewAt(s, x),
        egressStateMaxSeq: (s) => store.egressStateMaxSeq(s),
        egressStateTruncateAfter: (s, x) => store.egressStateTruncateAfter(s, x),
    };
}

function corruptContent(db: Db, sessionId: string): void {
    const { summary_hash } = blockRowRaw(db, sessionId);
    db.prepare("UPDATE content SET bytes = ?, byte_len = ? WHERE hash = ?").run(SENTINEL, SENTINEL.length, summary_hash);
}

test("fresh db: base DDL carries the self-contained columns and the first fold lands", () => {
    const { store, db, close } = openStore();
    try {
        const cols = (db.prepare("PRAGMA table_info(blocks)").all()) as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        for (const want of ["summary_bytes", "start_msgid", "end_msgid"]) {
            assert.ok(names.has(want), `fresh blocks table must carry ${want}`);
        }
        assert.ok(store.ingestSession(ingestInput("sess-fresh", ["h_msg1", "h_msg2"]), undefined, { completeLog: true }), "first fold ingest must apply");
        const row = blockRowRaw(db, "sess-fresh");
        assert.ok(row.summary_bytes !== null, "the folded block stores its summary bytes inline");
        assert.equal(Buffer.isBuffer(row.summary_bytes) ? row.summary_bytes.toString("utf8") : String(row.summary_bytes), SUMMARY_TEXT);
    } finally { close(); }
});

test("reader prefers the inline bytes; a corrupted content row no longer breaks block reads", () => {
    const { store, db, close } = openStore();
    try {
        assert.ok(store.ingestSession(ingestInput("sess-read", ["h_msg1", "h_msg2"]), undefined, { completeLog: true }));
        corruptContent(db, "sess-read");
        const contents = store.getBlockContents("sess-read", { limit: 10 });
        assert.equal(contents[0].summary, SUMMARY_TEXT, "the inline bytes win over the corrupted content row");
        const blocks = store.getBlocks("sess-read");
        assert.equal(blocks[0].summary, SUMMARY_TEXT, "getBlocks agrees");
    } finally { close(); }
});

test("legacy row (NULL inline) keeps the content-table read", () => {
    const { store, db, close } = openStore();
    try {
        assert.ok(store.ingestSession(ingestInput("sess-legacy", ["h_msg1"]), undefined, { completeLog: true }));
        db.prepare("UPDATE blocks SET summary_bytes = NULL WHERE session_id = ? AND block_id = 'blk0'").run("sess-legacy");
        const contents = store.getBlockContents("sess-legacy", { limit: 10 });
        assert.equal(contents[0].summary, SUMMARY_TEXT, "the NULL-inline row falls back to the content table");
    } finally { close(); }
});

test("msgid coordinates: egress-recorded session gets the covered min/max id; no-flow session stays NULL", () => {
    const { store, db, close } = openStore();
    try {
        // session A: the flow recorded exactly the covered ids, in order.
        const ops = opsFor(store);
        const M = (id: string, text: string) => ({ id, role: "user" as const, contentType: "text" as const, text });
        recordEgressTurn({ store: ops, sessionId: "sess-flow", prev: undefined, conversation: [M("h_msg1", "a"), M("h_msg2", "b"), M("h_msg3", "c")], systemText: "sys", nowMs: 1000 });
        assert.ok(store.ingestSession(ingestInput("sess-flow", ["h_msg1", "h_msg2", "h_msg3"]), undefined, { completeLog: true }));
        const flowRow = blockRowRaw(db, "sess-flow");
        assert.equal(flowRow.start_msgid, "h_msg1");
        assert.equal(flowRow.end_msgid, "h_msg3");

        // session B: no flow at all — coordinates stay NULL.
        assert.ok(store.ingestSession(ingestInput("sess-noflow", ["h_msg1", "h_msg2"]), undefined, { completeLog: true }));
        const noflowRow = blockRowRaw(db, "sess-noflow");
        assert.ok(noflowRow.start_msgid === null, "no-flow session: start_msgid stays NULL");
        assert.ok(noflowRow.end_msgid === null, "no-flow session: end_msgid stays NULL");
    } finally { close(); }
});

test("backfill: a legacy row re-stamps on the next ingest and the inline bytes win again", () => {
    const { store, db, close } = openStore();
    try {
        assert.ok(store.ingestSession(ingestInput("sess-backfill", ["h_msg1"]), undefined, { completeLog: true }));
        db.prepare("UPDATE blocks SET summary_bytes = NULL WHERE session_id = ? AND block_id = 'blk0'").run("sess-backfill");
        // the re-ingest sees NULL inline → re-stamps (equality fails → upsert).
        assert.ok(store.ingestSession(ingestInput("sess-backfill", ["h_msg1"]), undefined, { completeLog: true }));
        const row = blockRowRaw(db, "sess-backfill");
        assert.ok(row.summary_bytes !== null, "the legacy row re-stamped its inline bytes");
        // and the inline bytes now shield the content table again.
        corruptContent(db, "sess-backfill");
        const contents = store.getBlockContents("sess-backfill", { limit: 10 });
        assert.equal(contents[0].summary, SUMMARY_TEXT);
    } finally { close(); }
});

test("steady state: an unchanged stamped row carries its stored values forward without rewriting", () => {
    const { store, db, close } = openStore();
    try {
        assert.ok(store.ingestSession(ingestInput("sess-steady", ["h_msg1", "h_msg2"]), undefined, { completeLog: true }));
        // poison the content row BEFORE the second (steady-state) ingest: if
        // the second ingest re-wrote the block's CAS blob it would restore
        // the bytes; the #5744 equality must skip the whole write instead,
        // so the read stays correct purely from the inline column.
        corruptContent(db, "sess-steady");
        assert.ok(store.ingestSession(ingestInput("sess-steady", ["h_msg1", "h_msg2"]), undefined, { completeLog: true }), "steady-state save still applies the session row");
        const contents = store.getBlockContents("sess-steady", { limit: 10 });
        assert.equal(contents[0].summary, SUMMARY_TEXT);
        const row = blockRowRaw(db, "sess-steady");
        assert.equal(Buffer.isBuffer(row.summary_bytes) ? row.summary_bytes.toString("utf8") : String(row.summary_bytes), SUMMARY_TEXT, "stored inline bytes carried forward");
    } finally { close(); }
});
