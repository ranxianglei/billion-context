import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runSessionsCommand } from "../src/storage-maintenance.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { UnifiedStore, sha256Hex, type IngestSessionInput } from "../src/storage/store.ts";

process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_PERSIST_ZSTD = "0";

function input(id = "target", rich = false): IngestSessionInput {
    const view = JSON.stringify({ text: "shared block 海🌊", count: 2 });
    const media = Buffer.from("shared image bytes").toString("base64");
    const content = "shared CCR original 海🌊";
    return {
        session: {
            sessionId: id, protocol: "openai", createdAt: 1, updatedAt: 2, nextBlockId: 2, nextRunId: 2,
            metaJson: JSON.stringify({ note: "meta 海🌊" }), statsJson: "{}", metadataJson: "{}", kstateJson: "{}",
            tailJson: "{}", ccrJson: null, orphansJson: null,
        },
        messages: rich ? [0, 1].map((seq) => ({
            seq, msgId: `m${seq}`, ref: `m0000${seq + 1}`, refNum: seq + 1, role: "user", kind: "message",
            content: JSON.stringify({ id: `m${seq}`, role: "user", contentType: "image", imageBase64: { $media: sha256Hex(media) } }),
            media: [{ hash: sha256Hex(media), bytes: media }],
        })) : [],
        blocks: rich ? [{
            blockId: "b1", ord: 0, startSeq: 0, endSeq: 1, startRef: 1, endRef: 2, tier: 1,
            summary: view, one: view, summaryHash: sha256Hex(view), oneHash: sha256Hex(view),
            supersedesBlockId: null, active: true, createdAt: 3, coveredHash: "coverage",
            payloadJson: JSON.stringify({ blockId: "b1", summary: "海🌊", directMessageIds: ["m0", "m1"], effectiveMessageIds: ["m0", "m1"] }),
        }] : [],
        refs: rich ? [0, 1].map((ord) => ({ ord, rawId: `m${ord}`, ref: `m0000${ord + 1}`, refNum: ord + 1 })) : [],
        deadRefs: rich ? [{ ord: 0, ref: "m00003", refNum: 3, recordedAt: 1 }] : [],
        ccrEntries: rich ? [0, 1].map((ord) => ({ ord, key: `m0000${ord + 1}`, content, contentHash: sha256Hex(content) })) : [],
    };
}

function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "bili-cleanup-accounting-"));
    process.env.BILI_CONFIG_FILE = join(dir, "no-config.json");
    const store = UnifiedStore.open(join(dir, "index.db"));
    const db = openSqliteDatabase(join(dir, "index.db"), "node:sqlite").db;
    let closed = false;
    const closeStore = () => { if (!closed) { store.close(); closed = true; } };
    t.after(() => { db.close(); closeStore(); rmSync(dir, { recursive: true, force: true }); });
    store.ingestSession(input());
    return { dir, store, db, closeStore };
}

function checkpoint(store: UnifiedStore, id: string, pinned: boolean, stateJson: string, sessionId = "target") {
    store.insertCheckpoint({ cpId: id, sessionId, seqAt: 0, blockSetHash: "none", kind: "manual", pinned, createdAt: 1, stateJson });
}

function casBytes(db: ReturnType<typeof fixture>["db"]): number {
    const rows = db.prepare("SELECT bytes FROM content").all() as { bytes: Uint8Array }[];
    return rows.reduce((total, row) => total + row.bytes.byteLength, 0);
}

function inlineBytes(db: ReturnType<typeof fixture>["db"]): number {
    let total = 0;
    for (const [table, columns] of [
        ["sessions", ["meta_json", "stats_json", "metadata_json", "kstate_json", "tail_json", "ccr_json", "orphans_json"]],
        ["blocks", ["payload_json"]], ["session_ext", ["value_json"]],
    ] as const) {
        for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
            for (const column of columns) if (typeof row[column] === "string") total += Buffer.byteLength(row[column] as string, "utf8");
        }
    }
    return total;
}

function rows(db: ReturnType<typeof fixture>["db"]): number {
    return ["sessions", "messages", "message_media", "blocks", "dead_refs", "refs", "ccr_entries", "session_ext", "checkpoints", "conversations", "content"]
        .reduce((total, table) => total + (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
}

test("multiple references owned by one session are reclaimable once", (t) => {
    const { store, db } = fixture(t);
    const state = JSON.stringify({ note: "same checkpoint 海🌊" });
    checkpoint(store, "a", false, state);
    checkpoint(store, "b", false, state);
    const report = store.sessionStorageStats("target");
    const before = casBytes(db);
    store.deleteSession("target");
    assert.equal(report.casExclusiveBytes, before - casBytes(db));
    assert.equal(report.casExclusiveBytes, Buffer.byteLength(state));
    assert.equal(report.casSharedBlobs, 0);
});

test("a pinned-only checkpoint is retained rather than reported as freed", (t) => {
    const { store, db } = fixture(t);
    checkpoint(store, "pin", true, '{"keep":"海🌊"}');
    const report = store.sessionStorageStats("target");
    const before = casBytes(db);
    store.deleteSession("target");
    assert.equal(report.casExclusiveBytes, before - casBytes(db));
    assert.equal(report.casExclusiveBytes, 0);
    assert.equal(report.casSharedBlobs, 1);
    assert.equal(store.listCheckpoints().length, 1);
});

test("a pinned and an unpinned reference to one blob keep it alive", (t) => {
    const { store, db } = fixture(t);
    checkpoint(store, "pin", true, '{"keep":true}');
    checkpoint(store, "remove", false, '{"keep":true}');
    const report = store.sessionStorageStats("target");
    const before = casBytes(db);
    store.deleteSession("target");
    assert.equal(report.casExclusiveBytes, 0);
    assert.equal(report.casSharedBlobs, 1);
    assert.equal(casBytes(db), before);
    assert.equal(store.checkpointState("pin").stateJson, '{"keep":true}');
});

test("shared content held by another session survives", (t) => {
    const { store, db } = fixture(t);
    store.ingestSession(input("target", true));
    store.ingestSession(input("other", true));
    const before = casBytes(db);
    const report = store.sessionStorageStats("target");
    store.deleteSession("target");
    assert.equal(report.casExclusiveBytes, 0);
    assert.equal(report.casSharedBlobs, 5);
    assert.equal(casBytes(db), before);
    assert.equal(store.getMessages("other").length, 2);
});

test("message, media, paired block views and CCR references match actual CAS deletion", (t) => {
    const { store, db } = fixture(t);
    store.ingestSession(input("target", true));
    const before = casBytes(db);
    const report = store.sessionStorageStats("target");
    store.deleteSession("target");
    assert.equal(report.casExclusiveBytes, before - casBytes(db));
    assert.equal(casBytes(db), 0);
    assert.equal(report.casSharedBlobs, 0);
});

test("inline JSON uses UTF-8 byte lengths and includes retained orphan JSON", (t) => {
    const { store, db } = fixture(t);
    const plan = input("target", true);
    plan.session.metadataJson = JSON.stringify({ text: "中文🌊", nul: "\u0000" });
    plan.session.ccrJson = JSON.stringify({ byRef: {}, byHash: {}, note: "é" });
    plan.session.orphansJson = JSON.stringify({ orphan: { full: { text: "orphan 日本語", count: 1 }, one: null } });
    store.ingestSession(plan);
    store.setSessionExt("target", "note", { text: "extension 海🌊" });
    const expected = inlineBytes(db);
    assert.equal(store.sessionStorageStats("target").inlineBytes, expected);
});

test("stats for a missing session remain empty and reads do not mutate the store", (t) => {
    const { store, db } = fixture(t);
    const before = { rows: rows(db), bytes: casBytes(db) + inlineBytes(db) };
    const missing = store.sessionStorageStats("missing");
    assert.equal(missing.inlineBytes, 0);
    assert.equal(missing.casExclusiveBytes, 0);
    assert.equal(missing.casSharedBlobs, 0);
    assert.equal(Object.values(missing.rows).reduce((a, b) => a + b, 0), 0);
    store.sessionStorageStats("target");
    assert.deepEqual({ rows: rows(db), bytes: casBytes(db) + inlineBytes(db) }, before);
});

test("CLI removal reports database row and logical-byte deltas with pinned survivors", async (t) => {
    const { dir, store, db, closeStore } = fixture(t);
    store.ingestSession(input("target", true));
    store.setSessionExt("target", "extra", { text: "saved 海🌊" });
    checkpoint(store, "pin", true, '{"keep":"pinned 海🌊"}');
    checkpoint(store, "drop-a", false, '{"drop":"duplicate 海🌊"}');
    checkpoint(store, "drop-b", false, '{"drop":"duplicate 海🌊"}');
    const before = { rows: rows(db), bytes: inlineBytes(db) + casBytes(db) };
    closeStore();
    const result = await runSessionsCommand({ sub: "rm", target: "target", dir, json: true, noVacuum: true });
    assert.equal(result.code, 0, result.text);
    const report = JSON.parse(result.text) as { dbRowsReleased: number; dbBytesReleased: number; vacuumed: boolean };
    assert.equal(report.dbRowsReleased, before.rows - rows(db));
    assert.equal(report.dbBytesReleased, before.bytes - inlineBytes(db) - casBytes(db));
    assert.equal(report.vacuumed, false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE cp_id = 'pin'").get() as { n: number }).n, 1);
});
