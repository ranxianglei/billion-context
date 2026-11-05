import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #3245: ZCode routes its plain-HTTP traffic through bili's own listener when
// its GUI Network setting points at the local proxy. Such clients emit
// absolute-form requests whose target IS the proxy endpoint for its own
// surfaces (/bili/ provider routes, admin probes) — those must be served
// locally like direct connections, never denied by the tunnel self-layer.
// Absolute-form requires raw socket writes (node:http always emits origin form).

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface RawResponse { status: number; body: string }

/** Send an absolute-form request over a fresh loopback socket and read the full response. */
function absoluteRequest(port: number, method: string, targetUrl: string, hostHeader: string, body?: string): Promise<RawResponse> {
    const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("data", (c: Buffer) => { data += c.toString("utf8"); });
    sock.on("end", () => {
        const i = data.indexOf("\r\n\r\n");
        if (i < 0) return reject(new Error(`no response headers: ${data.slice(0, 200)}`));
        const status = Number(data.split(" ", 2)[1]);
        let respBody = data.slice(i + 4);
        // Node chunks responses without a Content-Length even when the client
        // asked for connection: close — strip chunk framing if present.
        if (/^[0-9a-f]+\r\n/i.test(respBody)) {
            const out: string[] = [];
            let rest = respBody;
            for (;;) {
                const nl = rest.indexOf("\r\n");
                const size = parseInt(rest.slice(0, nl).split(";")[0], 16);
                if (!Number.isFinite(size)) break;
                if (size === 0) break;
                out.push(rest.slice(nl + 2, nl + 2 + size));
                rest = rest.slice(nl + 2 + size + 2);
            }
            respBody = out.join("");
        }
        resolve({ status, body: respBody });
    });
    sock.once("error", reject);
    const payload = body ?? "";
    sock.write(`${method} ${targetUrl} HTTP/1.1\r\nhost: ${hostHeader}\r\nconnection: close\r\n${payload ? `content-length: ${Buffer.byteLength(payload)}\r\n` : ""}\r\n${payload}`);
    return promise;
}

test("#3245: ZCode-shaped traffic through the local bili listener is served locally, not self-denied", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const received: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            received.push(req.url ?? "");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const upOrigin = `http://127.0.0.1:${upstreamPort}`;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: upOrigin,
        routes: {},
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
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const selfOrigin = `http://127.0.0.1:${proxyPort}`;

    try {
        // A: the reported shape — provider route through the local listener,
        // emitted by an app-level proxy stack (Host = the proxy itself).
        // Pre-fix: 403 "the bili tunnel may not target the proxy itself".
        const routeProbe = await absoluteRequest(proxyPort, "GET", `${selfOrigin}/bili/${upOrigin}/v1/models`, `127.0.0.1:${proxyPort}`);
        assert.equal(routeProbe.status, 200, `self-addressed /bili/ route must be forwarded, got ${routeProbe.status}: ${routeProbe.body}`);
        assert.ok(received.includes("/v1/models"), `embedded upstream must receive the path; saw ${JSON.stringify(received)}`);

        // B: model-request shape through the same stack.
        const chat = await absoluteRequest(proxyPort, "POST", `${selfOrigin}/bili/${upOrigin}/v1/chat/completions`, `127.0.0.1:${proxyPort}`, JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hi" }] }));
        assert.equal(chat.status, 200, `self-addressed /bili/ model request must be forwarded, got ${chat.status}: ${chat.body}`);
        assert.ok(received.filter((u) => u === "/v1/chat/completions").length >= 1, `embedded upstream must receive the model request; saw ${JSON.stringify(received)}`);

        // C: admin self-probe stays served locally (#1073 behavior under the new path).
        const health = await absoluteRequest(proxyPort, "GET", `${selfOrigin}/__bili/health`, `127.0.0.1:${proxyPort}`);
        assert.equal(health.status, 200, `self-addressed admin probe must be served locally, got ${health.status}: ${health.body}`);
        assert.equal(JSON.parse(health.body).ok, true);

        // D: an explicit /bili/ wrapper whose EMBEDDED destination is the proxy
        // itself is still a genuine self-tunnel — the self-layer denial holds.
        const wrapped = await httpGet(proxyPort, `/bili/${selfOrigin}/v1/models`);
        assert.equal(wrapped.status, 403, `explicit self-wrapper must stay denied, got ${wrapped.status}: ${wrapped.body}`);
        assert.match(wrapped.body, /tunnel_destination_denied/, wrapped.body);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

function httpGet(port: number, reqPath: string): Promise<RawResponse> {
    const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
    return promise;
}
