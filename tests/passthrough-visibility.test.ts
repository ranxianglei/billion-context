import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { passthroughState, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

test("passthroughState resolves env over file over default", () => {
    const root = path.join(tmpdir(), `bili-passthrough-state-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const previousEnv = process.env.ACP_PASSTHROUGH;
    delete process.env.ACP_PASSTHROUGH;
    try {
        writeFileSync(biliConfig, "{}\n", "utf8");
        assert.deepEqual(passthroughState(process.env), { enabled: false, source: null });

        writeFileSync(biliConfig, '{"passthrough":true}\n', "utf8");
        assert.deepEqual(passthroughState(process.env), { enabled: true, source: "file" });

        process.env.ACP_PASSTHROUGH = "1";
        assert.deepEqual(passthroughState(process.env), { enabled: true, source: "env" });

        process.env.ACP_PASSTHROUGH = "0";
        assert.deepEqual(passthroughState(process.env), { enabled: false, source: "env" });
    } finally {
        if (previousEnv === undefined) delete process.env.ACP_PASSTHROUGH; else process.env.ACP_PASSTHROUGH = previousEnv;
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
        rmSync(root, { recursive: true, force: true });
    }
});

test("web config exposes and toggles passthrough (#405)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-passthrough-web-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");

    const previous = { config: process.env.BILI_CONFIG_FILE, env: process.env.ACP_PASSTHROUGH };
    process.env.BILI_CONFIG_FILE = biliConfig;
    delete process.env.ACP_PASSTHROUGH;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
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
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    const getConfig = async (): Promise<{ passthrough: { enabled: boolean; source: string | null } }> =>
        await (await fetch(`${base}/__bili/config`)).json() as { passthrough: { enabled: boolean; source: string | null } };
    try {
        // Default off — the panel must be able to SEE it (#405: silent kill).
        assert.deepEqual((await getConfig()).passthrough, { enabled: false, source: null });

        // Turn on via panel → file gets passthrough:true, source "file".
        const on = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passthrough: true }),
        });
        assert.equal(on.status, 200);
        assert.deepEqual((await getConfig()).passthrough, { enabled: true, source: "file" });
        assert.match(readFileSync(biliConfig, "utf8"), /"passthrough":\s*true/);
        assert.equal(opts.passthrough, true, "hot-flip: live options updated without restart");

        // Clear via panel → file key removed, compression back on.
        const off = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passthrough: null }),
        });
        assert.equal(off.status, 200);
        assert.deepEqual((await getConfig()).passthrough, { enabled: false, source: null });
        assert.doesNotMatch(readFileSync(biliConfig, "utf8"), /"passthrough"/);
        assert.equal(opts.passthrough, false);

        // Invalid payload.
        const bad = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passthrough: "yes" }),
        });
        assert.equal(bad.status, 400);

        // Env-forced: GET reports source "env"; PUT is refused with the way out.
        process.env.ACP_PASSTHROUGH = "1";
        assert.deepEqual((await getConfig()).passthrough, { enabled: true, source: "env" });
        const forced = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passthrough: null }),
        });
        assert.equal(forced.status, 409);
        const errBody = await forced.json() as { error: string };
        assert.match(errBody.error, /ACP_PASSTHROUGH/);
    } finally {
        await close(proxy);
        if (previous.env === undefined) delete process.env.ACP_PASSTHROUGH; else process.env.ACP_PASSTHROUGH = previous.env;
        if (previous.config === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous.config;
        rmSync(root, { recursive: true, force: true });
    }
});
