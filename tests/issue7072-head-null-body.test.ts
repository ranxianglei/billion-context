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

/** #7072: a 2xx with a null body logs the #821 warn. For HEAD that warn is
 *  NOISE — a HEAD response has no body by definition (RFC 9110 §9.3.2), so a
 *  200 HEAD with a null body is normal, not the #821 anomaly. Health probes
 *  (e.g. HEAD /api/hello) hit this on every request and flooded bili.log with
 *  `[unknown] ← upstream 200 returned a null body` lines. The relay must skip
 *  the warn for HEAD while still warning for a genuine 2xx null body (204/304
 *  on a body-bearing method). */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Captured {
    level: string;
    msg: string;
}

async function startProxyWith(
    upstream: http.Server,
): Promise<{ proxy: http.Server; proxyPort: number; upstreamPort: number; captured: Captured[] }> {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, proxyPort, upstreamPort, captured };
}

test("HEAD 200 with a null body does NOT log the #821 null-body warn (#7072)", async () => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            // HEAD: 200 with no body (correct per RFC 9110 §9.3.2).
            res.writeHead(200, { "content-type": "text/plain" });
            res.end();
        });
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/api/hello`, { method: "HEAD" });
        assert.equal(resp.status, 200);
        assert.equal(await resp.text(), "");
        const nullBodyWarns = captured.filter((c) => c.level === "warn" && c.msg.includes("returned a null body"));
        assert.equal(nullBodyWarns.length, 0, `expected no null-body warn for HEAD, got: ${nullBodyWarns.map((c) => c.msg).join(" | ")}`);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("GET 204 with a null body STILL logs the #821 null-body warn (#821 preserved)", async () => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            // GET: 204 → null body → the #821 anomaly the warn exists to name.
            res.writeHead(204);
            res.end();
        });
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/api/hello`, { method: "GET" });
        assert.equal(resp.status, 204);
        assert.equal(await resp.text(), "");
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("returned a null body"));
        assert.ok(warn, `expected null-body warn for GET 204, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.match(warn.msg, /upstream 204 returned a null body/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});
