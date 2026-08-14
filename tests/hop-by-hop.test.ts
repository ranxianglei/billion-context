import test from "node:test";
import assert from "node:assert/strict";
import http, { IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/** #80: hop-by-hop headers must never be forwarded. Static set
 *  (proxy-authorization, te, trailer, upgrade, …) AND headers dynamically
 *  named in the `Connection:` header (RFC 7230 §6.1) are stripped in both
 *  directions. proxy-authorization in particular carries client→proxy
 *  credentials that must not leak to the model endpoint. */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("forward: strips hop-by-hop and Connection-named headers both ways (#80)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let capturedReqHeaders: IncomingHttpHeaders = {};
    const upstream = http.createServer((req, res) => {
        capturedReqHeaders = req.headers;
        res.writeHead(200, {
            "content-type": "application/json",
            "x-upstream-keep": "yes",
            // Hop-by-hop on the response side: static + Connection-named.
            "proxy-authenticate": 'Basic realm="upstream"',
            "trailer": "x-upstream-trail",
            "connection": "x-upstream-drop",
            "x-upstream-drop": "must-not-reach-client",
        });
        res.end("{}");
    });
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
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // undici (fetch) refuses caller-supplied `connection` headers, so use a
        // raw http.request — the proxy must see exactly these bytes.
        const resp = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders; body: string }>();
        const req = http.request(
            {
                host: "127.0.0.1",
                port: proxyPort,
                path: `/bili/http://127.0.0.1:${upstreamPort}/v1/models`,
                headers: {
                    // Static hop-by-hop with credentials — must NOT reach upstream.
                    "proxy-authorization": "Basic dXNlcjpwYXNz",
                    // RFC 7230 §6.1: x-client-drop is named in Connection → hop-by-hop.
                    "connection": "x-client-drop",
                    "x-client-drop": "must-not-reach-upstream",
                    // End-to-end header — must be forwarded.
                    "x-client-keep": "yes",
                },
            },
            (res) => {
                let body = "";
                res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
                res.on("end", () => resp.resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
            },
        );
        req.once("error", (e) => resp.reject(e));
        req.end();
        const res = await resp.promise;
        assert.equal(res.status, 200);

        // Request direction.
        assert.equal(capturedReqHeaders["proxy-authorization"], undefined,
            "proxy-authorization must not leak to the model endpoint");
        assert.equal(capturedReqHeaders["x-client-drop"], undefined,
            "Connection-named request headers are hop-by-hop");
        assert.equal(capturedReqHeaders["x-client-keep"], "yes",
            "end-to-end headers are forwarded");

        // Response direction.
        assert.equal(res.headers["proxy-authenticate"], undefined);
        assert.equal(res.headers["x-upstream-drop"], undefined,
            "Connection-named response headers are hop-by-hop");
        assert.equal(res.headers["x-upstream-keep"], "yes",
            "end-to-end response headers are forwarded");
    } finally {
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});
