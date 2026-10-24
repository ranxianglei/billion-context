/**
 * #4609: quick_check must not turn open() into O(index.db).
 *
 * Pre-fix, EVERY open ran PRAGMA quick_check inline before listen — a 14 GB
 * index.db took 260 s, blew the launcher's hard 60 s spawn budget, and left
 * the host silent-direct for its whole lifetime. The fix splits the check
 * into three lanes (decision matrix below); each lane is pinned here, plus
 * the failure protocol (marker → next-open quarantine) and the inconclusive
 * contract (worker death ≠ corruption).
 *
 * The sync/deferred split point is forced down to fixture sizes through
 * setQuickCheckSyncMaxBytesForTests — the production constant (256 MiB) is
 * sized from the field scan rate (~54 MB/s → ~5 s worst-case inline freeze),
 * which no test fixture can reach.
 */
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

delete process.env.BILI_STORAGE_QUICK_CHECK;

import { UnifiedStore, setQuickCheckSyncMaxBytesForTests } from "../src/storage/store.ts";
import { storageStatusWire, _resetStorageRuntimeStatusForTest } from "../src/storage/runtime-status.ts";

function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "issue4609-"));
}

/** A valid migrated index.db (several KB — comfortably above the lowered
 *  split point, comfortably below the production constant). */
function makeDb(dir: string): string {
    const path = join(dir, "index.db");
    const store = UnifiedStore.open(path);
    store.close();
    return path;
}

/** Flip three mid-file page regions so the corruption sits well clear of the
 *  header (open/migration must still succeed) but deep inside btree pages
 *  (quick_check must report it). */
function corruptMiddle(path: string): void {
    const raw = readFileSync(path);
    for (const frac of [0.25, 0.5, 0.75]) {
        const start = Math.floor(raw.length * frac);
        const end = Math.min(start + 4096, raw.length - 16);
        for (let i = start; i < end; i++) raw[i] ^= 0xff;
    }
    writeFileSync(path, raw);
}

/** The deferred worker is deliberately unref'd (it must never hold the
 *  process open past a shutdown that outruns the scan). In a test process
 *  with nothing else on the event loop, that means the process can exit
 *  before the verdict lands — pin a ref'd timer around the await. */
async function awaitWithKeepAlive<T>(p: Promise<T>): Promise<T> {
    const keepAlive = setInterval(() => {}, 200);
    try {
        return await p;
    } finally {
        clearInterval(keepAlive);
    }
}

/** Self-validating precondition: prove the corruption is one quick_check
 *  actually detects (sync lane on a copy) — otherwise the deferred-failure
 *  tests below would pass vacuously. */
function assertQuickCheckDetects(corruptPath: string): void {
    const copy = `${corruptPath}.precond`;
    copyFileSync(corruptPath, copy);
    setQuickCheckSyncMaxBytesForTests(Number.MAX_SAFE_INTEGER);
    try {
        // Two failure shapes are legitimate: quick_check RETURNING an error
        // row (→ typed StorageIntegrityError) and the statement itself
        // THROWING on severe page damage (→ raw sqlite error rethrown).
        assert.throws(() => UnifiedStore.open(copy), /quick_check|integrity|malformed|not a database/i);
    } finally {
        setQuickCheckSyncMaxBytesForTests(null);
        rmSync(copy, { force: true });
    }
}

test("sync lane (small db): inline pass kept, fingerprint stamped, outcome surfaced", () => {
    const dir = freshDir();
    try {
        _resetStorageRuntimeStatusForTest();
        const path = makeDb(dir);
        const store = UnifiedStore.open(path);
        store.close();

        const wire = storageStatusWire();
        assert.equal(wire.integrity?.ok, true, "passing check surfaces on the status wire");
        assert.ok(typeof wire.integrity?.durationMs === "number" && wire.integrity.durationMs >= 0);

        const fpRaw = JSON.parse(readFileSync(`${path}.quickcheck`, "utf8")) as { size: unknown; mtimeMs: unknown };
        const st = statSync(path);
        assert.equal(fpRaw.size, st.size, "fingerprint records the checked main-file size");
        assert.equal(fpRaw.mtimeMs, st.mtimeMs, "fingerprint records the checked main-file mtime");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("skip lane: an unchanged db is not re-scanned (no integrity record on reopen)", () => {
    const dir = freshDir();
    try {
        const path = makeDb(dir);
        UnifiedStore.open(path).close(); // stamps the fingerprint
        _resetStorageRuntimeStatusForTest();

        const store = UnifiedStore.open(path);
        store.close();

        assert.equal(storageStatusWire().integrity, null, "cache hit → no check ran → nothing recorded");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("corrupted fingerprint json fails toward RE-CHECKING, not skipping", () => {
    const dir = freshDir();
    try {
        const path = makeDb(dir);
        UnifiedStore.open(path).close();
        writeFileSync(`${path}.quickcheck`, "{not-json");
        _resetStorageRuntimeStatusForTest();

        const store = UnifiedStore.open(path);
        store.close();

        assert.equal(storageStatusWire().integrity?.ok, true, "malformed cache → full check ran and passed");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("env opt-out: BILI_STORAGE_QUICK_CHECK=0 skips everything (no scan, no cache, no defer)", () => {
    const dir = freshDir();
    const prev = process.env.BILI_STORAGE_QUICK_CHECK;
    process.env.BILI_STORAGE_QUICK_CHECK = "0";
    try {
        _resetStorageRuntimeStatusForTest();
        const path = makeDb(dir);
        const store = UnifiedStore.open(path);
        store.close();

        assert.equal(store.deferredQuickCheck, null);
        assert.equal(storageStatusWire().integrity, null);
        assert.ok(!existsSync(`${path}.quickcheck`), "opt-out writes no fingerprint");
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_QUICK_CHECK;
        else process.env.BILI_STORAGE_QUICK_CHECK = prev;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("deferred lane (large db): open returns without scanning; background verdict passes and stamps the cache", async () => {
    const dir = freshDir();
    try {
        const path = makeDb(dir);
        setQuickCheckSyncMaxBytesForTests(1024);
        _resetStorageRuntimeStatusForTest();
        try {
            const store = UnifiedStore.open(path);
            assert.notEqual(store.deferredQuickCheck, null, "large-db lane owes a deferred scan");
            // Nothing recorded yet — the scan has not finished; the port was
            // already bindable at this point (that is the whole fix).
            assert.equal(storageStatusWire().integrity, null);

            const result = await awaitWithKeepAlive(store.deferredQuickCheck!);
            assert.ok(result !== null, "worker delivered a genuine verdict");
            assert.equal(result!.ok, true);
            assert.ok(result!.durationMs >= 0);

            assert.equal(storageStatusWire().integrity?.ok, true, "deferred pass lands on the status wire");
            assert.ok(existsSync(`${path}.quickcheck`), "passing deferred check stamps the fingerprint");
            store.close();
        } finally {
            setQuickCheckSyncMaxBytesForTests(null);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("deferred FAILURE: callback fires, marker persists, NEXT open quarantines the set and opens fresh", async () => {
    const dir = freshDir();
    try {
        const path = makeDb(dir);
        corruptMiddle(path);
        assertQuickCheckDetects(path);

        setQuickCheckSyncMaxBytesForTests(1024);
        const failures: string[] = [];
        try {
            const store = UnifiedStore.open(path, undefined, { onQuickCheckFailure: (detail) => failures.push(detail) });
            const result = await awaitWithKeepAlive(store.deferredQuickCheck!);
            assert.ok(result !== null && result.ok === false, "genuine failure verdict (not inconclusive)");
            assert.ok(result!.detail && result.detail.length > 0, "failure carries a greppable detail");
            assert.equal(failures.length, 1, "failure callback fired exactly once");
            assert.ok(failures[0].length > 0);
            assert.ok(existsSync(`${path}.quarantine-pending`), "marker written for the next open");
            store.close();

            // Next open consumes the marker BEFORE any handle exists → the
            // set moves aside, a fresh db opens clean.
            const store2 = UnifiedStore.open(path);
            store2.listSessionIds(); // fresh db is usable
            store2.close();
            const names0 = readdirSync(dir);
            assert.ok(names0.some((n) => n.startsWith("index.db.corrupt-")), "corrupt main db quarantined at next open");
            assert.ok(names0.includes("index.db"), "fresh db exists");
            assert.ok(!existsSync(`${path}.quarantine-pending`), "marker consumed");
        } finally {
            setQuickCheckSyncMaxBytesForTests(null);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("shadow sink: a deferred failure disables unified reads for the process lifetime", async () => {
    const { UnifiedShadow } = await import("../src/storage/shadow.ts");
    const dir = freshDir();
    try {
        const path = makeDb(dir);
        corruptMiddle(path);
        assertQuickCheckDetects(path);

        setQuickCheckSyncMaxBytesForTests(1024);
        try {
            const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
            assert.ok(shadow, "shadow still opens — the deferred failure cannot brick this boot");
            assert.equal(shadow.stats.disabled, false, "reads stay ON until the verdict lands");

            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !shadow.stats.disabled) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal(shadow.stats.disabled, true, "verdict landed → unified reads flipped off");
            assert.match(String(shadow.stats.lastError), /integrity quick_check failed/i);
            assert.ok(existsSync(`${path}.quarantine-pending`), "marker persisted for the next open");
            shadow.close();
        } finally {
            setQuickCheckSyncMaxBytesForTests(null);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a file that is not a database is a GENUINE failure verdict, not inconclusive", async () => {
    const { runDeferredQuickCheck } = await import("../src/storage/quick-check-worker.ts");
    const dir = freshDir();
    try {
        // node:sqlite defers header validation to the first statement, so
        // SQLITE_NOTADB surfaces as a statement failure — and a non-database
        // file at the index.db location IS corruption (something overwrote
        // it), so ok:false is the correct verdict here.
        const notADb = join(dir, "index.db");
        writeFileSync(notADb, "definitely not a sqlite database, just some bytes\n".repeat(8));
        const result = await awaitWithKeepAlive(runDeferredQuickCheck(notADb, "node:sqlite", import.meta.url));
        assert.ok(result !== null && result.ok === false, "NOTADB → genuine failure verdict");
        assert.match(String(result!.detail), /not a database/i);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("inconclusive contract: a worker that dies without a verdict resolves null, never rejects, never quarantines", async () => {
    const { runDeferredQuickCheck } = await import("../src/storage/quick-check-worker.ts");
    const dir = freshDir();
    try {
        // Force the worker's engine load to fail deterministically: the
        // better-sqlite3 branch anchors createRequire at a path whose
        // directory does not exist, so no node_modules is reachable and the
        // require throws MODULE_NOT_FOUND → the worker exits WITHOUT posting
        // (environmental death — must read as inconclusive, never corruption).
        const dbPath = makeDb(dir);
        const ghostAnchor = join(dir, "no-such-dir-4609", "anchor.js");
        const result = await awaitWithKeepAlive(runDeferredQuickCheck(dbPath, "better-sqlite3", ghostAnchor));
        assert.equal(result, null, "worker death is inconclusive, not a corruption verdict");
        assert.ok(!existsSync(`${dbPath}.quarantine-pending`), "inconclusive writes no marker");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
