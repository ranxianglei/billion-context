import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "archive-refs-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    const plan = planIngest({
        id: "session", createdAt: 1, lastSeen: 2, meta: { protocol: "openai" },
        stats: {}, metadata: {}, state: { blocks: [], nextBlockId: 1, nextRunId: 1,
            messageRefs: { byRaw: {}, byRef: {} } }, blockContents: new Map(),
        lastMessages: [], lastMessagesFolded: false,
    } as unknown as LegacySessionLike);
    store.ingestSession(plan);
    return { store, plan, archiveDir: join(dir, "archive"), close() {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    } };
}

test("restored identical checkpoints each retain ownership of their CAS body", () => {
    const f = fixture();
    try {
        for (const id of ["first", "second"]) f.store.insertCheckpoint({
            cpId: id, sessionId: "session", seqAt: 0, blockSetHash: "", kind: "manual",
            pinned: false, createdAt: 1, stateJson: '{"shared-checkpoint":true}',
        });
        assert.equal(f.store.contentRefCountOfBody("shared-checkpoint"), 2);
        assert.equal(f.store.archiveSession("session", f).ok, true);
        assert.equal(f.store.restoreArchived("session", f).ok, true);
        assert.equal(f.store.contentRefCountOfBody("shared-checkpoint"), 2);
        assert.equal(f.store.deleteCheckpoint("first"), true);
        assert.equal(f.store.checkpointState("second").stateJson, '{"shared-checkpoint":true}');
        assert.equal(f.store.deleteCheckpoint("second"), true);
        assert.equal(f.store.contentRefCountOfBody("shared-checkpoint"), 0);
    } finally { f.close(); }
});

test("already-live pinned checkpoints are not counted twice during restore", () => {
    const f = fixture();
    try {
        for (const id of ["pinned", "first", "second"]) f.store.insertCheckpoint({
            cpId: id, sessionId: "session", seqAt: 0, blockSetHash: "", kind: "manual",
            pinned: id === "pinned", createdAt: 1, stateJson: '{"pinned-shared":true}',
        });
        assert.equal(f.store.archiveSession("session", f).ok, true);
        assert.equal(f.store.contentRefCountOfBody("pinned-shared"), 1);
        assert.equal(f.store.restoreArchived("session", f).ok, true);
        assert.equal(f.store.contentRefCountOfBody("pinned-shared"), 3);
        f.store.deleteCheckpoint("first");
        f.store.deleteCheckpoint("second");
        assert.equal(f.store.checkpointState("pinned").stateJson, '{"pinned-shared":true}');
        assert.equal(f.store.contentRefCountOfBody("pinned-shared"), 1);
    } finally { f.close(); }
});

for (const wholeSession of [true, false]) test(`block summary and one-line body share two references (${wholeSession ? "session" : "block"} restore)`, () => {
    const f = fixture();
    try {
        const body = '{"text":"shared-block-body","count":5}';
        f.plan.blocks.push({ blockId: "b1", ord: 0, startSeq: 1, endSeq: 2, startRef: 1,
            endRef: 2, tier: 1, summary: body, summaryHash: sha256Hex(body), one: body,
            oneHash: sha256Hex(body), supersedesBlockId: null, active: true, createdAt: 1,
            coveredHash: "", payloadJson: "{}" });
        f.store.ingestSession(f.plan);
        assert.equal(f.store.contentRefCountOfBody("shared-block-body"), 2);
        if (wholeSession) {
            assert.equal(f.store.archiveSession("session", f).ok, true);
            assert.equal(f.store.restoreArchived("session", f).ok, true);
        } else {
            assert.equal(f.store.archiveBlock("session", "b1", f).ok, true);
            assert.equal(f.store.restoreBlock("session", "b1", f).ok, true);
        }
        assert.equal(f.store.contentRefCountOfBody("shared-block-body"), 2);
        f.store.deleteSession("session");
        assert.equal(f.store.contentRefCountOfBody("shared-block-body"), 0);
    } finally { f.close(); }
});

test("MySQL restore charges each new checkpoint and preserves an existing pinned owner", async () => {
    const f = fixture();
    try {
        for (const id of ["pinned", "first", "second"]) f.store.insertCheckpoint({
            cpId: id, sessionId: "session", seqAt: 0, blockSetHash: "", kind: "manual",
            pinned: id === "pinned", createdAt: 1, stateJson: '{"mysql-shared":true}',
        });
        assert.equal(f.store.archiveSession("session", f).ok, true);
        let references = 1;
        let committed = false;
        const connection = {
            async query(sql: string, args: unknown[]) {
                if (sql.startsWith("SELECT 1 FROM checkpoints")) return [args[0] === "pinned" ? [{}] : []];
                if (sql.startsWith("SELECT")) return [[]];
                if (sql.startsWith("INSERT INTO content")) references++;
                if (sql.startsWith("UPDATE content SET refcount = refcount + ?")) references += Number(args[0]);
                return [{ affectedRows: 1 }];
            },
            async beginTransaction() {}, async commit() { committed = true; },
            async rollback() {}, release() {},
        };
        const backend = new MysqlBackend({}, {
            createPool: () => ({ async getConnection() { return connection; } }),
        } as unknown as Mysql2Module);
        assert.equal((await backend.restoreArchived("session", f)).ok, true);
        assert.equal(committed, true);
        assert.equal(references, 3);
    } finally { f.close(); }
});
