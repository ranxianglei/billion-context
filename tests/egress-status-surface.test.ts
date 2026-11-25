import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { egressSummary, _resetUpstreamProxyForTest } from "../src/upstream-proxy.ts";

// #7750: the effective egress path (direct vs upstream proxy) must be answerable
// at a glance — the SAME decision the request path makes (resolveProxyDecision),
// surfaced in /__bili/status + the startup log so the #7747 cold-start remedy
// ("route egress through a proxy") is verifiable without reading config.

// ---------------------------------------------------------------------------
// Unit: egressSummary — the shared display helper behind both surfaces.

test("egressSummary: direct when no proxy is configured anywhere", () => {
    _resetUpstreamProxyForTest();
    try {
        assert.deepEqual(
            egressSummary({}, undefined, "https://api.example.com/v1", { explicitDirect: true, biliPort: 8787 }),
            { mode: "direct", proxy: null, source: "direct", upstream: "https://api.example.com/v1" },
        );
    } finally {
        _resetUpstreamProxyForTest();
    }
});

test("egressSummary: proxied via the global proxy, credentials masked", () => {
    _resetUpstreamProxyForTest();
    try {
        assert.deepEqual(
            egressSummary({}, "http://user:secret@proxy.example:8080", "https://api.example.com/v1", { biliPort: 8787, globalSource: "config" }),
            { mode: "proxied", proxy: "http://***:***@proxy.example:8080/", source: "config", upstream: "https://api.example.com/v1" },
        );
    } finally {
        _resetUpstreamProxyForTest();
    }
});

test("egressSummary: proxied via the env tier in auto mode", () => {
    _resetUpstreamProxyForTest();
    try {
        assert.deepEqual(
            egressSummary({}, "", "https://api.example.com/v1", { httpsProxy: "http://env.example:9443", biliPort: 8787, globalSource: "auto" }),
            { mode: "proxied", proxy: "http://env.example:9443/", source: "HTTPS_PROXY", upstream: "https://api.example.com/v1" },
        );
    } finally {
        _resetUpstreamProxyForTest();
    }
});

test("egressSummary: per-route proxy outranks the global proxy", () => {
    _resetUpstreamProxyForTest();
    try {
        const routes = { "https://api.example.com": { proxy: "http://provider.example:8080" } };
        assert.deepEqual(
            egressSummary(routes, "http://explicit.example:8080", "https://api.example.com/v1", { biliPort: 8787 }),
            { mode: "proxied", proxy: "http://provider.example:8080/", source: "provider", upstream: "https://api.example.com/v1" },
        );
    } finally {
        _resetUpstreamProxyForTest();
    }
});

test("egressSummary: a throwing decision degrades to direct/error, never fails the surface", () => {
    _resetUpstreamProxyForTest();
    try {
        // socks5:// is not an http(s) proxy origin → resolveProxyDecision throws.
        const routes = { "https://api.example.com": { proxy: "socks5://127.0.0.1:7890" } };
        assert.deepEqual(
            egressSummary(routes, undefined, "https://api.example.com/v1", { biliPort: 8787 }),
            { mode: "direct", proxy: null, source: "error", upstream: "https://api.example.com/v1" },
        );
    } finally {
        _resetUpstreamProxyForTest();
    }
});

// ---------------------------------------------------------------------------
// Integration: real servers, real sockets.

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

function baseOpts(over: Partial<ProxyOptions>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "https://api.example.com",
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
        ...over,
    } as ProxyOptions;
}

async function startListening(opts: ProxyOptions): Promise<http.Server> {
    const bili = await startServer(opts);
    if (!bili.listening) await once(bili, "listening");
    return bili;
}

test("integration: /__bili/status exposes the effective egress path (#7750)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetUpstreamProxyForTest();
    const bili = await startListening(baseOpts({
        proxy: "http://user:secret@proxy.example:8080",
        proxyMode: "auto",
        proxySource: "config",
        proxyFallback: { biliPort: 0, globalSource: "config" },
    }));
    const port = (bili.address() as { port: number }).port;
    try {
        const { status, body } = await get(port, "/__bili/status");
        assert.equal(status, 200);
        const data = JSON.parse(body);
        assert.deepEqual(data.egress, {
            mode: "proxied",
            proxy: "http://***:***@proxy.example:8080/",
            source: "config",
            upstream: "https://api.example.com",
        });
    } finally {
        bili.closeAllConnections?.();
        await close(bili);
        _resetUpstreamProxyForTest();
    }
});

test("integration: /__bili/overview parity carries the same egress field (#7750)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetUpstreamProxyForTest();
    const bili = await startListening(baseOpts({
        proxy: "http://user:secret@proxy.example:8080",
        proxyMode: "auto",
        proxySource: "config",
        proxyFallback: { biliPort: 0, globalSource: "config" },
    }));
    const port = (bili.address() as { port: number }).port;
    try {
        const { status, body } = await get(port, "/__bili/overview");
        assert.equal(status, 200);
        const data = JSON.parse(body);
        assert.deepEqual(data.egress, {
            mode: "proxied",
            proxy: "http://***:***@proxy.example:8080/",
            source: "config",
            upstream: "https://api.example.com",
        });
    } finally {
        bili.closeAllConnections?.();
        await close(bili);
        _resetUpstreamProxyForTest();
    }
});

// announceListening runs ASYNC after the 'listening' event (post-bind
// registration), so the [egress] line is not guaranteed to be captured the
// instant "listening" resolves — poll for it.
async function waitForEgressLine(captured: Array<{ level: string; msg: string }>, timeoutMs = 5000): Promise<{ level: string; msg: string }> {
    const start = Date.now();
    for (;;) {
        const line = captured.find((e) => e.msg.startsWith("[egress]"));
        if (line) return line;
        if (Date.now() - start > timeoutMs) {
            throw new Error(`[egress] startup line did not appear within ${timeoutMs}ms; recent info lines: ${JSON.stringify(captured.filter((e) => e.level === "info").slice(-10))}`);
        }
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("integration: startup log prints the proxied egress path once, credentials masked (#7750)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetUpstreamProxyForTest();
    const captured: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let bili: http.Server | undefined;
    try {
        bili = await startListening(baseOpts({
            log: true,
            proxy: "http://user:secret@proxy.example:8080",
            proxyMode: "auto",
            proxySource: "config",
            proxyFallback: { biliPort: 0, globalSource: "config" },
        }));
        const line = await waitForEgressLine(captured);
        const egressLines = captured.filter((e) => e.msg.startsWith("[egress]"));
        assert.equal(egressLines.length, 1, `expected exactly one [egress] startup line, got ${egressLines.length}`);
        assert.equal(line.level, "info");
        assert.ok(line.msg.includes("https://api.example.com"), "names the model upstream");
        assert.ok(line.msg.includes("proxied via http://***:***@proxy.example:8080/"), "names the masked proxy address");
        assert.ok(line.msg.includes("source: config"), "names the decision source");
        assert.ok(!line.msg.includes("secret"), "credential must not leak into the startup log");
    } finally {
        setLogCapture(null);
        if (bili) {
            bili.closeAllConnections?.();
            await close(bili);
        }
        _resetUpstreamProxyForTest();
    }
});

test("integration: startup log prints the direct egress path when no proxy is set (#7750)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetUpstreamProxyForTest();
    const captured: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let bili: http.Server | undefined;
    try {
        bili = await startListening(baseOpts({
            log: true,
            proxy: "",
            proxyMode: "direct",
            proxySource: "direct",
            // explicitDirect short-circuits to "direct" without consulting the
            // process env — deterministic regardless of CI proxy variables.
            proxyFallback: { explicitDirect: true, biliPort: 0 },
        }));
        const line = await waitForEgressLine(captured);
        assert.equal(line.level, "info");
        assert.ok(line.msg.includes("https://api.example.com"), "names the model upstream");
        assert.ok(line.msg.includes("direct (source: direct)"), "reports the direct path");
        assert.ok(!line.msg.includes("proxied via"), "does not claim a proxy");
    } finally {
        setLogCapture(null);
        if (bili) {
            bili.closeAllConnections?.();
            await close(bili);
        }
        _resetUpstreamProxyForTest();
    }
});
