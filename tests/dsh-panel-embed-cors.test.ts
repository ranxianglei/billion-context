import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

/** The dsh settings pane (#1590/#3100) pre-flights the embed face with a
 *  cors-mode `fetch(`${proxy}/__bili/?embed=1`)` from the dsh web origin
 *  (e.g. http://127.0.0.1:3080) — a CROSS-origin read of the proxy's UI
 *  route. Both hostnames are loopback names, so isTrustedAdminOrigin admits
 *  the request, but the browser only hands a cors response to JS when it
 *  carries access-control-allow-origin. Without the echo the probe rejects,
 *  the #3100 verdict never lands, and the pane stays on
 *  "connecting to the bili proxy…" forever while the proxy itself (model
 *  traffic, iframe navigation) keeps working. These tests pin the echo. */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(
    port: number,
    headers: Record<string, string>,
): Promise<{ status: number; acao: string | undefined; contentType: string | undefined; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; acao: string | undefined; contentType: string | undefined; body: string }>();
    const req = http.request(
        { host: "127.0.0.1", port, path: "/__bili/?embed=1", headers },
        (res) => {
            let body = "";
            res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                acao: res.headers["access-control-allow-origin"],
                contentType: res.headers["content-type"],
                body,
            }));
        },
    );
    req.once("error", reject);
    req.end();
    return promise;
}

test("embed face echoes access-control-allow-origin for cross-origin pane probes (#3100 fallout)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-embed-cors-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    const port = 8033 + (process.pid % 500);
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
    if (!proxy.listening) await once(proxy, "listening");
    const actualPort = (proxy.address() as { port: number }).port;
    const trusted = `127.0.0.1:${actualPort}`;
    try {
        // The dsh web pane: same loopback hostname, DIFFERENT port → cross-origin
        // for CORS, admitted by the trusted-origin gate (hostname-only, #1537).
        const paneLike = await request(actualPort, { host: trusted, origin: `http://127.0.0.1:3080` });
        assert.equal(paneLike.status, 200, "pane probe must be admitted");
        assert.match(String(paneLike.contentType ?? ""), /text\/html/, "embed face serves HTML");
        assert.equal(paneLike.acao, "http://127.0.0.1:3080", "probe response must echo the requesting origin so the browser exposes it");

        // Non-browser clients (curl, harness): no Origin header → no echo needed.
        const curlLike = await request(actualPort, { host: trusted });
        assert.equal(curlLike.status, 200);
        assert.equal(curlLike.acao, undefined, "no Origin → no access-control-allow-origin");

        // The bundled UI's own fetches stay same-origin: echo is exact, not "*".
        const sameHost = await request(actualPort, { host: `localhost:${actualPort}`, origin: `http://localhost:${actualPort}` });
        assert.equal(sameHost.status, 200);
        assert.equal(sameHost.acao, `http://localhost:${actualPort}`);

        // The rebinding gate is untouched: a foreign origin is still refused
        // BEFORE any CORS consideration (loopback-name pinning, #115).
        const spoofed = await request(actualPort, { host: trusted, origin: "http://evil.com:8080" });
        assert.equal(spoofed.status, 403, "non-loopback Origin must still be rejected");

        // #3513 (desktop variant): the dsh desktop Electron app renders the
        // pane from the custom scheme origin dsh-app://app. The gate must
        // admit exactly that origin so the probe's cors read carries the echo
        // (real-world console: "blocked by CORS policy … from origin
        // 'dsh-app://app'" with a bare 403).
        const desktop = await request(actualPort, { host: trusted, origin: "dsh-app://app" });
        assert.equal(desktop.status, 200, "dsh-app://app pane probe must be admitted");
        assert.equal(desktop.acao, "dsh-app://app", "desktop scheme origin must be echoed verbatim");

        // The allowance is the dsh desktop convention ONLY: a foreign hostname
        // under the same scheme, or any other custom scheme, stays rejected.
        const desktopEvil = await request(actualPort, { host: trusted, origin: "dsh-app://evil" });
        assert.equal(desktopEvil.status, 403, "dsh-app with a foreign hostname must be rejected");
        const fileLike = await request(actualPort, { host: trusted, origin: "file://" });
        assert.equal(fileLike.status, 403, "other non-http schemes stay rejected");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        proxy.closeAllConnections?.();
        await close(proxy);
        try { rmrf(root); } catch { /* best-effort */ }
    }
});
