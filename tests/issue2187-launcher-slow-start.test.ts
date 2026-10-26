// #2187: a LIVE spawned child past the initial 20s window must keep being
// waited for (extended budget), not abandoned — observed Windows spawn-window
// startups take 26-45s, and the one-shot budget misread that as failure. The
// cross-process waiter shares the same envelope, or it bails at 20s and
// double-spawns against a still-starting child.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimStartingMarker, removeStartingMarker, type ProxyInstanceFile as InstanceFile } from "../src/instance.ts";
import { ensureProxyRunning, SPAWN_BUDGET_MS, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-2187-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function recordedInstance(over: Partial<InstanceFile> = {}): InstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
        ...over,
    };
}

function makeFakeChild(pid: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
        },
    };
}

// Fake clock: 1 tick = 1 second — spans the observed slow-start envelope
// (26-45s) without burning wall-clock time.
function fakeClock() {
    let ticks = 0;
    return {
        now: () => ticks * 1000,
        sleep: () => {
            ticks += 1;
            return Promise.resolve();
        },
        ticks: () => ticks,
    };
}

for (const bindAt of [26, 45]) {
    test(`#2187 live child binding at ~${bindAt}s resolves within the extended budget`, async () => {
        let spawnCalls = 0;
        let childToken = "";
        const clock = fakeClock();
        const spawnImpl: SpawnFn = (_cmd, _args, options) => {
            spawnCalls++;
            childToken = (options.env?.BILI_LAUNCH_TOKEN as string) ?? "";
            return makeFakeChild(42460);
        };
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42460 }),
                spawnImpl,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () =>
                    clock.ticks() >= bindAt
                        ? recordedInstance({ launchToken: childToken, origin: "http://127.0.0.1:8787", port: 8787, pid: 42460 })
                        : undefined,
            },
        );
        assert.equal(spawnCalls, 1);
        assert.ok(handle.child, "the still-starting child was waited for, not abandoned");
        assert.equal(handle.origin, "http://127.0.0.1:8787");
        assert.ok(clock.ticks() <= Math.ceil(SPAWN_BUDGET_MS / 1000), `bound at ${bindAt}s must not burn the whole budget`);
    });
}

test("#2187 never-healthy child fails after the FULL extended budget, not the initial window", async () => {
    const clock = fakeClock();
    let spawnCalls = 0;
    const spawnImpl: SpawnFn = () => {
        spawnCalls++;
        return makeFakeChild(42461);
    };
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => ({ ok: false }),
                spawnImpl,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        ),
        new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`),
    );
    assert.equal(spawnCalls, 1);
    assert.ok(clock.ticks() >= 59, `the full budget (~${Math.ceil(SPAWN_BUDGET_MS / 1000)}s) must be consumed, got ${clock.ticks()}s`);
});

// #2260(A)/#2187: the timeout path is where the spawned child is still ALIVE.
// Before the fix it was abandoned — a detached proxy per failed bring-up, and
// dsh plan-time retries re-arming every 10s turned one persistently slow host
// into ~1 zombie per ~70s (each also stranding the lane sticky-port ladder).
test("#2260(A)/#2187 never-healthy child is hard-killed on timeout instead of leaking", async () => {
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const spawnImpl: SpawnFn = () => ({
        pid: 42462,
        kill(signal) {
            kills.push(signal);
            return true;
        },
    });
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => ({ ok: false }),
                spawnImpl,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        ),
        new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`),
    );
    assert.deepEqual(kills, ["SIGKILL"], "the abandoned child must be hard-killed exactly once");
});

test("#2187 cross-process waiter: instance appearing at ~45s attaches instead of double-spawning", async () => {
    try {
        claimStartingMarker({ token: "starter-2187", pid: process.pid, host: "127.0.0.1", port: 8788, startedAt: Date.now() });
        const clock = fakeClock();
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl: () => {
                    throw new Error("double-spawn: another launch was still bringing its proxy up");
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-9", watchdog: { armed: true } }),
                readInstanceFile: () =>
                    clock.ticks() >= 45 ? recordedInstance({ instanceId: "inst-9", origin: "http://127.0.0.1:8788", port: 8788 }) : undefined,
                now: clock.now,
                sleep: clock.sleep,
                registerWatcher: async () => "ok" as const,
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, "http://127.0.0.1:8788");
    } finally {
        removeStartingMarker();
    }
});
