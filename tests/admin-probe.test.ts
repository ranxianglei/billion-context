import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { selfAdminProbePath, startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

/** #1073: forward-proxy-style (absolute-form) management probes addressed to
 *  bili instances must return real health state instead of being tunneled and
 *  403'd by the target's own admin gate — while every #409 security property
 *  (self-layer denial, remote-peer marker, hostname marker) stays intact. */

test("selfAdminProbePath: self-addressed management probes only", () => {
    const P = 8787;
    // Self shapes qualify (IP literals, v6, hex-mapped, unspecified, localhost).
    assert.equal(selfAdminProbePath(`http://127.0.0.1:${P}/__bili/health`, P), "/__bili/health");
    assert.equal(selfAdminProbePath(`http://127.0.0.1:${P}/__bili/config?x=1`, P), "/__bili/config?x=1", "query preserved");
    assert.equal(selfAdminProbePath(`http://localhost:${P}/__acp/status`, P), "/__acp/status");
    assert.equal(selfAdminProbePath(`http://[::1]:${P}/__bili/`, P), "/__bili/");
    assert.equal(selfAdminProbePath(`http://[::ffff:127.0.0.1]:${P}/__bili/health`, P), "/__bili/health", "hex-mapped loopback folds to 127.0.0.1");
    assert.equal(selfAdminProbePath(`http://0.0.0.0:${P}/__bili/health`, P), "/__bili/health");
    assert.equal(selfAdminProbePath(`http://[::]:${P}/__acp/x`, P), "/__acp/x", "v6 unspecified in brackets");
    // Not self: different port (the cross-instance shape) or non-local host.
    assert.equal(selfAdminProbePath(`http://127.0.0.1:${P + 1}/__bili/health`, P), undefined, "different port is not self");
    assert.equal(selfAdminProbePath(`http://8.8.8.8:${P}/__bili/health`, P), undefined, "public IP is not self");
    assert.equal(selfAdminProbePath(`http://otherhost.invalid:${P}/__bili/health`, P), undefined, "foreign names stay conservative");
    // Self host but non-management path keeps the loud self-layer 403 (#562).
    assert.equal(selfAdminProbePath(`http://127.0.0.1:${P}/v1/chat/completions`, P), undefined);
    assert.equal(selfAdminProbePath(`http://127.0.0.1:${P}/__notadmin/`, P), undefined);
    // Not absolute-form at all.
    assert.equal(selfAdminProbePath("/__bili/health", P), undefined);
    // Malformed input never throws.
    assert.equal(selfAdminProbePath("http://[::1:", P), undefined);
    assert.equal(selfAdminProbePath("http://127.0.0.1:/__bili/", P), undefined);
    assert.equal(selfAdminProbePath(`http://127.0.0.1:${P}/__bili/health`, undefined), undefined, "no local port — cannot decide");
});

// ---------------------------------------------------------------------------
// Integration: real servers, real sockets (absolute-form requires raw writes —
// node:http always emits origin-form).

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

/** Send an absolute-form (forward-proxy style) request: `GET <targetUrl>` with
 *  an explicit Host header, over a fresh loopback socket. */
function absoluteGet(port: number, targetUrl: string, hostHeader: string): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("data", (c: Buffer) => { data += c.toString("utf8"); });
    sock.on("end", () => {
        const i = data.indexOf("\r\n\r\n");
        if (i < 0) return reject(new Error(`no response headers: ${data.slice(0, 200)}`));
        const status = Number(data.split(" ", 2)[1]);
        let body = data.slice(i + 4);
        // Node chunks responses without a Content-Length even when the client
        // asked for connection: close — strip chunk framing if present.
        if (/^[0-9a-f]+\r\n/i.test(body)) {
            const out: string[] = [];
            let rest = body;
            for (;;) {
                const nl = rest.indexOf("\r\n");
                const size = parseInt(rest.slice(0, nl).split(";")[0], 16);
                if (!Number.isFinite(size)) break;
                if (size === 0) break;
                out.push(rest.slice(nl + 2, nl + 2 + size));
                rest = rest.slice(nl + 2 + size + 2);
            }
            body = out.join("");
        }
        resolve({ status, body });
    });
    sock.once("error", reject);
    sock.write(`GET ${targetUrl} HTTP/1.1\r\nhost: ${hostHeader}\r\nconnection: close\r\n\r\n`);
    return promise;
}

async function makeBili(): Promise<http.Server> {
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
    return proxy;
}

test("integration: absolute-form management probes answer with real health state (#1073)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-admin-probe-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    const p1 = await makeBili();
    const p2 = await makeBili();
    const port1 = (p1.address() as { port: number }).port;
    const port2 = (p2.address() as { port: number }).port;
    try {
        const health1 = await get(port1, "/__bili/health");
        const health2 = await get(port2, "/__bili/health");
        assert.equal(health1.status, 200);
        assert.equal(health2.status, 200);
        const id1 = JSON.parse(health1.body).instanceId;
        const id2 = JSON.parse(health2.body).instanceId;
        assert.notEqual(id1, id2, "two distinct instances");

        // SELF shape: prober configured with P1's own port as its proxy asks
        // for http://127.0.0.1:<P1>/__bili/health. Pre-fix: tunneled onto
        // itself → 403 "the bili tunnel may not target the proxy itself".
        const selfProbe = await absoluteGet(port1, `http://127.0.0.1:${port1}/__bili/health`, `127.0.0.1:${port1}`);
        assert.equal(selfProbe.status, 200, `self-addressed probe must be served locally (got ${selfProbe.status}: ${selfProbe.body})`);
        assert.equal(JSON.parse(selfProbe.body).instanceId, id1, "answered by the probed instance itself");
        assert.equal(JSON.parse(selfProbe.body).ok, true);

        // CROSS-INSTANCE shape: the incident's traffic — connection lands on P1,
        // absolute target points at sibling P2. Pre-fix: P1 relayed WITH the
        // x-bili-tunnel marker → P2's admin gate 403 "management endpoints are
        // not reachable through the bili tunnel" (×2372 in the wild).
        const crossProbe = await absoluteGet(port1, `http://127.0.0.1:${port2}/__bili/health`, `127.0.0.1:${port2}`);
        assert.equal(crossProbe.status, 200, `loopback→loopback sibling probe must pass unmarked (got ${crossProbe.status}: ${crossProbe.body})`);
        assert.equal(JSON.parse(crossProbe.body).instanceId, id2, "reached the TARGET instance, not the relay");

        // SECURITY REGRESSION: hostname destination is not an IP literal → the
        // marker stays stamped (DNS-rebinding conservatism) → target still 403s.
        const byName = await absoluteGet(port1, `http://localhost:${port2}/__bili/health`, `localhost:${port2}`);
        assert.equal(byName.status, 403, "hostname-targeted cross-instance probe keeps the tunnel marker");
        assert.match(byName.body, /management endpoints are not reachable through the bili tunnel/);
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        p1.closeAllConnections?.();
        await close(p1);
        p2.closeAllConnections?.();
        await close(p2);
        try { rmrf(root); } catch { /* best-effort */ }
    }
});
