/**
 * #7561: the online store backup (VACUUM INTO) must run OFF the proxy's event
 * loop. A synchronous VACUUM INTO on the proxy's own connection froze
 * /__bili/health and in-flight requests for ~46 s on a 1.5 GB index.db, and a
 * health-probing supervisor killed bili mid-backup (target left half-written,
 * in-flight client requests cut off). runOnlineBackup moves the copy into a
 * worker thread (its own event loop, a read-only source connection) so the
 * proxy keeps serving for the whole copy.
 *
 * Facets:
 *   1. correctness — the worker produces a valid snapshot (opens, same rows);
 *   2. THE regression — the main event loop stays free during the copy: a
 *      setImmediate scheduled right after starting the backup fires BEFORE the
 *      copy lands, which is impossible if the VACUUM ran on the main thread;
 *   3. live source — the read-only worker coexists with the proxy's own open
 *      RW connection and leaves the source usable (no #4612 lock interaction);
 *   4. destination already exists → { ok: false } (the HTTP 409 path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnlineBackup } from "../src/storage/online-backup.js";
import { openSqliteDatabase, probeBuiltinSqlite } from "../src/storage/driver.js";

const HAS_BUILTIN_SQLITE = probeBuiltinSqlite();
const SKIP_NO_BUILTIN_SQLITE = HAS_BUILTIN_SQLITE ? undefined : "no node:sqlite builtin on this host — the online-backup worker path cannot run";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-issue7561-"));
}

/** Seed a source db with enough rows that VACUUM INTO is a real (multi-ms)
 * copy, not an instant. Returns the row count. */
function seedDb(dbPath: string, rows: number): number {
    const { db } = openSqliteDatabase(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO seed (v) VALUES (?)");
    for (let i = 0; i < rows; i++) ins.run(`row-${i}-${"x".repeat(1024)}`);
    db.close();
    return rows;
}

function countRows(dbPath: string): number {
    const { db } = openSqliteDatabase(dbPath);
    const row = db.prepare("SELECT COUNT(*) AS n FROM seed").get() as { n: number };
    db.close();
    return row.n;
}

test("runOnlineBackup: produces a valid snapshot of the source (#7561)", { skip: SKIP_NO_BUILTIN_SQLITE }, async () => {
    const dir = tmpDir();
    try {
        const src = join(dir, "index.db");
        const rows = seedDb(src, 500);
        const dst = join(dir, "backups", "snapshot.db");

        const result = await runOnlineBackup(src, dst);
        assert.equal(result.ok, true, `backup should succeed: ${result.error ?? ""}`);
        assert.ok(result.bytes && result.bytes > 0, "backup reports the produced byte length");
        assert.ok(existsSync(dst), "snapshot file exists");
        // The snapshot is a store that opens and holds the same data.
        assert.equal(countRows(dst), rows, "snapshot holds the same row count as the source");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runOnlineBackup: the main event loop stays free during the copy (#7561 regression)", { skip: SKIP_NO_BUILTIN_SQLITE }, async () => {
    const dir = tmpDir();
    try {
        const src = join(dir, "index.db");
        seedDb(src, 3000); // a few MB so the copy is a real window
        const dst = join(dir, "backups", "snapshot.db");

        const p = runOnlineBackup(src, dst);
        // Order is the assertion. A synchronous VACUUM on the main thread would
        // block until the copy finished BEFORE these two register, so the
        // promise resolution (a microtask) would land before this setImmediate.
        // The worker path returns a PENDING promise and the loop stays free, so
        // the immediate fires while the worker is still copying.
        const order: string[] = [];
        setImmediate(() => order.push("loop"));
        p.then(() => order.push("done"));
        const result = await p;
        assert.equal(result.ok, true, `backup should succeed: ${result.error ?? ""}`);
        assert.deepEqual(order, ["loop", "done"], "main event loop stayed free during the backup");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runOnlineBackup: the read-only worker coexists with the proxy's live RW connection (#7561)", { skip: SKIP_NO_BUILTIN_SQLITE }, async () => {
    const dir = tmpDir();
    try {
        const src = join(dir, "index.db");
        const rows = seedDb(src, 800);
        // Hold the source open RW — the proxy's own handle — for the whole
        // backup, then prove it is still usable afterwards.
        const live = openSqliteDatabase(src);
        try {
            const dst = join(dir, "backups", "snapshot.db");
            const result = await runOnlineBackup(src, dst);
            assert.equal(result.ok, true, `backup should succeed with the source open: ${result.error ?? ""}`);
            assert.equal(countRows(dst), rows, "snapshot reflects the pre-backup state");
            // The live connection was not disturbed: it can still write.
            live.db.prepare("INSERT INTO seed (v) VALUES (?)").run("post-backup-row");
            assert.equal(countRows(src), rows + 1, "source still writable after the worker backup");
        } finally {
            live.db.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runOnlineBackup: refuses to overwrite an existing destination (#7561)", { skip: SKIP_NO_BUILTIN_SQLITE }, async () => {
    const dir = tmpDir();
    try {
        const src = join(dir, "index.db");
        seedDb(src, 50);
        const dst = join(dir, "backups", "snapshot.db");
        mkdirSync(join(dir, "backups"), { recursive: true });
        seedDb(dst, 1); // pre-existing target

        const result = await runOnlineBackup(src, dst);
        assert.equal(result.ok, false, "must not overwrite an existing destination");
        assert.match(result.error ?? "", /exists/i);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
