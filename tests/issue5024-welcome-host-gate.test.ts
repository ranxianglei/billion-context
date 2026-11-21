// #5024: the GET / welcome branch (and the sibling /favicon.ico local route)
// matched on PATH ALONE, so a MITM-decrypted vhost request — which re-enters
// the same handler carrying the UPSTREAM vhost's Host header (GET
// https://chatgpt.com/ ⇒ Host: chatgpt.com) — got 302'd onto the local admin
// UI, or answered with bili's {ok:true} health JSON / bundled icon bytes
// instead of being forwarded. The fix gates both routes on the request being
// addressed to the gateway itself (isTrustedAdminOrigin +
// adminTrustedHostnames, the same identity judgment as the /__bili/ origin
// check, #1537 port-insensitive for SSH forwards); foreign-Host requests fall
// through to the normal forward path like every other path.
//
// These tests drive the FULL proxy over real TCP. A forged foreign Host on a
// loopback connection reproduces exactly what the MITM inner socket presents
// to handleAdminRoute (origin-form path + upstream Host); the socket marker
// only changes WHERE the fallback forwards, never WHETHER the admin layer
// answers locally — which is what this defect and its fix live in.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-5024-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

// Only method+path are asserted: the direct-forward path rewrites the Host
// header onto the configured upstream origin (in a real MITM leg the socket
// marker targets the vhost itself) — header rewriting is not under test here.
interface UpstreamHit {
    method: string;
    url: string;
}

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    _setForTest({});
    const hits: UpstreamHit[] = [];
    const upstream = http.createServer((req, res) => {
        hits.push({ method: req.method ?? "", url: req.url ?? "" });
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>upstream-site</html>");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: {}, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        hits,
        proxyPort,
        close: async () => {
            await new Promise<void>((r) => proxy.close(() => r()));
            await new Promise<void>((r) => upstream.close(() => r()));
        },
    };
}

/** Raw GET against the proxy; extraHeaders may forge the Host (the MITM-vhost
 *  shape). No redirect following — the 302 itself is under test. */
function rawGet(port: number, path: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; location?: string; contentType?: string; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers: extraHeaders }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                location: typeof res.headers.location === "string" ? res.headers.location : undefined,
                contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : undefined,
                body: Buffer.concat(chunks).toString("utf8"),
            }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("#5024 preserved: self-addressed browser navigation still 302s to /__bili/", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/", { accept: "text/html,application/xhtml+xml" });
        assert.equal(out.status, 302, `local browser visit to the gateway root must keep redirecting; got ${out.status}: ${out.body}`);
        assert.equal(out.location, "/__bili/");
        assert.equal(h.hits.length, 0, "welcome answer must never touch the upstream");
    } finally {
        await h.close();
    }
});

test("#5024 preserved: self-addressed health probe still gets the JSON ok", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/", { accept: "*/*" });
        assert.equal(out.status, 200);
        const json = JSON.parse(out.body) as { ok?: boolean };
        assert.equal(json.ok, true, `health probe shape must stay {ok:true,...}; got ${out.body}`);
        assert.equal(h.hits.length, 0);
    } finally {
        await h.close();
    }
});

test("#5024 fixed: MITM-vhost root navigation (Host: chatgpt.com, HTML Accept) is NOT 302'd — it forwards", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/", { host: "chatgpt.com", accept: "text/html,application/xhtml+xml" });
        assert.notEqual(out.status, 302, `foreign-vhost GET / must not be hijacked to the admin UI; got ${out.status} location=${out.location}`);
        assert.ok(!out.body.includes('"ok":true'), `foreign-vhost GET / must not receive the gateway health JSON; got ${out.body}`);
        assert.deepEqual(h.hits, [{ method: "GET", url: "/" }], "the request must reach the forward path untouched, exactly like every other path");
        assert.match(out.body, /upstream-site/, "client sees the upstream site's answer");
    } finally {
        await h.close();
    }
});

test("#5024 fixed: MITM-vhost root with Accept */* is NOT answered with the health JSON — it forwards", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/", { host: "chatgpt.com" });
        assert.notEqual(out.status, 302);
        assert.ok(!out.body.includes('"ok":true'), `Accept:*/* foreign-vhost GET / must forward, not return {ok:true}; got ${out.body}`);
        assert.deepEqual(h.hits, [{ method: "GET", url: "/" }]);
        assert.match(out.body, /upstream-site/);
    } finally {
        await h.close();
    }
});

test("#5024 fixed (same mechanism): MITM-vhost favicon probe forwards instead of getting bili's icon", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/favicon.ico", { host: "chatgpt.com" });
        assert.notEqual(out.contentType?.split(";")[0], "image/x-icon", `vhost favicon must not be answered with bili's bundled icon; got ${out.contentType}: ${out.body.slice(0, 40)}`);
        assert.deepEqual(h.hits, [{ method: "GET", url: "/favicon.ico" }], "the vhost's own favicon fetch must reach its upstream");
    } finally {
        await h.close();
    }
});

test("#5024 preserved: self-addressed favicon still served locally (dsh panel frame probe)", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/favicon.ico");
        assert.equal(out.status, 200);
        assert.equal(out.contentType?.split(";")[0], "image/x-icon", "gateway-origin favicon keeps its local answer");
        assert.ok(out.body.length > 0);
        assert.equal(h.hits.length, 0);
    } finally {
        await h.close();
    }
});

test("#5024 gate direction: self NAME on a different local port (SSH forward, #1537) still serves the welcome page", async () => {
    const h = await harness();
    try {
        const out = await rawGet(h.proxyPort, "/", { host: "localhost:18787", accept: "text/html" });
        assert.equal(out.status, 302, `ssh -L forwarded sessions present a different local port — the gate is port-insensitive by design (#1537); got ${out.status}`);
        assert.equal(out.location, "/__bili/");
        assert.equal(h.hits.length, 0);
    } finally {
        await h.close();
    }
});
