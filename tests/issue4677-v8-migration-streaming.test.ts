/**
 * #4677: the v8 identity backfill must stream, one session per transaction —
 * not load every message's content bytes into memory in a single .all()
 * inside one transaction (the v0.1.207 shape, which OOM'd multi-GB stores on
 * first open and, because the user_version bump sat in the same transaction,
 * re-ran and re-OMM'd on every subsequent open: permanently unopenable).
 *
 * Discriminators asserted here:
 *   1. backfill + wireIndex-split dedup still produces the v0.1.207 OUTCOME
 *      (keeper = lowest seq, later duplicates dropped, their CAS refs handed
 *      back) for rows whose bytes differ only in id/wireIndex;
 *   2. crash resume: a session whose rows already carry identities is never
 *      re-processed (planted stale identity survives a re-run), user_version
 *      still ends at 8;
 *   3. content-less rows terminate: they get the ABSENT marker (never equal
 *      to a sha256 hex identity), so the session is not rescanned forever;
 *   4. dedup groups span page boundaries (keeper at the head of the session,
 *      duplicate past the 500-row page edge);
 *   5. an empty store migrates to v8 without touching anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4677-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");

type Db = ReturnType<typeof openSqliteDatabase>["db"];

function sha256(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function tmpDb(): { db: Db; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4677-"));
    const file = path.join(dir, "sessions.db");
    const db = openSqliteDatabase(file).db;
    migrateSchema(db);
    return { db, file };
}

/** Rewind a fully-migrated DB into the pre-v8 state: columns present
 *  (probe-first path), every identity blanked, version stamped 7. */
function downgradeToV7(db: Db): void {
    db.exec("UPDATE messages SET identity = ''");
    db.exec("PRAGMA user_version = 7");
}

/** Insert a content row and return its hash (refcount starts at 1). */
function contentPut(db: Db, bytes: string): string {
    const hash = sha256(bytes);
    db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)").run(
        hash,
        Buffer.byteLength(bytes, "utf8"),
        Buffer.from(bytes, "utf8"),
    );
    return hash;
}

function msgPut(db: Db, sessionId: string, seq: number, msgId: string, role: string, contentHash: string): void {
    db.prepare(
        "INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash) VALUES (?, ?, ?, ?, 'message', ?)",
    ).run(sessionId, seq, msgId, role, contentHash);
}

function identityOf(db: Db, sessionId: string, seq: number): string {
    return (db.prepare("SELECT identity FROM messages WHERE session_id = ? AND seq = ?").get(sessionId, seq) as {
        identity: string;
    }).identity;
}

function refcountOf(db: Db, hash: string): number | undefined {
    return (db.prepare("SELECT refcount FROM content WHERE hash = ?").get(hash) as { refcount: number } | undefined)
        ?.refcount;
}

/** A stored-message serialization whose bytes differ only in id/wireIndex —
 *  the wireIndex-split shape: different content_hash, same identity. */
function storedMessage(id: string, text: string): string {
    return JSON.stringify({ id, wireIndex: 0, role: "user", content: text });
}

test("#4677 backfill sets identities and drops wireIndex-split duplicates (lowest seq keeps)", () => {
    const { db } = tmpDb();
    const a1 = contentPut(db, storedMessage("id-1", "hello"));
    const a2 = contentPut(db, storedMessage("id-2", "hello"));
    msgPut(db, "s1", 1, "m-keep", "user", a1);
    msgPut(db, "s1", 2, "m-keep", "user", a2);
    downgradeToV7(db);

    const { from, to } = migrateSchema(db);

    assert.equal(from, 7);
    assert.equal(to, 9);
    const identity = identityOfStoredContent(storedMessage("stripped", "hello"));
    assert.equal(identityOf(db, "s1", 1), identity);
    // the later duplicate row is gone and its content CAS ref handed back
    assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's1'").get() as { n: number }).n,
        1,
    );
    assert.equal(refcountOf(db, a2), 0);
    assert.equal(refcountOf(db, a1), 1);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    db.close();
});

test("#4677 crash resume: sessions that already carry identities are skipped, not recomputed", () => {
    const { db } = tmpDb();
    const done = contentPut(db, storedMessage("done", "already migrated"));
    msgPut(db, "s-done", 1, "m-done", "user", done);
    const pending = contentPut(db, storedMessage("pending", "still fresh"));
    msgPut(db, "s-pending", 1, "m-pending", "user", pending);
    downgradeToV7(db);
    // s-done was completed by an earlier (crashed) run: its rows already
    // carry identities — plant a deliberately stale one; a re-processing
    // implementation would overwrite it with the recomputed hash.
    db.prepare("UPDATE messages SET identity = 'stale-planted' WHERE session_id = 's-done'").run();

    migrateSchema(db);

    assert.equal(identityOf(db, "s-done", 1), "stale-planted");
    assert.equal(identityOf(db, "s-pending", 1), identityOfStoredContent(storedMessage("pending", "still fresh")));
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    db.close();
});

test("#4677 rows without content bytes terminate with the ABSENT marker instead of rescanning forever", () => {
    const { db } = tmpDb();
    const ghost = contentPut(db, storedMessage("ghost", "will lose its bytes"));
    msgPut(db, "s-ghost", 1, "m-ghost", "user", ghost);
    downgradeToV7(db);
    // fabricate the orphaned-row state (content GC'd while the message row
    // stayed): the FK is enforced on write, so lift it just for this delete
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM content WHERE hash = ?").run(ghost);
    db.exec("PRAGMA foreign_keys = ON");

    migrateSchema(db);
    const identity = identityOf(db, "s-ghost", 1);

    assert.equal(identity, "absent:");
    // second run is a no-op — the marker is not identity = '', so the
    // session is not selected again
    assert.equal(migrateSchema(db).from, 9);
    assert.equal(identityOf(db, "s-ghost", 1), "absent:");
    db.close();
});

test("#4677 dedup groups span page boundaries (keeper head, duplicate past the 500-row page edge)", () => {
    const { db } = tmpDb();
    const keeperHash = contentPut(db, storedMessage("page-keeper", "shared text"));
    msgPut(db, "s-page", 1, "m-page", "user", keeperHash);
    // fill past one page window with unique messages (one transaction — the
    // per-insert autocommit fsync made this the suite's slowest test)
    db.transaction(() => {
        for (let i = 2; i <= 502; i++) {
            const h = contentPut(db, storedMessage(`filler-${i}`, `filler ${i}`));
            msgPut(db, "s-page", i, `m-filler-${i}`, "user", h);
        }
    });
    // the duplicate lands past the page boundary: same identity (bytes
    // differ only in id), different content_hash
    const dupHash = contentPut(db, storedMessage("page-dup", "shared text"));
    msgPut(db, "s-page", 503, "m-page", "user", dupHash);
    downgradeToV7(db);

    migrateSchema(db);

    assert.equal(identityOf(db, "s-page", 1), identityOfStoredContent(storedMessage("x", "shared text")));
    const gone = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's-page' AND seq = 503")
        .get() as { n: number };
    assert.equal(gone.n, 0);
    assert.equal(refcountOf(db, dupHash), 0);
    const total = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's-page'")
        .get() as { n: number };
    assert.equal(total.n, 502);
    db.close();
});

test("#4677 empty store migrates to the schema head untouched", () => {
    const { db } = tmpDb();
    downgradeToV7(db);
    const { from, to } = migrateSchema(db);
    assert.equal(from, 7);
    assert.equal(to, 9);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    db.close();
});
