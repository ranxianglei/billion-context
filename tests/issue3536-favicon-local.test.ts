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
import { renderPage } from "../src/web/page.ts";
import { rmrf } from "./tmp-rm.ts";

// #3536: the dsh desktop settings panel frames /__bili/ and the browser fires
// GET /favicon.ico at the ORIGIN ROOT — which matched no admin route and fell
// through the relay onto the configured upstream (a wasted request + 403 noise
// in the log, upstream host visible in the panel's network tab). Two halves:
// the panel page declares an empty icon so well-behaved browsers never probe,
// and the proxy answers the probe locally (204) as a backstop — while every
// OTHER unknown path keeps the documented relay fallthrough.

async function waitReady(port: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`proxy on port ${port} did not become ready`);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function get(port: number, reqPath: string): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, signal: AbortSignal.timeout(5000) }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
    return promise;
}

/** Mock upstream shaped like the incident's Anthropic 403; records every hit. */
function startMockUpstream(): Promise<{ origin: string; hits: string[]; close: () => Promise<void> }> {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "forbidden", message: "Request not allowed" } }));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({
                origin: `http://127.0.0.1:${port}`,
                hits,
                close: async () => {
                    server.closeAllConnections?.();
                    await close(server);
                },
            });
        });
    });
}

async function makeBili(upstream: string): Promise<http.Server> {
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream,
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
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return proxy;
}

test("#3536: the panel page declares an empty icon so browsers never probe /favicon.ico", () => {
    for (const embed of [false, true]) {
        const html = renderPage("http://127.0.0.1:8787", "0.0.0-test", embed);
        assert.ok(
            html.includes('<link rel="icon" href="data:,">'),
            `embed=${embed}: the head must declare the empty icon before <title>`,
        );
        assert.ok(html.indexOf('<link rel="icon"') < html.indexOf("<title>"), "icon link sits inside <head>");
    }
});

test("#3536: GET /favicon.ico on the proxy origin answers 204 locally and never reaches the upstream; other unknown paths keep the relay fallthrough", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-issue3536-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    const up = await startMockUpstream();
    const bili = await makeBili(up.origin);
    const port = (bili.address() as { port: number }).port;
    try {
        await waitReady(port);

        const fav = await get(port, "/favicon.ico");
        assert.equal(fav.status, 204, `favicon probe must be answered locally (got ${fav.status}: ${fav.body.slice(0, 200)})`);
        assert.equal(fav.body, "");
        const favQuery = await get(port, "/favicon.ico?v=1");
        assert.equal(favQuery.status, 204, "the query form is the same asset");
        assert.deepEqual(up.hits, [], "no favicon probe may reach the configured upstream");

        // Both halves of the fix over real HTTP: the served panel page carries
        // the declaration that stops well-behaved browsers from probing at all.
        const page = await get(port, "/__bili/?embed=1");
        assert.equal(page.status, 200);
        assert.ok(page.body.includes('<link rel="icon" href="data:,">'), "served panel HTML declares the empty icon");

        // Regression guard: ONLY the favicon path is pinned local — every other
        // unknown path still falls through the relay onto the configured
        // upstream (the documented zero-config tunnel behavior).
        const other = await get(port, "/definitely/not/an/admin/path");
        assert.equal(other.status, 403, `unknown non-favicon paths keep the relay fallthrough (got ${other.status}: ${other.body.slice(0, 200)})`);
        assert.deepEqual(up.hits, ["GET /definitely/not/an/admin/path"], "exactly the non-favicon request was relayed");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        bili.closeAllConnections?.();
        await close(bili);
        await up.close();
        try { rmrf(root); } catch { /* best-effort */ }
    }
});
