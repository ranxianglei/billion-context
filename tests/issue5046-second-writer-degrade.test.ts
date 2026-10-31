/**
 * #5046/B (owner decision chain 2026-10-29 → 2026-10-30): a live foreign
 * bili process holding <db>.lock must make the proxy sidecar REFUSE TO START
 * (throw StorageSecondWriterError — no-degradation-in-any-case) with one
 * actionable error line (names BILI_SESSIONS_DIR + BILI_CONFIG_FILE) and
 * status-wire visibility. Both directions pinned: live same-lane/unknown-lane
 * foreign holder ⇒ refuse; no foreign holder ⇒ the original fast path is
 * unchanged; dead-pid stale lock ⇒ takeover unchanged; cross-lane live holder
 * ⇒ still opens (#5091 supported shared topology); the report-only default
 * policy (CLI/export open paths) stays byte-identical.
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

test("#5046/B: live same-lane foreign holder ⇒ open REFUSES TO START (throw), lock untouched, actionable error + status wire", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeMarker(state, "dsh");
    writeLock(sessions, foreign.pid!);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state, BILI_LAUNCHER_LANE: "dsh" }, () => {
        // 2026-10-30 "no degradation in any case": refused co-writing must
        // THROW so boot dies before listen(), not return null + run legacy.
        assert.throws(
            () => UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike),
            (err: unknown) => err instanceof StorageSecondWriterError,
            "must REFUSE with StorageSecondWriterError, not open a second writer",
        );
        const refused = logs.find((m) => m.includes("unified storage REFUSED"));
        assert.ok(refused, `actionable error line expected, got: ${logs.join(" | ")}`);
        assert.ok(refused!.includes("REFUSES TO START"), "the refusal must state its consequence");
        assert.ok(refused!.includes("BILI_SESSIONS_DIR") && refused!.includes("BILI_CONFIG_FILE"), "the fix must name both isolation vars");
        assert.equal(lockHolderPid(sessions), foreign.pid, "the foreign lock must NOT be stolen");
        // Pre-death diagnostic surface (#3040 visibility): the failure is
        // recorded BEFORE the throw so post-crash forensics can read why.
        withEnv({ BILI_STORAGE_UNIFIED: "shadow" }, () => {
            const wire = storageStatusWire();
            assert.equal(wire.degraded, true, "status wire must record the failed open");
            assert.ok(wire.reason?.startsWith("second-writer:"), `reason should be the pre-formatted refusal, got: ${wire.reason}`);
            assert.ok((wire.reason ?? "").includes("BILI_SESSIONS_DIR"), "wire reason must carry the fix");
        });
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

test("#5046/B: mixed-version fleet — old marker WITHOUT lane ⇒ conservative branch REFUSES", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeMarker(state, undefined);
    writeLock(sessions, foreign.pid!);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state, BILI_LAUNCHER_LANE: "dsh" }, () => {
        assert.throws(
            () => UnifiedShadow.maybeOpen(sessions, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike),
            (err: unknown) => err instanceof StorageSecondWriterError,
            "unknown peer lane must stay conservative and refuse (no info-level amnesty)",
        );
        assert.ok(logs.some((m) => m.includes("unified storage REFUSED")));
    });
    setLogCapture(null);
});

test("#5046/B: default policy (CLI/export direct open) stays report-only — store returned, lock taken over", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const state = freshState();
    const sessions = freshSessions();
    writeMarker(state, "dsh");
    writeLock(sessions, foreign.pid!);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    withEnv({ XDG_STATE_HOME: state, BILI_LAUNCHER_LANE: "dsh" }, () => {
        const store = UnifiedStore.open(path.join(sessions, "index.db"));
        assert.ok(store, "report-only paths (export/maintenance) keep running as before");
        assert.ok(logs.some((m) => m.includes("supported topology")), "#5091 report-only coexistence info line");
        assert.equal(lockHolderPid(sessions), process.pid, "report-only takeover unchanged");
        store.close();
    });
    setLogCapture(null);
});
