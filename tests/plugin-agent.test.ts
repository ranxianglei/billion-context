import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { proxyBaseFromUrl, proxyBaseFromEnv, detectProxyBase, fetchManifest, forwardTool, fetchStatus } from "../src/agent/shared.ts";
import biliPlugin, { createBiliPlugin } from "../src/agent/pi.ts";
import ompPlugin from "../src/agent/omp.ts";
import { pluginInstall, pluginRemove, pluginStatusAll, PLUGIN_AGENTS, selfPackageRoot } from "../src/plugin-install.ts";
import { resolveProxyOrigin, forwardTool as mcpForwardTool } from "../src/mcp.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

test("proxyBaseFromUrl detects /bili/ prefix and returns origin", () => {
    assert.equal(proxyBaseFromUrl("http://127.0.0.1:8787/bili/https://api.example.com/v1"), "http://127.0.0.1:8787");
    assert.equal(proxyBaseFromUrl("https://proxy.example.com/bili/https://upstream"), "https://proxy.example.com");
    assert.equal(proxyBaseFromUrl("https://api.example.com/v1"), undefined);
    assert.equal(proxyBaseFromUrl(undefined), undefined);
    assert.equal(proxyBaseFromUrl("not a url"), undefined);
    assert.equal(proxyBaseFromUrl("http://x/api/bili/v1"), undefined);
    assert.equal(proxyBaseFromUrl("http://x/bili/ftp://y"), undefined);
});

test("proxyBaseFromEnv accepts BILLION_CONTEXT_PROXY, detectProxyBase honors kill switch", async () => {
    await withEnv({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8790/", BILLION_CONTEXT_PLUGIN: undefined }, () => {
        assert.equal(proxyBaseFromEnv(), "http://127.0.0.1:8790");
        assert.equal(detectProxyBase("https://api.example.com/v1"), "http://127.0.0.1:8790");
        assert.equal(detectProxyBase("http://x/bili/https://y"), "http://x");
    });
    await withEnv({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8790/", BILLION_CONTEXT_PLUGIN: "0" }, () => {
        assert.equal(detectProxyBase("http://x/bili/https://y"), undefined);
    });
    await withEnv({ BILLION_CONTEXT_PROXY: "ftp://bad" }, () => {
        assert.equal(proxyBaseFromEnv(), undefined);
    });
});

type FakeProxy = {
    origin: string;
    toolCalls: Array<{ conversationId: string; tool: string; args: unknown }>;
    registers: Array<{ conversationId: string; agent: string; identity: boolean }>;
    close(): Promise<void>;
};

async function startFakeProxy(opts: { failRegister?: number } = {}): Promise<FakeProxy> {
    const toolCalls: FakeProxy["toolCalls"] = [];
    const registers: FakeProxy["registers"] = [];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools: { anthropic: [
                { name: "compress", description: "Compress context ranges", input_schema: { type: "object", properties: { content: { type: "array" } }, required: ["content"] } },
                { name: "acp_status", description: "Status", input_schema: { type: "object", properties: {} } },
            ] } }));
            return;
        }
        if (url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId: string; tool: string; args: unknown };
                toolCalls.push(data);
                res.writeHead(200, { "content-type": "application/json" });
                if (data.tool === "compress") {
                    res.end(JSON.stringify({ ok: true, result: "[Compressed m00001-m00002 -> b1]" }));
                } else {
                    res.end(JSON.stringify({ ok: false, error: "boom" }));
                }
            });
            return;
        }
        if (url === "/__bili/plugin/register" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId?: string; agent?: string; identity?: boolean };
                registers.push({ conversationId: data.conversationId ?? "", agent: data.agent ?? "", identity: data.identity === true });
                if (opts.failRegister !== undefined) {
                    res.writeHead(opts.failRegister);
                    res.end("{}");
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                }
            });
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, contextTokens: 1234 }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, toolCalls, registers, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("shared manifest/tool/status against a fake proxy", async () => {
    const proxy = await startFakeProxy();
    try {
        const tools = await fetchManifest(proxy.origin);
        assert.equal(tools.length, 2);
        assert.equal(tools[0]!.name, "compress");
        const result = await forwardTool(proxy.origin, "conv-1", "compress", { content: [] });
        assert.equal(result, "[Compressed m00001-m00002 -> b1]");
        await assert.rejects(forwardTool(proxy.origin, "conv-1", "acp_status", {}), /boom/);
        const status = await fetchStatus(proxy.origin, "conv-1");
        assert.equal(status?.contextTokens, 1234);
    } finally {
        await proxy.close();
    }
});

test("forwardTool rejects immediately when the caller's signal is already aborted", async () => {
    const proxy = await startFakeProxy();
    try {
        const ac = new AbortController();
        ac.abort();
        await assert.rejects(forwardTool(proxy.origin, "conv-1", "compress", { content: [] }, ac.signal), /abort/i);
    } finally {
        await proxy.close();
    }
});

type TextBlock = { type: "text"; text: string };
type RecordedTool = { name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: Record<string, unknown>) => Promise<{ content: TextBlock[]; isError?: boolean }> };

type RecordedCommand = { name: string; description?: string; handler: (args: string, ctx: unknown) => void | Promise<void> };

type FakePi = {
    events: Map<string, (event: unknown, ctx: unknown) => unknown>;
    tools: RecordedTool[];
    commands: Map<string, RecordedCommand>;
    providers: Map<string, string>;
    readonly registerCalls: number;
    on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
    registerTool: (tool: RecordedTool) => void;
    registerCommand: (name: string, options: RecordedCommand) => void;
    registerProvider?: (name: string, config: { baseUrl: string }) => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: RecordedTool[] = [];
    const commands = new Map<string, RecordedCommand>();
    const providers = new Map<string, string>();
    let registerCallCount = 0;
    return {
        events,
        tools,
        commands,
        providers,
        get registerCalls() { return registerCallCount; },
        on: (event, handler) => events.set(event, handler as (event: never, ctx: never) => unknown),
        registerTool: (tool) => {
            registerCallCount++;
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
        registerCommand: (name, options) => {
            commands.set(name, options);
        },
        registerProvider: (name, config) => {
            providers.set(name, config.baseUrl);
        },
    };
}

function fakeCtx(proxy: FakeProxy | undefined, sessionId = "sess-42"): Record<string, unknown> {
    return {
        sessionManager: { getSessionId: () => sessionId },
        model: { contextWindow: 1000000, baseUrl: proxy ? `${proxy.origin}/bili/https://api.example.com/v1` : "https://api.example.com/v1" },
        cwd: "/tmp",
    };
}

async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
}

// Windows CI runners can take seconds on a cold loopback connect, so a fixed
// 20ms flush races the manifest fetch. Poll for registration instead.
async function waitForTools(pi: FakePi, count: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pi.tools.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} registered tools; got ${pi.tools.length}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("#535: provider URL rewrites from env manifest applied at load", () => {
    const prevRewrites = process.env.BILI_PROVIDER_REWRITES;
    process.env.BILI_PROVIDER_REWRITES = JSON.stringify({
        glm: "http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1",
        other: "http://127.0.0.1:8787/bili/http://example.com",
    });
    try {
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        assert.deepEqual(Object.fromEntries(pi.providers), {
            glm: "http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1",
            other: "http://127.0.0.1:8787/bili/http://example.com",
        });
    } finally {
        if (prevRewrites === undefined) delete process.env.BILI_PROVIDER_REWRITES;
        else process.env.BILI_PROVIDER_REWRITES = prevRewrites;
    }
});

test("#535: invalid BILI_PROVIDER_REWRITES JSON → no rewrites applied", () => {
    const prevRewrites = process.env.BILI_PROVIDER_REWRITES;
    process.env.BILI_PROVIDER_REWRITES = "{not json";
    try {
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        assert.equal(pi.providers.size, 0);
    } finally {
        if (prevRewrites === undefined) delete process.env.BILI_PROVIDER_REWRITES;
        else process.env.BILI_PROVIDER_REWRITES = prevRewrites;
    }
});

test("#535: non-http(s) manifest entries are dropped", () => {
    const prevRewrites = process.env.BILI_PROVIDER_REWRITES;
    process.env.BILI_PROVIDER_REWRITES = JSON.stringify({ good: "http://x.example/v1", bad: "ftp://x.example", bad2: "not-a-url" });
    try {
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        assert.deepEqual(Object.fromEntries(pi.providers), { good: "http://x.example/v1" });
    } finally {
        if (prevRewrites === undefined) delete process.env.BILI_PROVIDER_REWRITES;
        else process.env.BILI_PROVIDER_REWRITES = prevRewrites;
    }
});

test("#535: session_before_compact cancels only pi auto compaction under bili launch", () => {
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("session_before_compact");
        assert.ok(handler, "pi under bili launch: handler registered");
        assert.deepEqual(handler({ reason: "threshold" }, undefined), { cancel: true });
        assert.deepEqual(handler({ reason: "overflow" }, undefined), { cancel: true });
        assert.equal(handler({ reason: "manual" }, undefined), undefined, "manual /compact stays user-owned");
        assert.equal(handler({ reason: "startup" }, undefined), undefined, "unknown reason → not cancelled");

        // omp: the event carries no reason field, so under bili ALL compaction
        // is cancelled (manual native /compact would destroy the ACP-tagged
        // context just like the auto path; the host shows "Compaction
        // cancelled" and the user should reach for /acp instead).
        const omp = makeFakePi();
        createBiliPlugin("omp")(omp as never);
        const ompHandler = omp.events.get("session_before_compact");
        assert.ok(ompHandler, "omp under bili launch: cancel-all handler registered");
        assert.deepEqual(ompHandler({}, undefined), { cancel: true });
        assert.deepEqual(ompHandler({ reason: "manual" }, undefined), { cancel: true });
        assert.deepEqual(ompHandler({ reason: "threshold" }, undefined), { cancel: true });
    } finally {
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("#535: plain pi (no BILLION_CONTEXT_PROXY) → no compaction cancel handler", () => {
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        assert.equal(pi.events.get("session_before_compact"), undefined, "native run stays fully native");
    } finally {
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("pi extension registers manifest tools and stamps headers when proxied", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        // The header is only stamped once tools are registered, so register
        // first (a real session does this via session_start before the first
        // provider request; a one-shot -p run races it and rides wire mode).
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        const headers: Record<string, string> = {};
        pi.events.get("before_provider_headers")!({ headers }, fakeCtx(proxy));
        assert.equal(headers["x-bili-plugin"], "pi");
        assert.equal(headers["x-bili-plugin-conversation"], "sess-42");
        assert.equal(headers["x-bili-plugin-context-window"], "1000000");
        assert.equal(pi.tools.length, 2);
        assert.equal(pi.tools[0]!.name, "compress");
        assert.deepEqual(pi.tools[0]!.parameters, { type: "object", properties: { content: { type: "array" } }, required: ["content"] });
        const out = await pi.tools[0]!.execute("call-1", { content: [] }, undefined, undefined, fakeCtx(proxy));
        assert.equal(out.content[0]!.text, "[Compressed m00001-m00002 -> b1]");
        assert.equal(out.isError, undefined);
        assert.deepEqual(proxy.toolCalls, [{ conversationId: "sess-42", tool: "compress", args: { content: [] } }]);
        const errOut = await pi.tools[1]!.execute("call-2", {}, undefined, undefined, fakeCtx(proxy));
        assert.match(errOut.content[0]!.text, /bili tool error:.*boom/);
        assert.equal(errOut.isError, true);
    } finally {
        await proxy.close();
    }
});

test("before_provider_headers does not claim plugin mode until tools are registered", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        const early: Record<string, string> = {};
        pi.events.get("before_provider_headers")!({ headers: early }, fakeCtx(proxy));
        assert.deepEqual(early, {});
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        const late: Record<string, string> = {};
        pi.events.get("before_provider_headers")!({ headers: late }, fakeCtx(proxy));
        assert.equal(late["x-bili-plugin"], "pi");
        assert.equal(late["x-bili-plugin-conversation"], "sess-42");
    } finally {
        await proxy.close();
    }
});

test("before_provider_headers stays silent when the manifest fetch keeps failing", async () => {
    // Graceful degradation: a dead manifest endpoint means the plugin never
    // claims ownership, so the session rides the proxy's wire mode forever.
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(origin));
        await flush();
        await flush();
        assert.equal(pi.tools.length, 0);
        const headers: Record<string, string> = {};
        pi.events.get("before_provider_headers")!({ headers }, fakeCtx(origin));
        assert.deepEqual(headers, {});
    } finally {
        server.close();
    }
});

test("pi extension survives hostile host shapes without throwing", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        pi.events.get("before_provider_headers")!({}, {});
        pi.events.get("before_provider_headers")!({ headers: null }, fakeCtx(proxy));
        pi.events.get("before_provider_headers")!({ headers: [] }, { sessionManager: {}, model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` } });
        await pi.events.get("session_start")!({}, {});
        await waitForTools(pi, 2);
        // proxied baseUrl above intentionally triggers header-fallback registration
        assert.equal(pi.tools.length, 2);
    } finally {
        await proxy.close();
    }
});

test("registration retries are throttled and deduped", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        assert.equal(pi.tools.length, 2);
        const calls = proxy.toolCalls.length;
        for (let i = 0; i < 5; i++) pi.events.get("before_provider_headers")!({ headers: {} }, fakeCtx(proxy));
        await flush();
        assert.equal(pi.tools.length, 2);
        assert.equal(proxy.toolCalls.length, calls);
    } finally {
        await proxy.close();
    }
});

test("pi extension is inert without a proxy", async () => {
    const pi = makeFakePi();
    biliPlugin(pi as never);
    const headers: Record<string, string> = {};
    pi.events.get("before_provider_headers")!({ headers }, fakeCtx(undefined));
    assert.deepEqual(headers, {});
    await pi.events.get("session_start")!({}, fakeCtx(undefined));
    await flush();
    assert.equal(pi.tools.length, 0);
});

test("/acp command is registered and renders proxy status", async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                ok: true,
                contextLimit: 200000,
                contextTokens: 12345,
                inputTokens: 10000,
                outputTokens: 1234,
                cachedTokens: 8000,
                requests: 7,
                blocks: [{ id: "b1", tier: 1, active: true }, { id: "b2", tier: 2, active: false }],
            }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp");
        assert.ok(cmd, "acp command should be registered");
        assert.match(cmd!.description ?? "", /ACP/);
        const notes: Array<{ msg: string; type?: string }> = [];
        const ctx = {
            sessionManager: { getSessionId: () => "sess-acp" },
            model: { baseUrl: `${origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd!.handler("", ctx);
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.type, "info");
        assert.match(notes[0]!.msg, /📊 ACP status/);
        assert.match(notes[0]!.msg, /context: 12\.3K \/ 200\.0K \(6\.2%\)/);
        assert.match(notes[0]!.msg, /in\/out\/cached: 10\.0K \/ 1\.2K \/ 8\.0K/);
        assert.match(notes[0]!.msg, /requests: 7/);
        assert.match(notes[0]!.msg, /blocks: 2 \(1 active\)/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("/acp command warns when no proxy is detected", async () => {
    await withEnv({ BILLION_CONTEXT_PROXY: undefined }, async () => {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp")!;
        const notes: Array<{ msg: string; type?: string }> = [];
        const ctx = {
            sessionManager: { getSessionId: () => "sess" },
            model: { baseUrl: "https://api.example.com/v1" },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.type, "warning");
        assert.match(notes[0]!.msg, /no proxy detected/);
    });
});

test("/acp command warns when the session is unknown", async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp")!;
        const notes: Array<{ msg: string; type?: string }> = [];
        const ctx = {
            sessionManager: { getSessionId: () => "sess-unknown" },
            model: { baseUrl: `${origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.type, "warning");
        assert.match(notes[0]!.msg, /no ACP session yet/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("/acp shows armed info when the proxy is live but the session is unknown", async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
            return;
        }
        if (req.url?.startsWith("/__bili/plugin/manifest")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, version: "9.9.9", toolNames: [] }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp")!;
        const notes: Array<{ msg: string; type?: string }> = [];
        const ctx = {
            sessionManager: { getSessionId: () => "sess-fresh" },
            model: { baseUrl: `${origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.type, "info");
        assert.match(notes[0]!.msg, /billion-context@9\.9\.9/);
        assert.match(notes[0]!.msg, /compression armed/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("/acp emits a persistent custom message via pi.sendMessage when available (issue #359)", async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, panel: "PANEL-BODY", contextTokens: 12345 }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const sent: Array<{ customType: string; content: string; display: boolean }> = [];
        const notes: string[] = [];
        const pi = { ...makeFakePi(), sendMessage: (m: { customType: string; content: string; display: boolean }) => sent.push(m) };
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-send" },
            model: { baseUrl: `${origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string) => notes.push(msg) },
        };
        await cmd.handler("", ctx);
        assert.equal(sent.length, 1, "one custom message sent");
        assert.equal(notes.length, 0, "notify must not fire when sendMessage is available");
        assert.equal(sent[0]!.customType, "bili-acp-status");
        assert.equal(sent[0]!.display, true);
        assert.equal(sent[0]!.content, "PANEL-BODY");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("/acp sends renderAcpStatus fallback content via sendMessage when no panel string", async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, contextLimit: 200000, contextTokens: 12345, inputTokens: 10000, outputTokens: 1234, cachedTokens: 8000, requests: 7, blocks: [{ id: "b1", tier: 1, active: true }] }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const sent: Array<{ customType: string; content: string; display: boolean }> = [];
        const pi = { ...makeFakePi(), sendMessage: (m: { customType: string; content: string; display: boolean }) => sent.push(m) };
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-send2" },
            model: { baseUrl: `${origin}/bili/https://api.example.com/v1` },
            ui: { notify: () => { throw new Error("notify must not fire"); } },
        };
        await cmd.handler("", ctx);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.customType, "bili-acp-status");
        assert.match(sent[0]!.content, /📊 ACP status/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("/acp falls back to notify when pi.sendMessage throws", async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, panel: "PANEL-BODY", contextTokens: 1 }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const notes: string[] = [];
        const pi = { ...makeFakePi(), sendMessage: () => { throw new Error("host sendMessage failed"); } };
        biliPlugin(pi as never);
        const cmd = pi.commands.get("acp")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-send3" },
            model: { baseUrl: `${origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string) => notes.push(msg) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1, "notify fallback fires");
        assert.equal(notes[0], "PANEL-BODY");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("omp entry reports x-bili-plugin: omp without env vars", async () => {
    const proxy = await startFakeProxy();
    try {
        await withEnv({ BILLION_CONTEXT_PLUGIN_AGENT: undefined, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            const pi = makeFakePi();
            ompPlugin(pi as never);
            await pi.events.get("session_start")!({}, fakeCtx(undefined));
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            pi.events.get("before_provider_headers")!({ headers }, fakeCtx(undefined));
            assert.equal(headers["x-bili-plugin"], "omp");
        });
        await withEnv({ BILLION_CONTEXT_PLUGIN_AGENT: "omp", BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            const pi = makeFakePi();
            biliPlugin(pi as never);
            await pi.events.get("session_start")!({}, fakeCtx(undefined));
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            pi.events.get("before_provider_headers")!({ headers }, fakeCtx(undefined));
            assert.equal(headers["x-bili-plugin"], "omp");
        });
        await withEnv({ BILLION_CONTEXT_PLUGIN_AGENT: undefined }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("dsh")(pi as never);
            const ctx = { sessionManager: { getSessionId: () => "s" }, model: { baseUrl: `${proxy.origin}/bili/https://x` } };
            await pi.events.get("session_start")!({}, ctx);
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            pi.events.get("before_provider_headers")!({ headers }, ctx);
            assert.equal(headers["x-bili-plugin"], "dsh");
        });
    } finally {
        await proxy.close();
    }
});

function hintEnv(home: string, piAgentDir: string): Record<string, string> {
    return {
        PI_CODING_AGENT_DIR: piAgentDir,
        CODEX_HOME: home,
        OPENCODE_CONFIG: path.join(home, ".config/opencode/opencode.json"),
        CLAUDE_CONFIG_DIR: home,
        CLAUDE: "/nonexistent/bili-claude-stub",
        BILI_MCP_PROXY: "http://127.0.0.1:8787",
    };
}

test("plugin install/remove roundtrips for pi/omp/codex/opencode under a fake HOME", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-home-"));
    const piAgentDir = path.join(home, ".pi/agent");
    await withEnv(hintEnv(home, piAgentDir), async () => {
        const root = selfPackageRoot();

        assert.match(pluginInstall("pi"), /installed/);
        const piSettings = JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[] };
        assert.ok(piSettings.packages.includes(root));
        assert.match(pluginInstall("pi"), /already installed/);
        assert.match(pluginRemove("pi"), /removed/);
        assert.ok(!(JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[] }).packages.includes(root));
        assert.match(pluginRemove("pi"), /not installed/);

        // Legacy entries (old billion-context-pi npm package, a dev checkout
        // path, backslash Windows paths) must be REPLACED by install so only
        // one bili plugin stays live.
        fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify({
            packages: [
                "npm:billion-context-pi",
                "npm:billion-context-pi@0.1.48",
                "npm:billion-context@0.1.40",
                "/home/x/projects/billion-context",
                "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\billion-context-pi",
                "/home/x/other-package",
            ],
            theme: "dark",
        }, null, 2));
        assert.match(pluginInstall("pi"), /installed/);
        const replaced = JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[]; theme: string };
        assert.deepEqual(replaced.packages, ["/home/x/other-package", root]);
        assert.equal(replaced.theme, "dark");
        assert.match(pluginRemove("pi"), /removed/);
        assert.deepEqual((JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[] }).packages, ["/home/x/other-package"]);

        // omp install/status/remove verify the entry's target exists, so
        // materialize the (gitignored) dist artifact for this sub-test.
        const ompDistFile = path.join(root, "dist", "agent", "omp.js");
        const createdOmpDist = !fs.existsSync(ompDistFile);
        if (createdOmpDist) {
            fs.mkdirSync(path.dirname(ompDistFile), { recursive: true });
            fs.writeFileSync(ompDistFile, "// test stub\n");
        }
        fs.mkdirSync(path.join(home, ".omp/agent"), { recursive: true });
        await withEnv({ PI_CODING_AGENT_DIR: path.join(home, ".omp/agent") }, async () => {
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), "extensions:\n  - /some/other/ext.js\nfirstRunComplete: true\n");
        assert.match(pluginInstall("omp"), /installed/);
        const ompText = fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8");
        assert.match(ompText, /extensions:\n  - \/some\/other\/ext\.js\n  - .*dist[\\/]agent[\\/]omp\.js\nfirstRunComplete: true\n/);
        assert.match(pluginInstall("omp"), /already installed/);
        assert.match(pluginRemove("omp"), /removed/);
        assert.equal(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), "extensions:\n  - /some/other/ext.js\nfirstRunComplete: true\n");

        const noExtYml = "firstRunComplete: true\n";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), noExtYml);
        pluginInstall("omp");
        assert.match(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), /firstRunComplete: true\nextensions:\n  - .*omp\.js\n/);
        pluginRemove("omp");

        const noNlYml = "extensions:";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), noNlYml);
        pluginInstall("omp");
        assert.match(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), /extensions:\n  - .*omp\.js\n/);
        pluginRemove("omp");

        const colZeroYml = "extensions:\n- /a.js\n- /b.js\nother: 1\n";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), colZeroYml);
        pluginInstall("omp");
        assert.match(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), /^extensions:\n- \/a\.js\n- \/b\.js\n- .*omp\.js\nother: 1\n$/);
        pluginRemove("omp");
        assert.equal(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), colZeroYml);

        const flowYml = "extensions: [/a.js]\n";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), flowYml);
        assert.throws(() => pluginInstall("omp"), /flow style|inline value/);
        const quotedYml = `extensions:\n  - "${path.join(root, "dist/agent/omp.js")}" # my ext\n`;
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), quotedYml);
        assert.match(pluginInstall("omp"), /already installed/);
        assert.match(pluginRemove("omp"), /removed/);
        assert.equal(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), "extensions:\n");
        });
        if (createdOmpDist) fs.rmSync(ompDistFile, { force: true });

        assert.match(pluginInstall("codex"), /installed/);
        const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
        assert.match(toml, /\[mcp_servers\.bili\]\ncommand = /);
        assert.match(toml, /BILI_MCP_PROXY = "http:\/\/127\.0\.0\.1:8787"/);
        fs.writeFileSync(path.join(home, "config.toml"), toml + "\n[mcp_servers.other]\ncommand = \"x\"\n");
        assert.match(pluginInstall("codex"), /already installed/);
        fs.writeFileSync(path.join(home, "config.toml"), fs.readFileSync(path.join(home, "config.toml"), "utf8").replace("8787", "9999"));
        assert.match(pluginInstall("codex"), /refreshed/);
        assert.match(fs.readFileSync(path.join(home, "config.toml"), "utf8"), /BILI_MCP_PROXY = "http:\/\/127\.0\.0\.1:8787"/);
        assert.match(pluginRemove("codex"), /removed/);
        const tomlAfter = fs.readFileSync(path.join(home, "config.toml"), "utf8");
        assert.doesNotMatch(tomlAfter, /mcp_servers\.bili/);
        assert.match(tomlAfter, /\[mcp_servers\.other\]\ncommand = "x"\n/);

        // Regression: a header-only [mcp_servers.bili] block as the final
        // line with no trailing newline must be fully removed (previously
        // the header line survived because the next-table search matched
        // the header itself when after.indexOf("\n") was -1).
        fs.writeFileSync(path.join(home, "config.toml"), "[mcp_servers.other]\ncommand = \"x\"\n[mcp_servers.bili]");
        assert.match(pluginRemove("codex"), /removed/);
        const tomlEdge = fs.readFileSync(path.join(home, "config.toml"), "utf8");
        assert.doesNotMatch(tomlEdge, /mcp_servers\.bili/);
        assert.match(tomlEdge, /\[mcp_servers\.other\]\ncommand = "x"\n/);

        assert.match(pluginInstall("opencode"), /installed/);
        const oc = JSON.parse(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")) as { mcp: Record<string, { command: string[]; environment?: Record<string, string> }> };
        assert.equal(oc.mcp.bili.command[1]!.endsWith(path.join("dist", "mcp.js")), true);
        assert.equal(oc.mcp.bili.environment?.BILI_MCP_PROXY, "http://127.0.0.1:8787");
        assert.match(pluginRemove("opencode"), /removed/);
        assert.equal((JSON.parse(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")) as { mcp?: unknown }).mcp, undefined);

        assert.throws(() => pluginInstall("claude"), /claude: install failed/);
        // The CLAUDE stub above keeps that assertion deterministic even on
        // machines WITH the real claude CLI; remove is a no-op when the
        // config has no bili entry (and must not exec the CLI at all).
        assert.match(pluginRemove("claude"), /not installed/);

        const rows = pluginStatusAll();
        assert.equal(rows.length, 5);
        assert.deepEqual(PLUGIN_AGENTS, ["pi", "omp", "claude", "codex", "opencode"]);
    });
    fs.rmSync(home, { recursive: true, force: true });
});

test("omp plugin: scoped matching, existence check, overlay redirect (issue #392)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-omp-"));
    const root = selfPackageRoot();
    const ompDistFile = path.join(root, "dist", "agent", "omp.js");
    const createdOmpDist = !fs.existsSync(ompDistFile);
    if (createdOmpDist) {
        fs.mkdirSync(path.dirname(ompDistFile), { recursive: true });
        fs.writeFileSync(ompDistFile, "// test stub\n");
    }
    try {
        const stale = "/does/not/exist/dist/agent/omp.js";

        // (a) a same-valued line OUTSIDE the extensions block must not block install
        {
            const agentDir = path.join(home, "a", ".omp", "agent");
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, "config.yml"),
                `extensions:\n  - ${stale}\nother:\n  - ${stale}\nfirstRunComplete: true\n`);
            await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
                assert.match(pluginInstall("omp"), /installed/);
                assert.equal(pluginStatusAll().find((r) => r.agent === "omp")?.status, "installed");
            });
            assert.match(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"),
                /extensions:\n  - \/does\/not\/exist\/dist\/agent\/omp\.js\n  - .*dist[\\/]agent[\\/]omp\.js\nother:\n  - \/does\/not\/exist\/dist\/agent\/omp\.js\n/);
        }

        // (b) remove only deletes in-block entries; the out-of-block line stays
        {
            const agentDir = path.join(home, "b", ".omp", "agent");
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, "config.yml"),
                `extensions:\n  - ${stale}\nother:\n  - ${stale}\nfirstRunComplete: true\n`);
            await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
                assert.match(pluginRemove("omp"), /removed/);
            });
            assert.equal(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"),
                `extensions:\nother:\n  - ${stale}\nfirstRunComplete: true\n`);
        }

        // (c) PI_CODING_AGENT_DIR pointing at a bili overlay redirects to the real home
        {
            const realHome = path.join(home, "c", ".omp", "agent");
            const overlay = realHome + "-bili";
            fs.mkdirSync(realHome, { recursive: true });
            fs.mkdirSync(overlay, { recursive: true });
            fs.writeFileSync(path.join(realHome, "config.yml"), "firstRunComplete: true\n");
            fs.writeFileSync(path.join(overlay, "config.yml"), "extensions:\n  - /stale/overlay/dist/agent/omp.js\n");
            await withEnv({ PI_CODING_AGENT_DIR: overlay }, async () => {
                assert.match(pluginInstall("omp"), /installed/);
            });
            assert.match(fs.readFileSync(path.join(realHome, "config.yml"), "utf8"),
                /extensions:\n  - .*dist[\\/]agent[\\/]omp\.js\n/);
            assert.equal(fs.readFileSync(path.join(overlay, "config.yml"), "utf8"),
                "extensions:\n  - /stale/overlay/dist/agent/omp.js\n");
        }

        // (d) a stale entry (target file gone) reports "broken"
        {
            const agentDir = path.join(home, "d", ".omp", "agent");
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, "config.yml"), `extensions:\n  - ${stale}\n`);
            await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
                assert.equal(pluginStatusAll().find((r) => r.agent === "omp")?.status, "broken");
            });
        }
    } finally {
        if (createdOmpDist) fs.rmSync(ompDistFile, { force: true });
    }
    fs.rmSync(home, { recursive: true, force: true });
});

test("resolveProxyOrigin discovers the running proxy via the state file", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-state-"));
    await withEnv({ XDG_STATE_HOME: state, BILI_MCP_PROXY: undefined }, () => {
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:8787");
        fs.mkdirSync(path.join(state, "billion-context"), { recursive: true });
        fs.writeFileSync(path.join(state, "billion-context", "proxy-origin"), "http://127.0.0.1:8792\n");
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:8792");
        fs.writeFileSync(path.join(state, "billion-context", "proxy-origin"), "ftp://bad\ngarbage");
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:8787");
    });
    await withEnv({ XDG_STATE_HOME: state, BILI_MCP_PROXY: "http://10.0.0.5:9000" }, () => {
        assert.equal(resolveProxyOrigin(), "http://10.0.0.5:9000");
    });
    fs.rmSync(state, { recursive: true, force: true });
});

test("plugin install refuses to touch broken or non-object configs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-home-"));
    const piAgentDir = path.join(home, ".pi/agent");
    await withEnv(hintEnv(home, piAgentDir), async () => {
        fs.mkdirSync(piAgentDir, { recursive: true });
        fs.writeFileSync(path.join(piAgentDir, "settings.json"), "{ not json");
        assert.throws(() => pluginInstall("pi"), /not valid JSON/);
        assert.equal(fs.existsSync(path.join(piAgentDir, "settings.json.bili-bak")), false);
        fs.writeFileSync(path.join(piAgentDir, "settings.json"), "[1,2]");
        assert.throws(() => pluginInstall("pi"), /expected a JSON object/);
        fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify({ packages: [`/opt/old/node_modules/billion-context`] }));
        assert.match(pluginInstall("pi"), /installed/);
        const after = JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[] };
        assert.equal(after.packages.length, 1);
        assert.ok(after.packages[0]!.endsWith(selfPackageRoot().slice(-10)) || after.packages[0] === selfPackageRoot());
        const ocDir = path.join(home, ".config/opencode");
        fs.mkdirSync(ocDir, { recursive: true });
        fs.writeFileSync(path.join(ocDir, "opencode.json"), "nope{");
        assert.throws(() => pluginInstall("opencode"), /not valid JSON/);
    });
    fs.rmSync(home, { recursive: true, force: true });
});

test("plugin list survives a broken host config (per-row error, no crash)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-home-"));
    const piAgentDir = path.join(home, ".pi/agent");
    await withEnv(hintEnv(home, piAgentDir), async () => {
        fs.writeFileSync(path.join(home, ".claude.json"), "{ broken json");
        const rows = pluginStatusAll();
        assert.equal(rows.length, 5);
        const claude = rows.find((r) => r.agent === "claude")!;
        assert.match(claude.status, /error: .*not valid JSON/);
        const pi = rows.find((r) => r.agent === "pi")!;
        assert.equal(pi.status, "not installed");
    });
    fs.rmSync(home, { recursive: true, force: true });
});

test("mcp forwardTool times out against a hanging proxy", async () => {
    const server = http.createServer(() => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await withEnv({ BILI_MCP_PROXY: origin }, async () => {
        await assert.rejects(() => mcpForwardTool("compress", {}, 200), /timed out after 200ms/);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("registered tools declare loadMode essential so omp 17.x keeps them top-level", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        // omp mounts extension tools that omit loadMode under xd:// devices —
        // invisible to the main turn's tools array. "essential" keeps them in.
        for (const tool of pi.tools) {
            assert.equal((tool as unknown as { loadMode?: string }).loadMode, "essential");
        }
    } finally {
        await proxy.close();
    }
});

test("omp plugin identity-registers the conversation once tools are ready", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        ompPlugin(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(proxy, "omp-sess-7"));
        await waitForTools(pi, 2);
        // omp never emits before_provider_headers, so the plugin must bind the
        // conversation via the launcher identity register (#162 semantics).
        const deadline = Date.now() + 15000;
        while (proxy.registers.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.deepEqual(proxy.registers, [{ conversationId: "omp-sess-7", agent: "omp", identity: true }]);
        // Re-driving per-request events must not re-POST (identityAt caches by sid).
        await pi.events.get("before_provider_request")!({}, fakeCtx(proxy, "omp-sess-7"));
        await flush();
        assert.equal(proxy.registers.length, 1);
        // A new session re-registers under its own id.
        await pi.events.get("session_start")!({}, fakeCtx(proxy, "omp-sess-8"));
        const deadline2 = Date.now() + 15000;
        while (proxy.registers.length < 2 && Date.now() < deadline2) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.deepEqual(proxy.registers[1], { conversationId: "omp-sess-8", agent: "omp", identity: true });
    } finally {
        await proxy.close();
    }
});

test("pi plugin does not identity-register (it stamps headers instead)", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        await pi.events.get("before_provider_request")!({}, fakeCtx(proxy));
        await flush();
        assert.deepEqual(proxy.registers, []);
    } finally {
        await proxy.close();
    }
});

test("omp identity register failure throttles and retries later", async () => {
    const proxy = await startFakeProxy({ failRegister: 500 });
    try {
        const pi = makeFakePi();
        createBiliPlugin("omp", { retryIntervalMs: 500 })(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(proxy, "omp-sess-9"));
        await waitForTools(pi, 2);
        const deadline = Date.now() + 15000;
        while (proxy.registers.length < 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(proxy.registers.length, 1);
        // Throttled: a burst of per-request events right after the failure must
        // not hammer the endpoint (retryAt gates re-entry).
        for (let i = 0; i < 5; i++) {
            await pi.events.get("before_provider_request")!({}, fakeCtx(proxy, "omp-sess-9"));
            await flush();
        }
        assert.equal(proxy.registers.length, 1, "throttled — no immediate retry");
        // After the throttle window, a per-request event retries ONLY the
        // register (re-fetches manifest, re-POSTs register; tools are NOT
        // re-registered).
        await new Promise((r) => setTimeout(r, 700));
        await pi.events.get("before_provider_request")!({}, fakeCtx(proxy, "omp-sess-9"));
        const deadline2 = Date.now() + 5000;
        while (proxy.registers.length < 2 && Date.now() < deadline2) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(proxy.registers.length, 2, "retried after the throttle window");
        assert.equal(pi.registerCalls, 2, "tools registered once, not re-registered on retry");
    } finally {
        await proxy.close();
    }
});

// #266: omp's chat-completions payloads carry NO conversation signal, so the
// plugin stamps prompt_cache_key with the omp session id. The
// before_provider_request return value REPLACES the whole outgoing payload
// (omp onPayload chain), so the matrix below drives the real handler and
// asserts exactly which payload shapes get stamped. fakeCtx(undefined) keeps
// registerTools a no-op (no proxy) so the test is pure.
test("omp before_provider_request stamps prompt_cache_key only for chat-completions payloads (injection matrix)", async () => {
    const sid = "omp-uuid-abc";
    const mk = (): FakePi => {
        const pi = makeFakePi();
        createBiliPlugin("omp")(pi as never);
        return pi;
    };
    const handler = (pi: FakePi, payload: unknown) =>
        pi.events.get("before_provider_request")!({ type: "before_provider_request", payload }, fakeCtx(undefined, sid));

    // chat payload (messages, no input, no max_tokens, no native pck) → stamped
    {
        const pi = mk();
        const payload = { model: "glm-4", messages: [{ role: "user", content: "hi" }] };
        const out = handler(pi, payload) as Record<string, unknown>;
        assert.equal(out.prompt_cache_key, sid, "chat payload stamped with the omp session id");
        assert.deepEqual(out.messages, payload.messages, "rest of the payload preserved");
        assert.equal(payload.prompt_cache_key, undefined, "original payload not mutated");
    }
    // real-world chat-completions payload carries max_tokens (omp's openai-compat
    // providers use maxTokensField:"max_tokens") → stamped (#268)
    {
        const pi = mk();
        const out = handler(pi, { model: "glm-4", messages: [{ role: "user", content: "hi" }], max_tokens: 4096, temperature: 0.7 }) as Record<string, unknown>;
        assert.equal(out.prompt_cache_key, sid, "chat-completions payload WITH max_tokens stamped");
        assert.equal(out.max_tokens, 4096, "max_tokens preserved");
    }
    // native prompt_cache_key already present → not overridden
    {
        const pi = mk();
        const out = handler(pi, { messages: [{ role: "user", content: "hi" }], prompt_cache_key: "native-pck" });
        assert.equal(out, undefined, "native pck is not overridden");
    }
    // responses payload (input array) → untouched
    {
        const pi = mk();
        const out = handler(pi, { input: [{ role: "user", content: "hi" }] });
        assert.equal(out, undefined, "responses payload (input) untouched");
    }
    // anthropic wire shape (messages + max_tokens) → stamped too: the plugin
    // cannot tell the wires apart by shape, and the proxy records the mapping
    // from the body pck on the anthropic path and strips the field before
    // forwarding to the real Anthropic (#268)
    {
        const pi = mk();
        const out = handler(pi, { messages: [{ role: "user", content: "hi" }], max_tokens: 1024, system: "s" }) as Record<string, unknown>;
        assert.equal(out.prompt_cache_key, sid, "anthropic wire shape stamped (proxy strips before forward)");
    }
    // no session id → untouched
    {
        const pi = mk();
        const out = pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, fakeCtx(undefined, ""));
        assert.equal(out, undefined, "no session id → untouched");
    }
    // non-object payload → untouched
    {
        const pi = mk();
        assert.equal(handler(pi, "not an object"), undefined, "non-object payload untouched");
        assert.equal(handler(pi, null), undefined, "null payload untouched");
        assert.equal(handler(pi, [1, 2, 3]), undefined, "array payload untouched");
    }
    // no messages array → untouched
    {
        const pi = mk();
        assert.equal(handler(pi, { model: "x" }), undefined, "no messages → untouched");
        assert.equal(handler(pi, { messages: "nope" }), undefined, "non-array messages → untouched");
    }
});

test("pi agent never stamps prompt_cache_key (it stamps headers instead)", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const out = pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, fakeCtx(undefined, "pi-uuid"));
    assert.equal(out, undefined, "pi agent never stamps the body");
});
