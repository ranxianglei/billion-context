// #2954: the post-spawn handshake must survive a clobbered proxy-origin file.
// The single file is last-writer-wins machine-wide; a concurrent instance that
// registers AFTER our child starves the launchToken match, and the old code
// burned the full 60s budget then SIGKILLed the healthy child (the reported
// WSL2/port-conflict bootstrap failure). The per-instance registry markers
// (#1232) cannot be clobbered — find our child there by pid and trust the
// origin IT recorded.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { ensureProxyRunning, SPAWN_BUDGET_MS, type SpawnChild, type SpawnFn } from "../src/launcher.ts";
import { rmrf } from "./tmp-rm.ts";

// #4953: private XDG roots — the starting marker is ONE global file per state
// dir (proxy-starting). A co-run launcher suite (or real machine activity)
// claiming it looks active to these fake clocks (their startedAt vs our tiny
// ticks*1000 epoch), so we wait behind it and burn a full extra budget.
// Convention: tests/auto-restart.test.ts.
const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2954-xdg-"));
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    rmrf(xdgRoot);
});

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-2954-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

const CHILD_PID = 42470;
const MINE_ORIGIN = "http://127.0.0.1:18788";
const FOREIGN_ORIGIN = "http://127.0.0.1:18787";

/** A LIVE foreign record (alive pid, different launchToken) — the clobber
 *  itself: another instance wrote proxy-origin after our child did. Its
 *  fingerprint differs so pre-spawn discovery refuses to attach to it. */
function foreignInstance(): ProxyInstanceFile {
    return {
        origin: FOREIGN_ORIGIN,
        instanceId: "foreign-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        launchToken: "somebody-else",
        codeFingerprint: "not-our-build",
    };
}

function mineMarker(): ProxyInstanceFile {
    return {
        origin: MINE_ORIGIN,
        instanceId: "mine-1",
        pid: CHILD_PID,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18788,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
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

test("#2954 healthy child resolves via its registry marker despite a clobbered proxy-origin file", async () => {
    const clock = fakeClock();
    let spawnCalls = 0;
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        spawnCalls++;
        return makeFakeChild(CHILD_PID);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 18787, passthrough: false, debug: false },
        {
            fetchImpl: async (url) => (url.startsWith(MINE_ORIGIN) ? { ok: true } : { ok: false }),
            fetchHealthInfo: async (origin) => (origin === FOREIGN_ORIGIN ? { ok: true, pid: process.pid } : { ok: false }),
            spawnImpl,
            now: clock.now,
            sleep: clock.sleep,
            readInstanceFile: () => foreignInstance(),
            listRegistryInstances: () => [mineMarker()],
        },
    );
    assert.equal(spawnCalls, 1);
    assert.equal(handle.origin, MINE_ORIGIN, "the child's own registered origin wins over the clobbered file");
    assert.equal(handle.port, 18788);
    assert.ok(handle.child, "the healthy child was kept, not abandoned");
    assert.ok(clock.ticks() <= 5, `resolved promptly (${clock.ticks()}s), not by burning the budget`);
});

test("#2954 an UNHEALTHY child marker still burns the full budget and gets killed (no premature attach)", async () => {
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const spawnImpl: SpawnFn = () => ({
        pid: CHILD_PID,
        kill(signal) {
            kills.push(signal);
            return true;
        },
    });
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 18787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async (origin) => (origin === FOREIGN_ORIGIN ? { ok: true, pid: process.pid } : { ok: false }),
                spawnImpl,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => foreignInstance(),
                listRegistryInstances: () => [mineMarker()],
            },
        ),
        new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`),
    );
    assert.ok(clock.ticks() >= 59, `the full budget was consumed before failing, got ${clock.ticks()}s`);
    assert.deepEqual(kills, ["SIGKILL"], "the never-healthy child is hard-killed exactly once");
});
