/**
 * #7156 regression tests — the non-decision facets of the dual-writer-corruption
 * incident (bili 0.1.216, DSH host, storage:full).
 *
 * Two independent defects surfaced in one incident:
 *   Problem 1 (storage corruption): the host's spawn ladder brought up a NEW
 *     sidecar while the wedged predecessor still held index.db — two live writers
 *     on one WAL db. The reporter's own repro (a 3-row UPDATE from a second
 *     connection against the LIVE db) corrupts it; the SAME update on a snapshot
 *     copy is fine. The corruption then poisons the .chk integrity cache: a
 *     process that booted healthy stamps a FRESH ok verdict at close over the
 *     corrupted file's stats, so every later boot skips the rescan (cache hit)
 *     and dies on the first write.
 *   Problem 2 (silent 0-historical): .recover left 3 blocks with payload_json=''
 *     (length 0). webSummaryRows' json_extract threw "malformed JSON", the whole
 *     .all() failed, unifiedWebSummaries swallowed the error SILENTLY, and the
 *     panel showed "0 historical sessions" with no trace in the server log.
 *
 * Facets covered here (the parts that need no owner decision):
 *   1. webSummaryRows guards each json_extract with json_valid — a corrupt/empty
 *      payload_json degrades to NULL (skipped by the filters, ignored by SUM)
 *      instead of killing the whole list.
 *   2. unifiedWebSummaries logs a warn when webSummaryRows throws — the fallback
 *      to the disk walk is no longer silent.
 *   3. a corruption that surfaces at the FIRST post-open write (large store /
 *      cached verdict — the synchronous quick_check never ran) is classified as
 *      "db corrupt" and the sidecar starts WITHOUT the index, instead of the
 *      opaque REFUSING-TO-START loop.
 *
 * The close-side facet of the .chk poisoning (the close-time cache refresh gated
 * on no live foreign writer) is pinned in storage-integrity-cache.test.ts.
 *
 * The second-writer POLICY itself (block vs. warn-only on a live foreign writer)
 * is an OPEN owner decision (#5281) and is deliberately NOT changed here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedStore } from "../src/storage/store.js";
import { UnifiedShadow, hadIntegrityQuickCheckFailure } from "../src/storage/shadow.js";
import { resetIntegrityCheckStateForTests, setIntegritySyncThresholdForTests } from "../src/storage/integrity-check.js";
import { probeBuiltinSqlite, probeHostBetterSqlite3 } from "../src/storage/driver.js";
import { setLogCapture } from "../src/logger.js";
import { SessionStore } from "../src/persist.js";
import { _resetStorageRuntimeStatusForTest } from "../src/storage/runtime-status.js";

const HAS_ENGINE = probeBuiltinSqlite() || probeHostBetterSqlite3();
const SKIP = HAS_ENGINE ? undefined : "no SQLite engine available on this host";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-issue7156-"));
}

/** Build the real schema (open+close creates the tables), then seed one session +
 *  a content row + one block carrying `payload` via a raw connection. Returns the
 *  db path. The block is active, so its payload feeds the activeCompressed sum. */
function seedSessionWithBlock(dir: string, payload: string): string {
    const p = join(dir, "index.db");
    const s0 = UnifiedStore.open(p);
    s0.close();
    const ro = new DatabaseSync(p);
    try {
        ro.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES ('h1', 1, 1, 'sha256', x'00')").run();
        ro.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES ('sess1', 1, 1)").run();
        ro.prepare(
            "INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, tier, summary_hash, covered_hash, payload_json, created_at, active) VALUES ('b1', 'sess1', 1, 0, 1, 1, 'h1', 'h1', ?, 1, 1)",
        ).run(payload);
    } finally {
        ro.close();
    }
    return p;
}

/** Zero one 4096-byte page (1-indexed SQLite page number). The deterministic recipe
 *  is to zero the sessions table's ROOT page (looked up from sqlite_master, so it is
 *  stable across schema sizes): open() survives (async mode — the sync quick_check
 *  never runs, and the migrations only touch the schema on page 1) but the first
 *  write that traverses the sessions b-tree (resetAllIngestWatermarks) throws
 *  "database disk image is malformed". */
function zeroPage(p: string, page: number): void {
    const fd = openSync(p, "r+");
    try {
        writeSync(fd, Buffer.alloc(4096, 0), 0, 4096, (page - 1) * 4096);
    } finally {
        closeSync(fd);
    }
}

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. The FIX 4 test
 *  below exercises the abandon-without-close path (owner policy 2026-10-30: a
 *  runtime corruption finding must not re-stamp the verdict cache), so the
 *  store handle outlives the test and holds index.db open. */
function rmBestEffort(p: string): void {
    try {
        rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("#7156 FIX 1: an empty payload_json degrades to NULL instead of killing webSummaryRows", { skip: SKIP }, () => {
    const dir = tmpDir();
    try {
        const p = seedSessionWithBlock(dir, JSON.stringify({ topic: "t", summary: "s", compressedTokens: 100 }));
        // The .recover artifact from the incident: payload_json left empty.
        const ro = new DatabaseSync(p);
        ro.prepare("UPDATE blocks SET payload_json = '' WHERE session_id = 'sess1' AND block_id = 'b1'").run();
        ro.close();
        const s = UnifiedStore.open(p);
        try {
            const rows = s.webSummaryRows(); // pre-fix: threw "malformed JSON"
            assert.equal(rows.length, 1, "the session is still listed");
            assert.equal(rows[0].sessionId, "sess1");
            assert.equal(rows[0].blocks, 1);
            assert.equal(rows[0].firstTopic, null, "the corrupt block's topic degrades to NULL");
            assert.equal(rows[0].firstSummary, null, "the corrupt block's summary degrades to NULL");
            assert.equal(rows[0].activeCompressedTokens, 0, "the corrupt block's tokens degrade to 0");
        } finally {
            s.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7156 FIX 1 control: a VALID payload_json still yields its aggregates", { skip: SKIP }, () => {
    const dir = tmpDir();
    try {
        const p = seedSessionWithBlock(dir, JSON.stringify({ topic: "t", summary: "s", compressedTokens: 100 }));
        const s = UnifiedStore.open(p);
        try {
            const rows = s.webSummaryRows();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].firstTopic, "t", "a valid payload's topic is surfaced");
            assert.equal(rows[0].firstSummary, "s");
            assert.equal(rows[0].activeCompressedTokens, 100, "a valid payload's tokens are summed");
        } finally {
            s.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7156 FIX 2: unifiedWebSummaries logs a warn when webSummaryRows throws (fallback is not silent)", { skip: SKIP }, () => {
    const dir = tmpDir();
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetStorageRuntimeStatusForTest();
    let store: SessionStore | undefined;
    try {
        store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        // Make webSummaryRows throw: drop the blocks table (a SQL error — the
        // json_valid guard of FIX 1 does not apply to a missing table).
        const ro = new DatabaseSync(join(dir, "index.db"));
        ro.exec("DROP TABLE blocks");
        ro.close();
        const warns: string[] = [];
        setLogCapture((level, msg) => { if (level === "warn") warns.push(String(msg)); });
        try {
            const rows = store.unifiedWebSummaries();
            assert.equal(rows, null, "a throwing webSummaryRows falls back to null (the disk walk)");
            assert.ok(
                warns.some((m) => m.includes("unifiedWebSummaries")),
                `the fallback is logged, not silent; got ${JSON.stringify(warns)}`,
            );
        } finally {
            setLogCapture(null);
        }
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        _resetStorageRuntimeStatusForTest();
        store?.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7156 FIX 4: a first-post-open-write corruption starts WITHOUT the index (not REFUSING TO START)", { skip: SKIP }, () => {
    const dir = tmpDir();
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetStorageRuntimeStatusForTest();
    resetIntegrityCheckStateForTests();
    try {
        // Build a real store with session rows (so data pages exist), close it.
        const p = join(dir, "index.db");
        const s0 = UnifiedStore.open(p);
        s0.close();
        const ro = new DatabaseSync(p);
        for (let i = 0; i < 60; i++) {
            ro.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, 1, 1)").run("s" + i + "-" + "x".repeat(300));
        }
        ro.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const rootPage = (ro.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'sessions'").get() as { rootpage: number }).rootpage;
        ro.close();
        // Corrupt the sessions root page: open() survives (async mode — the sync
        // quick_check never runs), but the first write (resetAllIngestWatermarks)
        // traverses the sessions b-tree and throws CORRUPT.
        zeroPage(p, rootPage);
        setIntegritySyncThresholdForTests(1); // force async mode for any size
        const errors: string[] = [];
        setLogCapture((level, msg) => { if (level === "error") errors.push(String(msg)); });
        try {
            const sh = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => null);
            assert.equal(sh, null, "a first-write corruption yields 'no sidecar' (start without index) — never a REFUSING-TO-START throw");
            assert.equal(hadIntegrityQuickCheckFailure(), true, "the integrity latch tripped");
            assert.ok(
                errors.some((m) => m.includes("first post-open write")),
                `the error names the first-write corruption; got ${JSON.stringify(errors)}`,
            );
        } finally {
            setLogCapture(null);
        }
    } finally {
        setIntegritySyncThresholdForTests(null);
        resetIntegrityCheckStateForTests();
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        _resetStorageRuntimeStatusForTest();
        rmBestEffort(dir);
    }
});
