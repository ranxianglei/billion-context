// #3654: under load a 1.5s health probe times out against a LIVE proxy whose
// event loop is inside a large compression; the old two-state probe read that
// as death, dropped the origin, respawned into the same process (twin-
// collision exit), and oversized sessions were then refused locally (#3308).
// This suite pins the three-state contract end to end:
//   A) probeLiveness — connect-refused = dead (fast), connect-but-silent =
//      busy, payload-validated alive;
//   B) createLiveOriginResolver — busy HELD origins are held through a bounded
//      jittered wait window (never dropped, never cached), dead stays an
//      instant fast path, busy replacements are routed to anyway, and the
//      refusal reason records busy-exhausted vs dead;
//   C) ensureProxyRunning — a twin-collision child (exit code 3) leads to
//      adoption of the serving instance instead of a failed bring-up;
//   D) eaddrinuseExitCode — only twin-collision maps to the adopt signal;
//   E) writeSpawnPortLog — the per-port log the failure message points at is
//      actually written for spawner children (#3116's 0-byte dead end);
//   F) refusal wording — busy-exhausted must not claim "proxy unavailable …
//      guaranteed upstream 400" (owner requirement 5).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { after } from "node:test";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the modules loaded dynamically.
process.env.NODE_TEST_CONTEXT = "1";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3654-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const { probeLiveness, tcpConnectable } = await import("../src/liveness.ts");
const { decideEaddrinuse, eaddrinuseExitCode, TWIN_ADOPT_EXIT_CODE } = await import("../src/listen-policy.ts");
const { writeSpawnPortLog } = await import("../src/instance.ts");
const { createLiveOriginResolver } = await import("../src/agent/native-intercept.ts");
import type { LivenessVerdict } from "../src/liveness.ts";
import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2State } from "../src/agent/opencode-v2.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { entryScriptFingerprint } from "../src/instance.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

function listenPort(server: net.Server | http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
}

async function withServer<T>(make: (server: net.Server) => void, fn: (origin: string, server: net.Server) => Promise<T>): Promise<T> {
    const server = net.createServer();
    // Destroy tracked connections on teardown: a paused (never-answered)
    // socket would otherwise hold server.close()'s callback hostage.
    const conns = new Set<net.Socket>();
    server.on("connection", (s) => { conns.add(s); s.on("close", () => conns.delete(s)); });
    make(server);
    const port = await listenPort(server);
    try {
        return await fn(`http://127.0.0.1:${port}`, server);
    } finally {
        for (const s of conns) s.destroy();
        conns.clear();
        await new Promise<void>((r) => server.close(() => r()));
    }
}

// ———— A) probeLiveness ————————————————————————————————————————————————

test("A: healthy bili proxy answers → alive", async () => {
    await withServer(() => {}, async (origin) => {
        const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
        const port = await listenPort(srv);
        try {
            const v = await probeLiveness(`http://127.0.0.1:${port}`, 1_000);
            assert.equal(v.state, "alive");
        } finally {
            await new Promise<void>((r) => srv.close(() => r()));
        }
    });
});

test("A: refused connection classifies dead in milliseconds (fast path unchanged)", async () => {
    // Grab a real port, release it, probe it: ECONNREFUSED on loopback.
    const holder = net.createServer();
    const port = await listenPort(holder);
    await new Promise<void>((r) => holder.close(() => r()));
    const t0 = Date.now();
    const v = await probeLiveness(`http://127.0.0.1:${port}`, 5_000);
    const elapsed = Date.now() - t0;
    assert.equal(v.state, "dead");
    assert.match(v.detail ?? "", /ECONNREFUSED|ECONNRESET|connect/i);
    assert.ok(elapsed < 1_000, `refused-connect must not pay the HTTP budget (took ${elapsed}ms)`);
});

test("A: connected but silent under the budget → busy (the #3654 signature)", async () => {
    await withServer((s) => s.on("connection", (socket) => socket.pause()), async (origin) => {
        const t0 = Date.now();
        const v = await probeLiveness(origin, 300);
        const elapsed = Date.now() - t0;
        assert.equal(v.state, "busy");
        assert.match(v.detail ?? "", /no health answer within 300ms/);
        assert.ok(elapsed >= 250, `the budget must actually elapse before calling it busy (took ${elapsed}ms)`);
    });
});

test("A: foreign 200 HTML is not a healthy bili proxy → dead", async () => {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>hello</html>"); });
    const port = await listenPort(srv);
    try {
        const v = await probeLiveness(`http://127.0.0.1:${port}`, 1_000);
        assert.equal(v.state, "dead");
        assert.match(v.detail ?? "", /non-JSON/);
    } finally {
        await new Promise<void>((r) => srv.close(() => r()));
    }
});

test("A: JSON health reporting ok:false → dead", async () => {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false })); });
    const port = await listenPort(srv);
    try {
        const v = await probeLiveness(`http://127.0.0.1:${port}`, 1_000);
        assert.equal(v.state, "dead");
        assert.match(v.detail ?? "", /not-ok/);
    } finally {
        await new Promise<void>((r) => srv.close(() => r()));
    }
});

test("A: tcpConnectable sees through a saturated loop (accept queue answers)", async () => {
    await withServer((s) => s.on("connection", (socket) => socket.pause()), async (origin) => {
        assert.equal(await tcpConnectable(origin, 500), true, "a blocked-loop listener still accepts TCP");
    });
    const holder = net.createServer();
    const port = await listenPort(holder);
    await new Promise<void>((r) => holder.close(() => r()));
    assert.equal(await tcpConnectable(`http://127.0.0.1:${port}`, 500), false);
});

// ———— B) createLiveOriginResolver —————————————————————————————————————

type VerdictOrBool = LivenessVerdict | boolean;

function scriptedProbe(script: VerdictOrBool[], byOrigin?: (o: string, i: number) => VerdictOrBool): { probe: (o: string) => Promise<VerdictOrBool>; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    return {
        calls,
        probe: async (o) => {
            calls.push(o);
            const v = byOrigin !== undefined ? byOrigin(o, i) : script[Math.min(i, script.length - 1)];
            i++;
            return v;
        },
    };
}

const BUSY: LivenessVerdict = { state: "busy", detail: "no health answer within 1500ms after TCP connect" };
const DEAD: LivenessVerdict = { state: "dead", detail: "ECONNREFUSED" };
const ALIVE: LivenessVerdict = { state: "alive" };

test("B: busy held origin recovers inside the window — no drop, no respawn, no cache solidification", async () => {
    const HELD = "http://127.0.0.1:18901";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; return undefined; },
    };
    // TTL far above the episode: if BUSY were ever cached, every re-probe in
    // the window would hit the cache and recovery below would be impossible.
    const { probe, calls } = scriptedProbe([BUSY, ALIVE]);
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, busyWaitCapMs: 400, busyReprobeBaseMs: 40 });
    const t0 = Date.now();
    const got = await resolve();
    const elapsed = Date.now() - t0;
    assert.equal(got, HELD, "the held origin must survive its own busy episode");
    assert.equal(respawnCalls, 0, "a busy origin must never trigger a respawn");
    assert.equal(calls.length, 2, "first probe busy, one re-probe alive");
    assert.ok(elapsed < 400 + 200, `recovery must land inside the window (took ${elapsed}ms)`);
    // Second call immediately: the ALIVE verdict IS cached → zero raw probes.
    const before = calls.length;
    assert.equal(await resolve(), HELD);
    assert.equal(calls.length, before, "alive verdicts stay TTL-cached (only busy is uncached)");
});

test("B: busy exhaustion lets go, respawns, and adopts the replacement", async () => {
    const HELD = "http://127.0.0.1:18902";
    const REPL = "http://127.0.0.1:18903";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; state.origin = REPL; return REPL; },
    };
    const { probe } = scriptedProbe([], (o) => (o === HELD ? BUSY : ALIVE));
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, busyWaitCapMs: 200, busyReprobeBaseMs: 30 });
    const got = await resolve();
    assert.equal(got, REPL, "the replacement must be adopted after the window");
    assert.equal(respawnCalls, 1);
    assert.equal(state.lastUnavailableReason, undefined, "success clears the refusal reason");
});

test("B: a busy REPLACEMENT is routed to anyway — the request queues behind the fold", async () => {
    const HELD = "http://127.0.0.1:18904";
    const REPL = "http://127.0.0.1:18905";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; state.origin = REPL; return REPL; },
    };
    const { probe } = scriptedProbe([], () => BUSY);
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, busyWaitCapMs: 150, busyReprobeBaseMs: 30 });
    const got = await resolve();
    assert.equal(got, REPL, "refusing a live-but-busy replacement would fail the request the adoption exists to save");
    assert.equal(respawnCalls, 1);
    assert.equal(state.lastUnavailableReason, undefined);
});

test("B: busy exhaustion with a dead replacement refuses and records busy-exhausted", async () => {
    const HELD = "http://127.0.0.1:18906";
    const REPL = "http://127.0.0.1:18907";
    let giveUps = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { state.origin = REPL; return REPL; },
        onGiveUp: () => { giveUps++; },
    };
    const { probe } = scriptedProbe([], (o) => (o === HELD ? BUSY : DEAD));
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, busyWaitCapMs: 150, busyReprobeBaseMs: 30, respawnCooldownMs: 60_000 });
    const got = await resolve();
    assert.equal(got, undefined);
    assert.equal(state.lastUnavailableReason, "busy-exhausted", "the refusal wording depends on this distinction");
    assert.equal(giveUps, 1);
});

test("B: dead verdict keeps the instant fast path (no busy window paid)", async () => {
    const HELD = "http://127.0.0.1:18908";
    const REPL = "http://127.0.0.1:18909";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; state.origin = REPL; return REPL; },
    };
    const { probe } = scriptedProbe([], (o) => (o === HELD ? DEAD : ALIVE));
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, busyWaitCapMs: 30_000, busyReprobeBaseMs: 1_000 });
    const t0 = Date.now();
    const got = await resolve();
    const elapsed = Date.now() - t0;
    assert.equal(got, REPL);
    assert.equal(respawnCalls, 1);
    assert.ok(elapsed < 500, `a refused connection must not pay any wait window (took ${elapsed}ms)`);
});

test("B: dead verdicts stay TTL-cached across callers", async () => {
    const HELD = "http://127.0.0.1:18910";
    const REPL = "http://127.0.0.1:18911";
    let respawnCalls = 0;
    // The respawn deliberately does NOT claim state.origin: a respawn that
    // does makes the next call re-own the dead replacement and take the
    // ownedThenLost path (which bypasses the cooldown BY DESIGN), so the
    // cache could never be observed.
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; return REPL; },
    };
    const { probe, calls } = scriptedProbe([DEAD]);
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, respawnCooldownMs: 60_000 });
    assert.equal(await resolve(), undefined);
    // Second call: no held origin, cooldown blocks a second respawn, and the
    // replacement's dead verdict comes straight from the TTL cache.
    assert.equal(await resolve(), undefined);
    assert.equal(respawnCalls, 1);
    assert.equal(calls.length, 2, `held-dead + replacement-dead, then cache hits only (got ${calls.length} raw probes)`);
    assert.equal(state.lastUnavailableReason, "bootstrap-failed");
});

test("B: concurrent callers share one respawn when the held origin dies (#1957)", async () => {
    const HELD = "http://127.0.0.1:18912";
    const REPL = "http://127.0.0.1:18913";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; state.origin = REPL; return REPL; },
    };
    const { probe } = scriptedProbe([], (o) => (o === HELD ? DEAD : ALIVE));
    const resolve = createLiveOriginResolver(state, { probe, probeTtlMs: 1_000, respawnCooldownMs: 60_000 });
    const [a, b] = await Promise.all([resolve(), resolve()]);
    assert.equal(a, REPL);
    assert.equal(b, REPL);
    assert.equal(respawnCalls, 1, "both callers must ride the single shared respawn");
});

test("B: legacy boolean probes still map (true→alive, false→dead)", async () => {
    const HELD = "http://127.0.0.1:18914";
    const REPL = "http://127.0.0.1:18915";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin: HELD,
        ready: Promise.resolve(undefined),
        respawn: async () => { respawnCalls++; state.origin = REPL; return REPL; },
    };
    const resolve = createLiveOriginResolver(state, { probe: async (o) => o !== HELD, probeTtlMs: 1_000 });
    assert.equal(await resolve(), REPL);
    assert.equal(respawnCalls, 1);
});

// ———— C) ensureProxyRunning twin adoption ————————————————————————————————

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-3654-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP = entryScriptFingerprint(FP_SCRIPT);
assert.ok(FP !== undefined, "fixture script must fingerprint");

const TWIN_ORIGIN = "http://127.0.0.1:18916";

function tmpHome(): { dir: string; restore: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3654-home-"));
    const prevCfg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    process.env.XDG_STATE_HOME = dir;
    return {
        dir,
        restore: () => {
            if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
            if (prevState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevState;
        },
    };
}

function twinInstance(lane: string): ProxyInstanceFile {
    return {
        origin: TWIN_ORIGIN,
        instanceId: "inst-3654",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18916,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        lane,
        codeFingerprint: FP,
    };
}

function fakeChildExitting(code: number | null): SpawnChild {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
        pid: 42_470,
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

interface BringUpResult {
    handle: Awaited<ReturnType<typeof ensureProxyRunning>>;
    spawnCalls: number;
    diag: string[];
}

async function bringUp3654(twin: ProxyInstanceFile | undefined, exitCode: number | null): Promise<BringUpResult> {
    let spawnCalls = 0;
    const diag: string[] = [];
    const clock = fakeClock();
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "dsh" },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) => (origin === TWIN_ORIGIN ? { ok: true, watchdog: { armed: true } } : undefined),
            readInstanceFile: () => undefined,
            listRegistryInstances: () => [],
            spawnImpl: (_cmd: string, _args: readonly string[]): SpawnChild => {
                spawnCalls++;
                return fakeChildExitting(exitCode);
            },
            now: clock.now,
            sleep: clock.sleep,
            registerWatcher: async () => "ok",
            attachDiag: (msg) => { diag.push(msg); },
            scriptPath: FP_SCRIPT,
            listAdoptCandidates: () => (twin !== undefined ? [twin] : []),
            isConnectable: async () => true,
        },
    );
    return { handle, spawnCalls, diag };
}

test("C: twin-collision exit adopts the serving instance instead of failing", async () => {
    const home = tmpHome();
    try {
        const { handle, spawnCalls, diag } = await bringUp3654(twinInstance("dsh"), TWIN_ADOPT_EXIT_CODE);
        assert.equal(spawnCalls, 1, "the spawn happened and lost the race");
        assert.equal(handle.attached, true, "adoption rides the normal attach path");
        assert.equal(handle.origin, TWIN_ORIGIN);
        assert.ok(diag.some((d) => d.includes("adopting serving twin")), "adoption must be announced");
    } finally {
        home.restore();
    }
});

test("C: twin-collision with nothing adoptable keeps the original failure (code 3 named)", async () => {
    const home = tmpHome();
    try {
        const pending = bringUp3654(undefined, TWIN_ADOPT_EXIT_CODE);
        await assert.rejects(pending, /code 3 \(twin-collision signal\)/);
    } finally {
        home.restore();
    }
});

test("C: a foreign-lane instance is never adopted", async () => {
    const home = tmpHome();
    try {
        const pending = bringUp3654(twinInstance("pi"), TWIN_ADOPT_EXIT_CODE);
        await assert.rejects(pending, /code 3 \(twin-collision signal\)/);
    } finally {
        home.restore();
    }
});

test("C: a plain crash (exit 1) does NOT take the adoption path", async () => {
    const home = tmpHome();
    try {
        const pending = bringUp3654(twinInstance("dsh"), 1);
        await assert.rejects(pending, /code 1/);
        // The rejection alone cannot show adoption was skipped — run again
        // capturing diagnostics through a resolved wrapper is overkill; the
        // code-1 message lacking the twin suffix pins the branch selection.
    } finally {
        home.restore();
    }
});

// ———— D) eaddrinuseExitCode ————————————————————————————————————————————

const baseCtx = {
    upgradeReplacement: false,
    launchToken: true,
    strictPort: false,
    attempts: 1,
    maxAttempts: 17,
    predecessorTicksLeft: 0,
    predecessorHolds: false,
    lastTriedPort: 18917,
};

test("D: only twin-collision maps to the adopt signal; every other terminal decision exits 1", () => {
    assert.equal(TWIN_ADOPT_EXIT_CODE, 3);
    const twin = decideEaddrinuse({ ...baseCtx, twinHolds: true });
    assert.deepEqual(twin, { kind: "fail-fast", reason: "twin-collision" });
    assert.equal(eaddrinuseExitCode("twin-collision"), 3);
    const strict = decideEaddrinuse({ ...baseCtx, twinHolds: false, strictPort: true });
    assert.equal(strict.kind === "fail-fast" ? strict.reason : undefined, "strict-port");
    assert.equal(eaddrinuseExitCode("strict-port"), 1);
    const busy = decideEaddrinuse({ ...baseCtx, twinHolds: false, launchToken: false });
    assert.equal(busy.kind === "fail-fast" ? busy.reason : undefined, "port-busy");
    assert.equal(eaddrinuseExitCode("port-busy"), 1);
    const upgrade = decideEaddrinuse({ ...baseCtx, twinHolds: false, upgradeReplacement: true });
    assert.equal(upgrade.kind === "fail-fast" ? upgrade.reason : undefined, "upgrade-replacement");
    assert.equal(eaddrinuseExitCode("upgrade-replacement"), 1);
    assert.equal(eaddrinuseExitCode(undefined), 1, "non-terminal decisions carry no exit code");
});

// ———— E) writeSpawnPortLog ——————————————————————————————————————————————

test("E: spawner children write their listen failure into the per-port log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3654-tmp-"));
    const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = dir;
    process.env.TEMP = dir;
    process.env.TMP = dir;
    try {
        assert.equal(dir, os.tmpdir(), "os.tmpdir() must follow the override on this platform");
        writeSpawnPortLog(18918, "2026-10-18T00:00:00.000Z [error] [v=test] listen failed: EADDRINUSE address in use: :::18918");
        const file = path.join(dir, "bili-proxy-18918.log");
        assert.ok(fs.existsSync(file), "the file the failure message points at must exist");
        assert.match(fs.readFileSync(file, "utf8"), /listen failed: EADDRINUSE/);
    } finally {
        for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ———— F) refusal wording ————————————————————————————————————————————————

const MODEL_URL = "https://api.anthropic.com/v1/messages";

test("F: busy-exhausted refusal says 'alive but unresponsive', never 'guaranteed upstream 400'", async () => {
    const { createNativeRoute } = await import("../src/agent/opencode-native.ts");
    const HELD = "http://127.0.0.1:18919";
    const state: NativeInterceptState = { origin: HELD, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, {
        probe: async () => ({ state: "busy" as const }),
        probeTtlMs: 500,
        busyWaitCapMs: 120,
        busyReprobeBaseMs: 20,
    });
    const s: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
    const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
    const e = {
        sessionID: "ses_busy",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
    };
    const err = await route(e, s).then(() => undefined, (x: unknown) => x);
    assert.ok(err instanceof Error, "oversize body must be refused locally");
    assert.match(err.message, /alive but unresponsive/);
    assert.doesNotMatch(err.message, /proxy unavailable/, "a saturated proxy is not 'unavailable'");
    assert.doesNotMatch(err.message, /guaranteed upstream 400/, "it would serve the request once the fold finishes");
    assert.equal(state.lastUnavailableReason, "busy-exhausted");
});

test("F: a genuinely dead proxy keeps the legacy refusal wording byte-for-byte", async () => {
    const { createNativeRoute } = await import("../src/agent/opencode-native.ts");
    const HELD = "http://127.0.0.1:18920";
    const state: NativeInterceptState = { origin: HELD, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => false, probeTtlMs: 500 });
    const s: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
    const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
    const e = {
        sessionID: "ses_dead",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
    };
    const err = await route(e, s).then(() => undefined, (x: unknown) => x);
    assert.ok(err instanceof Error);
    assert.match(err.message, /bili: proxy unavailable and this request cannot be sent uncompressed/);
    assert.match(err.message, /Recovery is automatic \(#3308\)/);
    assert.equal(state.lastUnavailableReason, "dead");
});

test("F: an under-window body still goes direct when nothing is routable (fail-open unchanged)", async () => {
    const { createNativeRoute } = await import("../src/agent/opencode-native.ts");
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => ({ state: "busy" as const }), probeTtlMs: 500, busyWaitCapMs: 100, busyReprobeBaseMs: 20 });
    const s: V2State = { windows: new Map([["prov/model-x", 1_000_000]]) };
    const body = JSON.stringify({ messages: [{ role: "user", content: "small" }] });
    const e = {
        sessionID: "ses_small",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
    };
    await route(e, s);
    assert.equal(s.proxyBase, undefined, "direct send — no proxy target pinned");
});
