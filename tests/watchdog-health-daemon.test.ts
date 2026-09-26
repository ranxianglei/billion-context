import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

/** #1322 counterpart of watchdog-health.test.ts: a proxy started WITHOUT
 *  BILI_PARENT_PID is a daemon — its health must say `armed:false` and it must
 *  keep refusing watcher registrations (409) while staying up. Separate file
 *  because src/server.ts captures BILI_PARENT_PID at module load. */

const root = path.join(tmpdir(), `bili-watchdog-daemon-${process.pid}-${Date.now()}`);
mkdirSync(path.join(root, "config"), { recursive: true });
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.BILI_CONFIG_FILE = path.join(root, "config", "billion-context.json");
writeFileSync(process.env.BILI_CONFIG_FILE, '{"providers":{}}\n', "utf8");
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.BILI_PARENT_PID;

const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });

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

test("health exposes an unarmed watchdog on a daemon proxy; registration stays refused (#1322)", async () => {
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
        assert.equal(j.watchdog?.armed, false, "no BILI_PARENT_PID → unarmed");
        assert.equal(j.watchdog?.parentPid, undefined, "no parent pid reported");
        assert.deepEqual(j.watchdog?.watchers, [], "empty owner set");

        // The #1322 attach case: a session tries to register on this daemon.
        // It must be refused (existing contract) AND the refusal must be
        // visible through health (the field that lets callers notice).
        const reg = await postJson(port, "/__bili/watcher", { pid: keeper.pid });
        assert.equal(reg.status, 409, "daemon refuses watchers");
        const h2 = JSON.parse((await getJson(port, "/__bili/health")).body) as { watchdog?: { armed?: boolean; watchers?: number[] } };
        assert.equal(h2.watchdog?.armed, false, "refused registration did not arm a watchdog");
        assert.deepEqual(h2.watchdog?.watchers, [], "refused registration did not join the set");
    } finally {
        proxy.closeAllConnections?.();
        await new Promise<void>((r) => proxy.close(() => r()));
        try { keeper.kill("SIGKILL"); } catch {}
        await rmSync(root, { recursive: true, force: true });
    }
});
