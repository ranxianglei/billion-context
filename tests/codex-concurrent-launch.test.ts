/** #3203: concurrent bili codex launches against the same home. Shared mode
 *  allocates a per-session overlay slot (`<home>-bili-s<N>`) so concurrent
 *  launches each own their generated files and proxy binding; legacy mode
 *  keeps the fixed name + exclusive lease; the pre-#3203 fixed-name overlay
 *  folds into the real home once (refused while a live legacy-era launch
 *  holds it). */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
    OverlayBusyError,
    prepareCodexHome,
    prepareCodexMcpInjection,
    mergeOverlayEntry,
    releaseOverlayLease,
} from "../src/launcher.ts";
import { supportsDirectorySymlink } from "./platform-capabilities.ts";

const crequire = createRequire(import.meta.url);

interface SqliteStmt {
    run(...params: unknown[]): unknown;
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

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER_URL = pathToFileURL(path.join(repoRoot, "src", "launcher.ts")).href;

function mkRoot(): string {
    return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "bili-3203-"));
}

function cleanup(...dirs: string[]): void {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// Synchronous sleep (repo idiom, see tests/external-summary.test.ts).
function syncPause(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Every *bili-conflict* path under dir, recursive. */
function findConflicts(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...findConflicts(p));
        else if (entry.name.includes("bili-conflict")) out.push(p);
    }
    return out;
}

/** A live foreign process whose pid can be planted as an overlay owner. */
async function spawnHolder(): Promise<{ pid: number; stop(): void }> {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    return { pid: child.pid ?? -1, stop: () => { try { child.kill(); } catch {} } };
}

function deadPid(): number {
    const res = spawnSync(process.execPath, ["-e", ""]);
    if (res.pid === undefined || res.pid <= 0) throw new Error("spawnSync returned no pid");
    return res.pid;
}

function plantLease(overlay: string, pid: number): void {
    const dir = path.join(overlay, ".bili-launch.lock");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid, token: "test-token", ts: Date.now() }, null, 2));
}

interface TsxChild {
    child: ChildProcess;
    stderr(): string;
    kill(): void;
    wait(): Promise<number | null>;
}

function tsxChild(script: string, args: string[]): TsxChild {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    // Captured at creation: a listener attached later can miss a close that
    // already fired, leaving the wait pending forever.
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    return {
        child,
        stderr: () => err,
        kill: () => { try { child.kill(); } catch {} },
        wait: () => closed,
    };
}

function writeScript(root: string, name: string, body: string): string {
    const p = path.join(root, name);
    fs.writeFileSync(p, body);
    return p;
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    for (;;) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
        if (size > 0 && size === lastSize) return;
        lastSize = size;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

// Child fixture: prepares a shared-mode injection for the given home, records
// the allocated slot, then keeps the slot lease alive until killed — exactly
// what a running bili codex session looks like between prepare and exit.
const PREPARE_HOLD_SRC = `
import fs from "node:fs";
import { prepareCodexMcpInjection } from "${LAUNCHER_URL}";
const [home, origin, out] = process.argv.slice(2);
const inj = prepareCodexMcpInjection({
    codexHome: home,
    origin,
    caPath: "/ca.pem",
    conversationId: "conv",
    manageRouting: true,
    sharedSqlite: true,
    sqliteHome: home,
});
fs.writeFileSync(out, JSON.stringify({ slot: inj.envPatch.CODEX_HOME ?? "" }));
setInterval(() => {}, 60000);
`;

test("shared mode allocates a per-session slot and pins CODEX_SQLITE_HOME to the real home (#3203)", () => {
    const root = mkRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        const inj = prepareCodexMcpInjection({
            codexHome: home,
            origin: "http://127.0.0.1:11111",
            caPath: "/ca.pem",
            conversationId: "first-session",
            manageRouting: true,
            sharedSqlite: true,
            sqliteHome: home,
        });
        const slot = inj.envPatch.CODEX_HOME;
        assert.ok(slot !== undefined, "expected a CODEX_HOME override");
        assert.match(slot!, /^.*-bili-s([1-9]|1[0-6])$/);
        assert.equal(slot!.startsWith(`${home}-bili-s`), true);
        assert.equal(inj.envPatch.CODEX_SQLITE_HOME, home);
        const env = fs.readFileSync(path.join(slot!, ".env"), "utf8");
        assert.ok(env.includes("http://127.0.0.1:11111"), "generated .env pins this launch's proxy");
        // A fresh shared launch must not resurrect the fixed-name overlay.
        assert.ok(!fs.existsSync(`${home}-bili`), "fixed-name overlay must not be created in shared mode");
    } finally {
        releaseOverlayLease();
        cleanup(root);
    }
});

test("legacy mode keeps the fixed-name overlay without CODEX_SQLITE_HOME (#3203 regression guard)", () => {
    const root = mkRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    try {
        const inj = prepareCodexMcpInjection({
            codexHome: home,
            origin: "http://127.0.0.1:11111",
            caPath: "/ca.pem",
            manageRouting: true,
            sharedSqlite: false,
        });
        assert.equal(inj.envPatch.CODEX_HOME, `${home}-bili`);
        assert.equal(inj.envPatch.CODEX_SQLITE_HOME, undefined);
    } finally {
        releaseOverlayLease();
        cleanup(root);
    }
});

test("concurrent shared-mode launches claim distinct slots (#3203)", { timeout: 120_000 }, async (t) => {
    const root = mkRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    const script = writeScript(root, "prepare-hold.mts", PREPARE_HOLD_SRC);
    const N = 4;
    const kids: TsxChild[] = [];
    t.after(() => { for (const k of kids) k.kill(); cleanup(root); });
    try {
        for (let i = 0; i < N; i++) {
            kids.push(tsxChild(script, [home, `http://127.0.0.1:${20000 + i}`, path.join(root, `out-${i}.json`)]));
        }
        const slots: string[] = [];
        for (let i = 0; i < N; i++) {
            try {
                await waitForFile(path.join(root, `out-${i}.json`), 90_000);
            } catch (e) {
                const dump = kids.map((k, j) => `--- child ${j}\n${k.stderr()}`).join("\n");
                throw new Error(`${e instanceof Error ? e.message : String(e)}; child stderr:\n${dump}`);
            }
            const rec = JSON.parse(fs.readFileSync(path.join(root, `out-${i}.json`), "utf8")) as { slot: string };
            assert.match(rec.slot, /^.*-bili-s([1-9]|1[0-6])$/, `launch ${i} got a slot: ${rec.slot}`);
            slots.push(rec.slot);
        }
        assert.equal(new Set(slots).size, N, `slots must be distinct, got ${JSON.stringify(slots)}`);
        // Every claimed slot carries a live owner record naming ITS launcher.
        for (const [slot, kid] of slots.map((s, i) => [s, kids[i]] as const)) {
            const rec = JSON.parse(fs.readFileSync(path.join(slot, ".bili-launch.lock", "owner.json"), "utf8")) as { pid?: number };
            assert.equal(rec.pid, kid.child.pid, `owner of ${path.basename(slot)} must be its launcher`);
        }
        for (const k of kids) assert.ok(!k.stderr().includes("BILI_OVERLAY_BUSY"), `no refusal expected, got: ${k.stderr()}`);
    } finally {
        for (const k of kids) k.kill();
        for (const k of kids) await k.wait();
    }
});

test("every slot held by a live launch refuses the next shared launch (#3203 exhaustion)", { timeout: 120_000 }, async (t) => {
    const root = mkRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const holder = await spawnHolder();
    const script = writeScript(root, "prepare-hold.mts", PREPARE_HOLD_SRC);
    const kid = tsxChild(script, [home, "http://127.0.0.1:21000", path.join(root, "out.json")]);
    t.after(() => { holder.stop(); kid.kill(); cleanup(root); });
    try {
        for (let n = 1; n <= 16; n++) plantLease(`${home}-bili-s${n}`, holder.pid);
        const code = await kid.wait();
        assert.notEqual(code, 0, "an exhausted pool must refuse the launch");
        assert.ok(kid.stderr().includes("BILI_OVERLAY_BUSY"), `expected the busy error code, got: ${kid.stderr()}`);
        assert.ok(kid.stderr().includes("all 16 per-session codex slots"), `expected the exhaustion detail, got: ${kid.stderr()}`);
    } finally {
        kid.kill();
    }
});

test("a stale per-session slot lease is reclaimed, not leaked forever (#3203)", () => {
    const root = mkRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        plantLease(`${home}-bili-s1`, deadPid());
        const overlay = prepareCodexHome({
            codexHome: home,
            origin: "http://127.0.0.1:11111",
            caPath: "/ca.pem",
            manageRouting: true,
            sharedSqlite: true,
        });
        assert.equal(overlay, `${home}-bili-s1`, "the stale s1 lease must be reclaimed, not skipped");
    } finally {
        releaseOverlayLease();
        cleanup(root);
    }
});

test("the pre-#3203 fixed-name overlay folds into the real home once (#3203 migration)", { skip: sqliteCtor === undefined ? "node:sqlite unavailable" : false }, () => {
    const root = mkRoot();
    const home = path.join(root, "home");
    const legacy = `${home}-bili`;
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, "sessions"));
    fs.writeFileSync(path.join(home, "sessions", "rollout-old.jsonl"), "{}\n");
    fs.mkdirSync(legacy);
    // Crash-residue shape: a private SQLite set (cleanly closed here) and a
    // private regular file, plus the generated files a legacy launch owned.
    const db = new sqliteCtor!(path.join(legacy, "state_5.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO threads VALUES(?, ?)").run(1, "legacy-thread");
    db.close();
    fs.writeFileSync(path.join(legacy, "notes.txt"), "private\n");
    fs.writeFileSync(path.join(legacy, ".env"), "# legacy generated\n");
    fs.writeFileSync(path.join(legacy, "config.toml"), "[mcp_servers.bili]\n");
    if (supportsDirectorySymlink()) {
        fs.symlinkSync(path.join(home, "sessions"), path.join(legacy, "sessions"), process.platform === "win32" ? "junction" : "dir");
    }
    try {
        const overlay = prepareCodexHome({
            codexHome: home,
            origin: "http://127.0.0.1:11111",
            caPath: "/ca.pem",
            manageRouting: true,
            sharedSqlite: true,
        });
        assert.match(overlay ?? "", /-bili-s[1-9]$/);
        // Private residue folded into the REAL home.
        assert.equal(fs.readFileSync(path.join(home, "notes.txt"), "utf8"), "private\n");
        const merged = new sqliteCtor!(path.join(home, "state_5.sqlite"), { readOnly: true });
        const row = merged.prepare("SELECT COUNT(*) AS n FROM threads").get();
        merged.close();
        assert.equal(Number(row?.n ?? 0), 1, "the legacy thread record must land in the real-home db");
        for (const n of fs.readdirSync(home)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation expected: ${n}`);
        // The legacy overlay itself survives (never deleted) with its symlink intact.
        assert.ok(fs.existsSync(legacy));
        if (supportsDirectorySymlink()) {
            assert.equal(fs.readlinkSync(path.join(legacy, "sessions")), path.join(home, "sessions"));
        }
        // Second pass is a no-op: nothing new lands, no conflict appears.
        const overlay2 = prepareCodexHome({
            codexHome: home,
            origin: "http://127.0.0.1:22222",
            caPath: "/ca.pem",
            manageRouting: true,
            sharedSqlite: true,
        });
        assert.equal(overlay2, overlay, "same process reuses its slot");
        for (const n of fs.readdirSync(home)) assert.ok(!n.includes("bili-conflict"), `second fold must stay clean: ${n}`);
    } finally {
        releaseOverlayLease();
        cleanup(root);
    }
});

test("a live legacy-era launch holding the fixed overlay refuses the shared launch (#3203 dual-writer guard)", { timeout: 120_000 }, async (t) => {
    const root = mkRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.mkdirSync(`${home}-bili`);
    const holder = await spawnHolder();
    plantLease(`${home}-bili`, holder.pid);
    const script = writeScript(root, "prepare-hold.mts", PREPARE_HOLD_SRC);
    const kid = tsxChild(script, [home, "http://127.0.0.1:21001", path.join(root, "out.json")]);
    t.after(() => { holder.stop(); kid.kill(); cleanup(root); });
    try {
        const code = await kid.wait();
        assert.notEqual(code, 0, "a live legacy holder must refuse the shared launch");
        assert.ok(kid.stderr().includes("BILI_OVERLAY_BUSY"), `expected the busy error code, got: ${kid.stderr()}`);
        assert.ok(kid.stderr().includes(String(holder.pid)), `expected the holder pid in the message, got: ${kid.stderr()}`);
        assert.ok(!fs.existsSync(path.join(root, "out.json")), "no slot may be recorded before the refusal");
    } finally {
        kid.kill();
    }
});

test("a byte-identical overlay generation is dropped silently on merge-back, a real conflict still quarantines (#3203)", () => {
    const root = mkRoot();
    const src = path.join(root, "overlay");
    const dst = path.join(root, "real");
    fs.mkdirSync(path.join(src, "conflict.txt"), { recursive: true });
    fs.mkdirSync(path.join(dst, "conflict.txt"), { recursive: true });
    try {
        // Case A: identical bytes — the overlay copy adds nothing; dropping it must not
        // quarantine a .bili-conflict twin (two concurrent slots both wrote the same
        // codex marker file, e.g. `.sandbox_migration` = "v1"). Identical bytes converge
        // in BOTH recency directions, so no mtime pinning is involved at all.
        fs.writeFileSync(path.join(src, "conflict.txt", "marker.txt"), "v1\n");
        fs.writeFileSync(path.join(dst, "conflict.txt", "marker.txt"), "v1\n");
        assert.ok(mergeOverlayEntry(path.join(src, "conflict.txt"), path.join(dst, "conflict.txt")), "merge keeps going");
        assert.ok(!fs.existsSync(path.join(src, "conflict.txt", "marker.txt")), "identical loser is dropped");
        assert.equal(fs.readFileSync(path.join(dst, "conflict.txt", "marker.txt"), "utf8"), "v1\n", "dst untouched");
        assert.deepEqual(findConflicts(root), [], "no quarantine anywhere for identical bytes");

        // Case B: different content — genuine divergence still quarantines the loser,
        // winner by recency. Recency comes from natural write order + a fixed pause:
        // forced mtimes via fs.utimesSync proved unreliable across CI environments
        // (future values are EINVAL on Windows — #3321), so the older side writes first.
        fs.writeFileSync(path.join(dst, "conflict.txt", "promoted.txt"), "v1\n");
        syncPause(1_100);
        fs.writeFileSync(path.join(src, "conflict.txt", "promoted.txt"), "v2\n");
        assert.ok(mergeOverlayEntry(path.join(src, "conflict.txt"), path.join(dst, "conflict.txt")));
        const quarantined = path.join(dst, "conflict.txt", "promoted.txt.bili-conflict");
        assert.ok(fs.existsSync(quarantined), "real conflict quarantines the older side");
        assert.equal(fs.readFileSync(quarantined, "utf8"), "v1\n", "loser's original bytes preserved");
        assert.equal(fs.readFileSync(path.join(dst, "conflict.txt", "promoted.txt"), "utf8"), "v2\n", "winner promoted");
    } finally {
        cleanup(root);
    }
});

test("divergent-byte merge-back quarantines exactly one side in BOTH recency directions (#3203)", () => {
    const root = mkRoot();
    const src = path.join(root, "overlay");
    const dst = path.join(root, "real");
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    try {
        // Identical flat files first: dropped silently, never quarantined (the
        // byte-identical rule is mtime-independent — both recency branches drop).
        fs.writeFileSync(path.join(src, "marker.txt"), "v1\n");
        fs.writeFileSync(path.join(dst, "marker.txt"), "v1\n");
        assert.ok(mergeOverlayEntry(path.join(src, "marker.txt"), path.join(dst, "marker.txt")), "identical loser merges cleanly");
        assert.ok(!fs.existsSync(path.join(src, "marker.txt")), "identical loser is dropped");
        assert.equal(fs.readFileSync(path.join(dst, "marker.txt"), "utf8"), "v1\n", "dst untouched");

        // Divergent, slot-side copy NEWER (written last after the fixed pause): it
        // wins, the home-side copy is quarantined.
        fs.writeFileSync(path.join(dst, "edit-a.txt"), "home-bytes\n");
        syncPause(1_100);
        fs.writeFileSync(path.join(src, "edit-a.txt"), "slot-bytes\n");
        assert.ok(mergeOverlayEntry(path.join(src, "edit-a.txt"), path.join(dst, "edit-a.txt")));
        assert.equal(fs.readFileSync(path.join(dst, "edit-a.txt"), "utf8"), "slot-bytes\n", "a newer slot edit must win");
        assert.equal(fs.readFileSync(`${path.join(dst, "edit-a.txt")}.bili-conflict`, "utf8"), "home-bytes\n", "the divergent home copy must be preserved");

        // Divergent, real-home edit NEWER (written last): it wins, the slot-side copy
        // is quarantined — a real-home edit made DURING the launch survives merge-back.
        fs.writeFileSync(path.join(src, "edit-b.txt"), "slot-bytes\n");
        syncPause(1_100);
        fs.writeFileSync(path.join(dst, "edit-b.txt"), "home-bytes\n");
        assert.ok(mergeOverlayEntry(path.join(src, "edit-b.txt"), path.join(dst, "edit-b.txt")));
        assert.equal(fs.readFileSync(path.join(dst, "edit-b.txt"), "utf8"), "home-bytes\n", "a newer real-home edit must win");
        assert.equal(fs.readFileSync(`${path.join(dst, "edit-b.txt")}.bili-conflict`, "utf8"), "slot-bytes\n", "the divergent slot copy must be preserved");

        assert.deepEqual(
            findConflicts(root).sort(),
            [path.join(dst, "edit-a.txt.bili-conflict"), path.join(dst, "edit-b.txt.bili-conflict")].sort(),
            "exactly the two divergent losers are quarantined, nothing else",
        );
    } finally {
        cleanup(root);
    }
});
