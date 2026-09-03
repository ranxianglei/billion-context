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
import { classifyIp, checkTunnelDestination, tunnelAllowlistFromEnv, parseIpLiteral, type ResolveHost } from "../src/tunnel-guard.ts";

/** #409: the /bili/<absolute-url> tunnel must not reach the proxy's own
 *  management plane, link-local metadata, or (for remote clients) any
 *  loopback/private destination — while LOCAL clients keep the self-hosted
 *  upstream case (sglang/ollama on 127.0.0.1:<other port>). */

test("parseIpLiteral: quads, v6, mapped; names are not literals", () => {
    assert.equal(parseIpLiteral("127.0.0.1"), "127.0.0.1");
    assert.equal(parseIpLiteral("FE80::1"), "fe80::1");
    assert.equal(parseIpLiteral("::ffff:192.168.0.1"), "::ffff:192.168.0.1");
    assert.equal(parseIpLiteral("metadata.google.internal"), null);
    assert.equal(parseIpLiteral("localhost"), null);
});

test("classifyIp: range matrix", () => {
    assert.equal(classifyIp("127.0.0.1"), "loopback");
    assert.equal(classifyIp("127.9.9.9"), "loopback");
    assert.equal(classifyIp("::1"), "loopback");
    assert.equal(classifyIp("169.254.169.254"), "linkLocal");
    assert.equal(classifyIp("fe80::1"), "linkLocal");
    assert.equal(classifyIp("10.1.2.3"), "private");
    assert.equal(classifyIp("172.16.0.1"), "private");
    assert.equal(classifyIp("172.31.255.255"), "private");
    assert.equal(classifyIp("192.168.1.1"), "private");
    assert.equal(classifyIp("100.64.0.1"), "private");
    assert.equal(classifyIp("fd00:ec2::254"), "private");
    assert.equal(classifyIp("::ffff:10.0.0.1"), "private");
    assert.equal(classifyIp("8.8.8.8"), "public");
    assert.equal(classifyIp("2606:4700::1111"), "public");
});

const localIps = () => new Set(["127.0.0.1", "::1", "192.168.1.5", "127.0.0.2"]);
const stubResolve = (map: Record<string, string[]>): ResolveHost => async (h) => map[h] ?? [];

test("checkTunnelDestination: self always denied, any client", async () => {
    for (const clientLoopback of [true, false]) {
        const v = await checkTunnelDestination("http://127.0.0.1:8787", { selfPort: 8787, clientLoopback, allowlist: ["127.0.0.1:8787"], localIps });
        assert.equal(v.ok, false);
        assert.equal(v.code, "self", "allowlist must not exempt the proxy itself");
        const lan = await checkTunnelDestination("http://192.168.1.5:8787", { selfPort: 8787, clientLoopback, allowlist: [], localIps });
        assert.equal(lan.ok, false);
        assert.equal(lan.code, "self", "interface address on the serving port is self");
    }
    const otherPort = await checkTunnelDestination("http://127.0.0.1:8199", { selfPort: 8787, clientLoopback: true, allowlist: [], localIps });
    assert.equal(otherPort.ok, true, "loopback client reaching a DIFFERENT local service is the self-hosted upstream case");
});

test("checkTunnelDestination: link-local/metadata always denied, incl. via DNS names", async () => {
    const direct = await checkTunnelDestination("http://169.254.169.254/latest/meta-data/", { selfPort: 8787, clientLoopback: true, allowlist: [], localIps });
    assert.equal(direct.ok, false);
    assert.equal(direct.code, "linkLocal");
    const byName = await checkTunnelDestination("http://metadata.google.internal/", {
        selfPort: 8787,
        clientLoopback: true,
        allowlist: ["metadata.google.internal"],
        localIps,
        resolveHost: stubResolve({ "metadata.google.internal": ["169.254.169.254"] }),
    });
    assert.equal(byName.ok, false, "names resolving into link-local are denied even when allowlisted");
    assert.equal(byName.code, "linkLocal");
});

test("checkTunnelDestination: private destinations — local allow, remote needs allowlist", async () => {
    const local = await checkTunnelDestination("http://127.0.0.1:8199/v1", { selfPort: 8787, clientLoopback: true, allowlist: [], localIps });
    assert.equal(local.ok, true);
    const remote = await checkTunnelDestination("http://127.0.0.1:8199/v1", { selfPort: 8787, clientLoopback: false, allowlist: [], localIps });
    assert.equal(remote.ok, false);
    assert.equal(remote.code, "privateRemote");
    const remoteLan = await checkTunnelDestination("http://192.168.1.9:9000/v1", { selfPort: 8787, clientLoopback: false, allowlist: [], localIps });
    assert.equal(remoteLan.ok, false);
    assert.equal(remoteLan.code, "privateRemote");
    const allowPort = await checkTunnelDestination("http://127.0.0.1:8199/v1", { selfPort: 8787, clientLoopback: false, allowlist: ["127.0.0.1:8199"], localIps });
    assert.equal(allowPort.ok, true, "host:port allowlist entry unlocks the remote client");
    const allowHost = await checkTunnelDestination("http://192.168.1.9:9000/v1", { selfPort: 8787, clientLoopback: false, allowlist: ["192.168.1.9"], localIps });
    assert.equal(allowHost.ok, true, "bare-host allowlist entry matches any port on that host");
    const wrongPort = await checkTunnelDestination("http://127.0.0.1:9000/v1", { selfPort: 8787, clientLoopback: false, allowlist: ["127.0.0.1:8199"], localIps });
    assert.equal(wrongPort.ok, false, "host:port entry must not unlock other ports");
});

test("checkTunnelDestination: public destinations pass for any client; unresolvable denied", async () => {
    for (const clientLoopback of [true, false]) {
        const pub = await checkTunnelDestination("https://api.example.com/v1", {
            selfPort: 8787,
            clientLoopback,
            allowlist: [],
            localIps,
            resolveHost: stubResolve({ "api.example.com": ["93.184.216.34"] }),
        });
        assert.equal(pub.ok, true);
    }
    const dead = await checkTunnelDestination("https://no-such-host.invalid/v1", {
        selfPort: 8787,
        clientLoopback: true,
        allowlist: [],
        localIps,
        resolveHost: async () => {
            throw new Error("ENOTFOUND");
        },
    });
    assert.equal(dead.ok, false);
    assert.equal(dead.code, "unresolvable");
});

test("checkTunnelDestination: default ports by scheme", async () => {
    const httpsNoPort = await checkTunnelDestination("https://169.254.169.254/", { selfPort: 8787, clientLoopback: true, allowlist: [], localIps });
    assert.equal(httpsNoPort.ok, false);
    assert.equal(httpsNoPort.code, "linkLocal", "scheme-default 443 still classified");
});

test("tunnelAllowlistFromEnv: comma parsing, case normalization, blanks dropped", () => {
    assert.deepEqual(tunnelAllowlistFromEnv({ BILI_TUNNEL_ALLOWED_HOSTS: "127.0.0.1:8199, LANRELAY.EXAMPLE , ,10.0.0.5" }), ["127.0.0.1:8199", "lanrelay.example", "10.0.0.5"]);
    assert.deepEqual(tunnelAllowlistFromEnv({}), []);
    assert.deepEqual(tunnelAllowlistFromEnv({ BILI_TUNNEL_ALLOWED_HOSTS: "  " }), []);
});

// ---------------------------------------------------------------------------
// Integration: real server, real sockets.

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function get(port: number, reqPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, headers }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
    return promise;
}

test("integration: tunnel cannot reach the proxy's own management plane (#409 PoC)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-tunnel-self-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
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
    const selfPort = (proxy.address() as { port: number }).port;
    try {
        const poc = await get(selfPort, `/bili/http://127.0.0.1:${selfPort}/__bili/config`);
        assert.equal(poc.status, 403, "the issue's PoC GET must be denied");
        assert.match(poc.body, /tunnel_destination_denied/);
        const pocPut = await get(selfPort, `/bili/http://127.0.0.1:${selfPort}/__bili/config`);
        assert.equal(pocPut.status, 403);
        // Direct loopback management access still works (marker not present).
        const direct = await get(selfPort, "/__bili/config", { host: `127.0.0.1:${selfPort}` });
        assert.equal(direct.status, 200);
        // Spoofed marker on a direct request only locks the spoofer out.
        const spoof = await get(selfPort, "/__bili/config", { host: `127.0.0.1:${selfPort}`, "x-bili-tunnel": "1" });
        assert.equal(spoof.status, 403, "admin gate rejects any request carrying the tunnel marker");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        proxy.closeAllConnections?.();
        await close(proxy);
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test("integration: metadata destination never contacted (403 before any socket); local upstream still proxied + marker stamped", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-tunnel-meta-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    // Echo upstream: captures headers, replies 200.
    let sawMarker: string | string[] | undefined;
    const echo = http.createServer((req, res) => {
        sawMarker = req.headers["x-bili-tunnel"];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    const echoPort = (echo.address() as { port: number }).port;

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
    const selfPort = (proxy.address() as { port: number }).port;
    try {
        const meta = await get(selfPort, "/bili/http://169.254.169.254/latest/meta-data/");
        assert.equal(meta.status, 403);
        assert.match(meta.body, /"detail":"linkLocal"/);
        // Self-hosted upstream on a DIFFERENT port still works for the local client.
        const local = await get(selfPort, `/bili/http://127.0.0.1:${echoPort}/v1/models`);
        assert.equal(local.status, 200, `loopback client → loopback upstream must pass (got ${local.status}: ${local.body})`);
        assert.equal(sawMarker, "1", "tunnel forward stamps x-bili-tunnel: 1");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        proxy.closeAllConnections?.();
        await close(proxy);
        echo.closeAllConnections?.();
        await close(echo);
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});
