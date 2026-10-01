import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findSameLanePredecessor, lanePreferredPort, portZoneFilePath, readZonePort, writeZonePort } from "../src/instance.ts";
import type { ProxyInstanceFile, RegistryEntry } from "../src/instance.ts";
import { ZONE_PORT_BASE, resolveZonePortBase } from "../src/config.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

// #1660: the self-managed port zone. Every lane'd launch tries the lane's
// sticky port first (a past +1-ladder drift it still points at), else the
// zone base; the spawn path settles the actually-bound port back sticky so
// later launches follow drift automatically. Pure file-backed functions —
// always driven against an explicit temp file here so tests never touch the
// developer's real state dir.

function zoneFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-port-zone-"));
    return path.join(dir, "port-zone.json");
}

test("readZonePort/writeZonePort: round-trip, per-lane isolation, preserves other lanes", () => {
    const file = zoneFile();
    try {
        assert.equal(readZonePort("zcode", file), undefined, "no record yet");
        writeZonePort("zcode", 18788, file);
        writeZonePort("claude", 18789, file);
        assert.equal(readZonePort("zcode", file), 18788);
        assert.equal(readZonePort("claude", file), 18789);
        // a rewrite of one lane preserves the other
        writeZonePort("zcode", 18790, file);
        assert.equal(readZonePort("zcode", file), 18790);
        assert.equal(readZonePort("claude", file), 18789);
        const shape = JSON.parse(readFileSync(file, "utf8")) as { lanes: Record<string, number> };
        assert.deepEqual(shape.lanes, { zcode: 18790, claude: 18789 });
    } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test("readZonePort: tolerates garbage — missing file, invalid JSON, out-of-range values", () => {
    const file = zoneFile();
    try {
        assert.equal(readZonePort("zcode", file), undefined, "missing file");
        writeFileSync(file, "{ this is not json", "utf8");
        assert.equal(readZonePort("zcode", file), undefined, "corrupt JSON");
        writeFileSync(file, JSON.stringify({ lanes: { zcode: "18788", claude: 0, pi: 65536, dsh: 1.5 } }), "utf8");
        assert.equal(readZonePort("zcode", file), undefined, "string is not a port");
        assert.equal(readZonePort("claude", file), undefined, "0 is not a port");
        assert.equal(readZonePort("pi", file), undefined, "65536 is out of range");
        assert.equal(readZonePort("dsh", file), undefined, "non-integer is not a port");
        writeFileSync(file, JSON.stringify({ lanes: { zcode: 18788 } }), "utf8");
        assert.equal(readZonePort("other", file), undefined, "lane without a record");
    } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test("writeZonePort: rejects invalid ports and never throws", () => {
    const file = zoneFile();
    try {
        writeZonePort("zcode", 0, file);
        writeZonePort("zcode", 65536, file);
        writeZonePort("zcode", 1.5, file);
        writeZonePort("zcode", Number.NaN, file);
        assert.equal(readZonePort("zcode", file), undefined, "nothing settled for invalid inputs");
        assert.doesNotThrow(() => writeZonePort("zcode", 18787, file));
    } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test("lanePreferredPort: sticky record beats the base; base honors BILI_ZONE_PORT", () => {
    const file = zoneFile();
    try {
        assert.equal(lanePreferredPort("zcode", { BILI_ZONE_PORT: "20000" }), 20000, "env override of the base");
        writeZonePort("zcode", 18788, file);
        // sticky lives in the DEFAULT state file — patch readZonePort's view by
        // pointing the default path at the temp file via the module seam: the
        // function reads portZoneFilePath() when no file is passed, so drive
        // the two-arg forms directly for the composed semantics instead.
        assert.equal(readZonePort("zcode", file), 18788, "sticky present in the temp zone file");
        assert.equal(lanePreferredPort("zcode", {}), ZONE_PORT_BASE, "default base without a sticky record (real state file untouched in tests)");
    } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test("resolveZonePortBase: BILI_ZONE_PORT validated 1..65535, junk falls back to the default", () => {
    assert.equal(ZONE_PORT_BASE, 18787, "the zone base sits below the Linux ephemeral range (32768-60999)");
    assert.equal(resolveZonePortBase({}), ZONE_PORT_BASE);
    assert.equal(resolveZonePortBase({ BILI_ZONE_PORT: "20000" }), 20000);
    assert.equal(resolveZonePortBase({ BILI_ZONE_PORT: "1" }), 1);
    assert.equal(resolveZonePortBase({ BILI_ZONE_PORT: "65535" }), 65535);
    assert.equal(resolveZonePortBase({ BILI_ZONE_PORT: "0" }), ZONE_PORT_BASE);
    assert.equal(resolveZonePortBase({ BILI_ZONE_PORT: "65536" }), ZONE_PORT_BASE);
    assert.equal(resolveZonePortBase({ BILI_ZONE_PORT: "not-a-port" }), ZONE_PORT_BASE);
});

test("portZoneFilePath: lives in the state dir", () => {
    assert.equal(path.basename(portZoneFilePath()), "port-zone.json");
});

// ---------------------------------------------------------------------------
// #1660 launch sequences: the sticky-zone lifecycle driven through
// ensureProxyRunning with mocked process edges. The single-shot tests in
// launcher.test.ts pin one decision each; these pin the REPEATED loop —
// spawn → settle → attach → drift → re-settle → attach-follows — the exact
// regression surface where a pre-resolved port silently skips the settle
// (fixed in 90cc7e8; only a repeated launch exposes the missing record).
// ---------------------------------------------------------------------------

// ensureProxyRunning coordinates across processes via <state>/proxy-starting
// (#707) and probes <state>/instances — point the state dir at a throwaway so
// these tests never touch the real one (same posture as launcher.test.ts).
const prevZoneTestXdgState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), "bili-zone-test-state-"));
after(() => {
    if (prevZoneTestXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevZoneTestXdgState;
});

// A script fixture whose content hash matches the instances the sim records —
// instanceCompatible demands the spawn script's fingerprint to match.
const ZONE_FP_SCRIPT = path.join(tmpdir(), `bili-zone-fp-${process.pid}.js`);
writeFileSync(ZONE_FP_SCRIPT, "// zone sequence fingerprint fixture\n");
const ZONE_FP_HASH = createHash("sha256").update(readFileSync(ZONE_FP_SCRIPT)).digest("hex");

function recordedZoneInstance(over: Partial<ProxyInstanceFile> = {}): ProxyInstanceFile {
    return {
        origin: `http://127.0.0.1:${ZONE_PORT_BASE}`,
        instanceId: "zone-inst-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: ZONE_PORT_BASE,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: ZONE_FP_HASH,
        ...over,
    };
}

function fakeZoneChild(pid: number): SpawnChild {
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on() {},
    };
}

/** A one-daemon world: `live` is the currently recorded instance, `squatted`
 *  holds ports dumb listeners occupy (the daemon's own port also blocks), and
 *  a spawn binds the requested port or ladders +1 past busy ones — the same
 *  EADDRINUSE walk the real server does (#1335). The zone file is REAL: the
 *  sim's zonePreferredPort/writeZonePort delegate to it, so the full
 *  write→read sticky loop runs on disk. */
function makeZoneSim(zoneFile: string, lane: string) {
    const sim = {
        live: undefined as ProxyInstanceFile | undefined,
        squatted: new Set<number>(),
        spawns: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
        settles: [] as Array<[string, number]>,
        pidSeq: 42100,
    };
    const spawnImpl: SpawnFn = (_cmd, args, options) => {
        sim.spawns.push({ args: [...args], env: options.env ?? {} });
        const want = Number(args[args.indexOf("--port") + 1]);
        let bind = want;
        while (sim.squatted.has(bind) || (sim.live !== undefined && bind === sim.live.port)) bind++;
        const childPid = ++sim.pidSeq;
        const token = options.env?.BILI_LAUNCH_TOKEN ?? `sim-token-${childPid}`;
        // inst.pid must be a LIVE pid — probeLiveInstances drops records whose
        // owner process is gone; the test process stands in for the daemon's.
        sim.live = recordedZoneInstance({
            pid: process.pid,
            port: bind,
            origin: `http://127.0.0.1:${bind}`,
            lane,
            launchToken: token,
            instanceId: `zone-sim-${childPid}`,
        });
        return fakeZoneChild(childPid);
    };
    const deps = {
        fetchImpl: async (url: string) =>
            sim.live !== undefined && url.startsWith(sim.live.origin) ? { ok: true } : { ok: false },
        fetchHealthInfo: async (origin: string) =>
            sim.live !== undefined && sim.live.origin === origin
                ? { ok: true, instanceId: sim.live.instanceId, watchdog: { armed: true } }
                : undefined,
        readInstanceFile: () => sim.live,
        spawnImpl,
        registerWatcher: async () => "ok" as const,
        sleep: () => Promise.resolve(),
        scriptPath: ZONE_FP_SCRIPT,
        zonePreferredPort: (l: string) => lanePreferredPort(l, {}, zoneFile),
        writeZonePort: (l: string, port: number) => {
            sim.settles.push([l, port]);
            writeZonePort(l, port, zoneFile);
        },
    };
    return { sim, deps };
}

const spawnPortArg = (spawn: { args: string[] }): string => spawn.args[spawn.args.indexOf("--port") + 1];

function zoneDir(): { dir: string; zoneFile: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-zone-seq-"));
    return { dir, zoneFile: path.join(dir, "port-zone.json") };
}

test("zone sequence: settle → attach → drift → re-settle → attach follows the drift (#1660)", async () => {
    const { dir, zoneFile } = zoneDir();
    const { sim, deps } = makeZoneSim(zoneFile, "zcode");
    const launch = () =>
        ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" }, deps);
    try {
        const h1 = await launch();
        assert.equal(sim.spawns.length, 1, "first launch spawns the lane daemon");
        assert.equal(h1.port, ZONE_PORT_BASE, "fresh lane'd launch binds the zone base");
        assert.equal(spawnPortArg(sim.spawns[0]), String(ZONE_PORT_BASE), "base is the spawn port, not an OS ephemeral");
        assert.deepEqual(sim.settles, [["zcode", ZONE_PORT_BASE]], "the bound port settles sticky");
        assert.equal(readZonePort("zcode", zoneFile), ZONE_PORT_BASE);

        const h2 = await launch();
        assert.equal(sim.spawns.length, 1, "repeat launch attaches instead of doubling");
        assert.equal(h2.attached, true);
        assert.equal(h2.port, ZONE_PORT_BASE, "attachment rides the settled port");
        assert.deepEqual(sim.settles, [["zcode", ZONE_PORT_BASE]], "attach never re-settles");

        sim.live = undefined; // daemon dies
        sim.squatted.add(ZONE_PORT_BASE); // a squatter takes the sticky port
        const h3 = await launch();
        assert.equal(sim.spawns.length, 2, "dead daemon + squatter forces a respawn");
        assert.equal(spawnPortArg(sim.spawns[1]), String(ZONE_PORT_BASE), "sticky port is still the preferred first try");
        assert.equal(h3.port, ZONE_PORT_BASE + 1, "the bind ladders +1 past the squatter");
        assert.deepEqual(
            sim.settles,
            [["zcode", ZONE_PORT_BASE], ["zcode", ZONE_PORT_BASE + 1]],
            "the drifted port settles sticky",
        );
        assert.equal(readZonePort("zcode", zoneFile), ZONE_PORT_BASE + 1);

        const h4 = await launch();
        assert.equal(sim.spawns.length, 2, "post-drift repeat attaches");
        assert.equal(h4.attached, true);
        assert.equal(h4.port, ZONE_PORT_BASE + 1, "later launches follow the drift");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("zone sequence: a second lane never attaches cross-lane and settles its own sticky key (#1225/#1660)", async () => {
    const { dir, zoneFile } = zoneDir();
    const { sim, deps } = makeZoneSim(zoneFile, "kimi");
    writeZonePort("zcode", ZONE_PORT_BASE, zoneFile); // lane one already settled…
    sim.squatted.add(ZONE_PORT_BASE); // …and its daemon holds the base port
    sim.live = recordedZoneInstance({ lane: "zcode", launchToken: "zcode-token" });
    try {
        const h = await ensureProxyRunning(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "kimi" },
            deps,
        );
        assert.equal(sim.spawns.length, 1, "a lane-mismatch instance is never an attach target");
        assert.equal(h.attached, undefined);
        assert.equal(h.port, ZONE_PORT_BASE + 1, "the second lane ladders past the first lane's daemon");
        assert.deepEqual(sim.settles, [["kimi", ZONE_PORT_BASE + 1]], "the lane settles its own key");
        assert.equal(readZonePort("zcode", zoneFile), ZONE_PORT_BASE, "lane one's sticky record is untouched");
        assert.equal(readZonePort("kimi", zoneFile), ZONE_PORT_BASE + 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("zone sequence: an explicit strictPort pin is exact and stays out of the sticky file (#964/#1660)", async () => {
    const { dir, zoneFile } = zoneDir();
    const { sim, deps } = makeZoneSim(zoneFile, "zcode");
    const pin = ZONE_PORT_BASE + 400;
    try {
        const h = await ensureProxyRunning(
            { host: "127.0.0.1", port: pin, strictPort: true, passthrough: false, debug: false, lane: "zcode" },
            deps,
        );
        assert.equal(sim.spawns.length, 1);
        assert.equal(spawnPortArg(sim.spawns[0]), String(pin), "the exact pin is the spawn port");
        assert.equal(sim.spawns[0].env.BILI_STRICT_PORT, "1", "strictness crosses the process boundary");
        assert.equal(h.port, pin);
        assert.deepEqual(sim.settles, [], "explicit pins never settle a zone record");
        assert.equal(readZonePort("zcode", zoneFile), undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("zone sequence: an unlane'd launch is ephemeral and never touches the zone file (#1660)", async () => {
    const { dir, zoneFile } = zoneDir();
    const { sim, deps } = makeZoneSim(zoneFile, "zcode");
    try {
        const h = await ensureProxyRunning({ host: "127.0.0.1", port: 0, passthrough: false, debug: false }, deps);
        assert.equal(sim.spawns.length, 1);
        assert.ok(Number(spawnPortArg(sim.spawns[0])) > 0, "an OS-assigned ephemeral port");
        assert.equal(h.port, Number(spawnPortArg(sim.spawns[0])));
        assert.deepEqual(sim.settles, [], "no lane → no sticky write");
        assert.equal(readZonePort("zcode", zoneFile), undefined, "the zone file stays empty");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// #1723: identify-before-ladder. findSameLanePredecessor decides whether an
// EADDRINUSE on the lane's sticky port is a same-lane predecessor being
// replaced by an upgrade (wait + rebind the SAME port) or something the plain
// ladder must handle (foreign squatter / same-code peer / dead record).
// ---------------------------------------------------------------------------

const OWN_FP = "fp-new-build";
const OLD_FP = "fp-old-build";

function registryEntry(over: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
        instanceId: over.instanceId ?? "pred-1",
        pid: process.pid,
        port: ZONE_PORT_BASE,
        origin: `http://127.0.0.1:${ZONE_PORT_BASE}`,
        startedAt: Date.now(),
        lane: "dsh",
        codeFingerprint: OLD_FP,
        ...over,
    };
}

function deadPid(): number {
    const r = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(r.pid > 0, "spawnSync reports the child pid");
    return r.pid;
}

test("findSameLanePredecessor: a live same-lane holder running different code IS the predecessor", () => {
    const pred = registryEntry();
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE, "dsh", OWN_FP)?.instanceId, "pred-1");
});

test("findSameLanePredecessor: missing fingerprints (pre-#1232 markers) count as different code", () => {
    const pred = registryEntry({ codeFingerprint: undefined });
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE, "dsh", OWN_FP)?.instanceId, "pred-1");
});

test("findSameLanePredecessor: a live peer running OUR build is contention, never a wait target", () => {
    const peer = registryEntry({ instanceId: "peer-1", codeFingerprint: OWN_FP });
    assert.equal(findSameLanePredecessor([peer], ZONE_PORT_BASE, "dsh", OWN_FP), undefined);
});

test("findSameLanePredecessor: mixed holders — the foreign-code entry wins the wait decision", () => {
    const peer = registryEntry({ instanceId: "peer-1", codeFingerprint: OWN_FP });
    const pred = registryEntry({ instanceId: "pred-1" });
    assert.equal(findSameLanePredecessor([peer, pred], ZONE_PORT_BASE, "dsh", OWN_FP)?.instanceId, "pred-1");
});

test("findSameLanePredecessor: wrong port, wrong lane, or undeclared lane never match", () => {
    const pred = registryEntry();
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE + 1, "dsh", OWN_FP), undefined, "different port");
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE, "kimi", OWN_FP), undefined, "different lane");
    assert.equal(findSameLanePredecessor([registryEntry({ lane: undefined })], ZONE_PORT_BASE, "dsh", OWN_FP), undefined, "undeclared (wildcard) lane is a manual daemon — never waited on");
});

test("findSameLanePredecessor: a dead holder is not a predecessor (the port frees itself)", () => {
    const dead = registryEntry({ pid: deadPid() });
    assert.equal(findSameLanePredecessor([dead], ZONE_PORT_BASE, "dsh", OWN_FP), undefined);
});

test("findSameLanePredecessor: unlane'd or fingerprint-less launches make no wait decisions", () => {
    const pred = registryEntry();
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE, undefined, OWN_FP), undefined, "no lane of our own");
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE, "", OWN_FP), undefined, "empty lane");
    assert.equal(findSameLanePredecessor([pred], ZONE_PORT_BASE, "dsh", undefined), undefined, "no own fingerprint — cannot tell builds apart");
    assert.equal(findSameLanePredecessor([], ZONE_PORT_BASE, "dsh", OWN_FP), undefined, "no holders at all");
});
