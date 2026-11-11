// #5955 — zombie proxy holds the canonical port + the fingerprint branch only
// skips without terminating → oversized sessions stuck at 422.
//
// The bring-up decision table had no row for "same-lane resident on the
// canonical port, DIFFERENT bytes, UNANSWERED health (BUSY)": attach vetoes
// it (code-fingerprint-mismatch), #4125 upward adoption demands an answered
// version, #3544 rotation excludes unverifiable residents (deliberate, #4811),
// and the spawned child ladders away or exits code 1. Nobody ever resolved
// the holder; the port stayed wedged until the process died on its own
// (guaranteed only for >=5min CONTINUOUS event-loop blocks).
//
// This suite pins the bounded-patience + forced-takeover step:
//   - pure rows for isWedgedSameLaneCandidate / stepWedgedLedger (both
//     directions, exact boundaries);
//   - full bring-up path: escalation only after WEDGED_TAKEOVER_WINDOW_MS AND
//     WEDGED_MIN_OBSERVATIONS, graceful shutdown first, then SIGTERM, then
//     SIGKILL/taskkill, and the listener-close verification BEFORE spawn;
//   - the observation ledger PERSISTS in the state dir — during a wedge the
//     client restarts on every failed bootstrap round, so a fresh process must
//     continue the previous process's window (and a REUSED pid must NOT
//     inherit the dead occupant's history — birth-stamp key);
//   - kill failure → fall through to the normal spawn ladder (never worse
//     than today), ledger entry kept, takeover retried on the next cycle;
//   - regression guards: healthy OLDER holder still routes through #3544
//     rotation ONLY, healthy NEWER holder still adopted (#4125), SAME-build
//     BUSY holder attached and NEVER killed (#4811), user-zone / foreign-lane
//     / foreign-port / attachUrl holders all untouched.
//
// Hermeticity: XDG_STATE_HOME is redirected to a scratch dir BEFORE any test
// runs, so probeLiveInstances' REAL registry view (discoverLiveInstances),
// the starting marker, and the default ledger file all live in scratch — no
// machine-local proxy state can leak into the candidate set.

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setLogCapture } from "../src/logger.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { removeStartingMarker } from "../src/instance.ts";
import {
    WEDGED_MIN_OBSERVATIONS,
    WEDGED_OBSERVATION_STALE_MS,
    WEDGED_TAKEOVER_WINDOW_MS,
    ensureProxyRunning,
    hardKillProxyTree,
    isWedgedSameLaneCandidate,
    processBirthStamp,
    stepWedgedLedger,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";

const SCRATCH_STATE = path.join(os.tmpdir(), `bili-state-5955-${process.pid}`);
fs.mkdirSync(path.join(SCRATCH_STATE, "billion-context"), { recursive: true });
process.env.XDG_STATE_HOME = SCRATCH_STATE;

const HOST = "127.0.0.1";
const PORT = 18787;
const ORIGIN = `http://${HOST}:${PORT}`;
const CHILD_PID = 42_471;
// Inter-cycle advance: > starting-marker TTL (90s) so each cycle re-claims its
// marker, and + one post-spawn poll (200ms) stays <= WEDGED_OBSERVATION_STALE_MS
// so observations BRIDGE across cycles instead of restarting the window.
const GAP_MS = 280_000;

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-5955-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

let ledgerFile = "";

function makeClock() {
    let t = 1_000_000_000;
    return {
        now: () => t,
        sleep: (ms: number) => new Promise<void>((res) => { t += Math.max(1, ms); res(); }),
        advance: (ms: number) => { t += ms; },
    };
}

interface World {
    clock: ReturnType<typeof makeClock>;
    connectable: boolean;
    gracefulShutdown: boolean;
    killReleases: boolean;
    shutdownCalls: string[];
    shutdownTimeouts: Array<number | undefined>;
    signalCalls: number[];
    killCalls: number[];
    spawnCalls: number;
    order: string[];
    diagMsgs: string[];
}

function makeWorld(opts: { gracefulShutdown: boolean; killReleases: boolean }): World {
    return {
        clock: makeClock(),
        connectable: true,
        gracefulShutdown: opts.gracefulShutdown,
        killReleases: opts.killReleases,
        shutdownCalls: [],
        shutdownTimeouts: [],
        signalCalls: [],
        killCalls: [],
        spawnCalls: 0,
        order: [],
        diagMsgs: [],
    };
}

function wedgedHolder(): ProxyInstanceFile {
    return {
        origin: ORIGIN,
        instanceId: "zombie-instance",
        pid: process.pid,
        startedAt: Date.now(),
        host: HOST,
        port: PORT,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: "foreign-build",
        lane: "dsh",
        launchToken: "zombie-token",
    };
}

// Own-child record found by the post-spawn pid fallback (the resident must come
// through the instance FILE view; the registry view feeds the pid fallback
// only — same discipline as the #3544 suite).
function mineMarker(): ProxyInstanceFile {
    return {
        origin: ORIGIN,
        instanceId: "mine-1",
        pid: CHILD_PID,
        startedAt: Date.now(),
        host: HOST,
        port: PORT,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
        lane: "dsh",
        launchToken: "mine-token",
    };
}

function makeFakeChild(pid: number): SpawnChild {
    return { pid, unref() {}, kill() { return true; }, on() {} };
}

type Deps = Parameters<typeof ensureProxyRunning>[1];

function makeDeps(w: World, holder: ProxyInstanceFile): Deps {
    return {
        fetchImpl: async (url: string) => ({ ok: url.startsWith(ORIGIN) }),
        fetchHealthInfo: async (origin: string) => (origin === holder.origin ? undefined : { ok: false }),
        readInstanceFile: () => holder,
        listRegistryInstances: () => [mineMarker()],
        spawnImpl: (_command: string, _args: readonly string[], _options: Parameters<SpawnFn>[2]): SpawnChild => {
            w.spawnCalls += 1;
            w.order.push("spawn");
            return makeFakeChild(CHILD_PID);
        },
        now: () => w.clock.now(),
        sleep: (ms: number) => w.clock.sleep(ms),
        scriptPath: FP_SCRIPT,
        nodeRuntime: process.execPath,
        registerWatcher: async () => "ok",
        resolveAttachUrl: () => undefined,
        resolveAttachExternal: () => false,
        resolveAttachPolicy: () => "own-lane",
        attachLanePriority: () => [],
        requestInstanceShutdown: async (origin: string, timeoutMs?: number) => {
            w.shutdownCalls.push(origin);
            w.shutdownTimeouts.push(timeoutMs);
            w.order.push("shutdown");
            if (w.gracefulShutdown) w.connectable = false;
            return true;
        },
        isConnectable: async (origin: string) => origin === holder.origin && w.connectable,
        signalWedgedHolder: (pid: number) => { w.signalCalls.push(pid); w.order.push("signal"); },
        killWedgedHolder: (pid: number) => {
            w.killCalls.push(pid);
            w.order.push("kill");
            if (w.killReleases) w.connectable = false;
        },
        wedgedLedgerPath: () => ledgerFile,
        // Deterministic birth stamp: stable per pid within a world unless a row
        // overrides the seam to simulate PID REUSE.
        processBirthStamp: async (pid: number) => `stamp-${pid}`,
        attachDiag: (msg: string) => { w.diagMsgs.push(msg); },
    };
}

async function runCycle(
    w: World,
    holder: ProxyInstanceFile,
    overrides?: { opts?: Record<string, unknown>; deps?: Partial<Deps> },
) {
    const opts = {
        host: HOST,
        port: PORT,
        passthrough: false,
        debug: false,
        lane: "dsh",
        parentPid: 999_999,
        ...(overrides?.opts ?? {}),
    };
    const deps = { ...makeDeps(w, holder), ...(overrides?.deps ?? {}) };
    return ensureProxyRunning(opts, deps);
}

/** Runs bring-up cycles GAP_MS apart until pred() holds; returns the last handle. */
async function cycleUntil(
    w: World,
    holder: ProxyInstanceFile,
    pred: () => boolean,
    maxCycles: number,
    overrides?: { opts?: Record<string, unknown>; deps?: Partial<Deps> },
) {
    let handle: Awaited<ReturnType<typeof runCycle>> | undefined;
    for (let i = 1; i <= maxCycles; i++) {
        if (i > 1) w.clock.advance(GAP_MS);
        handle = await runCycle(w, holder, overrides);
        if (pred()) break;
    }
    assert.ok(handle, `expected a handle within ${maxCycles} cycles`);
    return handle;
}

const watchingLines = (w: World) => w.diagMsgs.filter((m) => m.includes("patience before forced takeover"));
const startLines = (w: World) => w.diagMsgs.filter((m) => m.includes("patience window started"));

function readLedger(): Record<string, { pid: number; firstBusyAt: number; lastObservedAt: number; observations: number }> {
    const raw = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as { entries: Record<string, { pid: number; firstBusyAt: number; lastObservedAt: number; observations: number }> };
    return raw.entries;
}

beforeEach(() => {
    ledgerFile = path.join(SCRATCH_STATE, "billion-context", `wedged-ledger-${Math.random().toString(36).slice(2)}.json`);
    try { fs.unlinkSync(ledgerFile); } catch { /* fresh */ }
    removeStartingMarker();
});
afterEach(() => {
    try { fs.unlinkSync(ledgerFile); } catch { /* already gone */ }
    removeStartingMarker();
});

test("#5955 isWedgedSameLaneCandidate: positive + single-flip negatives", () => {
    const baseOpts = { host: HOST, port: PORT, passthrough: false, debug: false, lane: "dsh" };
    const pos = { inst: wedgedHolder(), health: undefined };

    assert.equal(isWedgedSameLaneCandidate(pos, baseOpts, PORT, FP_HASH, []), true, "wedged cell: foreign bytes, same lane, BUSY, canonical port");

    const wrongPort = { ...pos, inst: { ...pos.inst, port: 18799, origin: `http://${HOST}:18799` } };
    assert.equal(isWedgedSameLaneCandidate(wrongPort, baseOpts, PORT, FP_HASH, []), false, "different port");

    const foreignLane = { ...pos, inst: { ...pos.inst, lane: "pi" } };
    assert.equal(isWedgedSameLaneCandidate(foreignLane, baseOpts, PORT, FP_HASH, []), false, "foreign lane");

    const noLaneOpts = { ...baseOpts, lane: undefined };
    assert.equal(isWedgedSameLaneCandidate(pos, noLaneOpts, PORT, FP_HASH, []), false, "laneless bring-up");

    const userZone = { ...pos, inst: { ...pos.inst, lane: undefined, launchToken: undefined } };
    assert.equal(isWedgedSameLaneCandidate(userZone, baseOpts, PORT, FP_HASH, []), false, "user zone");

    const answered = { ...pos, health: { ok: true, instanceId: "zombie-instance", pid: process.pid, watchdog: { armed: true }, version: "0.0.1" } };
    assert.equal(isWedgedSameLaneCandidate(answered, baseOpts, PORT, FP_HASH, []), false, "answered health is not BUSY");

    const sameFp = { ...pos, inst: { ...pos.inst, codeFingerprint: "foreign-build" } };
    assert.equal(isWedgedSameLaneCandidate(sameFp, baseOpts, PORT, "foreign-build", []), false, "matching bytes are attachable, never a takeover target");

    const shapeOnly = { ...pos, inst: { ...pos.inst, codeFingerprint: "foreign-build", modelWindows: { gpt: 200_000 } } };
    assert.equal(isWedgedSameLaneCandidate(shapeOnly, baseOpts, PORT, "foreign-build", []), false, "shape-only mismatch is not the fp-mismatch cell");
});

test("#5955 stepWedgedLedger: boundaries (window, min observations, stale gap, fresh flag)", () => {
    const PID = 1234;
    const r0 = stepWedgedLedger(undefined, PID, 0);
    assert.equal(r0.entry.observations, 1);
    assert.equal(r0.entry.firstBusyAt, 0);
    assert.equal(r0.fresh, true, "first observation is a fresh window");
    assert.equal(r0.escalate, false, "fresh observation cannot escalate");

    let e = stepWedgedLedger(r0.entry, PID, 200_000);
    assert.equal(e.entry.observations, 2);
    assert.equal(e.fresh, false, "short gap bridges the window");
    assert.equal(e.escalate, false);
    e = stepWedgedLedger(e.entry, PID, 400_000);
    assert.equal(e.entry.observations, 3);
    assert.equal(e.escalate, false, "min observations reached but window not elapsed");
    e = stepWedgedLedger(e.entry, PID, WEDGED_TAKEOVER_WINDOW_MS - 1);
    assert.equal(e.escalate, false, "one ms short of the window");
    assert.equal(e.entry.firstBusyAt, 0, "window keeps counting from first observation");

    const atWindow = stepWedgedLedger(e.entry, PID, WEDGED_TAKEOVER_WINDOW_MS);
    assert.equal(atWindow.escalate, true, "window elapsed + enough observations → escalate");

    // Window elapsed but still below WEDGED_MIN_OBSERVATIONS even after this
    // step: patience continues (a long-running host that rarely re-brings-up
    // must not be killed off a couple of old sightings). Gap == STALE bridges
    // exactly.
    const sparse = { pid: PID, firstBusyAt: 0, lastObservedAt: WEDGED_OBSERVATION_STALE_MS, observations: WEDGED_MIN_OBSERVATIONS - 2 };
    const sparseStep = stepWedgedLedger(sparse, PID, WEDGED_TAKEOVER_WINDOW_MS);
    assert.equal(sparseStep.entry.observations, WEDGED_MIN_OBSERVATIONS - 1);
    assert.equal(sparseStep.entry.firstBusyAt, 0, "gap == STALE bridges the window");
    assert.equal(sparseStep.escalate, false, "min observations gate holds even past the window");

    // One ms over STALE: the run was interrupted (host restarted) → the window
    // restarts from now with a single fresh observation.
    const stale = { pid: PID, firstBusyAt: 0, lastObservedAt: WEDGED_OBSERVATION_STALE_MS - 1, observations: 5 };
    const staleStep = stepWedgedLedger(stale, PID, WEDGED_TAKEOVER_WINDOW_MS);
    assert.equal(staleStep.entry.firstBusyAt, WEDGED_TAKEOVER_WINDOW_MS, "stale gap restarts the window");
    assert.equal(staleStep.entry.observations, 1);
    assert.equal(staleStep.fresh, true, "stale gap is reported as a fresh window");
    assert.equal(staleStep.escalate, false);
});

test("#5955 processBirthStamp: own pid resolves to a stable non-empty stamp", async () => {
    const a = await processBirthStamp(process.pid);
    const b = await processBirthStamp(process.pid);
    assert.ok(a !== undefined && a.length > 0, "birth stamp available on this platform");
    assert.equal(b, a, "stable across reads");
    assert.equal(await processBirthStamp(-1), undefined, "invalid pid → undefined (key degrades to origin#pid)");
});

test("#5955 full path: graceful shutdown frees the port, no signal/kill needed", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = wedgedHolder();
    const handle = await cycleUntil(w, holder, () => w.shutdownCalls.length === 1, 6);

    assert.equal(w.shutdownCalls.length, 1, "exactly one graceful shutdown attempt");
    assert.deepEqual(w.shutdownCalls, [ORIGIN]);
    assert.equal(w.signalCalls.length, 0, "graceful release needs no signal");
    assert.equal(w.killCalls.length, 0, "graceful release needs no kill");
    assert.deepEqual(w.order.filter((s) => s !== "spawn"), ["shutdown"]);
    assert.equal(w.spawnCalls, 4, "each pre-escalation cycle spawns; the escalating cycle binds the freed port");
    assert.equal(handle.port, PORT);
    assert.ok(handle.child, "the escalated cycle must spawn a live child");
    assert.equal(startLines(w).length, 1, "patience-window start announced once, user-visibly");
    assert.equal(watchingLines(w).length, 2, "non-escalating cycles logged the observability line");
    assert.equal(fs.existsSync(ledgerFile), false, "successful takeover clears the persisted ledger");
});

test("#5955 full path: unresponsive holder → shutdown, then SIGTERM, then hard kill, in order", async () => {
    const w = makeWorld({ gracefulShutdown: false, killReleases: true });
    const holder = wedgedHolder();
    const handle = await cycleUntil(w, holder, () => w.killCalls.length === 1, 6);

    assert.deepEqual(w.order.filter((s) => s !== "spawn"), ["shutdown", "signal", "kill"], "escalation ladder order");
    assert.deepEqual(w.signalCalls, [holder.pid]);
    assert.deepEqual(w.killCalls, [holder.pid]);
    assert.equal(w.spawnCalls, 4);
    assert.equal(handle.port, PORT);
    assert.ok(handle.child);
    assert.equal(fs.existsSync(ledgerFile), false, "successful forced takeover clears the persisted ledger");
});

test("#5955 escalation pays a SHORT BUSY budget, not the graceful ladder", async () => {
    // Measured on the acceptance box (#5955): 12.4s of a 13.8s takeover sat
    // inside the graceful stages a BUSY holder can never answer (3s POST
    // timeout + 5s listener wait + 2s SIGTERM drain) before the hard kill it
    // always needs. The ladder is field-tuned down to 1s + 2s + 1s + 2s, so
    // the whole escalation must stay inside single-digit seconds of virtual
    // time — and the POST must never wait out the 3s graceful default.
    const w = makeWorld({ gracefulShutdown: false, killReleases: true });
    const holder = wedgedHolder();
    let handle: Awaited<ReturnType<typeof runCycle>> | undefined;
    for (let i = 1; i <= 3; i++) {
        if (i > 1) w.clock.advance(GAP_MS);
        handle = await runCycle(w, holder);
    }
    assert.equal(w.killCalls.length, 0, "still patient before the window elapses");

    w.clock.advance(GAP_MS);
    const t0 = w.clock.now();
    handle = await runCycle(w, holder);
    const escalationMs = w.clock.now() - t0;

    assert.equal(w.killCalls.length, 1, "the escalating cycle still ends in the hard kill");
    assert.equal(handle?.port, PORT);
    assert.equal(w.shutdownTimeouts.length, 1, "exactly one graceful shutdown request before the kill");
    const budget = w.shutdownTimeouts[0];
    assert.equal(typeof budget, "number", "the BUSY shutdown POST gets an explicit budget");
    assert.ok((budget as number) > 0 && (budget as number) < 3_000, `BUSY shutdown POST must not wait out the 3s graceful default (got ${budget}ms)`);
    assert.ok(escalationMs >= 2_000, `the post-kill settle stays conservative (got ${escalationMs}ms)`);
    assert.ok(escalationMs <= 6_000, `worst-case takeover staging bounded to ~6s (got ${escalationMs}ms)`);
});

test("#5955 hard kill: a pid already reaped by taskkill is silent, real failures still surface", () => {
    // win32: taskkill /F /T reaps the tree, then the defensive direct SIGKILL
    // finds the pid gone and used to emit "its listener may survive the
    // cleanup (#4125)" on EVERY takeover — noise that hides real survivors.
    const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    assert.equal(dead.status, 0);
    assert.equal(typeof dead.pid, "number");
    const lines: string[] = [];
    setLogCapture((level, msg) => { lines.push(`${level}:${msg}`); });
    try {
        hardKillProxyTree(dead.pid as number, "wedged holder");
    } finally {
        setLogCapture(null);
    }
    assert.equal(lines.filter((l) => l.includes("direct SIGKILL")).length, 0, "a kill that found the pid gone is not a survivor report");
    assert.equal(
        lines.filter((l) => l.includes("taskkill")).length,
        process.platform === "win32" ? 1 : 0,
        "a real hard-kill failure is still surfaced (#4125)",
    );
});

test("#5955 full path: kill fails → fall through to normal spawn, ledger kept, retry next cycle", async () => {
    const w = makeWorld({ gracefulShutdown: false, killReleases: false });
    const holder = wedgedHolder();
    const handle = await cycleUntil(w, holder, () => w.killCalls.length === 2, 8);

    assert.equal(w.shutdownCalls.length, 2, "one escalation attempt per qualifying cycle");
    assert.equal(w.signalCalls.length, 2);
    assert.equal(w.killCalls.length, 2);
    assert.equal(w.spawnCalls, 5, "every cycle still spawns — never worse than today while the holder survives");
    assert.equal(handle.port, PORT);
    assert.ok(handle.child);
    assert.equal(startLines(w).length, 1);
    assert.equal(watchingLines(w).length, 2, "only the pre-escalation cycles logged the watching line");
    const entries = readLedger();
    assert.equal(Object.keys(entries).length, 1, "surviving occupant keeps its ledger entry for the retry");
    // Five bring-ups, five observations — but the ledger's documented worst case
    // is a lost read-modify-write (wedged-takeover ledger contract in
    // src/launcher.ts: "the worst case loses one observation ... which is
    // safe"), so tolerate exactly that one
    // loss instead of turning an fs-timing hiccup into a CI flake. Anything
    // below 4 means observations are NOT bridging the gap (the patience window
    // would restart every cycle and the takeover could never fire).
    const observed = Object.values(entries)[0].observations;
    assert.ok(observed === 5 || observed === 4, `observations accumulate across failed escalations (got ${observed}, expected 5, or 4 for the documented one-observation loss)`);
});

test("#5955 full path: port:0 bring-up resolves the sticky lane port lazily", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = wedgedHolder();
    let zonePortCalls = 0;
    const handle = await cycleUntil(
        w,
        holder,
        () => w.shutdownCalls.length === 1,
        6,
        {
            opts: { port: 0 },
            deps: { zonePreferredPort: (lane: string) => { zonePortCalls += 1; assert.equal(lane, "dsh"); return PORT; } },
        },
    );
    assert.ok(zonePortCalls >= 1, "sticky resolver touched only because a real wedged-cell holder existed");
    assert.equal(handle.port, PORT, "after takeover the spawn binds the lane's preferred port");
    assert.ok(handle.child);
});

test("#5955 full path: observations persist across client restarts (file ledger)", async () => {
    const holder = wedgedHolder();
    const clock = makeClock();
    // "Process 1": one bring-up cycle in its own memory.
    const w1 = makeWorld({ gracefulShutdown: false, killReleases: false });
    w1.clock = clock;
    await runCycle(w1, holder);
    const key = `${ORIGIN}#${holder.pid}#stamp-${holder.pid}`;
    const after1 = readLedger();
    assert.equal(Object.keys(after1).length, 1);
    assert.equal(after1[key].observations, 1);

    // "Process 2": a FRESH world (fresh in-memory state) GAP later, same disk.
    clock.advance(GAP_MS);
    const w2 = makeWorld({ gracefulShutdown: false, killReleases: false });
    w2.clock = clock;
    await runCycle(w2, holder);
    const after2 = readLedger();
    assert.equal(after2[key].observations, 2, "the restarted client continues the previous process's window");
    assert.equal(after2[key].firstBusyAt, after1[key].firstBusyAt, "the window keeps counting from the first sighting");
    assert.equal(w2.shutdownCalls.length, 0, "no premature takeover after a mere two sightings");
});

test("#5955 full path: reused pid gets a fresh window (birth-stamp key)", async () => {
    const holder = wedgedHolder();
    const w = makeWorld({ gracefulShutdown: false, killReleases: false });
    let stamp = "boot-old";
    await runCycle(w, holder, { deps: { processBirthStamp: async () => stamp } });
    w.clock.advance(GAP_MS);
    await runCycle(w, holder, { deps: { processBirthStamp: async () => stamp } });
    // The OS hands the SAME pid to a brand-new process (different birth time).
    stamp = "boot-new";
    w.clock.advance(GAP_MS);
    const handle = await runCycle(w, holder, { deps: { processBirthStamp: async () => stamp } });

    const entries = readLedger();
    assert.equal(Object.keys(entries).length, 2, "old-stamp and new-stamp keys coexist (dead-pid prune cleans up later)");
    assert.equal(entries[`${ORIGIN}#${holder.pid}#boot-old`].observations, 2);
    assert.equal(entries[`${ORIGIN}#${holder.pid}#boot-new`].observations, 1, "reused pid starts at observation 1");
    assert.equal(w.shutdownCalls.length, 0, "never force-take-over a newborn instance on inherited history");
    assert.equal(startLines(w).length, 2, "the new occupant's patience window is announced again");
    assert.equal(handle.port, PORT);
});

test("#5955 negative: healthy OLDER holder still routes through #3544 rotation ONLY", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = wedgedHolder();
    const handle = await runCycle(w, holder, {
        deps: {
            fetchHealthInfo: async (origin: string) => origin === holder.origin
                ? { ok: true, instanceId: "zombie-instance", pid: process.pid, watchdog: { armed: true }, version: "0.0.1" }
                : { ok: false },
            fetchHealthInfoNoReuse: async () => ({ ok: false }),
        },
    });

    assert.deepEqual(w.shutdownCalls, [ORIGIN], "#3544 rotation performs the graceful shutdown");
    assert.equal(w.signalCalls.length, 0, "rotation never signals");
    assert.equal(w.killCalls.length, 0, "rotation never kills");
    assert.equal(w.spawnCalls, 1);
    assert.equal(handle.port, PORT);
    assert.equal(watchingLines(w).length, 0, "no wedged-takeover activity for a healthy holder");
    assert.equal(startLines(w).length, 0);
});

test("#5955 negative: healthy NEWER holder still adopted (#4125), never touched", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = wedgedHolder();
    const handle = await runCycle(w, holder, {
        deps: {
            fetchHealthInfo: async (origin: string) => origin === holder.origin
                ? { ok: true, instanceId: "zombie-instance", pid: process.pid, watchdog: { armed: true }, version: "999.0.0" }
                : { ok: false },
        },
    });

    assert.equal(w.spawnCalls, 0, "newer same-lane holder is adopted, not bypassed");
    assert.equal(w.shutdownCalls.length, 0);
    assert.equal(w.signalCalls.length, 0);
    assert.equal(w.killCalls.length, 0);
    assert.equal(handle.attached, true);
    assert.equal(handle.child, undefined);
});

test("#5955 negative: SAME-build BUSY holder is attached and NEVER killed (#4811)", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = { ...wedgedHolder(), codeFingerprint: FP_HASH };
    const handle = await runCycle(w, holder);

    assert.equal(w.spawnCalls, 0, "our own build attaches even while BUSY");
    assert.equal(w.shutdownCalls.length, 0, "never shut down our own build");
    assert.equal(w.signalCalls.length, 0, "never signal our own build");
    assert.equal(w.killCalls.length, 0, "never kill our own build");
    assert.equal(handle.attached, true);
    assert.equal(watchingLines(w).length, 0);
});

test("#5955 negative: user-zone BUSY holder untouched", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = { ...wedgedHolder(), lane: undefined, launchToken: undefined };
    const handle = await runCycle(w, holder);

    assert.equal(w.spawnCalls, 1);
    assert.equal(w.shutdownCalls.length, 0);
    assert.equal(w.signalCalls.length, 0);
    assert.equal(w.killCalls.length, 0);
    assert.equal(handle.port, PORT);
    assert.equal(watchingLines(w).length, 0);
});

test("#5955 negative: foreign-lane BUSY holder untouched", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = { ...wedgedHolder(), lane: "pi" };
    const handle = await runCycle(w, holder);

    assert.equal(w.spawnCalls, 1);
    assert.equal(w.shutdownCalls.length, 0);
    assert.equal(w.killCalls.length, 0);
    assert.equal(handle.port, PORT);
    assert.equal(watchingLines(w).length, 0);
});

test("#5955 negative: BUSY holder on a different port untouched", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = { ...wedgedHolder(), port: 18799, origin: `http://${HOST}:18799` };
    const handle = await runCycle(w, holder);

    assert.equal(w.spawnCalls, 1);
    assert.equal(w.shutdownCalls.length, 0);
    assert.equal(w.killCalls.length, 0);
    assert.equal(handle.port, PORT, "the spawn still binds the canonical port");
    assert.equal(watchingLines(w).length, 0);
});

test("#5955 negative: explicit attach target skips the takeover step entirely", async () => {
    const w = makeWorld({ gracefulShutdown: true, killReleases: false });
    const holder = wedgedHolder();
    const handle = await runCycle(w, holder, { deps: { resolveAttachUrl: () => ORIGIN } });

    assert.equal(w.spawnCalls, 1);
    assert.equal(w.shutdownCalls.length, 0);
    assert.equal(w.signalCalls.length, 0);
    assert.equal(w.killCalls.length, 0);
    assert.equal(handle.port, PORT);
    assert.equal(watchingLines(w).length, 0);
});
