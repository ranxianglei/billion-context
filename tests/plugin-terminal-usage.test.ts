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
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

process.env.NODE_ENV = "test";
const root = mkdtempSync(join(tmpdir(), "bili-terminal-usage-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

interface StatusResponse {
    sessionId: string;
    sessionRevision: string;
    contextTokensSource: "usage" | "estimate" | "unavailable";
    contextTokens: number | null;
    contextTokensAt: number | null;
    contextGeneration: string | null;
    inputTokens: number;
    cachedTokens: number;
}

function barrier() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    return { wait, release };
}

function frame(event: Record<string, unknown>) {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function harness(terminal: Record<string, unknown>, late = "") {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    _setForTest({});
    const sendTerminal = barrier();
    const endStream = barrier();
    let upstreamEnded = false;
    const initial = frame({ type: "response.output_text.delta", item_id: "msg_terminal", output_index: 0, delta: "answer" });
    const terminalFrame = frame(terminal);
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", async () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(initial);
            await sendTerminal.wait;
            res.write(terminalFrame);
            await endStream.wait;
            upstreamEnded = true;
            res.end(late);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "terminal-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;
    const response = await fetch(`${origin}/bili/${upstreamUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "terminal-usage" }, body: JSON.stringify({ model: "terminal-test", stream: true, input: [{ role: "user", content: "first original ".repeat(250) }], max_output_tokens: 1024 }) });
    assert.equal(response.status, 200);
    assert(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    const readThrough = async (target: string) => {
        while (!wire.includes(target)) {
            const { done, value } = await reader.read();
            assert(!done, "HTTP stream ended before the expected frame");
            wire += decoder.decode(value, { stream: true });
        }
    };
    await readThrough(initial);
    const status = async (): Promise<StatusResponse> => {
        const r = await fetch(`${origin}/__bili/plugin/status?conversationId=terminal-usage`);
        assert.equal(r.status, 200);
        return await r.json() as StatusResponse;
    };
    const drain = async () => {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            wire += decoder.decode(value, { stream: true });
        }
        wire += decoder.decode();
    };
    return {
        status, session: resolveConversation("terminal-usage").session!,
        terminal: async () => { sendTerminal.release(); await readThrough(terminalFrame); },
        finish: async () => { endStream.release(); await drain(); assert.equal(wire, initial + terminalFrame + late); },
        upstreamEnded: () => upstreamEnded,
        close: async () => {
            sendTerminal.release(); endStream.release();
            await drain();
            store.cancelAll();
            const closed = Promise.all([once(proxy, "close"), once(upstream, "close")]);
            proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.();
            await closed;
        },
    };
}

test("HTTP Responses terminal usage is observable before upstream EOF without double billing", { timeout: 10000 }, async () => {
    const h = await harness({ type: "response.completed", response: { id: "resp_terminal", status: "completed", output: [], usage: { input_tokens: 8971, output_tokens: 13, input_tokens_details: { cached_tokens: 1024 } } } });
    try {
        const pending = await h.status();
        assert.equal(pending.contextTokensSource, "estimate");
        await h.terminal();
        assert.equal(h.upstreamEnded(), false);
        const terminal = await h.status();
        assert.equal(terminal.contextTokensSource, "usage");
        assert.equal(terminal.contextTokens, 8971);
        assert.equal(terminal.sessionId, h.session.id);
        assert.equal(terminal.sessionRevision, pending.sessionRevision);
        assert.notEqual(terminal.contextGeneration, pending.contextGeneration);
        assert.equal(typeof terminal.contextTokensAt, "number");
        assert.equal((await h.status()).contextGeneration, terminal.contextGeneration);
        assert.deepEqual([terminal.inputTokens, terminal.cachedTokens, h.session.stats.outputTokens], [0, 0, 0], "observation does not book the request before its final usage settles");
        await h.finish();
        const final = await h.status();
        assert.equal(final.contextTokensSource, "usage");
        assert.equal(final.contextTokens, 8971);
        assert.equal(h.session.stats.requests, 1);
        assert.deepEqual([final.inputTokens, final.cachedTokens, h.session.stats.outputTokens, h.session.stats.cacheSamples], [8971, 1024, 13, 1]);
    } finally { await h.close(); }
});

test("HTTP Responses late usage revises the final sample without billing the terminal observation twice", { timeout: 10000 }, async () => {
    const late = frame({ type: "response.usage", usage: { prompt_tokens: 9100, completion_tokens: 21, prompt_tokens_details: { cached_tokens: 2048 } } });
    const h = await harness({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 8971, output_tokens: 13 } } }, late);
    try {
        await h.terminal();
        assert.equal(h.upstreamEnded(), false);
        const terminal = await h.status();
        assert.deepEqual([terminal.contextTokensSource, terminal.contextTokens, terminal.inputTokens], ["usage", 8971, 0]);
        await h.finish();
        const final = await h.status();
        assert.deepEqual([final.contextTokensSource, final.contextTokens, final.inputTokens, final.cachedTokens], ["usage", 9100, 9100, 2048]);
        assert.equal(h.session.stats.requests, 1);
        assert.deepEqual([h.session.stats.outputTokens, h.session.stats.cacheSamples], [21, 1]);
    } finally { await h.close(); }
});

test("HTTP Responses duplicate completion only settles one request", { timeout: 10000 }, async () => {
    const terminal = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 8971, output_tokens: 13, input_tokens_details: { cached_tokens: 1024 } } } };
    const h = await harness(terminal, frame(terminal));
    try {
        await h.terminal();
        assert.equal((await h.status()).contextTokensSource, "usage");
        await h.finish();
        const final = await h.status();
        assert.deepEqual([final.inputTokens, final.cachedTokens, h.session.stats.outputTokens, h.session.stats.cacheSamples, h.session.stats.requests], [8971, 1024, 13, 1, 1]);
    } finally { await h.close(); }
});

test("HTTP Responses missing terminal usage remains an estimate until a late real report", { timeout: 10000 }, async () => {
    const h = await harness({ type: "response.completed", response: { status: "completed", output: [] } }, frame({ type: "response.usage", usage: { prompt_tokens: 8971, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 1024 } } }));
    try {
        const pending = await h.status();
        await h.terminal();
        assert.equal(h.upstreamEnded(), false);
        const terminal = await h.status();
        assert.equal(terminal.contextTokensSource, "estimate");
        assert.equal(terminal.contextGeneration, pending.contextGeneration);
        await h.finish();
        const final = await h.status();
        assert.deepEqual([final.contextTokensSource, final.contextTokens, final.inputTokens, final.cachedTokens, h.session.stats.outputTokens], ["usage", 8971, 8971, 1024, 13]);
        assert.equal(h.session.stats.requests, 1);
    } finally { await h.close(); }
});

for (const [name, terminal] of [
    ["zero usage", { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } } }],
    ["output-only usage", { type: "response.completed", response: { status: "completed", output: [], usage: { output_tokens: 13 } } }],
    ["failed", { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "fixture failure" } } }],
    ["incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
] as const) {
    test(`HTTP Responses ${name} does not fabricate an input usage observation`, { timeout: 10000 }, async () => {
        const h = await harness(terminal);
        try {
            const pending = await h.status();
            await h.terminal();
            assert.equal(h.upstreamEnded(), false);
            const observed = await h.status();
            assert.deepEqual([observed.contextTokensSource, observed.contextTokens, observed.contextGeneration], [pending.contextTokensSource, pending.contextTokens, pending.contextGeneration]);
            await h.finish();
            const final = await h.status();
            assert.equal(final.contextTokensSource, "estimate");
            assert.equal(final.inputTokens, 0);
            assert.equal(h.session.stats.requests, 1);
            assert.equal(h.session.stats.outputTokens, name === "output-only usage" ? 13 : 0);
            assert.equal(h.session.stats.cacheSamples, 0);
        } finally { await h.close(); }
    });
}

test("HTTP Responses terminal observation nets outstanding credit without promoting an effective estimate", { timeout: 10000 }, async () => {
    const h = await harness({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 8971, output_tokens: 13, input_tokens_details: { cached_tokens: 1024 } } } });
    try {
        h.session.stats.compressCreditTokens = 1000;
        await h.terminal();
        const terminal = await h.status();
        assert.deepEqual([terminal.contextTokensSource, terminal.contextTokens, terminal.inputTokens], ["estimate", 7971, 0]);
        await h.finish();
        const final = await h.status();
        assert.deepEqual([final.contextTokensSource, final.contextTokens, final.inputTokens, final.cachedTokens], ["estimate", 7971, 8971, 1024]);
        assert.deepEqual([h.session.stats.outputTokens, h.session.stats.cacheSamples, h.session.stats.requests], [13, 1, 1]);
    } finally { await h.close(); }
});