// #4566 part 2 (owner decision 2026-10-26: A1 + (c)): the omp lane's sticky
// port moved under LIVE hosts twice — once because discovery treated a busy
// (event-loop-saturated) listener as dead and spawned a rival that laddered
// and RECORDED the new port, once because a dist change made the new build
// ladder past the still-serving old build and record THAT port. Every host
// pinned to the old origin then died (part 1, PR #4878, fixed the hop side).
// This suite pins the port side:
//   A) A1 — settleZonePort must NOT move the sticky record while a LIVE
//      same-lane bili holds the preferred port (healthy or wedged-busy);
//      foreign-lane / dead holders keep today's drift-and-record behavior;
//      the record converges back once the holder exits.
//   B) (c) — a BUSY candidate (TCP alive, health silent) that this launch
//      could attach to gets a bounded grace window to answer: an answer goes
//      through the regular gates with real data, silence keeps the existing
//      #4811 BUSY semantics, dying mid-window is dead-not-busy, and
//      non-attachable candidates (foreign lane) get NO grace at all.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

process.env.NODE_TEST_CONTEXT = "1";
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4566-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const { lanePreferredPort, readZonePort, writeZonePort } = await import("../src/instance.ts");
const { ensureProxyRunning } = await import("../src/launcher.ts");
const { ZONE_PORT_BASE } = await import("../src/config.ts");
import type { ProxyInstanceFile } from "../src/instance.ts";
import type { SpawnChild, SpawnFn } from "../src/launcher.ts";
import { rmrf } from "./tmp-rm.ts";

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-4566-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// #4566 lane-port-sticky fingerprint fixture\n");
const OWN_FP = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");
const OLD_FP = "fp-old-build-4566";

function deadPid(): number {
    const r = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(r.pid > 0, "spawnSync reports the child pid");
    return r.pid;
}

// ---------------------------------------------------------------------------
// A) A1: the sticky zone pointer never moves under a live same-lane bili.
// ---------------------------------------------------------------------------

interface HolderRow {
    /** registry marker claiming the preferred port; null = no marker at all */
    marker?: Partial<ProxyInstanceFile> | null;
    /** health answer for the preferred origin: undefined = silent */
    health?: { ok: boolean; pid?: number };
    /** TCP reachability of the preferred origin while health is silent */
    connectable?: boolean;
}

function makeA1World(zoneFile: string, lane: string, row: HolderRow) {
    const BASE = ZONE_PORT_BASE;
    const sim = {
        live: undefined as ProxyInstanceFile | undefined,
        squatted: new Set<number>(),
        spawns: 0,
        settles: [] as Array<[string, number]>,
        diag: [] as string[],
        pidSeq: 45_600,
    };
    // The holder occupies the preferred port from the start.
    sim.squatted.add(BASE);
    const holderOrigin = `http://127.0.0.1:${BASE}`;
    // A live same-lane holder on the preferred port is the DEFAULT world
    // (that is what A1 protects against); rows opt out with marker: null.
    const holder: ProxyInstanceFile | undefined = row.marker === null ? undefined : {
        origin: holderOrigin,
        instanceId: "holder-4566",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: BASE,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        lane,
        codeFingerprint: OLD_FP,
        ...row.marker,
    };
    const spawnImpl: SpawnFn = (_cmd, args, options) => {
        sim.spawns += 1;
        const want = Number(args[args.indexOf("--port") + 1]);
        let bind = want;
        while (sim.squatted.has(bind)) bind += 1;
        const childPid = ++sim.pidSeq;
        const token = options.env?.BILI_LAUNCH_TOKEN ?? `sim-token-${childPid}`;
        sim.live = {
            origin: `http://127.0.0.1:${bind}`,
            instanceId: `child-${childPid}`,
            pid: process.pid,
            startedAt: Date.now(),
            host: "127.0.0.1",
            port: bind,
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            lane,
            launchToken: token,
            codeFingerprint: OWN_FP,
        };
        return { pid: childPid, unref() {}, kill() { return true; }, on() {} } satisfies SpawnChild;
    };
    const deps = {
        fetchImpl: async (url: string) =>
            sim.live !== undefined && url.startsWith(sim.live.origin) ? { ok: true } : { ok: false },
        fetchHealthInfo: async (origin: string) => (origin === holderOrigin ? row.health : undefined),
        readInstanceFile: () => sim.live,
        listRegistryInstances: () => (holder !== undefined ? [holder] : []),
        isConnectable: async (origin: string) => (origin === holderOrigin ? (row.connectable ?? false) : false),
        spawnImpl,
        registerWatcher: async () => "ok" as const,
        sleep: () => Promise.resolve(),
        scriptPath: FP_SCRIPT,
        attachDiag: (msg: string) => { sim.diag.push(msg); },
        zonePreferredPort: (l: string) => lanePreferredPort(l, {}, zoneFile),
        writeZonePort: (l: string, port: number) => {
            sim.settles.push([l, port]);
            writeZonePort(l, port, zoneFile);
        },
    };
    return { sim, deps, BASE, holder };
}

function zoneDir(): { dir: string; zoneFile: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4566-zone-"));
    return { dir, zoneFile: path.join(dir, "port-zone.json") };
}

test("A1a: a serving same-lane holder keeps the sticky pointer — the laddered port is NOT recorded (#4566)", async () => {
    const { dir, zoneFile } = zoneDir();
    try {
        writeZonePort("zcode", ZONE_PORT_BASE, zoneFile);
        const { sim, deps, BASE } = makeA1World(zoneFile, "zcode", {
            health: { ok: true, pid: process.pid },
        });
        const h = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
        assert.equal(sim.spawns, 1, "the old build is not attachable (different fingerprint) — a new child spawns");
        assert.equal(h.port, BASE + 1, "the child ladders past the serving holder");
        assert.deepEqual(sim.settles, [], "NO sticky write: the pointer stays with the live holder");
        assert.equal(readZonePort("zcode", zoneFile), BASE, "the zone file is untouched");
        assert.ok(sim.diag.some((d) => d.includes("keeps sticky port") && d.includes("still serves")), "the hold decision is diagnosable");
    } finally { rmrf(dir); }
});

test("A1b: a wedged same-lane holder (TCP alive, health silent, live pid) also keeps the pointer (#4566/#3654)", async () => {
    const { dir, zoneFile } = zoneDir();
    try {
        writeZonePort("zcode", ZONE_PORT_BASE, zoneFile);
        const { sim, deps, BASE } = makeA1World(zoneFile, "zcode", {
            health: undefined,
            connectable: true,
        });
        const h = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
        assert.equal(h.port, BASE + 1);
        assert.deepEqual(sim.settles, [], "busy ≠ dead — moving the lane around a wedged holder ratchets it forever");
        assert.equal(readZonePort("zcode", zoneFile), BASE);
        assert.ok(sim.diag.some((d) => d.includes("keeps sticky port") && d.includes("kill")), "the log names the pid to kill");
    } finally { rmrf(dir); }
});

test("A1c: a FOREIGN-lane holder on the preferred port does NOT protect the pointer (today's drift stands)", async () => {
    const { dir, zoneFile } = zoneDir();
    try {
        writeZonePort("zcode", ZONE_PORT_BASE, zoneFile);
        const { sim, deps, BASE } = makeA1World(zoneFile, "zcode", {
            marker: { lane: "pi" },
            health: { ok: true, pid: process.pid },
        });
        const h = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
        assert.equal(h.port, BASE + 1);
        assert.deepEqual(sim.settles, [["zcode", BASE + 1]], "a different lane's proxy is not our lane's holder — the record moves as before");
        assert.equal(readZonePort("zcode", zoneFile), BASE + 1);
    } finally { rmrf(dir); }
});

test("A1d: a DEAD holder (pid gone) does not protect the pointer", async () => {
    const { dir, zoneFile } = zoneDir();
    try {
        writeZonePort("zcode", ZONE_PORT_BASE, zoneFile);
        const { sim, deps, BASE } = makeA1World(zoneFile, "zcode", {
            marker: { pid: deadPid() },
            health: undefined,
            connectable: false,
        });
        const h = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
        assert.equal(h.port, BASE + 1);
        assert.deepEqual(sim.settles, [["zcode", BASE + 1]], "a dead owner frees the port logically — the record may move");
    } finally { rmrf(dir); }
});

test("A1e: convergence — once the holder exits, the next launch reclaims the preferred port and re-settles it", async () => {
    const { dir, zoneFile } = zoneDir();
    try {
        writeZonePort("zcode", ZONE_PORT_BASE, zoneFile);
        const { sim, deps, BASE } = makeA1World(zoneFile, "zcode", {
            health: { ok: true, pid: process.pid },
        });
        const h1 = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
        assert.equal(h1.port, BASE + 1);
        assert.deepEqual(sim.settles, []);
        // The stack restarts the idle old instance: it exits, freeing the port.
        sim.squatted.delete(BASE);
        sim.live = undefined;
        (deps as { listRegistryInstances: () => ProxyInstanceFile[] }).listRegistryInstances = () => [];
        const h2 = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
        assert.equal(sim.spawns, 2);
        assert.equal(h2.port, BASE, "the freed preferred port is bound directly");
        assert.deepEqual(sim.settles, [["zcode", BASE]], "the idempotent re-settle converges the record");
        assert.equal(readZonePort("zcode", zoneFile), BASE);
    } finally { rmrf(dir); }
});

// ---------------------------------------------------------------------------
// B) (c): bounded grace window for BUSY candidates.
// ---------------------------------------------------------------------------

const TWIN_ORIGIN = "http://127.0.0.1:18936";

function twinInstance(lane?: string): ProxyInstanceFile {
    return {
        origin: TWIN_ORIGIN,
        instanceId: "inst-4566",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18936,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        ...(lane !== undefined ? { lane } : {}),
        codeFingerprint: OWN_FP,
    };
}

function fakeChildHanging(): SpawnChild {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
        pid: 45_671,
        unref() {},
        kill() { return true; },
        on(ev: string, cb: (...args: unknown[]) => void) {
            handlers.set(ev, cb);
            return this;
        },
    };
}

function fakeChildExitting(code: number | null): SpawnChild {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
        pid: 45_670,
        unref() {},
        kill() { return true; },
        on(ev: string, cb: (...args: unknown[]) => void) {
            handlers.set(ev, cb);
            if (ev === "exit") queueMicrotask(() => cb(code, null));
            return this;
        },
    };
}

function fakeClock() {
    let ticks = 0;
    return {
        now: () => ticks * 1000,
        sleep: () => { ticks += 1; return Promise.resolve(); },
    };
}

interface GraceRow {
    inst: ProxyInstanceFile;
    /** scripted health answers for the twin origin (undefined entries = silent) */
    answers: Array<{ ok: boolean; watchdog?: { armed: boolean } } | undefined>;
    /** per-call TCP connectability of the twin origin */
    connectable: Array<boolean> | boolean;
    initiatorLane?: string;
    /** "hanging" keeps the spawn wait loop from rediscovering (stable probe count) */
    child?: "exiting" | "hanging";
}

async function graceBringUp(row: GraceRow) {
    let spawnCalls = 0;
    const diag: string[] = [];
    let probes = 0;
    let connects = 0;
    const clock = fakeClock();
    const pending = ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, ...(row.initiatorLane !== undefined ? { lane: row.initiatorLane } : {}) },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) => {
                if (origin !== TWIN_ORIGIN) return undefined;
                const i = probes;
                probes += 1;
                return row.answers[Math.min(i, row.answers.length - 1)];
            },
            readInstanceFile: () => row.inst,
            listRegistryInstances: () => [],
            spawnImpl: (_cmd: string, _args: readonly string[]): SpawnChild => {
                spawnCalls += 1;
                return row.child === "hanging" ? fakeChildHanging() : fakeChildExitting(1);
            },
            now: clock.now,
            sleep: clock.sleep,
            registerWatcher: async () => "ok",
            attachDiag: (msg) => { diag.push(msg); },
            scriptPath: FP_SCRIPT,
            listAdoptCandidates: () => [],
            isConnectable: async (origin) => {
                if (origin !== TWIN_ORIGIN) return false;
                const v = row.connectable;
                const i = connects;
                connects += 1;
                return Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v;
            },
        },
    );
    const [handle, err] = await Promise.all([
        pending.then((h) => h, () => undefined),
        pending.then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ]);
    return { handle, err, spawnCalls, diag, probes, connects };
}

test("(c)-1: a BUSY same-lane candidate that answers within the grace window attaches with REAL health data", async () => {
    const r = await graceBringUp({
        inst: twinInstance("dsh"),
        answers: [undefined, { ok: true, watchdog: { armed: true } }],
        connectable: true,
        initiatorLane: "dsh",
    });
    assert.equal(r.err, undefined, `must attach, not fail: ${r.err?.message}`);
    assert.equal(r.handle?.attached, true);
    assert.equal(r.handle?.origin, TWIN_ORIGIN);
    assert.equal(r.spawnCalls, 0, "no rival spawn once the lane's own instance proves itself");
    assert.ok(r.probes >= 2, "the grace window actually re-probed");
});

test("(c)-2: a BUSY same-lane candidate that NEVER answers keeps today's #4811 semantics (kept, attached)", async () => {
    const r = await graceBringUp({
        inst: twinInstance("dsh"),
        answers: [undefined],
        connectable: true,
        initiatorLane: "dsh",
    });
    assert.equal(r.err, undefined, `must attach, not fail: ${r.err?.message}`);
    assert.equal(r.handle?.attached, true, "silence after the window = BUSY = attachable same-lane, unchanged");
    assert.equal(r.spawnCalls, 0);
    assert.ok(r.probes > 1, "the bounded window was spent, then the verdict froze");
    assert.ok(r.diag.some((d) => d.includes("keep") && d.includes("BUSY")), "the keep decision stays diagnosable");
});

test("(c)-3: a BUSY FOREIGN-lane candidate gets NO grace — one probe, immediate refusal", async () => {
    const r = await graceBringUp({
        inst: twinInstance("pi"),
        answers: [undefined],
        connectable: true,
        initiatorLane: "dsh",
        child: "hanging",
    });
    assert.equal(r.probes, 1, "waiting out an unrelated lane's saturation would stall our bring-up");
    assert.ok(r.diag.some((d) => d.includes("incompatible (lane-mismatch)") || d.includes("refusing to attach") || d.includes("not own lane")), "the foreign-lane candidate is refused, however worded");
    assert.equal(r.handle?.attached, undefined, "nothing was attached to the foreign lane's proxy");
    assert.ok(r.spawnCalls >= 1, "the launch proceeds to its own spawn");
});

test("(c)-4: a candidate that DIES during the grace window is dropped as dead, not kept BUSY", async () => {
    const r = await graceBringUp({
        inst: twinInstance("dsh"),
        answers: [undefined],
        // first entry: the initial BUSY detection; second: the post-window check sees the corpse
        connectable: [true, false],
        initiatorLane: "dsh",
    });
    assert.ok(r.probes >= 2, "the window started before the death was detected");
    assert.ok(r.diag.some((d) => d.includes("died while silent")), "death mid-window is diagnosed as dead");
    assert.ok(r.spawnCalls >= 1, "no attach target anymore — the launch spawns");
    assert.equal(r.handle?.attached, undefined, "nothing was attached to the corpse");
});
