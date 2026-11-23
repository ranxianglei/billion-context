/**
 * Pure-sqlite proven-corruption refusal (owner policy 2026-11-21, the #7156
 * production incident on this very host).
 *
 * Background: since the 2026-11-13 default flip, a process whose unified
 * selection is sqlite (the config default) and whose jsonWriter is at its
 * default runs in the PURE-SQLITE stance — the JSON envelopes are NOT written,
 * so index.db is the ONLY durable copy of every session. The historical
 * 2026-10-30 contract for a PROVEN-corrupt index was "loud alarm + start
 * WITHOUT the index (serve from the envelopes)" — in every stance that keeps
 * the envelopes as a real recovery source. In the pure-sqlite stance that
 * contract served a near-empty, non-persistent JSON view while the only
 * durable history sat in the corrupt index: strictly worse than the
 * corruption itself (this host's incident: 3 GB index, one session's history
 * degraded to a handful of turns until a manual sqlite .recover swap).
 *
 * New policy (this file):
 *   1. the stance predicate is the SAME formula as the persist constructor's
 *      jsonWriterOff switch (same knobs, same precedence — they cannot
 *      disagree);
 *   2. a proven-corrupt index (quick_check branch OR first-post-open-write
 *      branch) REFUSES TO START in the pure-sqlite stance: maybeOpen throws,
 *      boot exits, the corrupt set stays byte-identical, no quarantine copy,
 *      loud actionable error;
 *   3. BILI_STORAGE_ALLOW_LEGACY_DEGRADE=1/true/on restores the historical
 *      alarm-and-degrade contract for that stance only;
 *   4. every OTHER stance (explicit dual-write full, shadow, legacy, network
 *      backends, encryption) keeps the historical contract unchanged
 *      (returns null + alarm) — covered by the existing #4816/#durability
 *      tests, which stay green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedShadow, hadIntegrityQuickCheckFailure, resetIntegrityQuickCheckLatchForTests, storageStancePureSqlite, legacyDegradeAllowed } from "../src/storage/shadow.js";
import { openSqliteDatabase, probeBuiltinSqlite, probeHostBetterSqlite3 } from "../src/storage/driver.js";
import { resetIntegrityCheckStateForTests, setIntegritySyncThresholdForTests } from "../src/storage/integrity-check.js";
import { UnifiedStore } from "../src/storage/store.js";
import { setLogCapture } from "../src/logger.js";
import {
    _resetStorageRuntimeStatusForTest,
    storageStatusWire,
} from "../src/storage/runtime-status.js";

const HAS_ENGINE = probeBuiltinSqlite() || probeHostBetterSqlite3();
const SKIP_NO_ENGINE = HAS_ENGINE ? undefined : "no SQLite engine available on this host";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-pure-sqlite-refusal-"));
}

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

/** Zero one 4 KiB page (the deterministic recipe from
 *  issue7156-storage-corruption.test.ts): open() survives (the pragmas +
 *  migration only touch the header + page 1), but the first write that
 *  resolves the schema throws "database disk image is malformed". */
function zeroPage(p: string, page: number): void {
    const fd = openSync(p, "r+");
    try {
        writeSync(fd, Buffer.alloc(4096, 0), 0, 4096, page * 4096);
    } finally {
        closeSync(fd);
    }
}

/** Pure knob facets — no engine needed. The stance must mirror the persist
 *  constructor's jsonWriterOff formula exactly (same precedence). */
test("pure-sqlite stance: truth table (mirrors the persist jsonWriterOff switch)", () => {
    // The 2026-11-13 default: NOTHING set (or config empty) → pure sqlite.
    assert.equal(storageStancePureSqlite({}), true, "all-unset default IS the pure-sqlite stance");
    // An explicit BILI_STORAGE_UNIFIED=full is a DUAL-WRITE selection:
    // unifiedSelectionIsSqlite returns false, jsonWriter default stays ON.
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_UNIFIED: "full" }), false, "env explicit full = dual-write, not pure sqlite");
    // Env sqlite (the pure-sqlite spelling) → stance true.
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_UNIFIED: "sqlite" }), true);
    // File-tier selections: config storage.unified=full is ALSO a dual-write
    // selection (the production incident's file had full + explicit off below).
    assert.equal(storageStancePureSqlite({}, "full"), false, "file unified=full selects dual-write by default");
    assert.equal(storageStancePureSqlite({}, "sqlite"), true, "file unified=sqlite is pure sqlite");
    assert.equal(storageStancePureSqlite({}, ""), true, "file unified empty = sqlite default");
    assert.equal(storageStancePureSqlite({}, undefined), true, "file unified absent = sqlite default");
    // Explicit jsonWriter overrides the default in both directions.
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_UNIFIED: "full" }, undefined, "off"), true, "full + explicit off = pure sqlite (envelopes are NOT written)");
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_UNIFIED: "full" }, undefined, "on"), false, "full + explicit on = dual write");
    assert.equal(storageStancePureSqlite({}, undefined, "off"), true, "sqlite selection + explicit off = pure sqlite");
    // Env jsonWriter wins over the file value.
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_JSON_WRITER: "on" }, undefined, "off"), false, "env jsonWriter=on beats file off");
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_JSON_WRITER: "off" }, undefined, "on"), true, "env jsonWriter=off beats file on");
    // Non-full modes never qualify (the envelopes ARE the source of truth there).
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_UNIFIED: "legacy" }), false);
    assert.equal(storageStancePureSqlite({ BILI_STORAGE_UNIFIED: "shadow" }), false);
    // Encryption blocks the sidecar (persist forces envelope-only) → not the
    // pure-sqlite stance even if everything else says sqlite.
    assert.equal(storageStancePureSqlite({ BILI_ENCRYPTION_KEY: "secret" }), false, "encryption keeps the envelope as sole source of truth");
    // Non-sqlite backends keep the envelope as the sync read path → not pure.
    assert.equal(storageStancePureSqlite({}, undefined, undefined, "mysql"), false, "network backends are never the pure-sqlite stance");
    // The escape hatch is tri-state and never implied by storage config.
    assert.equal(legacyDegradeAllowed({}), false);
    assert.equal(legacyDegradeAllowed({ BILI_STORAGE_ALLOW_LEGACY_DEGRADE: "1" }), true);
    assert.equal(legacyDegradeAllowed({ BILI_STORAGE_ALLOW_LEGACY_DEGRADE: "true" }), true);
    assert.equal(legacyDegradeAllowed({ BILI_STORAGE_ALLOW_LEGACY_DEGRADE: "on" }), true);
    assert.equal(legacyDegradeAllowed({ BILI_STORAGE_ALLOW_LEGACY_DEGRADE: "yes" }), false, "garbage is NOT an escape");
    assert.equal(legacyDegradeAllowed({ BILI_STORAGE_ALLOW_LEGACY_DEGRADE: "0" }), false);
});

function corruptFixture(dir: string): { before: string; db: string } {
    const db = join(dir, "index.db");
    seedValidDb(db);
    truncateHalf(db); // proven to make PRAGMA quick_check throw CORRUPT
    return { before: createHash("sha256").update(readFileSync(db)).digest("hex"), db };
}

function resetLatches(): void {
    resetIntegrityCheckStateForTests();
    resetIntegrityQuickCheckLatchForTests();
    _resetStorageRuntimeStatusForTest();
}

test("#7156 pure-sqlite DEFAULT: a proven-corrupt index REFUSES TO START (throws, files untouched)", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full"; // wire 'requested' resolves from the REAL process env (like the #4816 sibling pins it); degraded=false under a legacy pin would blank the reason
    try {
        const { before, db } = corruptFixture(dir);
        resetLatches();
        // Default config (nothing set) + full via env = DUAL-WRITE — still
        // the historical contract (this is why the incident's explicit
        // off mattered). Control first:
        assert.equal(UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => null), null, "control: dual-write stance still degrades (historical contract)");
        resetLatches();
        // Now the pure-sqlite spellings must THROW:
        for (const env of [
            { BILI_STORAGE_UNIFIED: "sqlite" },
            { BILI_STORAGE_UNIFIED: "full", BILI_STORAGE_JSON_WRITER: "off" },
        ] as const) {
            resetLatches();
            assert.throws(
                () => UnifiedShadow.maybeOpen(dir, { ...env }, () => null),
                (err: unknown) => {
                    assert.match(String((err as Error).message ?? err), /malformed|not a database/i, "the thrown error must carry the driver's corruption evidence");
                    return true;
                },
                `pure-sqlite env ${JSON.stringify(env)} must refuse to boot`,
            );
        }
        // And the file tier (the incident's actual posture): config
        // storage.unified=full + storage.jsonWriter=off.
        resetLatches();
        assert.throws(
            () => UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => null, "full", undefined, undefined, "off"),
            (err: unknown) => {
                assert.match(String((err as Error).message ?? err), /malformed|not a database/i);
                return true;
            },
            "file unified=full + jsonWriter=off (the incident posture) must refuse to boot",
        );
        // Byte-identical corrupt set across ALL the attempts: no rename, no
        // quarantine copy, no repair.
        const after = createHash("sha256").update(readFileSync(db)).digest("hex");
        assert.equal(after, before, "the corrupt primary must stay byte-identical across every refused boot");
        assert.ok(!readdirSync(dir).some((n) => n.startsWith("index.db.corrupt-")), "no quarantine copies may be created by a refusal");
        // Loud + actionable on the status wire.
        const wire = storageStatusWire();
        assert.match(wire.reason ?? "", /REFUSES TO START/i, "the status wire must carry the pure-sqlite REFUSAL, not the historical degrade wording");
        assert.match(wire.reason ?? "", /integrity check and was left UNTOUCHED/);
        assert.equal(wire.splitBrain, null);
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        resetLatches();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7156 escape hatch: BILI_STORAGE_ALLOW_LEGACY_DEGRADE restores the historical alarm-and-degrade", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "sqlite"; // wire 'requested' resolves from the REAL process env; a legacy ambient pin would blank the reason (same pin as the refusal test above)
    try {
        corruptFixture(dir);
        resetLatches();
        // Pure-sqlite + escape → the OLD contract: null + loud alarm, no throw.
        const sh = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "sqlite", BILI_STORAGE_ALLOW_LEGACY_DEGRADE: "1" }, () => null);
        assert.equal(sh, null, "the escape hatch must restore the historical degrade (no sidecar)");
        const wire = storageStatusWire();
        assert.match(wire.reason ?? "", /WITHOUT the index/i);
        assert.equal(wire.degraded, true);
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        resetLatches();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7156 refusal is RECORDED for the diagnostics surface and repeats on every boot", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "sqlite"; // wire 'requested' resolves from the REAL process env; a legacy ambient pin would blank the reason (same pin as the refusal test above)
    try {
        corruptFixture(dir);
        resetLatches();
        assert.throws(() => UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "sqlite" }, () => null));
        // Boot is refused; the next boot (fresh process, fresh latches) must
        // refuse again from FRESH evidence — no in-process auto-retry exists
        // either (the latch short-circuits the #5188 reopen hook).
        resetLatches();
        assert.throws(() => UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "sqlite" }, () => null));
        const wire = storageStatusWire();
        assert.match(wire.reason ?? "", /REFUSES TO START/i);
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        resetLatches();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7156 pure-sqlite (2026-11-21 per-session rework): open no longer writes — a pre-verdict corruption boots, then surfaces loudly at the first ingest write", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "sqlite";
    try {
        // The incident's large-store path: the integrity check does not run
        // synchronously (async mode forced), so a proven corruption surfaces
        // at the process's FIRST INGEST WRITE instead of at quick_check —
        // the branch the truncateHalf tests above cannot reach. Before
        // 2026-11-21 the open-time GLOBAL watermark reset
        // (resetAllIngestWatermarks) made OPEN a write and this corruption
        // refused the boot. Now open performs NO write at all: the store
        // BOOTS even with the verdict not yet landed, and the corruption
        // surfaces — loudly (integrity latch + error) — at the process's
        // first ingest write. The pure-sqlite stance never writes JSON
        // envelopes, so the failed save leaves the in-memory view serving;
        // there is no durable JSON copy to silently degrade to.
        const p = join(dir, "index.db");
        const s0 = UnifiedStore.open(p);
        s0.close();
        const ro = new DatabaseSync(p);
        for (let i = 0; i < 60; i++) {
            ro.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, 1, 1)").run("s" + i + "-" + "x".repeat(300));
        }
        ro.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        ro.close();
        zeroPage(p, 2);
        setIntegritySyncThresholdForTests(1); // force async mode for any size
        const errors: string[] = [];
        setLogCapture((level, msg) => { if (level === "error") errors.push(String(msg)); });
        try {
            const legacy = {
                id: "s-corrupt-" + "x".repeat(10),
                createdAt: 1, lastSeen: 2, meta: {}, stats: {}, metadata: {},
                state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1 },
                blockContents: new Map(),
                lastMessages: [{ role: "user", content: "hello" }],
            };
            const sh = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "sqlite" }, () => legacy as never);
            assert.ok(sh, "open performs NO write anymore — a pre-verdict corrupt store BOOTS (2026-11-21 per-session watermark fix)");
            assert.equal(hadIntegrityQuickCheckFailure(), false, "no integrity latch before the first write");
            sh.record({});
            assert.equal(hadIntegrityQuickCheckFailure(), true, "the integrity latch tripped at the first ingest write");
            assert.ok(
                errors.some((m) => m.includes("ingest write")),
                `the error names the first-ingest-write corruption; got ${JSON.stringify(errors)}`,
            );
        } finally {
            setLogCapture(null);
        }
    } finally {
        setIntegritySyncThresholdForTests(null);
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        resetLatches();
        // The first-write corruption branch abandons the opened handle (GC
        // releases it — close() would re-stamp the poisoned integrity
        // verdict), and the background quick_check may still hold the file.
        // On Windows that keeps index.db locked, so rmSync can hit EBUSY
        // (or EPERM on Node 24 runners, same locked-file condition).
        // Retry briefly; if it still fails, leave the temp dir (the OS
        // reclaims it) — the test's assertions already ran.
        for (let attempt = 0; ; attempt++) {
            try {
                rmSync(dir, { recursive: true, force: true });
                break;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code !== "EBUSY" && code !== "EPERM") throw err;
                if (attempt >= 10) break;
                const until = Date.now() + 50;
                while (Date.now() < until) { /* spin-wait for GC to release the handle */ }
            }
        }
    }
});
