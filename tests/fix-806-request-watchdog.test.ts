import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, requestWatchdogBudgetMs } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { UPSTREAM_TIMEOUT_MS } from "../src/fetch-util.ts";
import { rmrf } from "./tmp-rm.ts";

function close(server: http.Server | net.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Harness {
    port: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstream: http.Server | net.Server, passthrough: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-fix806-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, "{}", "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough,
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        },
    };
}

const CHAT_BODY = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });

test("requestWatchdogBudgetMs: env override, default, and invalid values", () => {
    const prevWd = process.env.BILI_REQUEST_WATCHDOG_MS;
    const prevUp = process.env.BILI_UPSTREAM_TIMEOUT_MS;
    try {
        delete process.env.BILI_REQUEST_WATCHDOG_MS;
        delete process.env.BILI_UPSTREAM_TIMEOUT_MS;
        assert.equal(requestWatchdogBudgetMs(), 2 * UPSTREAM_TIMEOUT_MS);
        process.env.BILI_REQUEST_WATCHDOG_MS = "1500";
        assert.equal(requestWatchdogBudgetMs(), 1500);
        process.env.BILI_REQUEST_WATCHDOG_MS = "0";
        assert.equal(requestWatchdogBudgetMs(), 0);
        process.env.BILI_REQUEST_WATCHDOG_MS = "garbage";
        assert.equal(requestWatchdogBudgetMs(), 2 * UPSTREAM_TIMEOUT_MS);
    } finally {
        if (prevWd === undefined) delete process.env.BILI_REQUEST_WATCHDOG_MS; else process.env.BILI_REQUEST_WATCHDOG_MS = prevWd;
        if (prevUp === undefined) delete process.env.BILI_UPSTREAM_TIMEOUT_MS; else process.env.BILI_UPSTREAM_TIMEOUT_MS = prevUp;
    }
});

test("silent upstream: accepted request ends in 504 instead of hanging forever (#806)", async () => {
    // Accepts the TCP connection, sends nothing, never closes — the exact
    // wedge signature from #806 (zero outbound progress on a held request).
    const silentSockets: net.Socket[] = [];
    const silent = net.createServer((socket) => {
        silentSockets.push(socket);
        socket.on("error", () => {});
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const prev = process.env.BILI_REQUEST_WATCHDOG_MS;
    process.env.BILI_REQUEST_WATCHDOG_MS = "1500";
    const harness = await startProxy(silent, false);
    try {
        const ac = new AbortController();
        const guard = setTimeout(() => ac.abort(), 15_000);
        guard.unref?.();
        const started = Date.now();
        let res: Response;
        try {
            res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: CHAT_BODY,
                signal: ac.signal,
            });
        } catch (e) {
            throw new Error(`client request never completed in 15s — watchdog did not fire (${String(e)})`);
        }
        const body = (await res.json()) as { error?: { type?: string } };
        const elapsed = Date.now() - started;
        assert.equal(res.status, 504, `expected 504 from the watchdog, got ${res.status}`);
        assert.equal(body.error?.type, "gateway_timeout");
        assert.ok(elapsed >= 1400, `watchdog fired before its budget elapsed (${elapsed}ms < 1500ms)`);
        assert.ok(elapsed < 10_000, `watchdog took too long to fire (${elapsed}ms)`);
    } finally {
        if (prev === undefined) delete process.env.BILI_REQUEST_WATCHDOG_MS; else process.env.BILI_REQUEST_WATCHDOG_MS = prev;
        await harness.stop();
        harness.cleanup();
        // undici does not destroy its side of an aborted pre-response socket
        // (it lingers in the pool until headersTimeout), so close() on the raw
        // net server would wait forever — destroy our end explicitly first.
        for (const s of silentSockets) s.destroy();
        await close(silent);
    }
});

test("healthy long stream survives the watchdog — idle semantics, not total time (#806)", async () => {
    // 8 chunks at 400ms = ~3.2s total, which EXCEEDS the 1.5s budget. A
    // total-time deadline would cut the stream at 1.5s; the idle watchdog
    // re-arms on every byte written toward the client, so it completes.
    const intervalMs = 400;
    const totalChunks = 8;
    const streaming = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        let sent = 0;
        const t = setInterval(() => {
            sent += 1;
            res.write(`chunk-${sent}\n`);
            if (sent >= totalChunks) {
                clearInterval(t);
                res.end();
            }
        }, intervalMs);
        req.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => streaming.listen(0, "127.0.0.1", () => r()));
    const prev = process.env.BILI_REQUEST_WATCHDOG_MS;
    process.env.BILI_REQUEST_WATCHDOG_MS = "1500";
    const harness = await startProxy(streaming, true);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        const expected = Array.from({ length: totalChunks }, (_, i) => `chunk-${i + 1}\n`).join("");
        assert.equal(text, expected, "full stream must reach the client despite outliving the idle budget");
    } finally {
        if (prev === undefined) delete process.env.BILI_REQUEST_WATCHDOG_MS; else process.env.BILI_REQUEST_WATCHDOG_MS = prev;
        await harness.stop();
        harness.cleanup();
        (streaming as http.Server).closeAllConnections?.();
        await close(streaming);
    }
});

test("fast healthy response is unaffected by the watchdog (#806)", async () => {
    const fast = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
    });
    await new Promise<void>((r) => fast.listen(0, "127.0.0.1", () => r()));
    const prev = process.env.BILI_REQUEST_WATCHDOG_MS;
    process.env.BILI_REQUEST_WATCHDOG_MS = "60000";
    const harness = await startProxy(fast, true);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '{"ok":true}');
    } finally {
        if (prev === undefined) delete process.env.BILI_REQUEST_WATCHDOG_MS; else process.env.BILI_REQUEST_WATCHDOG_MS = prev;
        await harness.stop();
        harness.cleanup();
        (fast as http.Server).closeAllConnections?.();
        await close(fast);
    }
});
