/**
 * #5046/B policy evolution — final form (owner decision 2026-10-31):
 * a live foreign bili process holding <db>.lock NEVER blocks startup again,
 * whatever lanes are involved. The 2026-10-29→30 refuse-to-start policy
 * (same-lane / unknown-lane double-write shapes threw StorageSecondWriterError
 * so boot died before listen) was withdrawn because sharing one index.db IS
 * the supported topology (#5082/#5091): SQLite WAL is multi-process safe on a
 * local filesystem, inline lanes never register in the instance registry, and
 * real mixed-version fleets coexisted on one store for hours without incident.
 * The condition stays LOUD (no silent degradation): an info-level log line
 * names the peer, and the web/status wire surfaces the foreign pid via
 * recordSecondProcessOwner. The genuine hazard — two instances writing the
 * SAME session — keeps its own per-session alarm (the #3923 split-brain
 * contest, pinned in tests/issue-split-brain-surface.test.ts).
 *
 * Pinned here: live same-lane foreign holder ⇒ still opens (regression of the
 * exact bricked shape); mixed-version fleet marker WITHOUT lane ⇒ still opens
 * (regression of the pi-inline shape); cross-lane live holder ⇒ opens
 * (supported topology unchanged); dead-pid stale lock ⇒ takeover unchanged;
 * no foreign holder ⇒ original fast path unchanged; the
 * StorageSecondWriterError export survives for external code that still
 * imports/catches it even though nothing inside this repo throws it anymore.
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore, StorageSecondWriterError } from "../src/storage/store.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";

const DEAD_PID = 3999999;

let root: string;
let foreign: ChildProcess;
let engineAvailable = true;
let savedStateHome: string | undefined;
let savedLauncherLane: string | undefined;

function freshState(): string {
    return mkdtempSync(path.join(root, "state-"));
}

function freshSessions(): string {
    return mkdtempSync(path.join(root, "sessions-"));
}

function writeMarker(stateDir: string, lane: string | undefined): void {
    const dir = path.join(stateDir, "billion-context", "instances");
    mkdirSync(dir, { recursive: true });
    const entry: Record<string, unknown> = {
        instanceId: "foreign-00000001",
        pid: foreign.pid,
        port: 19999,
        origin: "http://127.0.0.1:19999",
        startedAt: Date.now(),
    };
    if (lane !== undefined) entry.lane = lane;
    writeFileSync(path.join(dir, "foreign-00000001.json"), JSON.stringify(entry));
}

function writeLock(sessionsDir: string, pid: number): void {
    writeFileSync(path.join(sessionsDir, "index.db.lock"), JSON.stringify({ pid, boot: Date.now() }));
}

function lockHolderPid(sessionsDir: string): number | null {
    const p = path.join(sessionsDir, "index.db.lock");
    if (!existsSync(p)) return null;
    return (JSON.parse(readFileSync(p, "utf8")) as { pid?: number }).pid ?? null;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

before(() => {
    root = mkdtempSync(path.join(tmpdir(), "bili-5046-"));
    savedStateHome = process.env.XDG_STATE_HOME;
    savedLauncherLane = process.env.BILI_LAUNCHER_LANE;
    foreign = spawn(process.execPath, ["-e", "setTimeout(()=>{},300000)"], { stdio: "ignore" });
    const probe = mkdtempSync(path.join(root, "probe-"));
    try {
        const s = UnifiedStore.open(path.join(probe, "index.db"));
        s.close();
    } catch {
        engineAvailable = false;
    }
});

after(() => {
    foreign.kill();
    rmSync(root, { recursive: true, force: true });
    setLogCapture(null);
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    if (savedLauncherLane === undefined) delete process.env.BILI_LAUNCHER_LANE;
    else process.env.BILI_LAUNCHER_LANE = savedLauncherLane;
});

test("#5046/B final (2026-10-31): live SAME-lane foreign holder ⇒ open succeeds (the formerly-bricked shape), info reported, lock taken over, status wire names the peer", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeMarker(state, "dsh");
    writeLock(sessions, foreign.pid!);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state, BILI_LAUNCHER_LANE: "dsh" }, () => {
        // Owner decision 2026-10-31: whatever the lane math says, startup must
        // NOT be blocked by a live second writer — this used to THROW here.
        const shadow = UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "a live same-lane foreign holder must NOT block startup anymore");
        assert.ok(logs.some((m) => m.includes("supported topology")), "#5082/#5091 shared-topology info notice expected");
        assert.ok(!logs.some((m) => m.includes("REFUSED")), "no refusal wording may remain");
        assert.equal(lockHolderPid(sessions), process.pid, "lockfile takeover behavior is unchanged");
        // Loud-but-not-blocking: the web/status wire still surfaces the peer.
        withEnv({ BILI_STORAGE_UNIFIED: "shadow" }, () => {
            const wire = storageStatusWire();
            assert.ok(!wire.degraded, "coexistence is not a degradation");
            assert.equal(wire.secondProcess?.pid, foreign.pid, "live foreign pid stays surfaced on the status wire");
        });
        shadow!.close();
    });
    setLogCapture(null);
});

test("#5046/B final: mixed-version fleet — old marker WITHOUT lane (inline/pre-#5046) ⇒ open succeeds (formerly refused)", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeMarker(state, undefined);
    writeLock(sessions, foreign.pid!);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state, BILI_LAUNCHER_LANE: "dsh" }, () => {
        const shadow = UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "an unknown-lane peer must NOT block startup anymore (owner decision 2026-10-31)");
        assert.ok(!logs.some((m) => m.includes("REFUSED")), "no refusal wording may remain");
        shadow!.close();
    });
    setLogCapture(null);
});

test("#5046/B negative: live DIFFERENT-lane foreign holder ⇒ still opens (supported shared topology unchanged)", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeMarker(state, "pi");
    writeLock(sessions, foreign.pid!);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state, BILI_LAUNCHER_LANE: "dsh" }, () => {
        const shadow = UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "cross-lane sharing is the supported topology — must still open");
        assert.ok(logs.some((m) => m.includes("supported topology")), "#5091 shared-topology info notice expected");
        assert.equal(lockHolderPid(sessions), process.pid, "cross-lane takeover keeps the existing behavior");
        shadow!.close();
    });
    setLogCapture(null);
});

test("#5046/B negative: stale lock (dead foreign pid) ⇒ normal open + takeover unchanged", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeLock(sessions, DEAD_PID);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state }, () => {
        const shadow = UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "a dead pid is a stale lock — normal open");
        assert.equal(lockHolderPid(sessions), process.pid, "stale lock taken over");
        assert.ok(!logs.some((m) => m.includes("REFUSED")), "no refusal for a stale lock");
        shadow!.close();
    });
    setLogCapture(null);
});

test("#5046/B negative: no foreign holder ⇒ original fast path (ENABLED line, no refusal)", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state }, () => {
        const shadow = UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "clean directory opens as before");
        assert.ok(logs.some((m) => m.includes("unified shadow mode ENABLED")), "fast-path ENABLED line expected");
        assert.ok(!logs.some((m) => m.includes("REFUSED")));
        shadow!.close();
    });
    setLogCapture(null);
});

test("#5046/B compat surface: StorageSecondWriterError is still exported (external importers/catch sites keep working) though nothing internal throws it", () => {
    const err = new StorageSecondWriterError(12345, "/tmp/index.db");
    assert.ok(err instanceof StorageSecondWriterError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "StorageSecondWriterError");
    assert.equal(err.pid, 12345);
    assert.equal(err.dbPath, "/tmp/index.db");
});
