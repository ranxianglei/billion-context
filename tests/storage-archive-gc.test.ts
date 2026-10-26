import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { resolveArchiveAfterDays } from "../src/knobs.ts";

/**
 * #3901 / #3463 (+ #3671 archive linkage) — session archiving + GC.
 *
 * archiveSession = export the envelope to the archive dir, delete the row
 * bodies (messages/blocks/…), keep a tombstone sessions row (status
 * 'archived', label intact), release every CAS refcount the session held.
 * Shared content rows survive via other sessions' refcounts. restoreArchived
 * re-ingests from the export. gc() = archive sweep by age + zero-ref
 * collection + optional vacuum.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-archive-gc-")),
    "no-config.json",
);

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[], lastSeen = 2_000): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen,
    meta: { protocol: "openai" },
    stats: {},
    metadata: { label: `label-${id}` },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

test("archiveAfterDays knob: env > file > default 365; 0 disables", () => {
    assert.equal(resolveArchiveAfterDays({ BILI_STORAGE_ARCHIVE_AFTER_DAYS: "7" }, undefined), 7);
    assert.equal(resolveArchiveAfterDays(undefined, 30), 30);
    assert.equal(resolveArchiveAfterDays(undefined, undefined), 365);
    assert.equal(resolveArchiveAfterDays({ BILI_STORAGE_ARCHIVE_AFTER_DAYS: "0" }, 30), 0);
    assert.equal(resolveArchiveAfterDays({ BILI_STORAGE_ARCHIVE_AFTER_DAYS: "garbage" }, undefined), 365);
});

test("archiveSession: tombstone + CAS release; shared rows survive; restore re-ingests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-archive-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const shared = mkMsg("m-shared", "shared body ".repeat(50));
        const onlyA = mkMsg("m-only-a", "exclusive to A ".repeat(50));
        store.ingestSession(planIngest(mkSession("sess-A", [shared, onlyA])));
        store.ingestSession(planIngest(mkSession("sess-B", [shared])));

        const archiveDir = path.join(dir, "archive");
        const archived = store.archiveSession("sess-A", { archiveDir });
        assert.ok(archived.ok);
        assert.ok(archived.exportPath, "archive returns the export path");
        assert.ok(fs.existsSync(archived.exportPath), "archive export file written");

        // Tombstone: session row survives with status + label, bodies gone.
        const tomb = store.getSessionRow("sess-A");
        assert.ok(tomb, "tombstone row kept");
        assert.equal((tomb as unknown as { status?: string }).status, "archived");
        assert.equal(store.getMessages("sess-A").length, 0, "message rows swept");

        // Shared content row still referenced by sess-B; exclusive content released.
        assert.equal(store.contentRefCountOfBody("shared body "), 1, "shared row survives with sess-B's refcount");
        assert.equal(store.contentRefCountOfBody("exclusive to A "), 0, "exclusive row released");

        // Restore: rows come back from the export.
        const restored = store.restoreArchived("sess-A", { archiveDir: path.join(dir, "archive") });
        assert.ok(restored.ok);
        assert.equal(store.getMessages("sess-A").length, 2, "restored session has its messages back");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("archive log: one append-only JSONL, one line per session, no per-session files (#3901 review)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-archive-log-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        store.ingestSession(planIngest(mkSession("sess-A", [mkMsg("m-a", "body a ".repeat(50))])));
        store.ingestSession(planIngest(mkSession("sess-B", [mkMsg("m-b", "body b ".repeat(50))])));
        const archiveDir = path.join(dir, "archive");
        const a = store.archiveSession("sess-A", { archiveDir });
        const b = store.archiveSession("sess-B", { archiveDir });
        assert.ok(a.ok && b.ok);
        assert.equal(a.exportPath, b.exportPath, "all archives land in the single log");
        assert.equal(fs.readdirSync(archiveDir).length, 1, "no per-session files sprayed");
        const lines = fs.readFileSync(a.exportPath!, "utf8").split("\n").filter((l) => l.trim());
        assert.equal(lines.length, 2, "one JSON line per archived session");
        assert.ok(JSON.parse(lines[0]).sessionId === "sess-A" && JSON.parse(lines[1]).sessionId === "sess-B", "lines carry their session ids");
        // restore removes exactly the restored session's line
        const restored = store.restoreArchived("sess-A", { archiveDir });
        assert.ok(restored.ok);
        const after = fs.readFileSync(a.exportPath!, "utf8").split("\n").filter((l) => l.trim());
        assert.equal(after.length, 1, "restore rewrites the log without the restored line");
        assert.equal(JSON.parse(after[0]).sessionId, "sess-B", "other sessions' lines survive the rewrite");
        // re-archive lands a fresh line again (append semantics)
        assert.ok(store.archiveSession("sess-A", { archiveDir }).ok);
        assert.equal(fs.readFileSync(a.exportPath!, "utf8").split("\n").filter((l) => l.trim()).length, 2);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("archive log: a crashed append's truncated line cannot block other restores (#3901 review)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-archive-trunc-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        store.ingestSession(planIngest(mkSession("sess-A", [mkMsg("m-a", "body a ".repeat(50))])));
        store.ingestSession(planIngest(mkSession("sess-B", [mkMsg("m-b", "body b ".repeat(50))])));
        const archiveDir = path.join(dir, "archive");
        assert.ok(store.archiveSession("sess-B", { archiveDir }).ok);
        // Simulate a crash mid-append for sess-A: a partial JSON line after sess-B's.
        const logPath = path.join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        fs.appendFileSync(logPath, '{"version":1,"sessionId":"sess-A","arc');
        // Restoring sess-B still works despite the malformed trailing line…
        const restored = store.restoreArchived("sess-B", { archiveDir });
        assert.ok(restored.ok, "malformed trailing line does not block other restores");
        assert.equal(store.getMessages("sess-B").length, 1, "restored session has its message back");
        // …and the rewrite drops the truncated line (its DB rows were never swept —
        // the append precedes the sweep — so nothing restorable is lost).
        const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
        assert.equal(lines.length, 0, "truncated line dropped by the restore rewrite");
        // Restoring the crashed session itself reports honestly: its data still lives in the DB,
        // and the next gc pass re-archives it with a fresh complete line.
        assert.deepEqual(store.restoreArchived("sess-A", { archiveDir }), { ok: false, reason: "export-missing" });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("gc(): age sweep archives only past-retention sessions; dormant shared rows collected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-gc-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const now = Date.now();
        const DAY = 86_400_000;
        const oldMsg = mkMsg("m-old", "ancient body ".repeat(50));
        const newMsg = mkMsg("m-new", "fresh body ".repeat(50));
        store.ingestSession(planIngest(mkSession("sess-old", [oldMsg], now - 400 * DAY)));
        store.ingestSession(planIngest(mkSession("sess-new", [newMsg], now - 1 * DAY)));

        const result = store.gc({ archiveAfterDays: 365, archiveDir: path.join(dir, "archive"), now });
        assert.equal(result.archived, 1, "only the 400-day-old session archives");
        assert.ok(store.getSessionRow("sess-old"));
        assert.equal((store.getSessionRow("sess-old") as unknown as { status?: string }).status, "archived");
        assert.equal((store.getSessionRow("sess-new") as unknown as { status?: string }).status, "active");
        // #4242 delete-on-zero: the released row is deleted INLINE by the
        // release itself, so gc's sweep counter may legitimately be 0 — the
        // observable contract is that the exclusive content is GONE.
        const contentLeft = (
            store as unknown as { db: { prepare: (q: string) => { all: () => { bytes?: unknown }[] } } }
        ).db.prepare("SELECT bytes FROM content").all().length;
        assert.ok(contentLeft === 1, `released exclusive content collected inline (left=${contentLeft})`);
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});
