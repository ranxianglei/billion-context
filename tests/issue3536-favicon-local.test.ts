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
import { FAVICON_ICO_BASE64 } from "../src/web/favicon.ts";
import { rmrf } from "./tmp-rm.ts";

// #3536/#4830: browsers probe the proxy origin for /favicon.ico (the dsh
// desktop settings panel frames /__bili/ and the frame fires the probe at
// the ORIGIN ROOT). Unanswered, the probe falls through the relay onto the
// configured upstream — a wasted request plus 403/timeout noise in the log
// for a static asset no model client ever asks for. Three halves: the panel
// page declares the bundled icon explicitly (page.ts), the proxy serves the
// bundled .ico bytes locally at /favicon.ico as the backstop (admin.ts), and
// every OTHER unknown path keeps the documented relay fallthrough.

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

function get(port: number, reqPath: string, init?: RequestInit): Promise<{ status: number; contentType: string | null; cacheControl: string | null; buf: Buffer }> {
    return fetch(`http://127.0.0.1:${port}${reqPath}`, { ...init, signal: AbortSignal.timeout(5000) }).then(async (res) => ({
        status: res.status,
        contentType: res.headers.get("content-type"),
        cacheControl: res.headers.get("cache-control"),
        buf: Buffer.from(await res.arrayBuffer()),
    }));
}

/** Mock upstream shaped like the incident's Anthropic 403; records every hit. */
function startMockUpstream(): Promise<{ origin: string; hits: string[]; close: () => Promise<void> }> {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        req.on("end", () => {
            hits.push(`${req.method} ${req.url}`);
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "forbidden", message: "Request not allowed" } }));
        });
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

test("#4830: the panel page declares the bundled icon so browsers fetch it from /favicon.ico", () => {
    for (const embed of [false, true]) {
        const html = renderPage("http://127.0.0.1:8787", "0.0.0-test", embed);
        assert.ok(
            html.includes('<link rel="icon" type="image/x-icon" href="/favicon.ico">'),
            `embed=${embed}: the head must declare the bundled icon before <title>`,
        );
        assert.ok(html.indexOf('<link rel="icon"') < html.indexOf("<title>"), "icon link sits inside <head>");
    }
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("#4830: the embedded favicon constant decodes to a structurally valid .ico (16px + 32px PNG entries)", () => {
    const ico = Buffer.from(FAVICON_ICO_BASE64, "base64");
    assert.equal(ico.readUInt16LE(0), 0, "reserved field");
    assert.equal(ico.readUInt16LE(2), 1, "container type must be icon");
    const count = ico.readUInt16LE(4);
    assert.equal(count, 2, "one entry per shipped size");
    const sizes: number[] = [];
    let end = 6 + count * 16;
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16;
        const w = ico[e] === 0 ? 256 : ico[e];
        const h = ico[e + 1] === 0 ? 256 : ico[e + 1];
        assert.equal(w, h, `entry ${i}: square dimensions`);
        sizes.push(w);
        assert.equal(ico.readUInt16LE(e + 4), 1, `entry ${i}: planes`);
        assert.equal(ico.readUInt16LE(e + 6), 32, `entry ${i}: bit count`);
        const len = ico.readUInt32LE(e + 8);
        const off = ico.readUInt32LE(e + 12);
        assert.ok(off + len <= ico.length, `entry ${i}: payload inside buffer`);
        assert.ok(ico.subarray(off, off + 8).equals(PNG_MAGIC), `entry ${i}: PNG-compressed payload`);
        end = Math.max(end, off + len);
    }
    assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 32], "shipped sizes");
    assert.equal(end, ico.length, "no trailing bytes after the last entry");
});

test("#3536/#4830: GET /favicon.ico answers with the bundled icon locally and never reaches the upstream; other unknown paths keep the relay fallthrough", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-issue3536-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    const expected = Buffer.from(FAVICON_ICO_BASE64, "base64");
    const up = await startMockUpstream();
    const bili = await makeBili(up.origin);
    const port = (bili.address() as { port: number }).port;
    try {
        await waitReady(port);

        // Positive gate: the probe is answered locally with the bundled bytes.
        const fav = await get(port, "/favicon.ico");
        assert.equal(fav.status, 200, `favicon probe must be answered locally (got ${fav.status})`);
        assert.equal(fav.contentType, "image/x-icon");
        assert.equal(fav.cacheControl, "no-cache", "same cache posture as the page shell");
        assert.ok(fav.buf.equals(expected), "served bytes are exactly the bundled icon");
        const favQuery = await get(port, "/favicon.ico?v=1");
        assert.equal(favQuery.status, 200, "the query form is the same asset");
        assert.ok(favQuery.buf.equals(expected), "query form serves identical bytes");
        assert.deepEqual(up.hits, [], "no favicon probe may reach the configured upstream");

        // Both halves of the fix over real HTTP: the served panel page carries
        // the declaration that points well-behaved browsers at the asset.
        const page = await get(port, "/__bili/?embed=1");
        assert.equal(page.status, 200);
        assert.ok(page.buf.toString("utf8").includes('<link rel="icon" type="image/x-icon" href="/favicon.ico">'), "served panel HTML declares the bundled icon");

        // Negative gates: ONLY GET /favicon.ico is pinned local. A non-GET on
        // the same path and every other unknown path still fall through the
        // relay onto the configured upstream (documented zero-config tunnel).
        const post = await get(port, "/favicon.ico", { method: "POST", body: "{}" });
        assert.equal(post.status, 403, `POST on the favicon path keeps the relay fallthrough (got ${post.status})`);
        const other = await get(port, "/definitely/not/an/admin/path");
        assert.equal(other.status, 403, `unknown non-favicon paths keep the relay fallthrough (got ${other.status})`);
        assert.deepEqual(up.hits, ["POST /favicon.ico", "GET /definitely/not/an/admin/path"], "exactly the non-asset requests were relayed");
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig;
        bili.closeAllConnections?.();
        await close(bili);
        await up.close();
        try { rmrf(root); } catch { /* best-effort */ }
    }
});
