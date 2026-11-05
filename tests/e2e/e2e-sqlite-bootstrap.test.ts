/**
 * e2e SQLite engine self-bootstrap (#2833) — REAL artifact lane.
 *
 * Gate: ACP_TEST_SQLITE_BOOTSTRAP=1 (needs network — downloads the pinned
 * better-sqlite3@13.0.3 tarball from the production registry, or the mirror
 * configured via BILI_UPDATE_REGISTRY / update.registry). Outside the default
 * `npm test` glob AND env-gated, so CI stays hermetic. Run it locally before
 * merging any change to the engine pin (version/sha512 in
 * src/storage/engine-bootstrap.ts) or to the minimal tgz extractor:
 *
 *   node --import tsx --test tests/e2e/e2e-sqlite-bootstrap.test.ts
 *   (with ACP_TEST_SQLITE_BOOTSTRAP=1 exported)
 *
 * Proves what the hermetic suite cannot: the pinned artifact really downloads
 * from the live registry, passes the in-repo sha512 pin, extracts through the
 * minimal tgz parser, LOADS its genuine N-API .node on this platform/ABI, and
 * drives UnifiedStore's full schema migration plus a write/read round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmrf } from "../tmp-rm.ts";
import {
    clearSelfDownloadedEngineForTests,
    openSqliteDatabase,
    setPreferredSqliteEngineForTests,
    setSqliteEnginesUnavailableForTests,
    setSqliteProbeOverridesForTests,
} from "../../src/storage/driver.ts";
import { ensureSqliteEngine, resetEngineBootstrapForTests } from "../../src/storage/engine-bootstrap.ts";
import { UnifiedStore } from "../../src/storage/store.ts";

const run = process.env.ACP_TEST_SQLITE_BOOTSTRAP === "1";
const skipReason = !run ? "set ACP_TEST_SQLITE_BOOTSTRAP=1 (real network download of the pinned engine artifact)" : undefined;

function resetSeams(): void {
    setPreferredSqliteEngineForTests(null);
    setSqliteEnginesUnavailableForTests(false);
    setSqliteProbeOverridesForTests(null);
    clearSelfDownloadedEngineForTests();
    resetEngineBootstrapForTests();
}

test("e2e sqlite bootstrap: pinned artifact downloads, verifies, loads, and drives the unified store", { skip: skipReason }, async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-e2e-boot-cache-"));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-e2e-boot-work-"));
    const cfgFile = path.join(workDir, "no-config.json");
    const prevCache = process.env.XDG_CACHE_HOME;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    try {
        // Hermetic config (absent file) + isolated cache; force the probes off
        // so this lane exercises the self-download path even on Node >= 22.5
        // where the builtin would otherwise short-circuit it. Unified mode is
        // on: bootstrap short-circuits to not-needed when storage is legacy.
        process.env.XDG_CACHE_HOME = cacheDir;
        process.env.BILI_CONFIG_FILE = cfgFile;
        process.env.BILI_STORAGE_UNIFIED = "full";
        resetSeams();
        setSqliteProbeOverridesForTests({ builtin: false, host: false });

        const out = await ensureSqliteEngine();
        assert.equal(out.status, "downloaded", `expected a fresh download, got ${JSON.stringify(out)}`);

        const dbPath = path.join(workDir, "index.db");
        const o = openSqliteDatabase(dbPath);
        assert.equal(o.engine, "better-sqlite3", "the loaded engine must be the self-downloaded one");
        assert.equal(o.source, "self-downloaded");

        // Engine-level proofs against the GENUINE native binding: DDL, DML,
        // reads, and BEGIN IMMEDIATE transaction semantics (the #2690 guard).
        o.db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        const ins = o.db.prepare("INSERT INTO t (k, v) VALUES (?, ?)");
        ins.run("a", "1");
        ins.run("b", "2");
        ins.run("c", "3");
        assert.deepEqual(o.db.prepare("SELECT k FROM t ORDER BY k").all(), [{ k: "a" }, { k: "b" }, { k: "c" }]);
        assert.equal((o.db.prepare("SELECT v FROM t WHERE k = ?").get("b") as { v: string }).v, "2");
        // The seam transaction executes immediately (BEGIN IMMEDIATE built in): a throw must roll back.
        assert.throws(() => o.db.transaction(() => {
            o.db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("rollback-me", "x");
            throw new Error("rollback trigger");
        }), /rollback trigger/);
        assert.equal((o.db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 3, "the immediate transaction must have rolled back");
        o.db.close();

        // The unified store's full schema migration over the self-downloaded
        // engine — the strongest cheap assertion that the binding is complete.
        const store = UnifiedStore.open(dbPath);
        try {
            assert.equal(store.engine, "better-sqlite3");
            assert.equal(store.engineSource, "self-downloaded");
            assert.equal(store.getSessionRow("does-not-exist"), null);
        } finally {
            store.close();
        }
    } finally {
        if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prevCache;
        if (prevCfg === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevCfg;
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        resetSeams();
        rmrf(cacheDir);
        rmrf(workDir);
    }
});
