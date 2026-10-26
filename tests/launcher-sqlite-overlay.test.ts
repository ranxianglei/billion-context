import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexHome, refreshOverlayHome, isSqliteMain, finalizeCodexHome, SQLITE_ORIGIN_FILE } from "../src/launcher.js";
import { supportsFileSymlink } from "./platform-capabilities.ts";

const crequire = createRequire(import.meta.url);

interface SqliteStmt {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDb {
    exec(sql: string): void;
    prepare(sql: string): SqliteStmt;
    close(): void;
}
type SqliteCtor = new (dbPath: string, opts?: { readOnly?: boolean }) => SqliteDb;

// node:sqlite needs Node >= 22.5 (experimental); CI runs 22/24. Skip gracefully elsewhere.
let sqliteCtor: SqliteCtor | undefined;
try {
    sqliteCtor = (crequire("node:sqlite") as { DatabaseSync?: SqliteCtor }).DatabaseSync;
} catch {}

// Child-process fixture: builds a WAL-mode db whose seed rows are checkpointed
// into the MAIN file (distinguishing it from sibling fixtures) and whose tail
// rows sit in an uncheckpointed -wal. Without "clean" the process exits without
// closing the handle, leaving main+WAL exactly like a killed codex.
const FIXTURE_SRC = `
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const [dir, name, seed, tail, clean] = process.argv.slice(2);
const db = new DatabaseSync(path.join(dir, name));
db.exec("PRAGMA journal_mode=WAL;");
db.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");
for (const r of seed.split(",")) {
    if (!r) continue;
    const [id, v] = r.split(":");
    db.prepare("INSERT INTO t VALUES(?, ?)").run(Number(id), v);
}
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
for (const r of tail.split(",")) {
    if (!r) continue;
    const [id, v] = r.split(":");
    db.prepare("INSERT INTO t VALUES(?, ?)").run(Number(id), v);
}
if (clean === "clean") db.close();
else process.exit(0);
`;

function mkRoot(): string {
    return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "bili-sqlite-overlay-"));
}

function buildDb(root: string, dir: string, name: string, seed: string, tail: string, clean: boolean): void {
    const script = path.join(root, "fixture.mjs");
    if (!fs.existsSync(script)) fs.writeFileSync(script, FIXTURE_SRC);
    execFileSync(process.execPath, ["--no-warnings", script, dir, name, seed, tail, clean ? "clean" : "dirty"], { cwd: root });
}

// Child-process fixture: opens an EXISTING db, reads one row, hard-exits
// without closing. Leaves exactly what a merely-opened WAL-mode db leaves —
// a zero-byte -wal plus a -shm (connection artifacts, no commit).
const BARE_OPEN_SRC = `
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const [dir, name] = process.argv.slice(2);
const db = new DatabaseSync(path.join(dir, name));
db.prepare("SELECT count(*) FROM t").get();
process.exit(0);
`;

function bareOpen(root: string, dir: string, name: string): void {
    const script = path.join(root, "bare-open.mjs");
    if (!fs.existsSync(script)) fs.writeFileSync(script, BARE_OPEN_SRC);
    execFileSync(process.execPath, ["--no-warnings", script, dir, name], { cwd: root });
}

// Deterministic main-mtime tie: emulates Windows timestamp-preserving file
// copies (the reported failure condition) without depending on platform copy
// semantics or wall-clock ordering.
const TIE_EPOCH_S = 1_700_000_000;
function pinMainsEqual(a: string, b: string): void {
    touch(a, TIE_EPOCH_S);
    touch(b, TIE_EPOCH_S);
}

function noConflicts(...dirs: string[]): void {
    for (const dir of dirs) {
        for (const n of fs.readdirSync(dir)) {
            assert.ok(!n.includes("bili-conflict"), `unexpected quarantined generation ${path.join(dir, n)}`);
        }
    }
}

function rowsOf(p: string): number[] {
    assert.ok(sqliteCtor, "node:sqlite unavailable");
    const db = new sqliteCtor(p);
    try {
        return db.prepare("SELECT id FROM t ORDER BY id").all().map((r) => Number(r.id));
    } finally {
        db.close();
    }
}

function quickCheckOk(p: string): boolean {
    assert.ok(sqliteCtor, "node:sqlite unavailable");
    const db = new sqliteCtor(p);
    try {
        return String(db.prepare("PRAGMA quick_check").get()!.quick_check) === "ok";
    } finally {
        db.close();
    }
}

function integrityOk(p: string): boolean {
    assert.ok(sqliteCtor, "node:sqlite unavailable");
    const db = new sqliteCtor(p);
    try {
        return String(db.prepare("PRAGMA integrity_check").get()!.integrity_check) === "ok";
    } finally {
        db.close();
    }
}

function capturedErrors(fn: () => void): string[] {
    const orig = console.error;
    const out: string[] = [];
    console.error = (...args: unknown[]): void => {
        out.push(args.map(String).join(" "));
    };
    try {
        fn();
    } finally {
        console.error = orig;
    }
    return out;
}

function touch(p: string, t: number): void {
    fs.utimesSync(p, t, t);
}

test("isSqliteMain detects db extensions and live sidecars", () => {
    assert.equal(isSqliteMain("state_5.sqlite", new Set()), true);
    assert.equal(isSqliteMain("a.db", new Set()), true);
    assert.equal(isSqliteMain("b.sqlite3", new Set()), true);
    assert.equal(isSqliteMain("z", new Set(["z-wal"])), true);
    assert.equal(isSqliteMain("z", new Set(["z-shm"])), true);
    assert.equal(isSqliteMain("z", new Set(["z-journal"])), true);
    assert.equal(isSqliteMain("state_5.sqlite-wal", new Set()), false);
    assert.equal(isSqliteMain("state_5.sqlite-shm", new Set()), false);
    assert.equal(isSqliteMain("config.toml", new Set()), false);
    assert.equal(isSqliteMain("plainfile", new Set(["other-wal"])), false);
});

test("cold start copies *.sqlite privately and keeps other entries shared", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seedA,2:seedB", "", true);
    fs.writeFileSync(path.join(real, "auth.json"), "{}\n");
    fs.mkdirSync(path.join(real, "sessions"));
    const mainBytes = fs.readFileSync(path.join(real, "state_5.sqlite"));

    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    const st = fs.lstatSync(path.join(overlay, "state_5.sqlite"));
    assert.ok(st.isFile(), "overlay db must be a regular file");
    assert.equal(st.nlink, 1, "overlay db must be a private copy, not a shared link");
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), mainBytes);
    assert.deepEqual(rowsOf(path.join(overlay, "state_5.sqlite")), [1, 2]);
    assert.equal(fs.readFileSync(path.join(overlay, "auth.json"), "utf8"), "{}\n");
    for (const dir of [real, overlay]) {
        for (const n of fs.readdirSync(dir)) {
            assert.ok(!n.endsWith("-wal") && !n.endsWith("-shm"), `unexpected sidecar ${path.join(dir, n)}`);
        }
    }
});

test("cold start copies a crashed set (main+WAL) whole and recovery works", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "logs_2.sqlite", "10:a", "11:tail", false);
    const mainBytes = fs.readFileSync(path.join(real, "logs_2.sqlite"));
    const walBytes = fs.readFileSync(path.join(real, "logs_2.sqlite-wal"));

    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    assert.deepEqual(fs.readFileSync(path.join(overlay, "logs_2.sqlite")), mainBytes);
    assert.deepEqual(fs.readFileSync(path.join(overlay, "logs_2.sqlite-wal")), walBytes);
    assert.equal(fs.lstatSync(path.join(overlay, "logs_2.sqlite")).nlink, 1);
    assert.equal(fs.lstatSync(path.join(overlay, "logs_2.sqlite-wal")).nlink, 1);
    assert.deepEqual(rowsOf(path.join(overlay, "logs_2.sqlite")), [10, 11], "WAL tail must recover against the copied main");
    assert.ok(quickCheckOk(path.join(overlay, "logs_2.sqlite")));
    assert.deepEqual(fs.readFileSync(path.join(real, "logs_2.sqlite")), mainBytes, "real home stays untouched");
});

test("leftover .sqlite set merges back as one unit (no per-file splice)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const run = (winnerSide: "real" | "overlay"): void => {
        const root = mkRoot();
        const real = path.join(root, "real");
        const overlay = path.join(root, "overlay");
        fs.mkdirSync(real, { recursive: true });
        fs.mkdirSync(overlay, { recursive: true });
        buildDb(root, real, "state_5.sqlite", "100:rSeed", "101:rTail", false);
        buildDb(root, overlay, "state_5.sqlite", "200:oSeed", "201:oTail", false);
        const rm = path.join(real, "state_5.sqlite");
        const om = path.join(overlay, "state_5.sqlite");
        const rw = path.join(real, "state_5.sqlite-wal");
        const ow = path.join(overlay, "state_5.sqlite-wal");
        const rMain = fs.readFileSync(rm);
        const oMain = fs.readFileSync(om);
        const rWal = fs.readFileSync(rw);
        const oWal = fs.readFileSync(ow);
        // Adversarial mtimes: the loser side owns the NEWER wal, so any
        // per-file adjudication splices generations. No origin snapshot exists
        // here (both sets built independently) → the conservative MAIN-db-mtime
        // fallback decides (#2195).
        const T = Date.now() / 1000;
        if (winnerSide === "real") {
            touch(rm, T);
            touch(om, T - 60);
            touch(rw, T - 30);
            touch(ow, T - 10);
        } else {
            touch(om, T);
            touch(rm, T - 60);
            touch(ow, T - 30);
            touch(rw, T - 10);
        }
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
        const winMain = winnerSide === "real" ? rMain : oMain;
        const winWal = winnerSide === "real" ? rWal : oWal;
        const loseMain = winnerSide === "real" ? oMain : rMain;
        const loseWal = winnerSide === "real" ? oWal : rWal;
        const winRows = winnerSide === "real" ? [100, 101] : [200, 201];
        assert.deepEqual(fs.readFileSync(rm), winMain, "active main must come from the winning side");
        assert.deepEqual(fs.readFileSync(rw), winWal, "active WAL must travel with its main");
        assert.deepEqual(rowsOf(rm), winRows);
        assert.ok(quickCheckOk(rm));
        assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite.bili-conflict")), loseMain, "losing main preserved");
        assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite-wal.bili-conflict")), loseWal, "losing WAL preserved");
        fs.rmSync(root, { recursive: true, force: true });
    };
    run("real");
    run("overlay");
});

test("overlay writes stay private until exit; divergent sides both survive", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    let db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db.close();
    db = new sqliteCtor(re);
    db.prepare("INSERT INTO t VALUES(3, 'viaReal')").run();
    db.close();

    assert.deepEqual(rowsOf(ov), [1, 2], "overlay generation sees only its own writes");
    assert.deepEqual(rowsOf(re), [1, 3], "real generation sees only its own writes");

    const T = Date.now() / 1000;
    touch(ov, T - 60);
    touch(re, T);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("diverge")), "divergence must be reported loudly");
    assert.deepEqual(rowsOf(re), [1, 3], "newer generation wins the merge-back");
    const conflict = path.join(real, "state_5.sqlite.bili-conflict");
    assert.deepEqual(rowsOf(conflict), [1, 2], "loser generation survives intact in the conflict file");
});

test("legacy symlinked main is replaced by a private copy; sidecars quarantined", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    if (!supportsFileSymlink()) {
        t.skip("file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege on this Windows host");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    const realMainBefore = fs.readFileSync(path.join(real, "state_5.sqlite"));
    fs.symlinkSync(path.join(real, "state_5.sqlite"), path.join(overlay, "state_5.sqlite"));
    fs.writeFileSync(path.join(overlay, "state_5.sqlite-wal"), "STALE-WAL-BYTES");

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("#1917")), "legacy migration must be announced");
    const st = fs.lstatSync(path.join(overlay, "state_5.sqlite"));
    assert.ok(st.isFile() && !st.isSymbolicLink(), "symlink must be gone, replaced by a regular file");
    assert.equal(st.nlink, 1);
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), realMainBefore);
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite-wal.bili-conflict")), Buffer.from("STALE-WAL-BYTES"));
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite")), realMainBefore, "real main untouched");
});

test("legacy hardlinked main keeps the real inode; sidecars quarantined", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    const realMain = path.join(real, "state_5.sqlite");
    const ino0 = fs.lstatSync(realMain).ino;
    const realMainBefore = fs.readFileSync(realMain);
    fs.linkSync(realMain, path.join(overlay, "state_5.sqlite"));
    fs.writeFileSync(path.join(overlay, "state_5.sqlite-wal"), "STALE-WAL-BYTES");

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("#1917")), "legacy migration must be announced");
    const st = fs.lstatSync(realMain);
    assert.equal(st.ino, ino0, "real home keeps the original inode");
    assert.equal(st.nlink, 1, "the shared link must be broken");
    assert.ok(!fs.existsSync(path.join(overlay, "state_5.sqlite.bili-conflict")));
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite-wal.bili-conflict")), Buffer.from("STALE-WAL-BYTES"));
    assert.deepEqual(fs.readFileSync(realMain), realMainBefore);
});

test("merge-back rolls back cleanly when the real slot is blocked", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(path.join(real, "state_5.sqlite"), { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, "state_5.sqlite"), "PRIVATE-MAIN");

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("could not merge")), "blocked merge must be reported");
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), Buffer.from("PRIVATE-MAIN"), "set stays for the next launch");
    assert.ok(fs.statSync(path.join(real, "state_5.sqlite")).isDirectory(), "blocked slot untouched");
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no partial conflict state: ${n}`);
    }
});

test("prepareCodexHome gives codex a private db copy while owning config/.env", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgText = '[model]\nname = "x"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), cfgText);
    fs.writeFileSync(path.join(codexHome, ".env"), "MY_VAR=keep\n");
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tok":1}\n');
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b", "", true);
    const mainBefore = fs.readFileSync(path.join(codexHome, "state_5.sqlite"));

    const overlay = prepareCodexHome({
        codexHome,
        origin: "http://127.0.0.1:8899",
        caPath: "/nonexistent/ca.pem",
        conversationId: "conv-42",
        manageRouting: true,
    });
    assert.equal(overlay, `${codexHome}-bili`);
    assert.ok(fs.readFileSync(path.join(overlay!, "config.toml"), "utf8").includes("[mcp_servers.bili]"));
    assert.ok(fs.readFileSync(path.join(overlay!, "config.toml"), "utf8").includes("conv-42"));
    const envText = fs.readFileSync(path.join(overlay!, ".env"), "utf8");
    assert.ok(envText.includes("BILLION_CONTEXT_PROXY=http://127.0.0.1:8899"));
    assert.ok(envText.includes("MY_VAR=keep"));
    const st = fs.lstatSync(path.join(overlay!, "state_5.sqlite"));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.nlink, 1, "codex db must be a private copy, not a shared link");
    assert.deepEqual(fs.readFileSync(path.join(overlay!, "state_5.sqlite")), mainBefore);
    assert.deepEqual(rowsOf(path.join(overlay!, "state_5.sqlite")), [1, 2]);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), cfgText, "real config untouched");
    assert.deepEqual(fs.readFileSync(path.join(codexHome, "state_5.sqlite")), mainBefore, "real db untouched");
});

test("sequential relaunch merges back silently: no warning, no conflict files (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    fs.writeFileSync(path.join(real, "config.toml"), "[x]\n");

    // Launch 1: cold copy into the overlay.
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    assert.ok(fs.existsSync(path.join(overlay, SQLITE_ORIGIN_FILE)), "origin snapshot recorded at copy time");

    // Normal bili session: write through the OVERLAY db only, close cleanly.
    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    const db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db.close();

    // Launch 2: both sides hold a main — the NORMAL steady state, not a
    // divergence. Must merge silently.
    const T = Date.now() / 1000;
    touch(ov, T);
    touch(re, T - 60);
    const errs2 = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs2.some((e) => e.includes("diverge") || e.includes("distinct")), `no spurious divergence on sequential use: ${JSON.stringify(errs2)}`);
    assert.deepEqual(rowsOf(re), [1, 2], "winner keeps all rows");
    for (const dir of [real, overlay]) {
        for (const n of fs.readdirSync(dir)) {
            assert.ok(!n.includes("bili-conflict"), `no conflict accumulation in ${dir}: ${n}`);
        }
    }
    assert.ok(!fs.existsSync(path.join(real, SQLITE_ORIGIN_FILE)), "origin metadata never leaks into the real home");
    const st = fs.lstatSync(ov);
    assert.ok(st.isFile() && st.nlink === 1, "steady state: overlay holds a fresh private copy");
    assert.deepEqual(rowsOf(ov), [1, 2]);

    // Launch 3 with no writes at all: still silent, still no conflicts.
    const errs3 = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs3.some((e) => e.includes("diverge") || e.includes("distinct")), `no spurious divergence on idle relaunch: ${JSON.stringify(errs3)}`);
    assert.deepEqual(rowsOf(re), [1, 2]);
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict accumulation in real home: ${n}`);
    }
});

test("true divergence with the REAL side as loser still warns and preserves (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    let db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db.close();
    db = new sqliteCtor(re);
    db.prepare("INSERT INTO t VALUES(3, 'viaReal')").run();
    db.close();

    // Overlay generation is newer → wins; the REAL side lost and differs from
    // what bili copied → genuine divergence: loud warning + preserved loser.
    const T = Date.now() / 1000;
    touch(ov, T);
    touch(re, T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("diverge")), "true divergence must be reported loudly");
    assert.deepEqual(rowsOf(re), [1, 2], "newer generation wins the merge-back");
    const conflict = path.join(real, "state_5.sqlite.bili-conflict");
    assert.deepEqual(rowsOf(conflict), [1, 3], "diverged real generation survives intact in the conflict file");
});

test("concurrent plain run with an idle bili: no warning, plain side wins (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    // Plain run advances the REAL home; the bili session did nothing.
    const re = path.join(real, "state_5.sqlite");
    const db = new sqliteCtor(re);
    db.prepare("INSERT INTO t VALUES(3, 'viaReal')").run();
    db.close();

    const T = Date.now() / 1000;
    touch(re, T);
    touch(path.join(overlay, "state_5.sqlite"), T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct")), `unmodified bili copy is not a divergence: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(re), [1, 3], "plain-run rows kept");
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict for an unmodified loser: ${n}`);
    }
    assert.deepEqual(rowsOf(path.join(overlay, "state_5.sqlite")), [1, 3], "overlay re-copied from the merged set");
});

test("missing origin record falls back to warn-and-preserve (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    fs.rmSync(path.join(overlay, SQLITE_ORIGIN_FILE), { force: true });

    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    const db2 = new sqliteCtor(ov);
    db2.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db2.close();

    const T = Date.now() / 1000;
    touch(ov, T);
    touch(re, T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("diverge")), "without provenance the conservative warning must fire");
    assert.deepEqual(rowsOf(re), [1, 2]);
    assert.deepEqual(rowsOf(path.join(real, "state_5.sqlite.bili-conflict")), [1], "loser preserved when provenance is unknown");
});

test("crashed set: stale loser WAL dropped silently once replayed into the winner (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    // Crashed launch: row 10 checkpointed into main, row 11 left in the WAL.
    buildDb(root, real, "state_5.sqlite", "10:a", "11:tail", false);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    assert.ok(fs.existsSync(path.join(overlay, "state_5.sqlite-wal")), "crashed set copied whole");

    // The bili session opens the overlay db: recovery replays the copied WAL
    // into the overlay main, then a clean close removes the overlay sidecars.
    const ov = path.join(overlay, "state_5.sqlite");
    assert.deepEqual(rowsOf(ov), [10, 11], "recovery replays the copied WAL against its main");
    const db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(12, 'viaOverlay')").run();
    db.close();

    const T = Date.now() / 1000;
    touch(ov, T);
    touch(path.join(real, "state_5.sqlite"), T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct")), `replayed WAL is not a divergence: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(path.join(real, "state_5.sqlite")), [10, 11, 12], "WAL tail recovered into the merged main");
    assert.ok(quickCheckOk(path.join(real, "state_5.sqlite")));
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict for the stale crashed set: ${n}`);
    }
});

test("isSqliteMain accepts uppercase extensions (#1919)", () => {
    assert.equal(isSqliteMain("STATE_5.DB", new Set()), true);
    assert.equal(isSqliteMain("Logs.SQLITE", new Set()), true);
    assert.equal(isSqliteMain("cache.Sqlite3", new Set()), true);
    assert.equal(isSqliteMain("X.WAL", new Set()), false);
    assert.equal(isSqliteMain("X.SHM", new Set()), false);
    assert.equal(isSqliteMain("x.JOURNAL", new Set()), false);
});

test("a directory named like a db is mirrored, not copied as a db set (#1919)", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(path.join(real, "logs.db", "inner"), { recursive: true });
    fs.writeFileSync(path.join(real, "logs.db", "inner", "note.txt"), "keep\n");
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("could not link")), `directory must not land in linkFailures: ${JSON.stringify(errs)}`);
    const st = fs.lstatSync(path.join(overlay, "logs.db"));
    assert.ok(st.isDirectory() || st.isSymbolicLink(), "directory mirrored via the ordinary link path");
    assert.equal(fs.readFileSync(path.join(overlay, "logs.db", "inner", "note.txt"), "utf8"), "keep\n");
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict files from a db-named directory: ${n}`);
    }
});

test("relative legacy symlink to the real main is migrated too (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    if (!supportsFileSymlink()) {
        t.skip("file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege on this Windows host");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    const realMainBefore = fs.readFileSync(path.join(real, "state_5.sqlite"));
    // RELATIVE target spelling — the exact-string readlink match used to miss it.
    fs.symlinkSync(path.join("..", "real", "state_5.sqlite"), path.join(overlay, "state_5.sqlite"));

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("#1917")), "legacy migration must be announced for relative links too");
    const st = fs.lstatSync(path.join(overlay, "state_5.sqlite"));
    assert.ok(st.isFile() && !st.isSymbolicLink(), "relative symlink replaced by a private copy");
    assert.equal(st.nlink, 1);
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), realMainBefore);
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite")), realMainBefore, "real main untouched");
});

test("second launch keeps the overlay-created database active in the new overlay (#1951)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "config.toml"), 'model = "audit-model"\n');
    // First launch: fresh real home, no database yet.
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml", ".env"]));
    // The client run inside that overlay creates its session database there
    // (one sentinel row), then the launch ends.
    buildDb(root, overlay, "state_5.sqlite", "1:first-session", "", true);
    // Second launch: the set merges back into the real home AND the copy phase
    // must re-import it into this launch's active home.
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml", ".env"]));
    assert.ok(fs.existsSync(path.join(real, "state_5.sqlite")), "db merged back into the real home");
    const overlayDb = path.join(overlay, "state_5.sqlite");
    assert.ok(fs.existsSync(overlayDb), "second launch's active CODEX_HOME keeps the database (#1951)");
    const st = fs.lstatSync(overlayDb);
    assert.ok(st.isFile(), "overlay db is a regular file");
    assert.equal(st.nlink, 1, "overlay db stays a private copy, never a shared link");
    assert.deepEqual(rowsOf(overlayDb), [1]);
    assert.deepEqual(rowsOf(path.join(real, "state_5.sqlite")), [1]);
    for (const dir of [real, overlay]) {
        for (const n of fs.readdirSync(dir)) {
            assert.ok(!n.includes("bili-conflict"), `unexpected conflict file ${path.join(dir, n)}`);
        }
    }
    const origin = JSON.parse(fs.readFileSync(path.join(overlay, SQLITE_ORIGIN_FILE), "utf8")) as Record<string, unknown>;
    assert.ok(origin["state_5.sqlite"], "fresh copy carries the #1919 provenance snapshot");
    // Third launch: the documented #1919 steady state — the unmodified overlay
    // copy is silently dropped and re-copied, no divergence noise.
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml", ".env"]));
    });
    assert.ok(!errs.some((e) => e.includes("distinct") || e.includes("bili-conflict")), `unexpected divergence noise: ${errs.join(" | ")}`);
    assert.ok(fs.existsSync(overlayDb), "steady state keeps the active overlay db");
    assert.deepEqual(rowsOf(overlayDb), [1]);
    assert.deepEqual(rowsOf(path.join(real, "state_5.sqlite")), [1]);
});

test("finalizeCodexHome: clean exit writes the run's db and files into a fresh real home (#1965)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
    const cfgText = '[model]\nname = "x"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), cfgText);
    fs.writeFileSync(path.join(codexHome, ".env"), "MY_VAR=keep\n");

    const overlay = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-42", manageRouting: true });
    assert.equal(overlay, `${codexHome}-bili`);
    // The run: the client creates its state db and one plain file under the
    // overlay; sessions/ is shared with the real home.
    buildDb(root, overlay!, "state_5.sqlite", "1:a,2:b", "", true);
    fs.writeFileSync(path.join(overlay!, "run-note.txt"), "from-run\n");
    fs.writeFileSync(path.join(overlay!, "sessions", "s1.jsonl"), '{"id":1}\n');

    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(codexHome, overlay!, [".env", "config.toml"])));
    assert.equal(errs.length, 0, `a clean exit must be silent: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(path.join(codexHome, "state_5.sqlite")), [1, 2], "run's db readable in the real home without another bili start");
    assert.ok(quickCheckOk(path.join(codexHome, "state_5.sqlite")));
    assert.equal(fs.readFileSync(path.join(codexHome, "run-note.txt"), "utf8"), "from-run\n", "run-created files merge back too");
    assert.ok(!fs.existsSync(path.join(overlay!, "run-note.txt")));
    assert.equal(fs.readFileSync(path.join(codexHome, "sessions", "s1.jsonl"), "utf8"), '{"id":1}\n', "shared-link writes already landed in the real home");
    assert.equal(fs.readFileSync(path.join(codexHome, ".env"), "utf8"), "MY_VAR=keep\n", "generated .env never leaves the overlay");
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), cfgText, "generated config.toml never leaves the overlay");
    for (const n of fs.readdirSync(codexHome)) {
        assert.ok(!n.startsWith(".bili-"), `no bili metadata in the real home: ${n}`);
        assert.ok(!n.includes("bili-conflict"), `no conflict on a clean exit: ${n}`);
    }
    assert.ok(fs.existsSync(path.join(overlay!, ".env")), "owned .env stays for the next launch");
    // The next bili launch imports the written-back db into its fresh overlay copy.
    const ov2 = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-43", manageRouting: true });
    assert.deepEqual(rowsOf(path.join(ov2!, "state_5.sqlite")), [1, 2], "second launch sees the written-back rows (#1951)");
});

test("finalizeCodexHome: cold-start rollout paths remain readable after directory write-back (#1965)", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "real-bili");
    fs.mkdirSync(real);
    fs.mkdirSync(path.join(overlay, "sessions"), { recursive: true });
    const rollout = path.join(overlay, "sessions", "s1.jsonl");
    fs.writeFileSync(rollout, '{"id":1}\n');

    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(real, overlay)));
    assert.deepEqual(errs, []);
    assert.equal(fs.readFileSync(path.join(real, "sessions", "s1.jsonl"), "utf8"), '{"id":1}\n');
    assert.equal(fs.readFileSync(rollout, "utf8"), '{"id":1}\n', "absolute rollout paths recorded under the overlay must still resolve");
    assert.ok(fs.lstatSync(path.join(overlay, "sessions")).isSymbolicLink(), "the moved directory must become a shared link, not a stale copy");
    fs.writeFileSync(path.join(real, "sessions", "s2.jsonl"), '{"id":2}\n');
    assert.equal(fs.readFileSync(path.join(overlay, "sessions", "s2.jsonl"), "utf8"), '{"id":2}\n');
    assert.ok(finalizeCodexHome(real, overlay), "subsequent finalization skips the shared directory");
});

test("finalizeCodexHome: existing db merges back silently and the next launch imports it (#1965)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "[x]\n");
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b,3:c", "", true);

    const ov1 = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-1", manageRouting: false });
    assert.equal(ov1, `${codexHome}-bili`);
    const ovp = path.join(ov1!, "state_5.sqlite");
    const rep = path.join(codexHome, "state_5.sqlite");
    const db = new sqliteCtor(ovp);
    db.prepare("INSERT INTO t VALUES(4, 'viaOverlay')").run();
    db.close();
    const T = Date.now() / 1000;
    touch(ovp, T);
    touch(rep, T - 60);
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(codexHome, ov1!, [".env", "config.toml"])));
    assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct") || e.includes("could not merge")), `steady-state merge must be silent: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1, 2, 3, 4]);
    assert.ok(quickCheckOk(rep));
    for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no conflict file: ${n}`);
    assert.ok(!fs.existsSync(ovp), "merged set leaves the overlay");
    const ov2 = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-2", manageRouting: false });
    assert.deepEqual(rowsOf(path.join(ov2!, "state_5.sqlite")), [1, 2, 3, 4], "next launch imports the merged rows");
});

test("finalizeCodexHome: concurrent native run advanced the real db — both generations survive (#1965)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "[x]\n");
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b,3:c", "", true);

    const ov = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-c", manageRouting: false });
    assert.ok(ov);
    const ovp = path.join(ov!, "state_5.sqlite");
    const rep = path.join(codexHome, "state_5.sqlite");
    const d1 = new sqliteCtor(ovp);
    d1.prepare("INSERT INTO t VALUES(4, 'bili')").run();
    d1.close();
    // A native codex meanwhile commits straight into the REAL home.
    const d2 = new sqliteCtor(rep);
    d2.prepare("INSERT INTO t VALUES(9, 'native')").run();
    d2.close();
    const T = Date.now() / 1000;
    touch(rep, T);
    touch(ovp, T - 60);
    const errs = capturedErrors(() => finalizeCodexHome(codexHome, ov!, [".env", "config.toml"]));
    assert.ok(errs.some((e) => e.includes("diverge") || e.includes("distinct")), `true divergence must be reported loudly: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1, 2, 3, 9], "newer native generation wins");
    const conflict = path.join(codexHome, "state_5.sqlite.bili-conflict");
    assert.ok(fs.existsSync(conflict), "the bili generation is preserved, never overwritten");
    assert.deepEqual(rowsOf(conflict), [1, 2, 3, 4]);
    assert.ok(quickCheckOk(rep));
    assert.ok(quickCheckOk(conflict));
    assert.ok(!fs.existsSync(ovp), "overlay set consumed");
});

test("finalizeCodexHome: blocked real slot keeps the whole set in the overlay and retry succeeds (#1965)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "[x]\n");
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b,3:c", "", true);

    const ov = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-b", manageRouting: false });
    assert.ok(ov);
    const ovp = path.join(ov!, "state_5.sqlite");
    const rep = path.join(codexHome, "state_5.sqlite");
    // A DIRECTORY where the db should be makes every rename onto it fail —
    // the Windows-style open-file lock stand-in used by the startup-path test.
    fs.renameSync(rep, `${rep}.bak`);
    fs.mkdirSync(rep);
    // The run left a CRASHED set behind: its new row checkpointed into main
    // (the copy already holds 1-3), tail row stuck in an uncheckpointed WAL.
    buildDb(root, ov!, "state_5.sqlite", "4:d", "5:e", false);
    let errs = capturedErrors(() => assert.equal(finalizeCodexHome(codexHome, ov!, [".env", "config.toml"]), false));
    assert.ok(errs.some((e) => e.includes("could not merge")), `blocked merge must be reported: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(ovp), [1, 2, 3, 4, 5], "set intact in the overlay, WAL still replayable");
    assert.ok(quickCheckOk(ovp));
    assert.ok(fs.statSync(rep).isDirectory(), "blocked slot untouched");
    for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no partial conflict state: ${n}`);
    // Lock released: restore the original real db and retry.
    fs.rmdirSync(rep);
    fs.renameSync(`${rep}.bak`, rep);
    errs = capturedErrors(() => assert.ok(finalizeCodexHome(codexHome, ov!, [".env", "config.toml"])));
    assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct") || e.includes("could not merge")), `retry after unblock must be silent: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1, 2, 3, 4, 5]);
    assert.ok(quickCheckOk(rep));
    assert.ok(!fs.existsSync(ovp), "set moved out of the overlay");
});

test("finalizeCodexHome: a crashed client's WAL travels with its main into a fresh real home (#1965)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "[x]\n");

    const ov = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-k", manageRouting: false });
    assert.ok(ov);
    // The client was killed mid-run: row 10 checkpointed into main, row 11
    // stuck in an uncheckpointed WAL.
    buildDb(root, ov!, "state_5.sqlite", "10:x", "11:y", false);
    const ovp = path.join(ov!, "state_5.sqlite");
    const walBefore = fs.readFileSync(`${ovp}-wal`);
    const rep = path.join(codexHome, "state_5.sqlite");
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(codexHome, ov!, [".env", "config.toml"])));
    assert.equal(errs.length, 0, `unit move into an empty slot must be silent: ${JSON.stringify(errs)}`);
    assert.deepEqual(fs.readFileSync(`${rep}-wal`), walBefore, "WAL moved as a unit with its main — no splice");
    assert.deepEqual(rowsOf(rep), [10, 11]);
    assert.ok(quickCheckOk(rep));
    assert.ok(!fs.existsSync(ovp), "set consumed from the overlay");
});

test("finalizeCodexHome: missing or untouched overlay is a silent no-op (#1965)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "[x]\n");
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b", "", true);

    assert.ok(finalizeCodexHome(codexHome, path.join(root, "no-such-overlay"), [".env", "config.toml"]), "missing overlay → nothing pending");

    // Spawn-failure degradation: prepare ran, the client never did — the
    // byte-identical overlay copy must merge back without noise.
    const ov = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-n", manageRouting: false });
    assert.ok(ov);
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(codexHome, ov!, [".env", "config.toml"])));
    assert.equal(errs.length, 0, `untouched overlay must finalize silently: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(path.join(codexHome, "state_5.sqlite")), [1, 2]);
    assert.ok(quickCheckOk(path.join(codexHome, "state_5.sqlite")));
    for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no conflict file: ${n}`);
});

test("finalizeCodexHome: a leftover lease directory never merges into the real home (#1965)", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "real");
    fs.mkdirSync(codexHome, { recursive: true });
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b", "", true);

    const ov = prepareCodexHome({ codexHome, origin: "http://127.0.0.1:8899", caPath: "/nonexistent/ca.pem", conversationId: "conv-n", manageRouting: false });
    assert.ok(ov);
    // Simulate a failed lease release (e.g. Windows EBUSY): the lock dir with
    // its owner record is still sitting in the overlay at finalize time.
    const leaseDir = path.join(ov, ".bili-launch.lock");
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(path.join(leaseDir, "owner.json"), JSON.stringify({ pid: process.pid, token: "tok", ts: Date.now() }));
    buildDb(root, ov, "state_5.sqlite", "3:c", "", true);

    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(codexHome, ov!, [".env", "config.toml"])));
    assert.equal(errs.length, 0, `finalize must stay silent: ${JSON.stringify(errs)}`);
    assert.equal(rowsOf(path.join(codexHome, "state_5.sqlite")).length, 3, "db still merges back");
    const realNames = fs.readdirSync(codexHome);
    assert.ok(!realNames.includes(".bili-launch.lock"), `lease dir leaked into the real home: ${JSON.stringify(realNames)}`);
    for (const n of realNames) assert.ok(!n.startsWith(".bili-"), `no bili metadata in the real home: ${n}`);
});

test("WAL-only overlay commit wins even with EQUAL main mtimes (#2195)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    // The reported bug shape: sequential bili launches, no concurrent codex.
    // The run's only commit sits in an uncheckpointed WAL, so the main db keeps
    // the copied bytes AND mtime; with equal main mtimes the old mtime rule
    // picked the STALE real side and quarantined the new generation.
    const run = (viaExit: boolean): void => {
        const root = mkRoot();
        const real = path.join(root, "real");
        const overlay = path.join(root, "overlay");
        fs.mkdirSync(real, { recursive: true });
        buildDb(root, real, "state_5.sqlite", "1:A", "", true);
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
        // The session commits ONLY to the WAL and dies without closing.
        buildDb(root, overlay, "state_5.sqlite", "", "2:B", false);
        const rep = path.join(real, "state_5.sqlite");
        const ovp = path.join(overlay, "state_5.sqlite");
        const oMainBytes = fs.readFileSync(ovp);
        const oWalBytes = fs.readFileSync(`${ovp}-wal`);
        pinMainsEqual(rep, ovp);
        const errs = capturedErrors(() => {
            if (viaExit) assert.ok(finalizeCodexHome(real, overlay, [".env", "config.toml"]));
            else assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
        });
        assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct")), `a single-side advance is not a divergence: ${JSON.stringify(errs)}`);
        assert.deepEqual(fs.readFileSync(rep), oMainBytes, "active main must come from the committed (overlay) side");
        assert.deepEqual(fs.readFileSync(`${rep}-wal`), oWalBytes, "the uncheckpointed WAL travels with its main");
        assert.deepEqual(rowsOf(rep), [1, 2], "the new thread is readable in the real home without manual recovery");
        assert.ok(integrityOk(rep), "active db passes integrity_check");
        noConflicts(real, overlay);
        fs.rmSync(root, { recursive: true, force: true });
    };
    run(true); // exit-time merge-back (the reported failure site)
    run(false); // next-launch startup fold (retry path)
});

test("WAL-only real-side advance wins over the idle overlay copy, equal mtimes (#2195)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:A", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    // A plain codex commits ONLY to the REAL home's WAL; the bili session merely
    // opened its copy (read) and died, leaving connection artifacts.
    buildDb(root, real, "state_5.sqlite", "", "2:P", false);
    bareOpen(root, overlay, "state_5.sqlite");
    const rep = path.join(real, "state_5.sqlite");
    const ovp = path.join(overlay, "state_5.sqlite");
    pinMainsEqual(rep, ovp);
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(real, overlay, [".env", "config.toml"])));
    assert.deepEqual(errs, [], `an idle overlay copy is provably stale — no warning at all: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1, 2], "plain-run rows kept");
    assert.ok(integrityOk(rep));
    assert.ok(!fs.existsSync(ovp), "stale overlay copy silently dropped");
    assert.ok(!fs.existsSync(`${ovp}-wal`) && !fs.existsSync(`${ovp}-shm`), "connection artifacts dropped with their set");
    noConflicts(real, overlay);
});

test("SHM-only drift is neither a commit nor a divergence (#2195)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:A", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    // The -shm is a rebuildable coordination file: reading can rewrite it, so
    // its byte drift alone must not count as a business commit.
    fs.writeFileSync(path.join(overlay, "state_5.sqlite-shm"), Buffer.alloc(32768, 0xab));
    const rep = path.join(real, "state_5.sqlite");
    pinMainsEqual(rep, path.join(overlay, "state_5.sqlite"));
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(real, overlay, [".env", "config.toml"])));
    assert.deepEqual(errs, [], `shm-only drift must stay silent: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1]);
    assert.ok(integrityOk(rep));
    noConflicts(real, overlay);
});

test("true WAL-only divergence on BOTH sides warns and preserves both generations (#2195)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:A", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    // Both sides commit WAL-only after the copy: genuine concurrent divergence.
    buildDb(root, overlay, "state_5.sqlite", "", "2:B", false);
    buildDb(root, real, "state_5.sqlite", "", "3:P", false);
    const rep = path.join(real, "state_5.sqlite");
    const ovp = path.join(overlay, "state_5.sqlite");
    pinMainsEqual(rep, ovp);
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(real, overlay, [".env", "config.toml"])));
    assert.ok(errs.some((e) => e.includes("diverge") && e.includes("distinct")), `true divergence must be reported loudly: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1, 3], "mtime tiebreak keeps one generation active deterministically");
    assert.ok(integrityOk(rep));
    const cMain = path.join(real, "state_5.sqlite.bili-conflict");
    const cWal = path.join(real, "state_5.sqlite-wal.bili-conflict");
    assert.ok(fs.existsSync(cMain) && fs.existsSync(cWal), "loser preserved as a whole recoverable group");
    // Recover exactly like the issue's manual step 6: restore standard names in
    // an isolated dir, then read.
    const iso = path.join(root, "iso");
    fs.mkdirSync(iso);
    fs.copyFileSync(cMain, path.join(iso, "state_5.sqlite"));
    fs.copyFileSync(cWal, path.join(iso, "state_5.sqlite-wal"));
    assert.deepEqual(rowsOf(path.join(iso, "state_5.sqlite")), [1, 2], "conflict group recovers the overlay generation");
    assert.ok(integrityOk(path.join(iso, "state_5.sqlite")));
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.endsWith(".bili-conflict.1"), `no double-preservation round: ${n}`);
    }
});

test("missing origin snapshot stays conservative with WAL-only commits (#2195)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:A", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    fs.rmSync(path.join(overlay, SQLITE_ORIGIN_FILE));
    buildDb(root, overlay, "state_5.sqlite", "", "2:B", false);
    const rep = path.join(real, "state_5.sqlite");
    const ovp = path.join(overlay, "state_5.sqlite");
    pinMainsEqual(rep, ovp);
    const errs = capturedErrors(() => assert.ok(finalizeCodexHome(real, overlay, [".env", "config.toml"])));
    assert.ok(errs.some((e) => e.includes("diverge") || e.includes("distinct")), `without provenance the conservative warning must fire: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(rep), [1], "no provenance claim: nothing is dropped silently");
    assert.ok(integrityOk(rep));
    const cMain = path.join(real, "state_5.sqlite.bili-conflict");
    const cWal = path.join(real, "state_5.sqlite-wal.bili-conflict");
    assert.ok(fs.existsSync(cMain) && fs.existsSync(cWal), "both generations preserved when provenance is unknown");
    const iso = path.join(root, "iso");
    fs.mkdirSync(iso);
    fs.copyFileSync(cMain, path.join(iso, "state_5.sqlite"));
    fs.copyFileSync(cWal, path.join(iso, "state_5.sqlite-wal"));
    assert.deepEqual(rowsOf(path.join(iso, "state_5.sqlite")), [1, 2], "preserved group stays recoverable");
});
