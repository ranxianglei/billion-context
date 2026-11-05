/**
 * #4816/#5108 regression: corruption-shaped quick_check failures must reach
 * the #4175 quarantine decision instead of escaping it as raw driver errors.
 *
 * The #4175 quarantine guard only catches StorageIntegrityError, but several
 * corruption shapes make `PRAGMA quick_check` THROW (truncated file →
 * "database disk image is malformed", garbage header → "file is not a
 * database") instead of returning non-ok verdict rows. Those raw throws
 * escaped the shadow's quarantine and left the corrupt index in place
 * forever (permanent legacy-only degrade; the reporter's only exit was a
 * manual rename). Facets covered here:
 *   1. the classifier itself (corruption shapes match, transient shapes do NOT);
 *   2. UnifiedStore.open turns a throwing scan into StorageIntegrityError;
 *   3. the shadow leaves the file set EXACTLY where it is (no automatic
 *      rename — #4626-era owner decision) and REFUSES TO OPEN — no legacy
 *      fallback either (the two replicas would fork forever), throwing the
 *      typed error with the actionable operator instruction + cached FAIL;
 *   4. the FAIL verdict makes the next open fail fast WITHOUT rescan;
 *   5. the documented manual resolution (back up, move aside, restart)
 *      actually unblocks: a fresh store rebuilds cleanly;
 *   5. the background (large-store) check caches its FAIL verdict across a clean close;
 *   6. /__bili/status reports the resolved engine when the failure happened AFTER resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedStore, StorageIntegrityError } from "../src/storage/store.js";
import { UnifiedShadow } from "../src/storage/shadow.js";
import { sqliteCorruptionDetail } from "../src/storage/sqlite-errors.js";
import { openSqliteDatabase, probeBuiltinSqlite, probeHostBetterSqlite3 } from "../src/storage/driver.js";
import {
    readIntegrityCache,
    resetIntegrityCheckStateForTests,
    setIntegritySyncThresholdForTests,
    backgroundIntegrityInflightForTests,
    integrityCheckRunsForTests,
} from "../src/storage/integrity-check.js";
import {
    _resetStorageRuntimeStatusForTest,
    recordSidecarOpenFailure,
    storageStatusWire,
    storageDiagnosticsLines,
} from "../src/storage/runtime-status.js";

const HAS_ENGINE = probeBuiltinSqlite() || probeHostBetterSqlite3();
const SKIP_NO_ENGINE = HAS_ENGINE ? undefined : "no SQLite engine available on this host";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-issue4816-"));
}

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A real multi-page db (~62 KB, 200 rows) — enough pages for truncation to break. */
function seedValidDb(dbPath: string): void {
    const { db } = openSqliteDatabase(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO seed (v) VALUES (?)");
    for (let i = 0; i < 200; i++) ins.run(`row-${i}-${"x".repeat(300)}`);
    db.close();
}

function truncateHalf(dbPath: string): void {
    truncateSync(dbPath, Math.floor(statSync(dbPath).size / 2));
}

function garbageHeader(dbPath: string): void {
    writeFileSync(dbPath, Buffer.from("this is definitely not a sqlite database file, not even close"));
}

/** Zero page 2 (the first btree data page after sqlite_master on page 1).
 * Verified recipe: pragmas/schema-migration survive (they only touch the
 * header + page 1) but the full quick_check scan throws CORRUPT — needed to
 * exercise the background-check facet, where open() must succeed first. */
function zeroFirstDataPage(dbPath: string): void {
    const fd = openSync(dbPath, "r+");
    try {
        writeSync(fd, Buffer.alloc(4096, 0), 0, 4096, 4096);
    } finally {
        closeSync(fd);
    }
}

test("#4816 classifier: corruption shapes match, transient shapes must NOT", () => {
    // better-sqlite3 stamps symbolic err.code values
    assert.notEqual(sqliteCorruptionDetail(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" })), null);
    assert.notEqual(sqliteCorruptionDetail(Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" })), null);
    // node:sqlite ERR_SQLITE_ERROR carries the errmsg text only
    assert.notEqual(sqliteCorruptionDetail(Object.assign(new Error("database disk image is malformed"), { code: "ERR_SQLITE_ERROR" })), null);
    assert.notEqual(sqliteCorruptionDetail(new Error("file is not a database")), null);
    // the [storage:<engine>] wrapper keeps the message text
    assert.notEqual(sqliteCorruptionDetail(new Error("[storage:better-sqlite3] file is not a database")), null);
    // Transient shapes MUST stay unclassified: quarantining a locked-but-healthy
    // index over an AV lock would destroy a working store (#362/#3823 class).
    assert.equal(sqliteCorruptionDetail(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })), null);
    assert.equal(sqliteCorruptionDetail(Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" })), null);
    assert.equal(sqliteCorruptionDetail(Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" })), null);
    assert.equal(sqliteCorruptionDetail(new Error("some other failure")), null);
    assert.equal(sqliteCorruptionDetail(null), null);
    assert.equal(sqliteCorruptionDetail(undefined), null);
});

test("#4816 store: a throwing quick_check becomes StorageIntegrityError", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    try {
        const p = join(dir, "index.db");
        seedValidDb(p);
        truncateHalf(p); // proven to make PRAGMA quick_check throw CORRUPT
        assert.throws(
            () => UnifiedStore.open(p),
            (err: unknown) => err instanceof StorageIntegrityError && /malformed/.test(err.detail),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    const dir2 = tmpDir();
    try {
        const p = join(dir2, "index.db");
        seedValidDb(p);
        garbageHeader(p); // proven to make PRAGMA quick_check throw NOTADB
        assert.throws(
            () => UnifiedStore.open(p),
            (err: unknown) => err instanceof StorageIntegrityError && /not a database/.test(err.detail),
        );
        // control: a healthy file still opens
        rmSync(p);
        seedValidDb(p);
        const s = UnifiedStore.open(p);
        s.close();
    } finally {
        rmSync(dir2, { recursive: true, force: true });
    }

    const dir3 = tmpDir();
    try {
        const p = join(dir3, "index.db");
        seedValidDb(p);
        zeroFirstDataPage(p); // page-content corruption throws like truncation does
        assert.throws(
            () => UnifiedStore.open(p),
            (err: unknown) => err instanceof StorageIntegrityError && /malformed/.test(err.detail),
        );
    } finally {
        rmSync(dir3, { recursive: true, force: true });
    }
});

test("#4816 shadow: throwing corruption leaves every file UNTOUCHED and boots WITHOUT the index", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    // The wire reason below resolves `requested` from the REAL process env
    // (runtime-status records it only via SessionStore), and the CI baseline
    // preload pins BILI_STORAGE_UNIFIED=legacy for the non-storage corpus
    // (#2815) — pin full to match the mode maybeOpen is asked for; restore
    // afterwards.
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        seedValidDb(join(dir, "index.db"));
        truncateHalf(join(dir, "index.db"));
        const before = createHash("sha256").update(readFileSync(join(dir, "index.db"))).digest("hex");
        _resetStorageRuntimeStatusForTest();
        // #4626-era owner decision chain (FINAL, 2026-10-30): NO rename AND
        // NO legacy fallback AND no refusal — a provably-corrupt index alarms
        // loudly and the open comes back as "no sidecar"; this process then
        // serves from the envelopes until an operator fixes things by hand.
        const sh = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => null);
        assert.equal(sh, null, "a provably-corrupt index must yield 'no sidecar' (loud alarm) — nothing auto-renames, falls back legacy-only or blocks the boot");
        // Byte-identical file set: NO automatic rename/repair (#4626-era owner
        // decision — checkpoint rows live only inside the index, and with
        // jsonWriterOff it is the sole durable copy).
        const after = createHash("sha256").update(readFileSync(join(dir, "index.db"))).digest("hex");
        assert.equal(after, before, "the corrupt primary must stay byte-identical");
        assert.ok(!readdirSync(dir).some((n) => n.startsWith("index.db.corrupt-")), "no quarantine copies may exist anymore");
        // Loud + actionable on the status wire.
        const wire = storageStatusWire();
        assert.match(wire.reason ?? "", /integrity check and was left UNTOUCHED/);
        assert.match(wire.reason ?? "", /starting WITHOUT the index/i);
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        _resetStorageRuntimeStatusForTest();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#4816 repeat boots decide from FRESH evidence every time — no FAIL verdict is ever persisted", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    try {
        resetIntegrityCheckStateForTests();
        const p = join(dir, "index.db");
        seedValidDb(p);
        truncateHalf(p); // proven to make PRAGMA quick_check throw CORRUPT
        assert.throws(
            () => UnifiedStore.open(p),
            (err: unknown) => err instanceof StorageIntegrityError && /malformed/.test(err.detail),
        );
        const scansAfterFirst = integrityCheckRunsForTests();
        const cache = readIntegrityCache(p);
        assert.ok(
            cache === null || cache.ok !== false,
            `a FAIL verdict must never reach the cache any more, got ${JSON.stringify(cache)}`,
        );
        // Second boot: no verdict short-circuit exists for failures — the
        // same file set gets its own live scan and refuses again on the
        // SAME fresh evidence (owner policy 2026-10-30).
        assert.throws(
            () => UnifiedStore.open(p),
            (err: unknown) => err instanceof StorageIntegrityError && /malformed/.test(err.detail),
        );
        assert.equal(integrityCheckRunsForTests(), scansAfterFirst + 1, "every boot runs its own fresh check — the second refusal came from evidence, not a cached verdict");
    } finally {
        resetIntegrityCheckStateForTests();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#4816 operator resolution: moving the corrupt set aside unblocks a fresh rebuild", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    let fresh: UnifiedStore | null = null;
    try {
        seedValidDb(join(dir, "index.db"));
        truncateHalf(join(dir, "index.db"));
        assert.throws(() => UnifiedStore.open(join(dir, "index.db")), (err: unknown) => err instanceof StorageIntegrityError);
        // The documented manual step: back up, move the file set aside…
        for (const suffix of ["", "-wal", "-shm"] as const) {
            const from = join(dir, `index.db${suffix}`);
            if (!existsSync(from)) continue;
            renameSync(from, `${from}.moved-by-operator`);
        }
        // …and the next start rebuilds cleanly against the empty directory.
        fresh = UnifiedStore.open(join(dir, "index.db"));
        assert.deepEqual(fresh.listSessionIds(), [] as string[], "rebuilt index opens cleanly against the empty directory");
    } finally {
        fresh?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#4816 worker facet: a large store's throwing background check is ALARM-ONLY — the next boot still throws, from its own scan", { skip: SKIP_NO_ENGINE }, async () => {
    const dir = tmpDir();
    try {
        resetIntegrityCheckStateForTests();
        setIntegritySyncThresholdForTests(1); // force async mode for any size
        const p = join(dir, "index.db");
        seedValidDb(p);
        zeroFirstDataPage(p); // open() survives; only the full worker scan throws
        const s1 = UnifiedStore.open(p);
        try {
            await waitFor(() => !backgroundIntegrityInflightForTests(p), 15000);
            // The finding is loud in runtime-status/logs but must NEVER be
            // written as a boot-blocker (owner policy 2026-10-30).
            const cache = readIntegrityCache(p);
            assert.ok(
                cache === null || cache.ok !== false,
                `the background FAIL must not reach the cache, got ${JSON.stringify(cache)}`,
            );
        } finally {
            s1.close();
        }
        // Next boot: no cached verdict to trust. Drop the async-threshold
        // override first so this boot checks synchronously — its own fresh
        // scan finds the corruption and refuses.
        setIntegritySyncThresholdForTests(null);
        assert.throws(
            () => UnifiedStore.open(p),
            (err: unknown) => err instanceof StorageIntegrityError && /malformed/.test(err.detail),
        );
    } finally {
        setIntegritySyncThresholdForTests(null);
        resetIntegrityCheckStateForTests();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5108 diagnostics: engine reports the resolved engine when the open failed after resolution", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    try {
        seedValidDb(join(dir, "index.db"));
        const s = UnifiedStore.open(join(dir, "index.db"));
        s.close(); // populates the driver's resolved-engine info
        _resetStorageRuntimeStatusForTest();
        recordSidecarOpenFailure("[storage] database disk image is malformed");
        const wire = storageStatusWire();
        assert.ok(wire.engine !== null, "resolved engine must be reported even though the sidecar never opened");
        assert.ok(typeof wire.engine?.name === "string" && wire.engine.name.length > 0);
        const lines = storageDiagnosticsLines({ sessions: 0, storageLogLines: [] });
        assert.ok(lines.some((l) => l.includes("resolved, but index.db open failed")), `diagnostics line annotated, got ${JSON.stringify(lines)}`);
    } finally {
        _resetStorageRuntimeStatusForTest();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5108 diagnostics: no-engine failures keep reporting engine null", () => {
    _resetStorageRuntimeStatusForTest();
    recordSidecarOpenFailure("no SQLite engine available");
    try {
        const wire = storageStatusWire();
        assert.equal(wire.engine, null);
        const lines = storageDiagnosticsLines({ sessions: 0, storageLogLines: [] });
        assert.ok(!lines.some((l) => l.includes("resolved, but index.db open failed")));
    } finally {
        _resetStorageRuntimeStatusForTest();
    }
});
