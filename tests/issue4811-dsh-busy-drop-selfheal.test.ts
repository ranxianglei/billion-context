// #4811: the dsh lane lost its proxy ~half the time to a three-part race:
//   1) probeLiveInstances dropped a BUSY candidate (health probe timed out,
//      TCP connect succeeded — the instance is alive, event loop saturated by
//      a large fold) identically to a DEAD one. Discovery then concluded
//      "nothing listening", spawned a second proxy, which hit EADDRINUSE,
//      exited with the twin-collision code, and the launcher paid a full
//      adoption round trip (7–27 s measured) while the client give-up wall
//      was 13.5 s — race lost 3/5 observed, session committed to direct
//      (uncompressed) traffic permanently. The spawned child had also opened
//      the shared index.db before its listen failed (#3923/#3959 two-writer
//      window).
//   2) bootstrap()'s catch logged the failure and returned undefined without
//      arming ANY retry driver — unlike every other degradation path
//      (ensureProxyRunning's 17-attempt listen loop, the registration
//      backoff, #4755's give-up re-arm), so one one-shot bootstrap failure
//      was terminal until a host restart (27 min dead lane in the field).
//   3) logHeadSample read a FIXED OFFSET 0 of the append-only per-port log
//      (rotated only at 5 MB), so "child output head" always showed the
//      oldest line ever written — in the reporter's environment a 2-day-old
//      EADDRINUSE from a previous build, actively misdirecting triage.
//
// This suite pins all three:
//   A) discovery — a BUSY same-lane / user-zone / laneless-initiator
//      candidate is ATTACHED (no spawn, no detour, no second writer); dead
//      and answered-not-ok candidates keep spawning; a BUSY declared
//      foreign-lane instance stays refused (its lifecycle is unverifiable
//      from this lane); a BUSY user-zone instance is skipped for a LANEd
//      initiator exactly like its healthy-unarmed sibling (#2877 parity).
//   B) the per-port log failure report samples THIS spawn's bytes, not the
//      oldest bytes in the file.
//   C) a one-shot bootstrap failure on a FRESH context self-heals through
//      the recovery timer alone (zero model traffic). Verified on unmodified
//      master: this contract already held via #2187's plan-time arming (a
//      fresh register is base-less AND !toolsReady, which even the old clear
//      condition spared) — the row is the regression net against THAT arming
//      being lost. The bootstrap-catch arm added by #4811 is defense-in-depth
//      at the point where the failure IS known; the field-case shape —
//      given-up (base-less + tools-ready) followed by further failures — is
//      pinned by tests/issue4755-dsh-giveup-selfheal.test.ts.

import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the modules loaded dynamically (same discipline as the #3654 suite).
process.env.NODE_TEST_CONTEXT = "1";
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4811-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const { entryScriptFingerprint } = await import("../src/instance.ts");
const { ensureProxyRunning } = await import("../src/launcher.ts");
const dsh = await import("../src/agent/dsh-native.ts");
import type { ProxyInstanceFile } from "../src/instance.ts";
import type { SpawnChild } from "../src/launcher.ts";
import { rmrf } from "./tmp-rm.ts";

afterEach(() => { void dsh._settleNativeForTest(); });

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-4811-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP = entryScriptFingerprint(FP_SCRIPT);
assert.ok(FP !== undefined, "fixture script must fingerprint");

const TWIN_ORIGIN = "http://127.0.0.1:18916";

function tmpHome(): { dir: string; restore: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4811-home-"));
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

/** lane undefined → user-zone instance (manual `bili start` shape: no lane
 *  declaration, no launch token). */
function twinInstance(lane?: string): ProxyInstanceFile {
    return {
        origin: TWIN_ORIGIN,
        instanceId: "inst-4811",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18916,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        ...(lane !== undefined ? { lane } : {}),
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

interface BringUpRow {
    inst: ProxyInstanceFile | undefined;
    /** health answer for the twin origin: undefined = probe timed out (silent) */
    health: { ok: boolean; watchdog?: { armed: boolean } } | undefined;
    /** TCP connectability of the twin origin while the probe is silent */
    connectable: boolean;
    /** initiator lane; undefined = lane-less hook */
    initiatorLane?: string;
}

interface BringUpResult {
    handle: Awaited<ReturnType<typeof ensureProxyRunning>> | undefined;
    err: Error | undefined;
    spawnCalls: number;
    diag: string[];
}

async function bringUp(row: BringUpRow): Promise<BringUpResult> {
    let spawnCalls = 0;
    const diag: string[] = [];
    const clock = fakeClock();
    const pending = ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, ...(row.initiatorLane !== undefined ? { lane: row.initiatorLane } : {}) },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) => (origin === TWIN_ORIGIN ? row.health : undefined),
            readInstanceFile: () => row.inst,
            listRegistryInstances: () => [],
            spawnImpl: (_cmd: string, _args: readonly string[]): SpawnChild => {
                spawnCalls++;
                return fakeChildExitting(1);
            },
            now: clock.now,
            sleep: clock.sleep,
            registerWatcher: async () => "ok",
            attachDiag: (msg) => { diag.push(msg); },
            scriptPath: FP_SCRIPT,
            listAdoptCandidates: () => [],
            isConnectable: async () => row.connectable,
        },
    );
    const [handle, err] = await Promise.all([
        pending.then((h) => h, () => undefined),
        pending.then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ]);
    return { handle, err, spawnCalls, diag };
}

// ———— A) discovery: BUSY retention vs dead/not-ok/foreign/user-zone skips —

test("A1: a BUSY same-lane instance is attached, not dropped-and-respawned (#4811 §1)", async () => {
    const home = tmpHome();
    try {
        const { handle, err, spawnCalls, diag } = await bringUp({
            inst: twinInstance("dsh"),
            health: undefined,
            connectable: true,
            initiatorLane: "dsh",
        });
        assert.equal(err, undefined, `must attach, not fail: ${err?.message}`);
        assert.equal(handle?.attached, true, "the saturated daemon IS the lane's proxy — attach to it");
        assert.equal(handle?.origin, TWIN_ORIGIN);
        assert.equal(spawnCalls, 0, "no second writer: the whole point of keeping the BUSY candidate");
        assert.ok(diag.some((d) => d.includes("keep") && d.includes("BUSY")), "the keep decision must be diagnosable");
    } finally {
        home.restore();
    }
});

test("A2: a BUSY user-zone instance is attached for a lane-less initiator (#1660 parity)", async () => {
    const home = tmpHome();
    try {
        const { handle, err, spawnCalls } = await bringUp({
            inst: twinInstance(),
            health: undefined,
            connectable: true,
        });
        assert.equal(err, undefined, `must attach, not fail: ${err?.message}`);
        assert.equal(handle?.attached, true);
        assert.equal(spawnCalls, 0);
    } finally {
        home.restore();
    }
});

test("A3: a genuinely DEAD instance keeps dropping and spawning (negative gate)", async () => {
    const home = tmpHome();
    try {
        const { handle, err, spawnCalls, diag } = await bringUp({
            inst: twinInstance("dsh"),
            health: undefined,
            connectable: false,
            initiatorLane: "dsh",
        });
        assert.equal(handle, undefined);
        assert.match(err?.message ?? "", /code 1/, "the spawned child's plain crash surfaces as before");
        assert.equal(spawnCalls, 1, "dead means dead — discovery must still spawn");
        assert.ok(diag.some((d) => d.includes("health probe failed")), "the drop must stay diagnosable as dead");
    } finally {
        home.restore();
    }
});

test("A4: an instance that ANSWERS not-ok keeps dropping and spawning (draining ≠ busy)", async () => {
    const home = tmpHome();
    try {
        const { handle, err, spawnCalls, diag } = await bringUp({
            inst: twinInstance("dsh"),
            health: { ok: false },
            connectable: true,
            initiatorLane: "dsh",
        });
        assert.equal(handle, undefined);
        assert.match(err?.message ?? "", /code 1/);
        assert.equal(spawnCalls, 1);
        assert.ok(diag.some((d) => d.includes("answered but reports not-ok")), "an explicit not-ok answer is a drain signal, not saturation");
    } finally {
        home.restore();
    }
});

test("A5: a BUSY declared foreign-lane instance stays refused (lifecycle unverifiable)", async () => {
    const home = tmpHome();
    try {
        const { handle, err, spawnCalls, diag } = await bringUp({
            inst: twinInstance("pi"),
            health: undefined,
            connectable: true,
        });
        assert.equal(handle, undefined);
        assert.match(err?.message ?? "", /code 1/);
        assert.equal(spawnCalls, 1, "refusal falls through to the normal spawn ladder");
        assert.ok(diag.some((d) => d.includes("refusing to attach") && d.includes("BUSY")), "the refusal must name the reason");
    } finally {
        home.restore();
    }
});

test("A6: a BUSY user-zone instance is skipped for a LANEd initiator (#2877 own-lane parity)", async () => {
    const home = tmpHome();
    try {
        const { handle, err, spawnCalls, diag } = await bringUp({
            inst: twinInstance(),
            health: undefined,
            connectable: true,
            initiatorLane: "dsh",
        });
        assert.equal(handle, undefined);
        assert.match(err?.message ?? "", /code 1/);
        assert.equal(spawnCalls, 1);
        assert.ok(diag.some((d) => d.includes("not own lane")), "same skip class as the healthy-unarmed sibling — no new fallback opened");
    } finally {
        home.restore();
    }
});

// ———— B) per-port log sampling: THIS spawn's bytes, not the oldest ————————

test("B: the failure report samples this spawn's output, not offset 0 of a rotated history (#4811 §4)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4811-tmp-"));
    const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const home = tmpHome();
    // grab a real port and release it: deterministic occupancy without assuming
    // a fixed range is free (#360)
    const holder = net.createServer();
    await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.listen(0, "127.0.0.1", () => resolve()); });
    const port = (holder.address() as AddressInfo).port;
    await new Promise<void>((r) => holder.close(() => r()));
    process.env.TMPDIR = dir;
    process.env.TEMP = dir;
    process.env.TMP = dir;
    const oldNoise = "OLD NOISE two-day-old EADDRINUSE from a previous build\n".repeat(40);
    const logPath = path.join(dir, `bili-proxy-${port}.log`);
    fs.writeFileSync(logPath, oldNoise);
    try {
        assert.equal(dir, os.tmpdir(), "os.tmpdir() must follow the override on this platform");
        let spawnCalls = 0;
        const pending = ensureProxyRunning(
            { host: "127.0.0.1", port, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => undefined,
                readInstanceFile: () => undefined,
                listRegistryInstances: () => [],
                spawnImpl: (_cmd: string, _args: readonly string[]): SpawnChild => {
                    spawnCalls++;
                    fs.appendFileSync(logPath, "NEW LINE from child 4811\n");
                    return fakeChildExitting(1);
                },
                now: () => Date.now(),
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                registerWatcher: async () => "ok",
                attachDiag: () => {},
                scriptPath: FP_SCRIPT,
                listAdoptCandidates: () => [],
                isConnectable: async () => false,
            },
        );
        const err = await pending.then(() => undefined, (e: unknown) => e);
        assert.ok(err instanceof Error, "the crashed child must still fail the bring-up");
        assert.equal(spawnCalls, 1);
        assert.match(err.message, /child output head: "[^"]*NEW LINE from child 4811/, "this spawn's bytes must be what triage sees");
        assert.doesNotMatch(err.message, /OLD NOISE/, "offset-0 sampling would surface the oldest line ever written");
        // zero-output edge (#4811 §4 subcase): a child that dies before writing a
        // byte must not be reported with the PREVIOUS spawn's tail as its head
        let secondSpawnCalls = 0;
        const pending2 = ensureProxyRunning(
            { host: "127.0.0.1", port, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => undefined,
                readInstanceFile: () => undefined,
                listRegistryInstances: () => [],
                spawnImpl: (_cmd: string, _args: readonly string[]): SpawnChild => {
                    secondSpawnCalls++;
                    return fakeChildExitting(1);
                },
                now: () => Date.now(),
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                registerWatcher: async () => "ok",
                attachDiag: () => {},
                scriptPath: FP_SCRIPT,
                listAdoptCandidates: () => [],
                isConnectable: async () => false,
            },
        );
        const err2 = await pending2.then(() => undefined, (e: unknown) => e);
        assert.ok(err2 instanceof Error, "the silent child must still fail the bring-up");
        assert.equal(secondSpawnCalls, 1);
        assert.match(err2.message, /this child appended nothing of its own/, "a zero-output child must be said so, not quoted from history");
        assert.doesNotMatch(err2.message, /OLD NOISE|NEW LINE/, "an earlier spawn's bytes must never be quoted as this child's output");
    } finally {
        for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        home.restore();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ———— C) one-shot bootstrap failure self-heals (fresh context, zero traffic) —

type MockTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

function mockBiliHandler(counters: { manifestRequests: number }): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    const manifestTools: MockTool[] = [
        {
            name: "compress",
            description: "Compress a range of messages",
            inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
        },
    ];
    return (req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            counters.manifestRequests += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

async function startMockProxy(): Promise<{ origin: string; close: () => void; manifestRequests: () => number }> {
    const counters = { manifestRequests: 0 };
    const server = http.createServer(mockBiliHandler(counters));
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close(), manifestRequests: () => counters.manifestRequests });
        });
    });
}

type HostCtx = Parameters<typeof dsh.apply>[0];

function mockCtx() {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: {
            register: (t: RegisteredTool) => { tools.push(t); },
        },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test("C: a one-shot bootstrap failure on a fresh context self-heals through the recovery driver (#4811 §2)", async () => {
    const proxy2 = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-4811-bootstrap-"));
    try {
        await withEnv({
            DSH_HOME: home,
            BILLION_CONTEXT_PROXY: undefined,
            BILLION_CONTEXT_ATTACH: undefined,
            BILI_DSH_RECOVERY_INTERVAL_MS: "20",
            BILI_DSH_RETRY_INTERVAL_MS: "20",
        }, async () => {
            dsh._resetRegisterForTest(undefined);
            let attempts = 0;
            // the field case: the FIRST bring-up loses (EADDRINUSE behind a
            // saturated incumbent), later ones win. Two consecutive one-shot
            // failures must be absorbed, not terminal.
            dsh._setSpawnForTest(() => {
                attempts += 1;
                return attempts < 3
                    ? Promise.reject(new Error("listen failed: EADDRINUSE (simulated one-shot bootstrap failure)"))
                    : Promise.resolve(proxy2.origin);
            });
            try {
                const ctx = mockCtx();
                dsh.apply(ctx);
                await waitFor(
                    () => dsh._registerStateForTest().base === proxy2.origin && ctx.registeredTools.length === 1,
                    "timer-driven re-base onto the replacement plus tool registration",
                );
                assert.equal(dsh._nativeStateForTest().origin, proxy2.origin, "interceptor origin follows the healed base");
                assert.ok(attempts >= 3, "the two one-shot failures were absorbed by retries, not fatal");
                // churn pin: once healthy again the timer must clear itself —
                // neither respawns nor re-registrations may follow
                const settledManifest = proxy2.manifestRequests();
                const settledAttempts = attempts;
                await new Promise((r) => setTimeout(r, 150));
                assert.equal(attempts, settledAttempts, "no background respawn churn after the heal");
                assert.equal(proxy2.manifestRequests(), settledManifest, "no background re-registration after the heal (#3380: registrations survive)");
            } finally {
                dsh._setSpawnForTest(undefined);
            }
        });
    } finally {
        proxy2.close();
        rmrf(home);
        dsh._resetRegisterForTest(undefined);
    }
});
