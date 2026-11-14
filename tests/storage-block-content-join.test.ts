import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { UnifiedStore, sha256Hex, type IngestSessionInput } from "../src/storage/store.ts";

function input(sessionId = "target"): IngestSessionInput {
    const orphan = JSON.stringify({
        "b-c": { one: null, full: { text: "stale orphan", count: 1 } },
        orphan: { one: null, full: { text: "retained orphan", count: 1 } },
    });
    return {
        session: {
            sessionId, createdAt: 1, updatedAt: 2, nextBlockId: 5, nextRunId: 1,
            metaJson: "{}", statsJson: "{}", metadataJson: "{}", kstateJson: "{}", tailJson: "{}",
            ccrJson: null, orphansJson: orphan,
        },
        messages: Array.from({ length: 5 }, (_, seq) => ({
            seq, msgId: `m${seq}`, ref: null, refNum: null, role: "user", kind: "message",
            content: JSON.stringify({ id: `m${seq}`, role: "user", contentType: "text", text: `source ${seq}` }),
        })),
        refs: [], deadRefs: [], ccrEntries: [], orphansJson: orphan,
        blocks: ["b-z", "b-c", "b-b", "b-a"].map((blockId, i) => {
            const summary = JSON.stringify({ text: `${sessionId} ${blockId} 海🌊\u0000`, count: 2 });
            const one = i === 3 ? null : i === 0 ? summary : JSON.stringify({ text: `one ${blockId}`, count: 1 });
            return {
                blockId, ord: i === 1 ? 0 : 1, startSeq: i, endSeq: i + 1, startRef: i + 1, endRef: i + 2,
                tier: i % 2, summary, one, summaryHash: sha256Hex(summary), oneHash: one === null ? null : sha256Hex(one),
                supersedesBlockId: i === 2 ? "b-c" : null, active: i !== 2, createdAt: 1000 + i,
                coveredHash: `coverage-${i}`, payloadJson: JSON.stringify({
                    blockId, directMessageIds: [`m${i}`, `m${i + 1}`], effectiveMessageIds: [`m${i}`, `m${i + 1}`], untouched: true,
                }),
            };
        }),
    };
}

function setup(engine: "node:sqlite" | "better-sqlite3", t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "bili-block-join-"));
    const file = join(dir, "index.db");
    let store: UnifiedStore;
    try { store = UnifiedStore.open(file, engine); }
    catch (error) {
        rmSync(dir, { recursive: true, force: true });
        if (engine === "better-sqlite3" && String(error).includes("[storage:better-sqlite3]")) {
            t.skip(String(error));
            return;
        }
        throw error;
    }
    const writer = openSqliteDatabase(file, engine).db;
    t.after(() => { writer.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    store.ingestSession(input());
    return { store, writer };
}

for (const engine of ["node:sqlite", "better-sqlite3"] as const) {
    test(`${engine}: complete and paginated block reads retain fields, order and null views`, (t) => {
        const fixture = setup(engine, t);
        if (!fixture) return;
        const { store } = fixture;
        const expected = input().blocks.slice().sort((a, b) => a.ord - b.ord || a.blockId.localeCompare(b.blockId));
        assert.deepEqual(store.getBlocks("target"), expected);
        for (const [limit, offset] of [[1, 0], [2, 1], [2, 3], [2, 9], [0, 0]]) {
            const page = expected.slice(offset, offset + limit);
            assert.deepEqual(store.getBlocks("target", { limit, offset }), page);
            assert.deepEqual(store.getBlockContents("target", { limit, offset }), page.map(({ blockId, summary, one }) => ({ blockId, summary, one })));
        }
    });

    test(`${engine}: identical block ids in other sessions cannot duplicate or replace results`, (t) => {
        const fixture = setup(engine, t);
        if (!fixture) return;
        const { store } = fixture;
        const before = store.getBlocks("target");
        store.ingestSession(input("other"));
        assert.deepEqual(store.getBlocks("target"), before);
        assert.equal(store.getBlocks("other").length, 4);
        assert.deepEqual(store.getBlocks("missing"), []);
        assert.deepEqual(store.getBlockContents("missing", { limit: 5 }), []);
        assert.equal(store.getBlockContents("missing"), null);
    });

    test(`${engine}: decoded block maps preserve row-over-orphan precedence`, (t) => {
        const fixture = setup(engine, t);
        if (!fixture) return;
        const { store } = fixture;
        const contents = store.getBlockContents("target");
        assert.ok(contents);
        assert.equal(contents.size, 5);
        assert.equal(contents.get("b-c")?.full.text, "target b-c 海🌊\u0000");
        assert.deepEqual(contents.get("orphan"), { one: null, full: { text: "retained orphan", count: 1 } });
        assert.equal(contents.get("b-a")?.one, null);
    });

    test(`${engine}: missing CAS rows preserve empty-summary and null-one fallbacks`, (t) => {
        const fixture = setup(engine, t);
        if (!fixture) return;
        const { store, writer } = fixture;
        const target = input().blocks[1];
        writer.exec("PRAGMA foreign_keys=OFF");
        writer.prepare("DELETE FROM content WHERE hash IN (?, ?)").run(target.summaryHash!, target.oneHash!);
        const full = store.getBlocks("target")[0];
        assert.equal(full.blockId, target.blockId);
        assert.equal(full.summary, "");
        assert.equal(full.one, null);
        assert.equal(full.summaryHash, target.summaryHash);
        assert.equal(full.oneHash, target.oneHash);
        assert.deepEqual(store.getBlockContents("target", { limit: 1 }), [{ blockId: target.blockId, summary: "", one: null }]);
        assert.equal(store.getBlocks("target").length, 4);
    });

    test(`${engine}: raw invalid UTF-8 and zero-byte CAS payloads decode exactly as before`, (t) => {
        const fixture = setup(engine, t);
        if (!fixture) return;
        const { store, writer } = fixture;
        const target = input().blocks[1];
        const bytes = Buffer.from([0x66, 0x80, 0x00, 0x6f]);
        writer.prepare("UPDATE content SET bytes = ?, byte_len = ? WHERE hash = ?").run(bytes, bytes.length, target.summaryHash!);
        writer.prepare("UPDATE content SET bytes = ?, byte_len = 0 WHERE hash = ?").run(Buffer.alloc(0), target.oneHash!);
        const expected = { blockId: target.blockId, summary: bytes.toString("utf8"), one: "" };
        const { blockId, summary, one } = store.getBlocks("target")[0];
        assert.deepEqual({ blockId, summary, one }, expected);
        assert.deepEqual(store.getBlockContents("target", { limit: 1 }), [expected]);
        assert.throws(() => store.getBlockContents("target"), SyntaxError);
    });
}
