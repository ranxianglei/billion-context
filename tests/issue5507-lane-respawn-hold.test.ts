// #5507 Q4: every self-spawning native lane must hold a model request racing an
// IN-FLIGHT launcher spawn out to the launcher's own bring-up budget instead of
// degrading at the generic 15s readiness cap. pi carried this seam since #4516
// (its #4515 report); dsh/omp/opencode held only the 15s cap while their spawn
// budget was 60s, so a slow cold start refused (422 oversize) or direct-sent a
// turn the sanctioned bring-up would have served. The intercept-side wait-budget
// mechanism is pinned in tests/issue4516-pi-direct-fallback.test.ts; this suite
// pins the LANE arming: each launcher-spawn transition arms
// state.spawnWaitMs = SPAWN_BUDGET_MS + margin, and a healthy attach never does.
// It also pins the RESOLVER-side consumption: OpenCode 2.x model traffic resolves
// through createLiveOriginResolver, which must honor the armed budget too —
// without that read the hold never applied to opencode's primary path.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { SPAWN_BUDGET_MS } from "../src/launcher.js";
import { apply as dshApply, _resetRegisterForTest as dshReset, _setSpawnForTest as dshSetSpawn, _settleNativeForTest as dshSettle, _spawnWaitMsForTest as dshHold, _nativeStateForTest as dshNativeState } from "../src/agent/dsh-native.ts";
import { planNativeOmp, armNativeOmp, _resetNativeStateForTest as ompReset, _setSpawnForTest as ompSetSpawn, _spawnWaitMsForTest as ompHold, _nativeStateForTest as ompNativeState } from "../src/agent/omp-native.ts";
import { planNativeOpencode, armNativeOpencode, _resetNativeStateForTest as ocReset, _setSpawnForTest as ocSetSpawn, _spawnWaitMsForTest as ocHold, _nativeStateForTest as ocNativeState } from "../src/agent/opencode-native.ts";
import { planNativePi, armNativePi, _resetNativeStateForTest as piReset, _setSpawnForTest as piSetSpawn, _spawnWaitMsForTest as piHold, _nativeStateForTest as piNativeState } from "../src/agent/pi-native.ts";
import { createLiveOriginResolver, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { rmrf } from "./tmp-rm.ts";

delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

afterEach(() => { void dshSettle(); });

const HOLD_BUDGET_MS = SPAWN_BUDGET_MS + 10_000;

type HostCtx = Parameters<typeof dshApply>[0];

function mockCtx(): HostCtx {
    const tools: unknown[] = [];
    const commands: unknown[] = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: { register: (t: unknown) => { tools.push(t); } },
        commands: { register: (c: unknown) => { commands.push(c); } },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    } as HostCtx;
}

// A mock proxy answering the version probe with a build newer than any release,
// so dsh's stale-build rotation path (#5167) cannot fire in the healthy cases.
function mockBiliHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "999.0.0", tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }] } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

async function startMockProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer(mockBiliHandler());
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

// An origin whose listener is already gone: the version probe fails instantly.
async function deadOrigin(): Promise<string> {
    const server = http.createServer(() => {});
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            server.close(() => resolve(`http://127.0.0.1:${addr.port}`));
        });
    });
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
    }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

type Lane = {
    name: string;
    reset: () => void;
    setSpawn: (fn?: () => Promise<string | undefined>) => void;
    hold: () => number | undefined;
    arm: (ctx: HostCtx) => void;
    nativeState: () => { origin?: string };
};

const LANES: Lane[] = [
    { name: "dsh", reset: dshReset, setSpawn: dshSetSpawn, hold: dshHold, arm: (ctx) => dshApply(ctx), nativeState: dshNativeState },
    { name: "omp", reset: ompReset, setSpawn: ompSetSpawn, hold: ompHold, arm: () => armNativeOmp(planNativeOmp(process.env)), nativeState: ompNativeState },
    { name: "opencode", reset: ocReset, setSpawn: ocSetSpawn, hold: ocHold, arm: () => armNativeOpencode(planNativeOpencode(process.env, false)), nativeState: ocNativeState },
    { name: "pi", reset: piReset, setSpawn: piSetSpawn, hold: piHold, arm: () => armNativePi(planNativePi(process.env, false)), nativeState: piNativeState },
];

const CLEAN_LANED_ENV: Record<string, string | undefined> = {
    BILLION_CONTEXT_ATTACH: undefined,
    BILI_PI_INLINE: undefined,
    BILI_OPENCODE_INLINE: undefined,
    BILI_PROVIDER_REWRITES: undefined,
    BILLION_CONTEXT_PLUGIN: undefined,
    BILI_NATIVE_DSH: undefined,
    BILI_NATIVE_OMP: undefined,
    BILI_NATIVE_OPENCODE: undefined,
    BILI_NATIVE_PI: undefined,
    // shrink the routed-evidence grace so a dead target falls back fast
    BILI_ATTACH_EVIDENCE_GRACE_MS: "20",
};

// The lane resets must run BEFORE the env is staged: the omp/opencode/pi
// reset hooks also clear their lane's preset env vars, and a reset after
// staging would silently flip the plan from attach to spawn.
for (const lane of LANES) {
    test(`#5507 ${lane.name}: a dead attach target falling back to a launcher spawn arms the bring-up hold budget`, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), `bili-5507-${lane.name}-dead-`));
        const live = await startMockProxy();
        const dead = await deadOrigin();
        lane.reset();
        try {
            await withEnv({ ...CLEAN_LANED_ENV, BILLION_CONTEXT_PROXY: dead, DSH_HOME: home }, async () => {
                let spawnAttempts = 0;
                lane.setSpawn(() => {
                    spawnAttempts += 1;
                    return Promise.resolve(live.origin);
                });
                try {
                    assert.equal(lane.hold(), undefined, "precondition: fresh state carries no hold budget");
                    lane.arm(mockCtx());
                    await waitFor(() => lane.hold() === HOLD_BUDGET_MS, `${lane.name}: hold budget armed by the fallback-to-spawn transition`);
                    assert.ok(spawnAttempts >= 1, "the fallback actually drove the (stubbed) launcher spawn");
                } finally {
                    lane.setSpawn(undefined);
                }
            });
        } finally {
            lane.reset();
            live.close();
            rmrf(home);
        }
    });

    test(`#5507 ${lane.name}: a healthy attach never arms the bring-up hold budget`, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), `bili-5507-${lane.name}-live-`));
        const live = await startMockProxy();
        lane.reset();
        try {
            await withEnv({ ...CLEAN_LANED_ENV, BILLION_CONTEXT_PROXY: live.origin, DSH_HOME: home }, async () => {
                try {
                    lane.arm(mockCtx());
                    await waitFor(() => lane.nativeState().origin !== undefined, `${lane.name}: healthy attach settles on the target`);
                    assert.equal(lane.nativeState().origin, live.origin, "attached to the declared target, nothing spawned");
                    assert.equal(lane.hold(), undefined, "no launcher spawn started, so no hold budget may be armed");
                } finally {
                    lane.setSpawn(undefined);
                }
            });
        } finally {
            lane.reset();
            live.close();
            rmrf(home);
        }
    });
}

// ———— V2 live-origin resolver consumes the armed hold (#5507) ——————————————
// Arming is only half the seam: OpenCode 2.x model traffic resolves through
// createLiveOriginResolver, which awaited readiness under the generic cap even
// when spawnWaitMs was armed — so on 2.x hosts the hold never applied to
// opencode at all. Both directions pinned: an armed state adopts a respawn that
// lands after the generic cap but inside the armed budget; a disarmed state
// still degrades at the generic cap (no silent 70s holds everywhere).

const LATE_ORIGIN = "http://127.0.0.1:49999";

function lateSpawnResolver(armed: boolean): { resolve: () => Promise<string | undefined>; landedNow: () => boolean } {
    let landed = false;
    const state: NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        readyTimeoutMs: 100,
        ...(armed ? { spawnWaitMs: 600 } : {}),
        respawn: () => new Promise<string | undefined>((resolveSpawn) => {
            setTimeout(() => {
                landed = true;
                resolveSpawn(LATE_ORIGIN);
            }, 400);
        }),
    };
    return { resolve: createLiveOriginResolver(state, { probe: async () => true }), landedNow: () => landed };
}

test("#5507 v2-route: an armed hold adopts a respawn landing past the generic cap", async () => {
    const { resolve, landedNow } = lateSpawnResolver(true);
    const origin = await resolve();
    assert.equal(origin, LATE_ORIGIN, "the spawn lands at 400ms, inside the 600ms armed budget but past the 100ms generic cap — it must be adopted");
    assert.ok(landedNow(), "adoption implies the wait actually held out for the landing");
});

test("#5507 v2-route: a disarmed state degrades at the generic cap before a late spawn lands", async () => {
    const { resolve, landedNow } = lateSpawnResolver(false);
    const origin = await resolve();
    assert.equal(origin, undefined, "no armed budget → no extended hold");
    assert.equal(landedNow(), false, "the decision was made at the 100ms cap, before the 400ms landing");
});
