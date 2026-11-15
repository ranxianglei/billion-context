import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { storagePragmas, WAL_JOURNAL_SIZE_LIMIT } from "../src/storage/schema.ts";

/**
 * #3901 / #3463 follow-up — `PRAGMA auto_vacuum = INCREMENTAL` must actually
 * land in the file header of a brand-new index.db.
 *
 * SQLite honours auto_vacuum only while the database file is still empty;
 * `PRAGMA journal_mode = WAL` already writes page 1. With the two in the
 * wrong order a fresh store silently stays at auto_vacuum=0 and
 * gc({vacuum:"incremental"}) / `bili storage gc --vacuum incremental`
 * reclaims nothing: the freelist only ever grows and the file never shrinks
 * without the offline full VACUUM.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-auto-vacuum-")),
    "no-config.json",
);

interface CoreMsg { id: string; role: string; contentType: string; text: string }

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
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

/** ~1.6 MiB of unique message bodies spread over 20 sessions. */
function fill(store: UnifiedStore): string[] {
    const ids: string[] = [];
    for (let s = 0; s < 20; s++) {
        const id = `sess-${s}`;
        const msgs: CoreMsg[] = [];
        for (let m = 0; m < 4; m++) {
            msgs.push({ id: `m-${s}-${m}`, role: "user", contentType: "text", text: `body ${s}/${m} `.repeat(2_000) });
        }
        store.ingestSession(planIngest(mkSession(id, msgs)));
        ids.push(id);
    }
    return ids;
}

function pragmaNumber(dbPath: string, name: "auto_vacuum" | "page_count" | "freelist_count"): number {
    const { db } = openSqliteDatabase(dbPath);
    try {
        const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
        return Number(row[name]);
    } finally {
        db.close();
    }
}

const rmDir = (dir: string): void => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
};

test("storagePragmas: auto_vacuum is issued before journal_mode", () => {
    const pragmas = storagePragmas(WAL_JOURNAL_SIZE_LIMIT);
    const autoVacuum = pragmas.findIndex((p) => /\bauto_vacuum\b/.test(p));
    const journalMode = pragmas.findIndex((p) => /\bjournal_mode\b/.test(p));
    assert.ok(autoVacuum >= 0 && journalMode >= 0, "both pragmas are present");
    assert.ok(autoVacuum < journalMode, "auto_vacuum only sticks while the file is empty; switching to WAL writes page 1");
});

test("a brand-new index.db is created with auto_vacuum=INCREMENTAL (2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-auto-vacuum-new-"));
    try {
        const dbPath = path.join(dir, "index.db");
        UnifiedStore.open(dbPath).close();
        assert.equal(pragmaNumber(dbPath, "auto_vacuum"), 2, "0 = NONE, 1 = FULL, 2 = INCREMENTAL");
    } finally {
        rmDir(dir);
    }
});

test("gc({vacuum:'incremental'}) on a new store returns freed pages and shrinks the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-auto-vacuum-gc-"));
    try {
        const dbPath = path.join(dir, "index.db");
        let store = UnifiedStore.open(dbPath);
        const ids = fill(store);
        store.close();
        const pagesFull = pragmaNumber(dbPath, "page_count");
        const bytesFull = fs.statSync(dbPath).size;

        store = UnifiedStore.open(dbPath);
        for (const id of ids) store.deleteSession(id);
        store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "incremental" });
        store.close();

        const pagesAfter = pragmaNumber(dbPath, "page_count");
        assert.equal(pragmaNumber(dbPath, "freelist_count"), 0, "incremental_vacuum drained the freelist");
        assert.ok(pagesAfter < pagesFull / 2, `page count dropped (${pagesFull} -> ${pagesAfter})`);
        assert.ok(fs.statSync(dbPath).size < bytesFull / 2, `index.db shrank on disk (${bytesFull} -> ${fs.statSync(dbPath).size} bytes)`);
    } finally {
        rmDir(dir);
    }
});

test("a file created with auto_vacuum=0 stays that way until one full VACUUM converts it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-auto-vacuum-legacy-"));
    try {
        const dbPath = path.join(dir, "index.db");
        // The layout every index.db got while WAL was switched on first.
        {
            const { db } = openSqliteDatabase(dbPath);
            db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA auto_vacuum = INCREMENTAL");
            db.exec("CREATE TABLE legacy_marker (x INTEGER)");
            db.close();
        }
        assert.equal(pragmaNumber(dbPath, "auto_vacuum"), 0, "precondition: the pragma was ignored once page 1 existed");

        let store = UnifiedStore.open(dbPath);
        const ids = fill(store);
        for (const id of ids) store.deleteSession(id);
        store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "incremental" });
        store.close();
        assert.equal(pragmaNumber(dbPath, "auto_vacuum"), 0, "opening an existing file does not migrate it");
        assert.ok(pragmaNumber(dbPath, "freelist_count") > 0, "incremental_vacuum is a no-op on an auto_vacuum=0 file");

        store = UnifiedStore.open(dbPath);
        store.vacuum("full");
        store.close();
        assert.equal(pragmaNumber(dbPath, "auto_vacuum"), 2, "the full rewrite applies the pending auto_vacuum mode");
        assert.equal(pragmaNumber(dbPath, "freelist_count"), 0);
    } finally {
        rmDir(dir);
    }
});
