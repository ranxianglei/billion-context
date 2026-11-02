// #3923/#3959: machine-global shared sessions dir — two bili proxies of
// DIFFERENT lanes sharing one index.db is the deliberate topology (AGENTS.md
// "machine-global facilities stay SHARED"). These tests pin the
// owner-required surface, both directions each (#3617):
//   D1 the secondProcess warning never freezes: a live foreign pid stays
//      surfaced; a pid that has exited self-clears at the status read.
//   D2 cross-lane registry hit → benign=true (informational log + wire);
//      same-lane / registry miss / undeclared lane keep the loud corruption
//      warning (benign=false).
//   G1 a real split-brain contest surfaces session id + title + both sides'
//      pid/lane (log line AND web wire); no contest → nothing surfaced.
//   G2 the surfaced entry is dismissable (POST /__bili/storage/split-brain/
//      ack): ack clears it, the SAME contest stays quiet, a NEW contest
//      re-surfaces, an unknown session answers 400.
//   G3 the stored verdict never outlives its evidence (#4626): it persists
//      while the peer's marker evidence holds and self-clears at the status
//      read once the peer provably stops contesting (both directions).
//   G4 the evidence check fails closed (#4626): an unreadable writers dir or
//      torn peer marker is UNKNOWN and keeps the notice; only provable
//      absence/staleness clears.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { startServer } from "../src/server.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { probeBuiltinSqlite, probeHostBetterSqlite3, setPreferredSqliteEngineForTests, setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";
import { _resetStorageRuntimeStatusForTest, ackSplitBrainContest, recordSecondProcessOwner, recordSplitBrainContest, registerSplitBrainEvidenceCheck, storageStatusWire, type SplitBrainContestInput } from "../src/storage/runtime-status.ts";
import { createServedMarkerWriter, peerStillContests, writerMarkerDir, type WriterIdentity } from "../src/served-markers.ts";
import { isPidAlive } from "../src/instance.ts";
import { setLogCapture } from "../src/logger.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { MESSAGES } from "../src/web/i18n.ts";
import { makeOpts } from "./corrupt-index-child.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_LAUNCHER_LANE", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;
type EnvSnap = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function saveEnv(): EnvSnap {
    const snap: EnvSnap = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnap): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

function isolate(base: string): void {
    fs.mkdirSync(path.join(base, "sessions"), { recursive: true });
    process.env.BILI_SESSIONS_DIR = path.join(base, "sessions");
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
}

function resetSeams(): void {
    setSqliteEnginesUnavailableForTests(false);
    setPreferredSqliteEngineForTests(null);
    _resetStorageRuntimeStatusForTest();
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function spawnLiveChild(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    child.unref();
    return child;
}

async function waitPidAlive(pid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isPidAlive(pid)) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(isPidAlive(pid), `pid ${pid} should be alive by now`);
}

/** A SIGKILLed child lingers as a zombie until the loop reaps it — poll
 *  liveness to false before asserting the self-clear. */
async function waitPidDead(pid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!isPidAlive(pid), `pid ${pid} should be dead by now`);
}

/** Registry entry under the isolated XDG_STATE_HOME — the shape instance.ts
 *  writes to <stateDir>/instances/<instanceId>.json. */
function writeInstanceEntry(stateRoot: string, id: string, pid: number, lane?: string): void {
    const dir = path.join(stateRoot, "billion-context", "instances");
    fs.mkdirSync(dir, { recursive: true });
    const entry: Record<string, unknown> = { instanceId: id, pid, port: 8787, origin: "http://127.0.0.1:8787", startedAt: Date.now() };
    if (lane !== undefined) entry.lane = lane;
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(entry));
}

// Beyond any sane pid_max (Linux default 4194304) — provably dead.
const DEAD_PID = 999_999_999;

function writePeerMarker(dir: string, id: string, pid: number, servedAt: Record<string, number>): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ v: 1, instanceId: id, pid, origin: "http://127.0.0.1:8787", version: "0.1.205", lane: "dsh", servedAt }));
    return file;
}

function backdate(file: string, ageMs: number): void {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
}

interface SplitBrainWire {
    sessionId: string;
    title?: string;
    self: { pid: number; lane?: string; origin: string };
    peer: { pid: number; lane?: string; origin: string };
    at: number;
}

interface StorageWireShape {
    secondProcess: { pid: number; at: number; lane?: string; instanceId?: string; benign: boolean } | null;
    splitBrain: SplitBrainWire | null;
}

async function fetchJson<T>(port: number, p: string): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal(res.status, 200, `${p} answers 200`);
    return (await res.json()) as T;
}

async function postJson(port: number, p: string, body: unknown): Promise<{ status: number; doc: { ok?: boolean; error?: string } }> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, doc: (await res.json()) as { ok?: boolean; error?: string } };
}

// ---- D1: dead-pid self-clear at the status read ------------------------------

test("#3959 D1: secondProcess stays while the foreign pid lives, self-clears once it dies", async () => {
    _resetStorageRuntimeStatusForTest();
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    const child = spawnLiveChild();
    try {
        await waitPidAlive(child.pid!);
        recordSecondProcessOwner(child.pid!, { lane: "dsh", instanceId: "peer-1", benign: true });
        let wire = storageStatusWire();
        assert.equal(wire.secondProcess?.pid, child.pid, "live foreign pid stays surfaced");
        assert.equal(wire.secondProcess?.benign, true);
        assert.equal(wire.secondProcess?.lane, "dsh");
        child.kill("SIGKILL");
        await waitPidDead(child.pid!);
        wire = storageStatusWire();
        assert.equal(wire.secondProcess, null, "dead pid self-clears at the status read");
        assert.ok(logs.some((l) => l === `info [storage] second-process pid ${child.pid} has exited — stale warning cleared`), "clear is logged once, info level");
    } finally {
        setLogCapture(null);
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        _resetStorageRuntimeStatusForTest();
    }
});

// ---- D2: coexistence at store open (#5082 semantics) -------------------------

test("#3959/#5082 D2: every live foreign pid is informational — cross-lane, same lane, registry miss alike", { skip: !(probeBuiltinSqlite() || probeHostBetterSqlite3()) && "no SQLite engine available on this host" }, async () => {
    const snap = saveEnv();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3959-d2-"));
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    try {
        isolate(base);
        resetSeams();
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_ENCRYPTION_KEY;
        process.env.BILI_LAUNCHER_LANE = "pi";
        const child = spawnLiveChild();
        await waitPidAlive(child.pid!);
        try {
            // cross-lane: registry entry with lane "dsh" ≠ own "pi" → benign
            writeInstanceEntry(path.join(base, "state"), "peer-dsh", child.pid!, "dsh");
            fs.writeFileSync(path.join(base, "sessions", "a.db.lock"), JSON.stringify({ pid: child.pid }));
            let store = UnifiedStore.open(path.join(base, "sessions", "a.db"));
            let wire = storageStatusWire();
            assert.equal(wire.secondProcess?.pid, child.pid);
            assert.equal(wire.secondProcess?.benign, true, "known bili instance of a different lane is the supported topology");
            assert.equal(wire.secondProcess?.lane, "dsh");
            assert.equal(wire.secondProcess?.instanceId, "peer-dsh");
            assert.ok(logs.some((l) => l.startsWith("info ") && l.includes(`pid ${child.pid}`) && l.includes("lane dsh") && l.includes("supported topology")), "informational log, not the corruption error");
            assert.ok(!logs.some((l) => l.startsWith("error ") && l.includes("already writing")), "cross-lane hit does NOT log the corruption error");
            store.close();
            _resetStorageRuntimeStatusForTest();
            logs.length = 0;

            // same lane: registry entry with lane "pi" === own "pi" — #5082:
            // two instances OPENING one db is safe; only same-session dual
            // writes are the hazard (contested elsewhere) → informational too.
            writeInstanceEntry(path.join(base, "state"), "peer-pi", child.pid!, "pi");
            fs.writeFileSync(path.join(base, "sessions", "b.db.lock"), JSON.stringify({ pid: child.pid }));
            store = UnifiedStore.open(path.join(base, "sessions", "b.db"));
            wire = storageStatusWire();
            assert.equal(wire.secondProcess?.benign, true, "same-lane peer is informational too (#5082)");
            assert.equal(wire.secondProcess?.lane, "pi");
            assert.ok(logs.some((l) => l.startsWith("info ") && l.includes("supported topology")), "same-lane peer logs the shared-topology info line");
            assert.ok(!logs.some((l) => l.startsWith("error ") && l.includes("already writing")), "same-lane peer does NOT log the old corruption error");
            store.close();
            _resetStorageRuntimeStatusForTest();
            logs.length = 0;

            // registry miss: unknown process → still informational, no lane recorded
            fs.rmSync(path.join(base, "state", "billion-context", "instances"), { recursive: true, force: true });
            fs.writeFileSync(path.join(base, "sessions", "c.db.lock"), JSON.stringify({ pid: child.pid }));
            store = UnifiedStore.open(path.join(base, "sessions", "c.db"));
            wire = storageStatusWire();
            assert.equal(wire.secondProcess?.benign, true, "unknown process is informational too (#5082)");
            assert.equal(wire.secondProcess?.lane, undefined);
            assert.equal(wire.secondProcess?.instanceId, undefined);
            assert.ok(!logs.some((l) => l.startsWith("error ") && l.includes("already writing")), "registry miss does NOT log the old corruption error");
            assert.ok(logs.some((l) => l.startsWith("info ") && l.includes(`pid ${child.pid}`) && l.includes("supported topology")), "registry miss logs the shared-topology info line");
            store.close();
        } finally {
            child.kill("SIGKILL");
            await waitPidDead(child.pid!);
        }
    } finally {
        setLogCapture(null);
        resetSeams();
        rmrf(base);
        restoreEnv(snap);
    }
});

// ---- G1: split-brain contest carries identity ---------------------------------

test("#3959 G1: contested commit names session title + both lanes in log and contest payload", () => {
    const dir = writerMarkerDir(fs.mkdtempSync(path.join(os.tmpdir(), "bili-3959-g1-")));
    const logs: Array<[string, string]> = [];
    const contests: Array<{ sessionId: string; title?: string; self: WriterIdentity; peer: WriterIdentity & { servedAt: number } }> = [];
    const SELF: WriterIdentity = { instanceId: "self-1", pid: process.pid, origin: "http://127.0.0.1:18802", version: "0.1.202", lane: "pi" };
    const PEER: WriterIdentity = { instanceId: "peer-1", pid: process.pid, origin: "http://127.0.0.1:8787", version: "0.1.201", lane: "dsh" };
    const peerAt = Date.now() - 1000;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "peer-1.json"), JSON.stringify({ v: 1, ...PEER, servedAt: { "sess-a": peerAt } }));
    const w = createServedMarkerWriter(
        SELF,
        dir,
        (level, msg) => logs.push([level, msg]),
        {
            resolveTitle: (id) => (id === "sess-a" ? "Fix auth bug" : undefined),
            onContest: (c) => contests.push(c),
        },
    );
    w.noteServed("sess-a");
    assert.equal(logs.length, 1, "contested commit logs once");
    assert.ok(logs[0][1].includes('[split-brain] session sess-a "Fix auth bug"'), "log names the session title");
    assert.ok(logs[0][1].includes("lane pi"), "log names this side's lane");
    assert.ok(logs[0][1].includes("lane dsh"), "log names the peer's lane");
    assert.equal(contests.length, 1, "contest surfaced to the record seam");
    assert.equal(contests[0].sessionId, "sess-a");
    assert.equal(contests[0].title, "Fix auth bug");
    assert.equal(contests[0].self.lane, "pi");
    assert.equal(contests[0].peer.lane, "dsh");
    assert.equal(contests[0].peer.pid, PEER.pid);
    assert.equal(contests[0].peer.servedAt, peerAt, "peer servedAt carried for ack semantics");
    w.dispose();

    // negative: no peer marker → no contest surfaced
    const dir2 = writerMarkerDir(fs.mkdtempSync(path.join(os.tmpdir(), "bili-3959-g1b-")));
    const logs2: Array<[string, string]> = [];
    const contests2: unknown[] = [];
    const w2 = createServedMarkerWriter(SELF, dir2, (level, msg) => logs2.push([level, msg]), { resolveTitle: () => "should not fire", onContest: (c) => contests2.push(c) });
    w2.noteServed("sess-solo");
    assert.equal(logs2.length, 0, "uncontested commit stays silent");
    assert.equal(contests2.length, 0, "no contest payload without a peer");
    w2.dispose();
});

// ---- G2: ack semantics (record/ack module) ------------------------------------

test("#3959 G2: ack clears the surfaced entry; same contest stays quiet, a new one re-surfaces", () => {
    _resetStorageRuntimeStatusForTest();
    const base: SplitBrainContestInput = {
        sessionId: "sess-a",
        title: "Fix auth bug",
        self: { instanceId: "self-1", pid: 111, origin: "http://127.0.0.1:18802", lane: "pi", version: "0.1.202" },
        peer: { instanceId: "peer-1", pid: 222, origin: "http://127.0.0.1:8787", lane: "dsh", version: "0.1.201", servedAt: 1000 },
        at: Date.now(),
    };
    recordSplitBrainContest(base);
    let wire = storageStatusWire();
    assert.equal(wire.splitBrain?.sessionId, "sess-a");
    assert.equal(wire.splitBrain?.title, "Fix auth bug");
    assert.equal(wire.splitBrain?.self.lane, "pi");
    assert.equal(wire.splitBrain?.peer.lane, "dsh");
    assert.equal(wire.splitBrain?.peer.pid, 222);
    assert.equal((wire.splitBrain?.peer as { servedAt?: number }).servedAt, undefined, "peer servedAt is internal — never on the wire");
    assert.equal(ackSplitBrainContest("sess-unknown"), false, "ack of an unsurfaced session is rejected");
    assert.equal(ackSplitBrainContest("sess-a"), true, "ack of the surfaced session clears it");
    assert.equal(storageStatusWire().splitBrain, null);
    recordSplitBrainContest(base);
    assert.equal(storageStatusWire().splitBrain, null, "the SAME contest (same peer servedAt) stays dismissed after ack");
    recordSplitBrainContest({ ...base, peer: { ...base.peer, servedAt: 2000 } });
    wire = storageStatusWire();
    assert.equal(wire.splitBrain?.sessionId, "sess-a", "a NEW contest (newer peer servedAt) re-surfaces");
    _resetStorageRuntimeStatusForTest();
});

// ---- #4626: the stored verdict must not outlive its evidence ------------------

test("#4626 G3: stored verdict persists while evidence holds, self-clears once the peer stops contesting", () => {
    _resetStorageRuntimeStatusForTest();
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4626-g3-"));
    try {
        const dir = writerMarkerDir(tmp);
        const base: SplitBrainContestInput = {
            sessionId: "sess-stale",
            title: "Fix auth bug",
            self: { instanceId: "self-1", pid: process.pid, origin: "http://127.0.0.1:18802", lane: "pi", version: "0.1.205" },
            peer: { instanceId: "peer-gone", pid: DEAD_PID, origin: "http://127.0.0.1:8787", lane: "dsh", version: "0.1.204", servedAt: Date.now() - 1000 },
            at: Date.now(),
        };
        // The server's registration shape (src/server.ts): the verdict holds iff
        // the accused peer's own marker still contests — tri-state, fails closed.
        registerSplitBrainEvidenceCheck((c) =>
            peerStillContests(dir, "self-1", c.peer.instanceId, c.sessionId, Date.now()));

        // Phase A — fresh tombstone (dead pid, marker just rewritten by the
        // peer's graceful-shutdown flush): the notice MUST persist; a dead pid
        // alone is not proof of absence on every platform.
        const file = writePeerMarker(dir, "peer-gone", DEAD_PID, { [base.sessionId]: base.peer.servedAt });
        recordSplitBrainContest(base);
        assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-stale", "fresh tombstone keeps the notice honest");

        // Phase B — dead pid + marker older than the freshness grace: the next
        // status read clears the stored verdict by itself (#4626).
        backdate(file, 40_000);
        assert.equal(storageStatusWire().splitBrain, null, "dead peer + stale marker clears the stored verdict at the status read");
        assert.ok(logs.some((l) => l.startsWith("info ") && l.includes("[split-brain] session sess-stale") && l.includes("peer-gone") && l.includes(String(DEAD_PID))), "the clear is logged with full ids");
        assert.equal(storageStatusWire().splitBrain, null, "stays cleared on subsequent reads");

        // Phase C — an evidence-based clear must NOT poison the ack guard: if
        // the same peer contests again, the notice surfaces again.
        backdate(file, 0);
        recordSplitBrainContest(base);
        assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-stale", "a renewed contest re-surfaces after an evidence-based clear");
    } finally {
        setLogCapture(null);
        _resetStorageRuntimeStatusForTest();
        rmrf(tmp);
    }
});

test("#4626 G3-negative: without a registered check the stored verdict stands (legacy replay)", () => {
    _resetStorageRuntimeStatusForTest();
    const base: SplitBrainContestInput = {
        sessionId: "sess-legacy",
        self: { instanceId: "self-1", pid: process.pid, origin: "http://127.0.0.1:18802", lane: "pi", version: "0.1.205" },
        peer: { instanceId: "peer-x", pid: DEAD_PID, origin: "http://127.0.0.1:8787", lane: "dsh", version: "0.1.204", servedAt: Date.now() - 1000 },
        at: Date.now(),
    };
    try {
        recordSplitBrainContest(base);
        assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-legacy", "no registered check ⇒ stored entry replays as-is");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4626-g3n-"));
        try {
            const dir = writerMarkerDir(tmp);
            writePeerMarker(dir, "peer-live", process.pid, { [base.sessionId]: Date.now() - 1000 });
            registerSplitBrainEvidenceCheck((c) =>
                peerStillContests(dir, "self-1", c.peer.instanceId, c.sessionId, Date.now()));
            const live: SplitBrainContestInput = { ...base, peer: { ...base.peer, instanceId: "peer-live", pid: process.pid } };
            recordSplitBrainContest(live);
            assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-legacy", "live peer + fresh marker keeps the notice surfaced");
        } finally {
            rmrf(tmp);
        }
    } finally {
        _resetStorageRuntimeStatusForTest();
    }
});

test("#4626 G4: evidence check fails closed — unknown evidence keeps the notice", () => {
    _resetStorageRuntimeStatusForTest();
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4626-g4-"));
    try {
        const dir = writerMarkerDir(tmp);
        const base: SplitBrainContestInput = {
            sessionId: "sess-fc",
            self: { instanceId: "self-1", pid: process.pid, origin: "http://127.0.0.1:18802", lane: "pi", version: "0.1.205" },
            peer: { instanceId: "peer-gone", pid: DEAD_PID, origin: "http://127.0.0.1:8787", lane: "dsh", version: "0.1.204", servedAt: Date.now() - 1000 },
            at: Date.now(),
        };
        registerSplitBrainEvidenceCheck((c) =>
            peerStillContests(dir, "self-1", c.peer.instanceId, c.sessionId, Date.now()));
        const file = writePeerMarker(dir, "peer-gone", DEAD_PID, { [base.sessionId]: base.peer.servedAt });
        recordSplitBrainContest(base);
        assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-fc");

        // Writers dir vanishes (state-dir move / transient FS error): UNKNOWN —
        // the notice stays and no false "no longer contests" line appears.
        fs.rmSync(dir, { recursive: true });
        assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-fc", "missing writers dir ⇒ unknown ⇒ notice kept");
        assert.ok(!logs.some((l) => l.includes("no longer contests")), "an unknown verdict never logs a false clear");

        // Dir restored but the accused marker reaped: PROVABLY STOPPED — clears.
        fs.mkdirSync(dir, { recursive: true });
        assert.equal(storageStatusWire().splitBrain, null, "absent peer marker ⇒ cleared at the status read");

        // Torn/malformed marker: UNKNOWN again — a renewed verdict stays up.
        fs.writeFileSync(file, "{ torn mid-write");
        recordSplitBrainContest(base);
        assert.equal(storageStatusWire().splitBrain?.sessionId, "sess-fc", "unreadable peer marker ⇒ unknown ⇒ notice kept");
    } finally {
        setLogCapture(null);
        _resetStorageRuntimeStatusForTest();
        rmrf(tmp);
    }
});

// ---- web surface: wire + endpoint + page/client/i18n ---------------------------

test("#3959 web: status carries secondProcess/splitBrain; ack endpoint clears; page/client/i18n wired", async () => {
    const snap = saveEnv();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3959-web-"));
    let proxy: http.Server | undefined;
    try {
        isolate(base);
        resetSeams();
        const upstreamPort = await freePort();
        proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;

        let s = await fetchJson<{ storage: StorageWireShape }>(port, "/__bili/status");
        assert.equal(s.storage.secondProcess, null, "no second process recorded → null");
        assert.equal(s.storage.splitBrain, null, "no contest recorded → null");

        // #4626: surfaced entries re-evaluate against CURRENT writer-marker
        // evidence at each status read — give the recorded contest real
        // evidence in the server's writers dir (fresh mtime keeps it contested
        // even though DEAD_PID is provably not a live process).
        const peerMarker = writePeerMarker(path.join(base, "state", "billion-context", "writers"), "peer-1", DEAD_PID, { "sess-web": Date.now() - 1000 });

        const contest: SplitBrainContestInput = {
            sessionId: "sess-web",
            title: "Fix auth bug",
            self: { instanceId: "self-1", pid: process.pid, origin: "http://127.0.0.1:18802", lane: "pi", version: "0.1.202" },
            peer: { instanceId: "peer-1", pid: DEAD_PID, origin: "http://127.0.0.1:8787", lane: "dsh", version: "0.1.201", servedAt: 1000 },
            at: Date.now(),
        };
        recordSplitBrainContest(contest);
        s = await fetchJson<{ storage: StorageWireShape }>(port, "/__bili/status");
        assert.equal(s.storage.splitBrain?.sessionId, "sess-web", "status wire carries the surfaced contest");
        assert.equal(s.storage.splitBrain?.title, "Fix auth bug");
        assert.equal(s.storage.splitBrain?.peer.lane, "dsh");
        assert.equal(s.storage.splitBrain?.peer.pid, DEAD_PID);

        const acked = await postJson(port, "/__bili/storage/split-brain/ack", { sessionId: "sess-web" });
        assert.equal(acked.status, 200, "ack of the surfaced session answers 200");
        assert.equal(acked.doc.ok, true);
        s = await fetchJson<{ storage: StorageWireShape }>(port, "/__bili/status");
        assert.equal(s.storage.splitBrain, null, "ack clears the surfaced entry");

        const unknown = await postJson(port, "/__bili/storage/split-brain/ack", { sessionId: "sess-nope" });
        assert.equal(unknown.status, 400, "ack of an unknown session answers 400");
        const malformed = await postJson(port, "/__bili/storage/split-brain/ack", { nope: 1 });
        assert.equal(malformed.status, 400, "malformed body answers 400");

        recordSplitBrainContest({ ...contest, peer: { ...contest.peer, servedAt: 2000 } });
        s = await fetchJson<{ storage: StorageWireShape }>(port, "/__bili/status");
        assert.equal(s.storage.splitBrain?.sessionId, "sess-web", "a NEW contest re-surfaces on the wire after ack");

        // #4626 end-to-end: once the peer's marker is past its freshness grace
        // and its pid is provably dead, the next status read clears the notice
        // WITHOUT a manual ack.
        backdate(peerMarker, 40_000);
        s = await fetchJson<{ storage: StorageWireShape }>(port, "/__bili/status");
        assert.equal(s.storage.splitBrain, null, "stale verdict self-clears at the status read without a manual ack");

        const html = renderPage("http://127.0.0.1:1", "0.0.0");
        assert.ok(html.includes('id="split-brain-banner"'), "page carries the split-brain banner div");
        assert.ok(WEB_CLIENT.includes('"split-brain-banner"'), "client targets the banner element");
        assert.ok(WEB_CLIENT.includes('t("sys.split_brain_title")'), "client renders the localized title");
        assert.ok(WEB_CLIENT.includes('t("sys.split_brain", {'), "client composes the localized sentence");
        assert.ok(WEB_CLIENT.includes('API_ROOT + "/storage/split-brain/ack"'), "dismiss button POSTs the ack endpoint");
        assert.ok(WEB_CLIENT.includes('"btn sm"'), "dismiss button follows the sm button convention");
        assert.ok(!WEB_CLIENT.includes('t("sys.storage_second_process",'), "#5082: the corruption-alarm copy is gone from the client");
        assert.ok(!WEB_CLIENT.includes('storage_second_process_cross_lane'), "#5082: the old cross-lane keys are fully replaced");
        assert.ok(WEB_CLIENT.includes("#5082"), "client cites #5082 where coexistence is declared supported");
        assert.ok(WEB_CLIENT.includes('t("sys.storage_second_process_shared"'), "informational branch uses the shared-topology copy");
        assert.ok(WEB_CLIENT.includes('classList.add("info")'), "informational branch swaps to info styling");
        for (const locale of ["zh-CN", "en"] as const) {
            for (const key of [
                "sys.storage_second_process_shared_title",
                "sys.storage_second_process_shared",
                "sys.split_brain_title",
                "sys.split_brain",
                "sys.split_brain_lane_undeclared",
                "sys.split_brain_ack_btn",
                "sys.split_brain_acked",
            ]) {
                assert.ok(typeof MESSAGES[locale][key] === "string" && MESSAGES[locale][key].length > 0, `${locale} carries ${key}`);
            }
        }
    } finally {
        if (proxy) await close(proxy);
        resetSeams();
        rmrf(base);
        restoreEnv(snap);
    }
});
