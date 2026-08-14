import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/** #115: DNS rebinding defense on /__bili/ management endpoints. An attacker
 *  who resolves evil.com → 127.0.0.1 can make a browser request arrive at the
 *  loopback proxy with Host/Origin = evil.com. The proxy must reject any
 *  admin request whose Host is not one of its own listen identities —
 *  including requests with NO Origin header (same-origin GET/fetch). */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(
    port: number,
    headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request(
        { host: "127.0.0.1", port, path: "/__bili/config", headers },
        (res) => {
            let body = "";
            res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
    );
    req.once("error", reject);
    req.end();
    return promise;
}

test("admin endpoints: DNS-rebinding Host is rejected with and without Origin (#115)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-admin-origin-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    const port = 8017 + (process.pid % 500);
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
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const actualPort = (proxy.address() as { port: number }).port;
    const trusted = `127.0.0.1:${actualPort}`;
    try {
        // Rebinding attack, browser POST with Origin matching the spoofed Host.
        const spoofed = await request(actualPort, { host: `evil.com:${actualPort}`, origin: `http://evil.com:${actualPort}` });
        assert.equal(spoofed.status, 403, "Origin==Host==evil.com must be rejected");
        // Rebinding attack, same-origin GET with NO Origin header — the read path.
        const noOrigin = await request(actualPort, { host: `evil.com:${actualPort}` });
        assert.equal(noOrigin.status, 403, "untrusted Host with no Origin must be rejected");
        // (A request with no Host at all is not constructible over HTTP/1.1 —
        // Node always sends one — so that path needs no case here.)
        // Legitimate: trusted Host, no Origin (curl / CLI UI).
        const curlLike = await request(actualPort, { host: trusted });
        assert.equal(curlLike.status, 200);
        // Legitimate: trusted Host + matching Origin (the bundled web UI).
        const uiLike = await request(actualPort, { host: `localhost:${actualPort}`, origin: `http://localhost:${actualPort}` });
        assert.equal(uiLike.status, 200);
        // Cross-site Origin on a trusted Host (another site's JS talking to us).
        const crossOrigin = await request(actualPort, { host: trusted, origin: "http://evil.com:8080" });
        assert.equal(crossOrigin.status, 403, "Origin not in trusted hosts must be rejected");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        proxy.closeAllConnections?.();
        await close(proxy);
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test("admin endpoints work with port: 0 (dynamic port assignment)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-admin-port0-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    // port: 0 → the OS assigns the real port; trusted-host pinning must use
    // the socket's localPort, not the configured 0 (regression: every admin
    // request 403'd because the trusted set contained "localhost:0").
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
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const actualPort = (proxy.address() as { port: number }).port;
    try {
        const curlLike = await request(actualPort, { host: `127.0.0.1:${actualPort}` });
        assert.equal(curlLike.status, 200, "admin endpoints must accept trusted Host on the dynamically assigned port");
        const uiLike = await request(actualPort, { host: `localhost:${actualPort}`, origin: `http://localhost:${actualPort}` });
        assert.equal(uiLike.status, 200);
        const spoofed = await request(actualPort, { host: `evil.com:${actualPort}` });
        assert.equal(spoofed.status, 403, "rebinding Host still rejected on dynamic port");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        proxy.closeAllConnections?.();
        await close(proxy);
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});
