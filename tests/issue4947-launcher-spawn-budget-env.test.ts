// Spawn-budget env knobs (#4939 and the cross-lane shared-store variant): a
// large index.db opens whole-DB before bind, and two lanes sharing one store
// contend for the write lock on cold start — pre-bind startup past the fixed
// 60s budget makes the launcher kill-spawn loop into the same contention.
// The knobs must resolve at module load, and the resolved budget must actually
// be consumed by the wait loop. This file runs in its own node --test process
// so the module-level constants pick up the env set below.

process.env.BILI_SPAWN_WAIT_MS = "5000";
process.env.BILI_SLOW_START_GRACE_MS = "3000";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnChild, SpawnFn } from "../src/launcher.ts";

// Private XDG roots BEFORE importing the launcher: the starting marker is one
// GLOBAL file per state dir, so any concurrent launcher activity in the shared
// dir (other suites, other processes) makes this file wait behind it and burn
// its budget ticks past the assertions below.
const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue4947-env-"));
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");

const { SPAWN_BUDGET_MS, ensureProxyRunning } = await import("../src/launcher.ts");

function makeFakeChild(pid: number): SpawnChild {
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on() {},
    };
}

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

test("BILI_SPAWN_WAIT_MS / BILI_SLOW_START_GRACE_MS resolve the spawn budget at module load", () => {
    assert.equal(SPAWN_BUDGET_MS, 5000 + 3000);
});

test("the resolved env budget is consumed by the wait loop, not just exported", async () => {
    const clock = fakeClock();
    const spawnImpl: SpawnFn = () => makeFakeChild(42470);
    await assert.rejects(
        ensureProxyRunning(
            // Private port: the port log (.tmp/bili-proxy-<port>.log) is shared
            // per port across processes and rotates under writers (#4811).
            { host: "127.0.0.1", port: 39787, passthrough: false, debug: false },
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
    assert.ok(clock.ticks() >= 8, `the env budget (8s) must be fully consumed, got ${clock.ticks()}s`);
    // Upper bound vs the #2187 baseline: with the built-in 60s budget this same
    // never-healthy scenario consumes >=59 ticks; a much smaller total proves
    // the env budget (not the default) drove the deadline.
    assert.ok(clock.ticks() < 59, `the wait must stay below the built-in 60s budget baseline (>=59 ticks), got ${clock.ticks()}s`);
});

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    fs.rmSync(xdgRoot, { recursive: true, force: true });
});
