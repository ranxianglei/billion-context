import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { listSessions } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

// #411: a client cancel mid-stream used to (1) drop the usage already sniffed
// (anthropic message_start input) so lastInputTokens froze at the previous
// turn, (2) log a context-free global [error] AbortError (~260/day on a real
// host), and (3) leak the fetchWithTimeout 10-minute idle timer because
// clearUpstreamTimer only ran on success paths. These tests drive real client
// aborts through the proxy against a slow-drip upstream.

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => void 0);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface Rig {
    proxyPort: number;
    proxyUrl: (path: string) => string;
    modelUrl: () => string;
    closeAll(): Promise<void>;
}

type UpstreamMode = "drip" | "cut" | "delayed-json";

async function startRig(mode: UpstreamMode = "drip"): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        if (mode === "delayed-json") {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "x", usage: { input_tokens: 99, output_tokens: 1 } }));
            }, 500);
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1234 } } }));
        res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        if (mode === "cut") {
            setTimeout(() => res.destroy(), 50);
            return;
        }
        let i = 0;
        const t = setInterval(() => {
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `x${i++} ` } }));
        }, 25);
        req.on("close", () => {
            clearInterval(t);
            res.destroy();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "i411-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: true,
        logFile: "/dev/null",
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        closeAll: async () => {
            await close(proxy);
            await close(upstream);
        },
    };
}

async function register(rig: Rig, conversationId: string): Promise<void> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: "mcp" }),
    });
    assert.equal(res.status, 200, "register accepted");
}

function modelBody(stream: boolean): string {
    return JSON.stringify({ model: "i411-model", max_tokens: 8192, stream, messages: [{ role: "user", content: "hello" }] });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error("condition not met within timeout");
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("#411 plugin stream: client abort keeps sniffed usage, logs info (not error), clears the upstream timer", async () => {
    const rig = await startRig("drip");
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        await register(rig, "i411-conv-1");
        const ac = new AbortController();
        const res = await fetch(rig.modelUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: modelBody(true), signal: ac.signal });
        assert.equal(res.status, 200);
        const reader = res.body!.getReader();
        await reader.read();
        await reader.read();
        ac.abort();
        await waitFor(() => listSessions().some((s) => s.stats.lastInputTokens === 1234));
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
        assert.ok(captured.some((l) => l.level === "info" && l.msg.includes("client aborted mid-stream")), `expected info abort log, got: ${JSON.stringify(captured)}`);
        assert.ok(!captured.some((l) => l.level === "error" && l.msg.includes("AbortError")), `no bare AbortError error log, got: ${JSON.stringify(captured.filter((l) => l.level === "error"))}`);
    } finally {
        setLogCapture(null);
        await rig.closeAll();
    }
});

test("#411 abort storm: repeated client cancels do not accumulate upstream timers", async () => {
    const rig = await startRig("drip");
    try {
        await register(rig, "i411-conv-2");
        for (let round = 0; round < 3; round++) {
            const ac = new AbortController();
            const res = await fetch(rig.modelUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: modelBody(true), signal: ac.signal });
            const reader = res.body!.getReader();
            await reader.read();
            await reader.read();
            ac.abort();
            await waitFor(() => _liveUpstreamTimersForTest() === 0);
        }
        assert.equal(_liveUpstreamTimersForTest(), 0);
    } finally {
        await rig.closeAll();
    }
});

test("#411 upstream cut with client alive: usage still lands, failure is a real error", async () => {
    const rig = await startRig("cut");
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        await register(rig, "i411-conv-3");
        const res = await fetch(rig.modelUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: modelBody(true) });
        assert.equal(res.status, 200);
        const reader = res.body!.getReader();
        try {
            for (;;) {
                const { done } = await reader.read();
                if (done) break;
            }
        } catch {
            // upstream socket destroyed mid-stream — the client sees a cut
        }
        await waitFor(() => listSessions().some((s) => s.stats.lastInputTokens === 1234));
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
        assert.ok(!captured.some((l) => l.msg.includes("client aborted mid-stream")), "client-alive cut must not be classified as a client abort");
    } finally {
        setLogCapture(null);
        await rig.closeAll();
    }
});

test("#411 plugin non-stream: client abort mid-body does not crash and clears the timer", async () => {
    const rig = await startRig("delayed-json");
    try {
        await register(rig, "i411-conv-4");
        const ac = new AbortController();
        const p = fetch(rig.modelUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: modelBody(false), signal: ac.signal });
        const res = await p;
        assert.equal(res.status, 200);
        setTimeout(() => ac.abort(), 60);
        await assert.doesNotReject(async () => {
            try {
                await res.arrayBuffer();
            } catch {
                // aborted mid-body — expected
            }
        });
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
    } finally {
        await rig.closeAll();
    }
});

test("#411 anonymous passthrough: client abort clears the timer and logs info", async () => {
    const rig = await startRig("drip");
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        const ac = new AbortController();
        const res = await fetch(rig.modelUrl(), { method: "GET", signal: ac.signal });
        assert.equal(res.status, 200);
        const reader = res.body!.getReader();
        await reader.read();
        ac.abort();
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
        assert.ok(!captured.some((l) => l.level === "error" && l.msg.includes("AbortError")), `no bare AbortError error log, got: ${JSON.stringify(captured.filter((l) => l.level === "error"))}`);
    } finally {
        setLogCapture(null);
        await rig.closeAll();
    }
});
