import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

/** #1322: /__bili/health must expose the session-lifecycle watchdog state so
 *  attachers and operators can tell a session-owned proxy (armed — dies with
 *  its sessions) from a daemon squatting a stable port (unarmed — outlives all
 *  of them). This file covers the ARMED side: BILI_PARENT_PID is captured when
 *  src/server.ts loads, so it is set BEFORE the dynamic import (node --test
 *  gives every file its own process). */

const root = path.join(tmpdir(), `bili-watchdog-armed-${process.pid}-${Date.now()}`);
mkdirSync(path.join(root, "config"), { recursive: true });
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.BILI_CONFIG_FILE = path.join(root, "config", "billion-context.json");
writeFileSync(process.env.BILI_CONFIG_FILE, '{"providers":{}}\n', "utf8");
delete process.env.BILLION_CONTEXT_PROXY;

const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
const keeper2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
process.env.BILI_PARENT_PID = String(keeper.pid ?? 0);

function getJson(port: number, urlPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.once("error", reject);
    });
}
function postJson(port: number, urlPath: string, body: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.once("error", reject);
        req.end(JSON.stringify(body));
    });
}

test("health exposes an armed watchdog with its owner set (#1322)", async () => {
    assert.ok((keeper.pid ?? 0) > 1, "keeper spawned");
    const [{ startServer }, { defaultConfig }, { SessionStore, _setStoreForTest }, { _setForTest: setRegistryForTest }] = await Promise.all([
        import("../src/server.ts"),
        import("acp-kernel"),
        import("../src/persist.ts"),
        import("../src/registry.ts"),
    ]);
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as AddressInfo).port;
    try {
        const h = await getJson(port, "/__bili/health");
        assert.equal(h.status, 200);
        const j = JSON.parse(h.body) as { watchdog?: { armed?: boolean; parentPid?: number; watchers?: number[] } };
        assert.equal(j.watchdog?.armed, true, "BILI_PARENT_PID arms the watchdog");
        assert.equal(j.watchdog?.parentPid, keeper.pid, "the spawning owner is reported");
        assert.deepEqual(j.watchdog?.watchers, [keeper.pid], "owner seeds the watcher set");

        // A second owner registers through the live route and shows up in health.
        const reg = await postJson(port, "/__bili/watcher", { pid: keeper2.pid });
        assert.equal(reg.status, 200, "armed proxy accepts a second owner");
        const h2 = JSON.parse((await getJson(port, "/__bili/health")).body) as { watchdog?: { watchers?: number[] } };
        assert.deepEqual([...(h2.watchdog?.watchers ?? [])].sort(), [keeper.pid, keeper2.pid].sort(), "registered owner appears in health");
    } finally {
        // Close the proxy BEFORE killing the owners: a live watchdog whose last
        // watcher dies would run shutdown() → process.exit(0) under the test.
        proxy.closeAllConnections?.();
        await new Promise<void>((r) => proxy.close(() => r()));
        for (const k of [keeper, keeper2]) {
            try { k.kill("SIGKILL"); } catch {}
        }
        delete process.env.BILI_PARENT_PID;
        await rmSync(root, { recursive: true, force: true });
    }
});
