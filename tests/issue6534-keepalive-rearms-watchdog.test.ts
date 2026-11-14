import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import {
    startServer,
    _resetRequestWatchdogSeamsForTest,
} from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Harness {
    port: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstream: http.Server, passthrough: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-6534-${process.pid}-${Date.now()}`);
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
        streamErrorShape: "protocol",
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
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

const CHAT_BODY = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });

/**
 * #6534: a committed stream that stalls after writing some bytes must still be
 * terminated by the request watchdog.
 *
 * Root cause: the stream keepalive (#1647) writes SSE comment pings to hold the
 * client across upstream silence. Those pings went through the patched
 * res.write, which re-arms the idle watchdog on every write. With the
 * keepalive's ~10s effective cadence always beating the 24-min idle budget,
 * fire() never ran — a truly stalled stream held the client forever (the
 * incident: 4h12m of silence, no watchdog log line).
 *
 * Fix: the keepalive now emits its pings through the pre-watchdog write
 * (stored by armRequestWatchdog), so a ping does NOT re-arm the idle timer.
 *
 * This test reproduces the bug and verifies the fix: with the keepalive
 * enabled (default), a stalled SSE stream is terminated by the watchdog within
 * its idle budget. Before the fix the keepalive re-armed the watchdog and the
 * request hung indefinitely.
 */
test("#6534: stalled SSE stream — watchdog fires even with keepalive enabled", async () => {
    // Upstream: sends 2xx SSE headers + one small chunk, then goes silent
    // forever (never ends, never sends more). This is the incident shape: a
    // committed stream that stalls mid-body.
    const stalled = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("data: partial\n\n");
        // Then silence — no more writes, no end. The socket stays open until
        // the proxy aborts it (watchdog fire) or the test tears it down.
        req.on("close", () => { /* client/proxy went away — nothing to clean up */ });
    });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", () => r()));

    const prevWd = process.env.BILI_REQUEST_WATCHDOG_MS;
    const prevKa = process.env.BILI_STREAM_KEEPALIVE_MS;
    _resetRequestWatchdogSeamsForTest();
    // 2s idle budget — short enough to fire well inside the 8s guard.
    process.env.BILI_REQUEST_WATCHDOG_MS = "2000";
    // Keepalive at default cadence would write every ~10s — slower than the 2s
    // budget, so it would NOT re-arm in time even before the fix. Force a fast
    // keepalive (idleMs=500 → interval ~167ms, effective ~333ms) so that,
    // BEFORE the fix, it re-arms the watchdog well inside the 2s budget and the
    // bug manifests (request hangs). AFTER the fix, the pings bypass the
    // watchdog, so it fires at 2s regardless of the keepalive cadence.
    process.env.BILI_STREAM_KEEPALIVE_MS = "500";
    const harness = await startProxy(stalled, false);
    try {
        const ac = new AbortController();
        const guard = setTimeout(() => ac.abort(), 8_000);
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
            throw new Error(`client request never completed in 8s — the watchdog did not fire (the #6534 bug: keepalive re-arms it) (${String(e)})`);
        }
        const body = await res.text();
        const elapsed = Date.now() - started;
        // The watchdog fired: the response was committed (200) and then ended
        // by the watchdog (res.end()), so the client sees a 200 with the
        // partial body + keepalive comments, terminated well inside the guard.
        assert.ok(elapsed >= 1_800, `watchdog fired before its budget elapsed (${elapsed}ms < 2000ms)`);
        assert.ok(elapsed < 8_000, `watchdog took too long to fire (${elapsed}ms) — keepalive may still be re-arming it (the #6534 bug)`);
        // The body carries the upstream's first chunk; the keepalive comments
        // may also be present (they are SSE no-ops). The key assertion is the
        // elapsed time: the stream was terminated by the watchdog, not hung.
        assert.ok(body.includes("data: partial"), `expected the upstream's first chunk in the body, got: ${body.slice(0, 200)}`);
    } finally {
        _resetRequestWatchdogSeamsForTest();
        if (prevWd === undefined) delete process.env.BILI_REQUEST_WATCHDOG_MS; else process.env.BILI_REQUEST_WATCHDOG_MS = prevWd;
        if (prevKa === undefined) delete process.env.BILI_STREAM_KEEPALIVE_MS; else process.env.BILI_STREAM_KEEPALIVE_MS = prevKa;
        await harness.stop();
        harness.cleanup();
        (stalled as http.Server).closeAllConnections?.();
        await close(stalled);
    }
});
