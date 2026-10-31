// #4125: the spawn-wait settle loop's PRIMARY branches (launchToken handshake,
// registry-by-pid) used to trust ANY healthy answer at the origin our child
// CLAIMED — while the preferred-port fallback already verified the responder's
// pid (#1753). A foreign responder that took over that address (port-stealing
// non-libuv process, cross-build confusion) was exported to the client as ours:
// one writer per copy violated (#991/#1225). These tests pin BOTH directions of
// the gate (#3617): own/absent pid settles, a positively-foreign pid never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile as InstanceFile } from "../src/instance.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

const FP_SCRIPT = path.join(os.tmpdir(), `bili-4125-fp-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

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
            return this;
        },
    };
}

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

test("ensureProxyRunning: launchToken record settles when the claimed origin's health names the spawned child (#4125)", async () => {
    let childToken = "";
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) =>
                origin === "http://127.0.0.1:8795" ? { ok: true, pid: 42470 } : { ok: false },
            spawnImpl: (_cmd, _args, options) => {
                childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                return makeFakeChild(42470);
            },
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
            listRegistryInstances: () => [],
            readInstanceFile: () =>
                childToken
                    ? recordedInstance({ origin: "http://127.0.0.1:8795", port: 8795, launchToken: childToken })
                    : undefined,
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:8795");
    assert.equal(handle.port, 8795);
});

test("ensureProxyRunning: a foreign responder on the child's CLAIMED origin is not exported as ours (#4125)", async () => {
    let childToken = "";
    const diag: string[] = [];
    let ticks = 0;
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                // The child's own record points at 8796 — but the answer there
                // comes from ANOTHER process's pid.
                fetchHealthInfo: async (origin) =>
                    origin === "http://127.0.0.1:8796" ? { ok: true, pid: 875250 } : { ok: false },
                spawnImpl: (_cmd, _args, options) => {
                    childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                    return makeFakeChild(42471);
                },
                attachDiag: (m) => diag.push(m),
                now: () => ticks * 1000,
                sleep: () => {
                    ticks += 10;
                    return Promise.resolve();
                },
                scriptPath: FP_SCRIPT,
                listRegistryInstances: () => [],
                readInstanceFile: () =>
                    childToken
                        ? recordedInstance({ origin: "http://127.0.0.1:8796", port: 8796, launchToken: childToken })
                        : undefined,
            },
        ),
        /did not become healthy/,
    );
    const contested = diag.filter((m) => m.includes("refusing to claim a contested origin"));
    assert.equal(contested.length, 1, "the contested-origin diagnostic fires exactly once");
    assert.match(contested[0], /pid 875250/);
    assert.match(contested[0], /child is pid 42471/);
});

test("ensureProxyRunning: a claimed-origin responder WITHOUT a pid still settles (legacy fail-open, #4125)", async () => {
    let childToken = "";
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) =>
                origin === "http://127.0.0.1:8797" ? { ok: true } : { ok: false },
            spawnImpl: (_cmd, _args, options) => {
                childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                return makeFakeChild(42472);
            },
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
            listRegistryInstances: () => [],
            readInstanceFile: () =>
                childToken
                    ? recordedInstance({ origin: "http://127.0.0.1:8797", port: 8797, launchToken: childToken })
                    : undefined,
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:8797");
    assert.equal(handle.port, 8797);
});

test("ensureProxyRunning: registry-by-pid settles when that entry's origin names the spawned child (#4125)", async () => {
    let spawned = false;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) =>
                origin === "http://127.0.0.1:8798" ? { ok: true, pid: 42473 } : { ok: false },
            spawnImpl: () => {
                spawned = true;
                return makeFakeChild(42473);
            },
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
            listRegistryInstances: () =>
                spawned
                    ? [recordedInstance({ instanceId: "reg-1", pid: 42473, origin: "http://127.0.0.1:8798", port: 8798 })]
                    : [],
            readInstanceFile: () => undefined,
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:8798");
    assert.equal(handle.port, 8798);
});

test("ensureProxyRunning: a foreign responder on the registry entry's origin ends in a loud failure, not a misroute (#4125)", async () => {
    let spawned = false;
    const diag: string[] = [];
    let ticks = 0;
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) =>
                    origin === "http://127.0.0.1:8799" ? { ok: true, pid: 875250 } : { ok: false },
                spawnImpl: () => {
                    spawned = true;
                    return makeFakeChild(42474);
                },
                attachDiag: (m) => diag.push(m),
                now: () => ticks * 1000,
                sleep: () => {
                    ticks += 10;
                    return Promise.resolve();
                },
                scriptPath: FP_SCRIPT,
                listRegistryInstances: () =>
                    spawned
                        ? [recordedInstance({ instanceId: "reg-1", pid: 42474, origin: "http://127.0.0.1:8799", port: 8799 })]
                        : [],
                readInstanceFile: () => undefined,
            },
        ),
        /did not become healthy/,
    );
    const contested = diag.filter((m) => m.includes("refusing to claim a contested origin"));
    assert.equal(contested.length, 1, "the contested-origin diagnostic fires exactly once");
    assert.match(contested[0], /pid 875250/);
    assert.match(contested[0], /child is pid 42474/);
});

test("ensureProxyRunning: health-info probe failure falls back to the legacy boolean probe (#4125)", async () => {
    let childToken = "";
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => undefined,
            spawnImpl: (_cmd, _args, options) => {
                childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                return makeFakeChild(42475);
            },
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
            listRegistryInstances: () => [],
            readInstanceFile: () =>
                childToken
                    ? recordedInstance({ origin: "http://127.0.0.1:8800", port: 8800, launchToken: childToken })
                    : undefined,
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:8800");
    assert.equal(handle.port, 8800);
});
