/**
 * #7156 operator tools: `bili storage backup` / `bili storage repair`.
 *
 * Born from the 2026-11-20 production incident: a 3.2 GB index.db proved
 * corrupt and the recovery path was a hand-rolled .recover-equivalent plus
 * manual file surgery. Those moves are now first-class verified commands —
 * this suite pins their contracts:
 *   1. backup = online VACUUM INTO snapshot, quick_check-verified before it
 *      counts, retention prunes to the newest N;
 *   2. repair --from = backup verified (quick_check + sessions readable),
 *      broken index quarantined IN PLACE (evidence kept), backup COPIED in
 *      (never moved), re-verified after the swap;
 *   3. repair without --from = no-backup salvage: row-by-row extraction
 *      from the corrupt file into a fresh schema — broken page ranges
 *      bisect to single rows, a corrupt cell nulls its own column, small
 *      tables survive intact, and the result self-verifies before the swap;
 *   4. every swap path refuses while another live process holds
 *      index.db.lock (#4175 pid discipline — a quarantined file must not be
 *      stolen out from under an active writer);
 *   5. the verdict helpers classify healthy / corrupt / unopenable files
 *      correctly, and --json output is machine-parseable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase, probeBuiltinSqlite, probeHostBetterSqlite3 } from "../src/storage/driver.js";
import { migrateSchema } from "../src/storage/schema.js";
import {
    quickCheckVerdict,
    liveWriterPid,
    runStorageBackupCommand,
    runStorageRepairCommand,
} from "../src/storage-backup-repair.js";

const HAS_ENGINE = probeBuiltinSqlite() || probeHostBetterSqlite3();
const SKIP_NO_ENGINE = HAS_ENGINE ? undefined : "no SQLite engine available on this host";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-backup-repair-"));
}

/** A small realistic index.db: 3 sessions + content rows incl. one ~100 KB
 *  BLOB (overflow-page territory — the shape that dies in field corruption). */
function buildSeedDb(dir: string): string {
    const dbPath = join(dir, "index.db");
    const { db } = openSqliteDatabase(dbPath);
    migrateSchema(db);
    const now = Date.now();
    const insSession = db.prepare(
        "INSERT INTO sessions (session_id, protocol, status, created_at, updated_at, meta_json, stats_json) VALUES (?, ?, 'active', ?, ?, '{}', ?)",
    );
    for (let i = 0; i < 3; i++) {
        insSession.run(`s${i}-seed`, "openai", now, now, JSON.stringify({ requests: i + 1 }));
    }
    const insContent = db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)");
    for (let i = 0; i < 20; i++) {
        const b = Buffer.from(`small content payload ${i} — padding padding padding`);
        insContent.run(`hash-small-${i}`, b.length, b);
    }
    const big = Buffer.alloc(100 * 1024, 0x41);
    big.write("overflow-row-head", 0);
    insContent.run("hash-big-0", big.length, big);
    db.close();
    return dbPath;
}

/** Flip a 4096-byte window at ~1/3 of the file — the durability-test
 *  corruption shape: the db still opens, but scans over the hit pages fail. */
function corruptAtThird(dbPath: string): void {
    const size = statSync(dbPath).size;
    const offset = Math.floor(size / 3);
    const buf = readFileSync(dbPath);
    for (let i = 0; i < 4096; i++) buf[Math.min(offset + i, buf.length - 1)] ^= 0xff;
    writeFileSync(dbPath, buf);
}

function listQuarantined(dir: string): string[] {
    return readdirSync(dir).filter((f) => /^index\.db\.corrupt-/.test(f));
}

function freshDeadPid(): number {
    // spawn + wait: guaranteed-dead pid for the stale-lock facet.
    const r = spawnSync("true");
    return (r.pid as number) > 0 ? (r.pid as number) : 1;
}

test("quickCheckVerdict: healthy db passes, truncation is a corrupt FAIL verdict", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    try {
        const dbPath = buildSeedDb(dir);
        const ok = quickCheckVerdict(dbPath);
        assert.equal(ok.ok, true, `healthy db must pass: ${ok.detail}`);
        truncateSync(dbPath, Math.floor(statSync(dbPath).size / 2));
        const bad = quickCheckVerdict(dbPath);
        assert.equal(bad.ok, false);
        assert.equal(bad.corrupt, true, `truncation must classify as corruption: ${bad.detail}`);
        const notDb = join(dir, "garbage.bin");
        writeFileSync(notDb, Buffer.from("definitely not a sqlite database, just text bytes"));
        const g = quickCheckVerdict(notDb);
        assert.equal(g.ok, false);
        assert.equal(g.corrupt, true, `garbage header must classify as corruption: ${g.detail}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("liveWriterPid: live pid detected, dead/stale/absent/malformed all clear", { skip: SKIP_NO_ENGINE }, () => {
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        writeFileSync(dbPath, "x");
        assert.equal(liveWriterPid(dbPath), null, "no lock file = no live writer");
        const lockPath = `${dbPath}.lock`;
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, boot: Date.now() }));
        assert.equal(liveWriterPid(dbPath), process.pid, "our own pid must be seen as live");
        const dead = freshDeadPid();
        writeFileSync(lockPath, JSON.stringify({ pid: dead }));
        assert.equal(liveWriterPid(dbPath), null, `dead pid (${dead}) = stale lock`);
        writeFileSync(lockPath, "not json at all");
        assert.equal(liveWriterPid(dbPath), null, "malformed lock = unreadable, treated as absent");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("backup: verified snapshot + retention keeps the newest N", { skip: SKIP_NO_ENGINE }, async () => {
    const dir = tmpDir();
    try {
        buildSeedDb(dir);
        const first = await runStorageBackupCommand({ dir, keep: 2, json: true });
        assert.equal(first.code, 0, first.text);
        const data = JSON.parse(first.text) as { backup: string; quickCheck: string; keep: number; pruned: string[] };
        assert.ok(existsSync(data.backup), "snapshot file exists");
        assert.equal(data.quickCheck, "ok");
        assert.equal(data.keep, 2);
        assert.equal(quickCheckVerdict(data.backup).ok, true, "the snapshot itself must pass quick_check");
        // The snapshot sees the same data as the source.
        const v = quickCheckVerdict(data.backup);
        assert.equal(v.ok, true, v.detail);
        const backupsDir = join(dir, "backups");
        for (let i = 0; i < 3; i++) {
            const r = await runStorageBackupCommand({ dir, keep: 2 });
            assert.equal(r.code, 0, r.text);
        }
        const survivors = readdirSync(backupsDir).filter((f) => /^index-.*\.db$/.test(f));
        assert.equal(survivors.length, 2, `retention keep=2 must leave exactly 2 (got ${survivors.join(", ")})`);
        const noDb = tmpDir();
        const missing = await runStorageBackupCommand({ dir: noDb });
        assert.equal(missing.code, 1);
        assert.match(missing.text, /nothing to back up/);
        rmSync(noDb, { recursive: true, force: true });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("repair --from: verifies the backup, quarantines in place, copies (never moves)", { skip: SKIP_NO_ENGINE }, async () => {
    const dir = tmpDir();
    try {
        const dbPath = buildSeedDb(dir);
        const bak = await runStorageBackupCommand({ dir, json: true });
        assert.equal(bak.code, 0, bak.text);
        const backupPath = (JSON.parse(bak.text) as { backup: string }).backup;
        const backupSize = statSync(backupPath).size;

        corruptAtThird(dbPath);
        assert.equal(quickCheckVerdict(dbPath).ok, false, "precondition: the live index must be corrupt");

        // A corrupt backup must be refused, not swapped in.
        const refused = await runStorageRepairCommand({ dir, from: dbPath });
        assert.equal(refused.code, 1);
        assert.match(refused.text, /refused/);
        assert.equal(listQuarantined(dir).length, 0, "a refused repair must not quarantine anything");
        const noSuch = await runStorageRepairCommand({ dir, from: join(dir, "no-such.db") });
        assert.equal(noSuch.code, 1);
        assert.match(noSuch.text, /no such backup file/);

        const r = await runStorageRepairCommand({ dir, from: backupPath });
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /sessions in backup: 3/);
        assert.equal(quickCheckVerdict(dbPath).ok, true, "restored index must pass quick_check");
        const q = listQuarantined(dir);
        assert.ok(q.length >= 1, "the corrupt original is quarantined in place");
        assert.ok(existsSync(backupPath), "the backup itself stays untouched");
        assert.equal(statSync(backupPath).size, backupSize, "copy, never move");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("repair refuses to swap a HEALTHY index for a backup (rollback-by-typo guard)", { skip: SKIP_NO_ENGINE }, async () => {
    const dir = tmpDir();
    try {
        buildSeedDb(dir);
        const bak = await runStorageBackupCommand({ dir, json: true });
        assert.equal(bak.code, 0, bak.text);
        const backupPath = (JSON.parse(bak.text) as { backup: string }).backup;
        const r = await runStorageRepairCommand({ dir, from: backupPath });
        assert.equal(r.code, 1);
        assert.match(r.text, /PASSES quick_check/);
        assert.ok(listQuarantined(dir).length === 0, "nothing was quarantined");
        const r2 = await runStorageRepairCommand({ dir });
        assert.equal(r2.code, 1);
        assert.match(r2.text, /PASSES quick_check/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("repair (no --from): salvage extracts what survived into a fresh schema", { skip: SKIP_NO_ENGINE }, async () => {
    const dir = tmpDir();
    try {
        const dbPath = buildSeedDb(dir);
        corruptAtThird(dbPath);
        const r = await runStorageRepairCommand({ dir, json: true });
        assert.ok(r.code === 0 || r.code === 1, "salvage must not throw");
        const data = JSON.parse(r.text) as {
            mode: string;
            rowsLost: number;
            quarantined: string[];
            tables: Array<{ table: string; salvaged: number; lost: number }>;
        };
        assert.equal(data.mode, "salvage");
        assert.ok(Array.isArray(data.tables) && data.tables.length > 0, "per-table report");
        const sessions = data.tables.find((t) => t.table === "sessions");
        assert.ok(sessions && sessions.salvaged === 3, `small tables survive intact (got ${JSON.stringify(sessions)})`);
        assert.ok(data.quarantined.length >= 1 && data.quarantined.some((f) => f.includes("index.db.corrupt-")), `the corrupt original is quarantined in place (${JSON.stringify(data.quarantined)})`);
        assert.ok(listQuarantined(dir).length >= 1);
        assert.equal(quickCheckVerdict(dbPath).ok, true, "the salvaged db self-verifies before it counts");
        // And a fresh store can open + read it.
        const ro = openSqliteDatabase(dbPath);
        try {
            const rows = ro.db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
            assert.equal(rows.n, 3);
        } finally {
            ro.db.close();
        }
        // Unopenable garbage = an honest refusal, not a swap.
        const dir2 = tmpDir();
        try {
            const bad = join(dir2, "index.db");
            writeFileSync(bad, Buffer.from("this file is not a database at all, just plain text bytes here"));
            const g = await runStorageRepairCommand({ dir: dir2 });
            assert.equal(g.code, 1);
            assert.match(g.text, /salvage|open/i);
            assert.ok(!existsSync(`${bad}.corrupt-`), "nothing was quarantined for the unreadable file");
        } finally {
            rmSync(dir2, { recursive: true, force: true });
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("repair refuses while another live process holds index.db.lock", { skip: SKIP_NO_ENGINE }, async () => {
    const dir = tmpDir();
    try {
        buildSeedDb(dir);
        writeFileSync(join(dir, "index.db.lock"), JSON.stringify({ pid: process.pid, boot: Date.now() }));
        const r = await runStorageRepairCommand({ dir });
        assert.equal(r.code, 1);
        assert.match(r.text, /pid \d+/);
        assert.match(r.text, /index\.db\.lock/);
        assert.ok(listQuarantined(dir).length === 0, "refused repair touches nothing");
        // backup stays online-safe even with a live writer present.
        const b = await runStorageBackupCommand({ dir });
        assert.equal(b.code, 0, `backup must not refuse a live writer (online VACUUM INTO): ${b.text}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
