import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { applyEgressTransforms, parseEgressTransformEntries, resetEgressModuleCache, type EgressTransformBase } from "../src/egress-transforms.js";
import { startServer } from "../src/server.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import type { ProxyOptions } from "../src/config.js";

function moduleFixture(rejectOld = false) {
    resetEgressModuleCache();
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-reload-"));
    const path = join(dir, "transform.mjs");
    const key = `egress-reload:${dir}`;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    Reflect.set(globalThis, Symbol.for(key), { entered, wait });
    const old = `const gate = globalThis[Symbol.for(${JSON.stringify(key)})]; gate.entered(); await gate.wait;\n`
        + (rejectOld ? 'throw new Error("old generation failed");\n' : '')
        + 'export default { transform() { return { headers: { "x-plugin-generation": "old" } }; } };';
    writeFileSync(path, old);
    const entries = parseEgressTransformEntries([{ module: path }]);
    const run = async () => {
        const base: EgressTransformBase = { sessionId: undefined, upstreamUrl: "https://upstream.fixture.invalid", method: "POST", url: "/test", headers: {}, protocol: "openai", model: "fixture", stage: "initial" };
        await applyEgressTransforms("body", base, entries, () => {});
        return base.headers["x-plugin-generation"];
    };
    return { dir, path, started, release, run, entries,
        edit: () => {
            writeFileSync(path, 'export default { transform() { return { headers: { "x-plugin-generation": "new" } }; } };');
            const next = new Date(Date.now() + 1000);
            utimesSync(path, next, next);
        },
        close: () => { release(); Reflect.deleteProperty(globalThis, Symbol.for(key)); resetEgressModuleCache(); rmSync(dir, { recursive: true, force: true }); },
    };
}

for (const rejectOld of [false, true]) {
    test(`a pre-reload module ${rejectOld ? "failure" : "success"} cannot replace the new generation's cache`, async () => {
        const f = moduleFixture(rejectOld);
        try {
            const pending = f.run();
            await f.started;
            resetEgressModuleCache();
            f.edit();
            assert.equal(await f.run(), "new");
            f.release();
            assert.equal(await pending, rejectOld ? undefined : "old");
            assert.equal(await f.run(), "new", "later requests must retain the reloaded transform");
        } finally { f.close(); }
    });
}

test("real config reload keeps the new plugin after an older HTTP request finishes importing", async () => {
    const f = moduleFixture();
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(f.dir, "config.json");
    writeFileSync(process.env.BILI_CONFIG_FILE, JSON.stringify({ egressTransforms: [{ module: f.path }], compress: { injectTool: false, injectNudge: false } }));
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ generation: req.headers["x-plugin-generation"] })); });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 10_000, kernelConfig: defaultConfig(10_000),
        compress: { injectTool: false, injectNudge: false }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: true,
        autoUpdate: false, mitm: { enabled: false, domains: [] }, egressTransforms: f.entries } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const request = async () => {
        const response = await fetch(`${origin}/bili/http://127.0.0.1:${upstreamPort}/test`, { method: "POST", body: "body", signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200);
        return (await response.json() as { generation: string }).generation;
    };
    let pending: Promise<string> | undefined;
    try {
        pending = request();
        await f.started;
        f.edit();
        const reload = await fetch(origin + "/__bili/config/reload", { method: "POST" });
        assert.equal(reload.status, 200, await reload.text());
        assert.equal(await request(), "new");
        f.release();
        assert.equal(await pending, "old");
        assert.equal(await request(), "new");
    } finally {
        f.release();
        await pending?.catch(() => {});
        proxy.closeAllConnections();
        upstream.closeAllConnections();
        await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        f.close();
    }
});
