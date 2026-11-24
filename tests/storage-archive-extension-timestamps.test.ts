import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.js";
import { UnifiedStore } from "../src/storage/store.js";

function session(id: string): LegacySessionLike {
    return {
        id, createdAt: 1_000, lastSeen: 2_000, meta: { protocol: "openai" }, stats: {}, metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: [{ id: "message-1", role: "user", contentType: "text", text: "retained history" }],
    };
}

function withStore(run: (store: UnifiedStore, archiveDir: string) => void): void {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-archive-ext-"));
    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(path.join(root, "index.db"), "node:sqlite");
        run(store, path.join(root, "archive"));
    } finally {
        store?.close();
        rmSync(root, { recursive: true, force: true });
    }
}

test("archiving a session with extension state remains restorable", () => {
    withStore((store, archiveDir) => {
        store.ingestSession(planIngest(session("with-ext")));
        store.setSessionExt("with-ext", "plugin-state", { installed: true, revision: 2 });
        const before = store.listSessionExt("with-ext");
        assert.equal(store.archiveSession("with-ext", { archiveDir }).ok, true);
        assert.deepEqual(store.listSessionExt("with-ext"), []);
        assert.deepEqual(store.restoreArchived("with-ext", { archiveDir }), { ok: true });
        assert.deepEqual(store.listSessionExt("with-ext"), before);
        assert.equal(store.getMessages("with-ext")[0]?.content.includes("retained history"), true);
    });
});

test("archive exports retain extension timestamps including zero", (t) => {
    withStore((store, archiveDir) => {
        store.ingestSession(planIngest(session("timestamp-ext")));
        t.mock.method(Date, "now", () => 0);
        store.setSessionExt("timestamp-ext", "first", { value: "first" });
        t.mock.restoreAll();
        const before = store.listSessionExt("timestamp-ext");
        const archived = store.archiveSession("timestamp-ext", { archiveDir });
        assert.ok(archived.exportPath);
        const dump = JSON.parse(readFileSync(archived.exportPath, "utf8")) as { sessionExt: Array<{ updated_at?: number }> };
        assert.equal(dump.sessionExt[0]?.updated_at, 0);
        assert.deepEqual(store.restoreArchived("timestamp-ext", { archiveDir }), { ok: true });
        assert.deepEqual(store.listSessionExt("timestamp-ext"), before);
    });
});

test("old archives without extension timestamps restore using a finite write time", () => {
    withStore((store, archiveDir) => {
        store.ingestSession(planIngest(session("legacy-ext")));
        store.setSessionExt("legacy-ext", "legacy", { value: "preserved" });
        const archived = store.archiveSession("legacy-ext", { archiveDir });
        assert.ok(archived.exportPath);
        const dump = JSON.parse(readFileSync(archived.exportPath, "utf8")) as { sessionExt: Array<{ updated_at?: number }> };
        for (const row of dump.sessionExt) delete row.updated_at;
        writeFileSync(archived.exportPath, JSON.stringify(dump) + "\n");
        assert.deepEqual(store.restoreArchived("legacy-ext", { archiveDir }), { ok: true });
        assert.deepEqual(store.getSessionExt("legacy-ext", "legacy"), { value: "preserved" });
        assert.equal(Number.isFinite(store.listSessionExt("legacy-ext")[0]?.updatedAt), true);
    });
});

test("sessions without extension rows keep their archive round trip", () => {
    withStore((store, archiveDir) => {
        store.ingestSession(planIngest(session("no-ext")));
        assert.equal(store.archiveSession("no-ext", { archiveDir }).ok, true);
        assert.deepEqual(store.restoreArchived("no-ext", { archiveDir }), { ok: true });
        assert.deepEqual(store.listSessionExt("no-ext"), []);
    });
});
