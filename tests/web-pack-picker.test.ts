// #5319 (web half): GET /__bili/packs returns the resolved pack inventory
// (project > user > shipped > builtin, first-wins per name) that the settings
// panel's promptPack picker renders. The loopback + trusted-origin gates are
// covered by the existing admin gate tests; here we assert inventory shape,
// provenance labels, and user-dir discovery over a real server on port 0.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { rmrf } from "./tmp-rm.js";

async function waitReady(port: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`proxy on port ${port} did not become ready`);
}

function get(port: number, reqPath: string): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
    return promise;
}

test("#5319 web half: GET /__bili/packs lists resolved packs with provenance", async (t) => {
    const root = path.join(tmpdir(), `bili-pack-picker-${process.pid}-${Date.now()}`);
    const cfgHome = path.join(root, "xdg-config");
    const packDir = path.join(cfgHome, "billion-context", "packs");
    mkdirSync(packDir, { recursive: true });
    // A user-dir file pack, visible to the resolver via XDG_CONFIG_HOME/billion-context/packs.
    writeFileSync(path.join(packDir, "zz-test.json"), JSON.stringify({ promptSections: { philosophy: "zz philosophy" } }), "utf8");
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, "{}\n", "utf8");
    const prevFile = process.env.BILI_CONFIG_FILE;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.BILI_CONFIG_FILE = biliConfig;
    process.env.XDG_CONFIG_HOME = cfgHome;
    t.after(() => {
        if (prevFile === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevFile;
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
        rmrf(root);
    });
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
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
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        await waitReady(port);
        const r = await get(port, "/__bili/packs");
        assert.equal(r.status, 200);
        const data = JSON.parse(r.body) as { packs?: Array<{ name: string; version: string | null; description: string | null; source: string }> };
        assert.ok(Array.isArray(data.packs) && data.packs.length > 0, "pack list present");
        const byName = new Map(data.packs.map((p) => [p.name, p]));
        assert.equal(byName.get("default")?.source, "builtin:default");
        assert.equal(byName.get("lean")?.source, "builtin:lean");
        assert.equal(byName.get("chat")?.source, "shipped:chat", "#5320 shipped builtin listed");
        const zz = byName.get("zz-test");
        assert.ok(zz, "user-dir file pack listed");
        assert.ok(zz.source.startsWith("file:"), `user pack source is a file origin, got ${zz.source}`);
    } finally {
        proxy.close();
    }
});
