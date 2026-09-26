import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { proxyBaseFromUrl, proxyBaseFromEnv, detectProxyBase, fetchManifest, forwardTool, fetchStatus } from "../src/agent/shared.ts";
import { wrapCacheReport, wrapRuleReport } from "../src/acp-panel.ts";
import biliPlugin, { createBiliPlugin } from "../src/agent/pi.ts";
import ompPlugin from "../src/agent/omp.ts";
import { pluginInstall, pluginRemove, pluginStatusAll, PLUGIN_AGENTS, selfPackageRoot, pickPluginKey, detectOpencodeMajor, piEntryFor, PI_NPM_ENTRY, isPiEntry, claudeNativeInstalled } from "../src/plugin-install.ts";
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
    registers: Array<{ conversationId: string; agent: string; identity: boolean; parentConversationId?: string }>;
    runtimeInfos: Array<Record<string, unknown>>;
    close(): Promise<void>;
};

async function startFakeProxy(opts: { failRegister?: number; statusOk?: boolean } = {}): Promise<FakeProxy> {
    const toolCalls: FakeProxy["toolCalls"] = [];
    const registers: FakeProxy["registers"] = [];
    const runtimeInfos: FakeProxy["runtimeInfos"] = [];
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
                const data = JSON.parse(body) as { conversationId?: string; agent?: string; identity?: boolean; parentConversationId?: unknown };
                registers.push({ conversationId: data.conversationId ?? "", agent: data.agent ?? "", identity: data.identity === true, ...(typeof data.parentConversationId === "string" && data.parentConversationId ? { parentConversationId: data.parentConversationId } : {}) });
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
        if (url === "/__bili/plugin/runtime-info" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                runtimeInfos.push(JSON.parse(body) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            if (opts.statusOk === false) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, contextTokens: 1234 }));
            }
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, toolCalls, registers, runtimeInfos, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

test("#535/#851: session_before_compact cancels only auto compaction under bili launch", async () => {
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("session_before_compact");
        assert.ok(handler, "pi under bili launch: handler registered");
        assert.deepEqual(await handler({ reason: "threshold" }, undefined), { cancel: true });
        assert.deepEqual(await handler({ reason: "overflow" }, undefined), { cancel: true });
        assert.equal(await handler({ reason: "manual" }, undefined), undefined, "manual /compact stays user-owned");
        assert.equal(await handler({ reason: "startup" }, undefined), undefined, "unknown reason → not cancelled");

        // omp: the hook event carries no reason field, so the plugin tracks
        // the auto_compaction_start announcement instead — only announced
        // (auto) passes are cancelled, manual stays user-owned (#851).
        const omp = makeFakePi();
        createBiliPlugin("omp")(omp as never);
        const ompHandler = omp.events.get("session_before_compact");
        assert.ok(ompHandler, "omp under bili launch: handler registered");
        assert.equal(await ompHandler({}, undefined), undefined, "unannounced (manual) compaction stays user-owned");
        const ompStart = omp.events.get("auto_compaction_start");
        const ompEnd = omp.events.get("auto_compaction_end");
        assert.ok(ompStart, "omp tracks auto_compaction_start announcements");
        assert.ok(ompEnd, "omp tracks auto_compaction_end announcements");
        ompStart({}, undefined);
        assert.deepEqual(await ompHandler({}, undefined), { cancel: true }, "announced auto compaction is cancelled");
        assert.equal(await ompHandler({}, undefined), undefined, "the announcement is consumed by the cancel");
        ompStart({}, undefined);
        ompEnd({}, undefined);
        assert.equal(await ompHandler({}, undefined), undefined, "aborted auto pass (end before hook) leaves manual unblocked");
    } finally {
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("#535/#519: no proxy at factory time → cancel inert until a proxy appears", async () => {
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("session_before_compact");
        assert.ok(handler, "handler registered; arming decided at event time");
        assert.equal(await handler({ reason: "threshold" }, undefined), undefined, "no proxy → native compaction untouched");
        // native mode (#519): BILLION_CONTEXT_PROXY lands only AFTER the factory ran
        process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
        assert.deepEqual(await handler({ reason: "threshold" }, undefined), { cancel: true });
        assert.deepEqual(await handler({ reason: "overflow" }, undefined), { cancel: true });
        assert.equal(await handler({ reason: "manual" }, undefined), undefined, "manual /compact stays user-owned");
        // /bili/ baseUrl routing (no env at all) arms the cancel too
        delete process.env.BILLION_CONTEXT_PROXY;
        const biliCtx = { model: { baseUrl: "http://127.0.0.1:8787/bili/https://api.example.com/v1" } };
        assert.deepEqual(await handler({ reason: "threshold" }, biliCtx), { cancel: true });
    } finally {
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("#1382: compaction cancel requires evidence the proxy carries this conversation", async () => {
    // Native mode sets BILLION_CONTEXT_PROXY for the whole process, but a
    // provider like pi-claude-bridge runs its own child process against
    // upstream directly (model.baseUrl = literal "claude-bridge") — the proxy
    // never saw this conversation. Cancelling there killed ALL compaction:
    // the bridge disables Claude Code's own auto-compact and takes over Pi's
    // in its own session_before_compact handler, which never runs once an
    // earlier handler returned cancel. The fix: positive evidence only.
    const bridgeCtx = {
        sessionManager: { getSessionId: () => "sess-bridge" },
        model: { contextWindow: 1000000, baseUrl: "claude-bridge" },
        cwd: "/tmp",
    };
    const httpCtx = (sid: string) => ({
        sessionManager: { getSessionId: () => sid },
        model: { contextWindow: 1000000, baseUrl: "https://api.example.com/v1" },
        cwd: "/tmp",
    });

    const unknownProxy = await startFakeProxy({ statusOk: false });
    const knownProxy = await startFakeProxy({ statusOk: true });
    try {
        // (A) The reported repro: non-http(s) provider AND the proxy has no
        // such conversation → threshold/overflow must NOT be cancelled.
        await withEnv({ BILLION_CONTEXT_PROXY: unknownProxy.origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            const handler = pi.events.get("session_before_compact")!;
            assert.equal(await handler({ reason: "threshold" }, bridgeCtx), undefined, "non-http(s) provider + unknown conversation → native compaction proceeds");
            assert.equal(await handler({ reason: "overflow" }, bridgeCtx), undefined, "same for overflow");
            assert.equal(await handler({ reason: "manual" }, bridgeCtx), undefined, "manual /compact stays user-owned");
        });

        // (B) The veto alone: even if the proxy CONFIRMS the conversation id
        // (stale state from an earlier proxied phase of the same session), a
        // non-http(s) baseUrl means this turn's traffic cannot reach it.
        await withEnv({ BILLION_CONTEXT_PROXY: knownProxy.origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            const handler = pi.events.get("session_before_compact")!;
            assert.equal(await handler({ reason: "threshold" }, bridgeCtx), undefined, "non-http(s) baseUrl vetoes even a confirming proxy");
        });

        // (C) Positive evidence via the proxy: http provider, fresh instance
        // (no local stamp), proxy confirms it carries the conversation → cancel.
        await withEnv({ BILLION_CONTEXT_PROXY: knownProxy.origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            const handler = pi.events.get("session_before_compact")!;
            assert.deepEqual(await handler({ reason: "threshold" }, httpCtx("sess-carried")), { cancel: true }, "proxy confirms carriage → auto compaction cancelled");
        });

        // (D) http provider whose traffic bypasses the proxy (e.g. a custom
        // provider added after launch, never routed through it): no local
        // stamp, proxy has no such conversation → native compaction proceeds.
        await withEnv({ BILLION_CONTEXT_PROXY: unknownProxy.origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            const handler = pi.events.get("session_before_compact")!;
            assert.equal(await handler({ reason: "threshold" }, httpCtx("sess-direct")), undefined, "proxy never saw this conversation → native compaction proceeds");
        });
    } finally {
        await unknownProxy.close();
        await knownProxy.close();
    }

    // (E) Local stamp fast path: x-bili-plugin-conversation stamped for this
    // sid (tools registered + request routed through the proxy) is evidence
    // on its own — no status round-trip needed, so it holds even when the
    // proxy reports the conversation unknown.
    const stampedProxy = await startFakeProxy({ statusOk: false });
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: stampedProxy.origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            const ctx = fakeCtx(stampedProxy, "sess-stamped");
            await pi.events.get("session_start")!({}, ctx);
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            await pi.events.get("before_provider_headers")!({ headers }, ctx);
            assert.equal(headers["x-bili-plugin-conversation"], "sess-stamped");
            const handler = pi.events.get("session_before_compact")!;
            assert.deepEqual(await handler({ reason: "threshold" }, ctx), { cancel: true }, "locally stamped session is carried by construction");
        });
    } finally {
        await stampedProxy.close();
    }

    // (F) Probe failure is safe-side: proxy unreachable (connection refused)
    // and no local stamp → no evidence → defer to native compaction instead
    // of cancelling into an overflow.
    const probePort = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const port = (s.address() as { port: number }).port;
            s.close(() => resolve(port));
        });
    });
    await withEnv({ BILLION_CONTEXT_PROXY: `http://127.0.0.1:${probePort}` }, async () => {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("session_before_compact")!;
        assert.equal(await handler({ reason: "threshold" }, httpCtx("sess-down")), undefined, "unreachable proxy → no ownership evidence → native compaction proceeds");
    });

    // (G) omp parity: announced auto passes get the same evidence gate.
    const ompCtx = httpCtx("sess-omp");
    const runOmpCase = async (statusOk: boolean, expectCancel: boolean, label: string): Promise<void> => {
        const proxy = await startFakeProxy({ statusOk });
        try {
            await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
                const omp = makeFakePi();
                createBiliPlugin("omp")(omp as never);
                const handler = omp.events.get("session_before_compact")!;
                omp.events.get("auto_compaction_start")!({}, undefined);
                const got = await handler({}, ompCtx);
                assert.deepEqual(got, expectCancel ? { cancel: true } : undefined, label);
            });
        } finally {
            await proxy.close();
        }
    };
    await runOmpCase(true, true, "omp: proxy confirms carriage → announced auto compaction cancelled");
    await runOmpCase(false, false, "omp: proxy never saw the conversation → announced auto compaction proceeds");

    // (H) omp identity fast path: a successful identity register is local
    // evidence — the cancel holds even though the proxy reports unknown.
    const identityProxy = await startFakeProxy({ statusOk: false });
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: identityProxy.origin }, async () => {
            const omp = makeFakePi();
            createBiliPlugin("omp")(omp as never);
            // #1403: pck stamping (the identity signal) only fires for
            // destinations bili actually processes — route through /bili/.
            const ctx = { ...httpCtx("sess-omp-id"), model: { contextWindow: 1000000, baseUrl: `${identityProxy.origin}/bili/https://api.example.com/v1` } };
            const payload = await omp.events.get("before_provider_request")!({ payload: { messages: [{ role: "user", content: "hi" }] } }, ctx);
            assert.equal((payload as { prompt_cache_key?: string })?.prompt_cache_key, "sess-omp-id", "identity registration completed with the request");
            omp.events.get("auto_compaction_start")!({}, undefined);
            assert.deepEqual(await omp.events.get("session_before_compact")!({}, ctx), { cancel: true }, "identity-registered session is carried by construction");
        });
    } finally {
        await identityProxy.close();
    }
});

test("pi extension registers manifest tools and stamps headers when proxied", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        // The header is only stamped once tools are registered, so register
        // first (a real session does this via session_start before the first
        // provider request; launcher-mode -p wins that race via the load-time
        // manifest prime — #1217, covered by the dedicated test below).
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        const headers: Record<string, string> = {};
        await pi.events.get("before_provider_headers")!({ headers }, fakeCtx(proxy));
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

test("#1214: before_provider_headers awaits tool registration — one-shot (-p) first request claims plugin mode", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        // The -p shape: NO session_start prewarm — the one and only request
        // dispatches at boot. pi's runner awaits async handlers, so awaiting
        // the handler mirrors the real host; the stamp must already carry
        // the full plugin-ownership header set on the FIRST fire.
        const headers: Record<string, string> = {};
        await pi.events.get("before_provider_headers")!({ headers }, fakeCtx(proxy));
        assert.equal(headers["x-bili-plugin"], "pi");
        assert.equal(headers["x-bili-plugin-conversation"], "sess-42");
        assert.equal(headers["x-bili-plugin-context-window"], "1000000");
        assert.equal(pi.tools.length, 2, "tools registered before the request could leave");
        // Subsequent fires stay stamped (cached registration, no re-fetch).
        const again: Record<string, string> = {};
        await pi.events.get("before_provider_headers")!({ headers: again }, fakeCtx(proxy));
        assert.equal(again["x-bili-plugin"], "pi");
    } finally {
        await proxy.close();
    }
});

test("before_provider_headers stamps after a session_start prewarm too", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        biliPlugin(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx(proxy));
        await waitForTools(pi, 2);
        const late: Record<string, string> = {};
        await pi.events.get("before_provider_headers")!({ headers: late }, fakeCtx(proxy));
        assert.equal(late["x-bili-plugin"], "pi");
        assert.equal(late["x-bili-plugin-conversation"], "sess-42");
    } finally {
        await proxy.close();
    }
});

test("#1217: launcher-mode manifest fetch is primed at extension load time", async () => {
    // Correctness of the -p first-request stamp under ANY latency is #1228's
    // awaited ownership claim; this prime is the latency half: the manifest
    // fetch must be IN FLIGHT before any event fires (load time, not
    // session_start), so that awaited claim resolves without waiting on the
    // network RTT. omp has no header hook at all — for it the prime is the
    // only way round 1 can carry plugin headers. Assert on observed request
    // arrival, not wall-clock margins.
    const manifest = JSON.stringify({ tools: { anthropic: [
        { name: "compress", description: "c", input_schema: { type: "object", properties: {} } },
        { name: "acp_status", description: "s", input_schema: { type: "object", properties: {} } },
    ] } });
    let manifestHits = 0;
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            manifestHits++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(manifest);
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        const ctx = { sessionManager: { getSessionId: () => "sess-42" }, model: { contextWindow: 1000000, baseUrl: "https://api.example.com/v1" } };
        await withEnv({ BILLION_CONTEXT_PROXY: origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            const deadline = Date.now() + 5000;
            while (manifestHits === 0 && Date.now() < deadline) await sleep(5);
            assert.ok(manifestHits >= 1, "manifest fetch must already be in flight before any event (load-time prime)");
            await pi.events.get("session_start")!({}, ctx);
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            await pi.events.get("before_provider_headers")!({ headers }, ctx);
            assert.equal(headers["x-bili-plugin"], "pi");
            assert.equal(headers["x-bili-plugin-conversation"], "sess-42");
            assert.equal(pi.tools.length, 2);
        });
    } finally {
        server.close();
    }
});

test("#1217: a failed manifest prime falls back to the event-time fetch and retry throttle", async () => {
    // A failed prime must degrade to the EXISTING event-time path: one
    // fallback fetch, then retry-throttled. With #1228's awaited claim, round
    // 1 rides wire mode while throttled, and the next awaited event performs
    // the recovery fetch and stamps in the same call. The first two requests
    // always fail and later ones succeed, so settlement is detected by
    // observed request arrival — never by wall-clock margins.
    let manifestRequests = 0;
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            manifestRequests++;
            if (manifestRequests > 2) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ tools: { anthropic: [
                    { name: "compress", description: "c", input_schema: { type: "object", properties: {} } },
                    { name: "acp_status", description: "s", input_schema: { type: "object", properties: {} } },
                ] } }));
                return;
            }
            res.writeHead(404);
            res.end("{}");
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        const ctx = { sessionManager: { getSessionId: () => "sess-42" }, model: { contextWindow: 1000000, baseUrl: "https://api.example.com/v1" } };
        await withEnv({ BILLION_CONTEXT_PROXY: origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi", { retryIntervalMs: 500 })(pi as never);
            // Request #1 = the failed load-time prime; request #2 = the
            // event-time fallback fetch kicked off by session_start. Wait
            // until BOTH are observed at the still-failing server, then drain.
            await pi.events.get("session_start")!({}, ctx);
            const settleDeadline = Date.now() + 5000;
            while (manifestRequests < 2 && Date.now() < settleDeadline) await sleep(5);
            assert.ok(manifestRequests >= 2, "failed prime must fall through to the event-time fetch");
            await flush();
            assert.equal(pi.tools.length, 0, "two failed fetches → no tools yet");
            // Round 1 while throttled: the awaited claim finds retryAt armed →
            // NO third request, NO stamp — graceful wire-mode degradation.
            const round1: Record<string, string> = {};
            await pi.events.get("before_provider_headers")!({ headers: round1 }, ctx);
            assert.deepEqual(round1, {}, "throttled round 1 rides wire mode");
            assert.equal(manifestRequests, 2, "throttle window makes no extra fetches");
            // Recovery: once the throttle expires, the next awaited event does
            // exactly one recovery fetch and stamps in the same call.
            let stamped: Record<string, string> | undefined;
            const recoverDeadline = Date.now() + 5000;
            while (!stamped && Date.now() < recoverDeadline) {
                const h: Record<string, string> = {};
                await pi.events.get("before_provider_headers")!({ headers: h }, ctx);
                if (h["x-bili-plugin"] === "pi") stamped = h;
                else await sleep(10);
            }
            assert.ok(stamped !== undefined, "recovery fetch succeeds once the throttle expires");
            assert.equal(stamped["x-bili-plugin-conversation"], "sess-42");
            assert.equal(pi.tools.length, 2);
            assert.equal(manifestRequests, 3, "recovery is a single fetch, not a storm");
        });
    } finally {
        server.close();
    }
});

test("#1217: kill switch suppresses the load-time manifest prime", async () => {
    let manifestHits = 0;
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            manifestHits++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools: { anthropic: [] } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: origin, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi as never);
            await sleep(50);
            assert.equal(manifestHits, 0, "BILLION_CONTEXT_PLUGIN=0 must keep the plugin fully inert at load time");
        });
    } finally {
        server.close();
    }
});

test("before_provider_headers stays silent when the manifest fetch keeps failing", async () => {
    // Graceful degradation: a dead manifest endpoint means the plugin never
    // claims ownership, so the session rides the proxy's wire mode forever.
    // #1214: the handler must RESOLVE (bounded await), never throw.
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
        await pi.events.get("before_provider_headers")!({ headers }, fakeCtx(origin));
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
        // #788: neutral wording — offers BOTH exits (proxy mode or remove the
        // plugin) instead of assuming proxy intent.
        assert.match(notes[0]!.msg, /no proxy detected/);
        assert.match(notes[0]!.msg, /run via `bili pi` \(or set a \/bili\/ baseURL\) to use proxy mode/);
        assert.match(notes[0]!.msg, /`bili plugin remove pi`/);
        assert.match(notes[0]!.msg, /billion-context-pi/);
    });
});

test("/acp no-proxy warning offers the remove exit for omp without billion-context-pi mention", async () => {
    await withEnv({ BILLION_CONTEXT_PROXY: undefined }, async () => {
        const pi = makeFakePi();
        ompPlugin(pi as never);
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
        assert.match(notes[0]!.msg, /run via `bili omp`/);
        assert.match(notes[0]!.msg, /`bili plugin remove omp`/);
        assert.doesNotMatch(notes[0]!.msg, /billion-context-pi/);
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

function startCacheReportProxy(result: string | undefined, error?: string): Promise<{ origin: string; calls: Array<{ conversationId: string; tool: string }>; close(): Promise<void> }> {
    const calls: Array<{ conversationId: string; tool: string }> = [];
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId: string; tool: string };
                calls.push({ conversationId: data.conversationId, tool: data.tool });
                res.writeHead(200, { "content-type": "application/json" });
                if (error !== undefined) res.end(JSON.stringify({ ok: false, error }));
                else res.end(JSON.stringify({ ok: true, result }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
                calls,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

test("/acp-cache forwards acp_cache and persists the wrapped report via sendMessage (#800)", async () => {
    const proxy = await startCacheReportProxy("CACHE-REPORT-BODY");
    try {
        const sent: Array<{ customType: string; content: string; display: boolean }> = [];
        const notes: string[] = [];
        const pi = { ...makeFakePi(), sendMessage: (m: { customType: string; content: string; display: boolean }) => sent.push(m) };
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-cache");
        assert.ok(cmd, "acp-cache command should be registered");
        const ctx = {
            sessionManager: { getSessionId: () => "sess-cache" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string) => notes.push(msg) },
        };
        await cmd!.handler("", ctx);
        // the model-facing tool is forwarded with the session's conversation id
        assert.deepEqual(proxy.calls, [{ conversationId: "sess-cache", tool: "acp_cache" }]);
        assert.equal(sent.length, 1, "one custom message sent");
        assert.equal(notes.length, 0, "notify must not fire when sendMessage is available");
        assert.equal(sent[0]!.customType, "bili-acp-cache");
        assert.equal(sent[0]!.display, true);
        assert.equal(sent[0]!.content, wrapCacheReport("CACHE-REPORT-BODY"));
    } finally {
        await proxy.close();
    }
});

test("/acp-cache falls back to raw-text notify when the host has no sendMessage (#800)", async () => {
    const proxy = await startCacheReportProxy("CACHE-REPORT-BODY");
    try {
        const notes: Array<{ msg: string; type?: string }> = [];
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-cache")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-cache" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1, "notify fallback fires");
        assert.equal(notes[0]!.type, "info");
        // transient notice carries the RAW report (no wrapper) — the wrapper is
        // only meaningful for the persistent-message strip path.
        assert.equal(notes[0]!.msg, "CACHE-REPORT-BODY");
    } finally {
        await proxy.close();
    }
});

test("/acp-cache warns when no proxy is detected (#800)", async () => {
    await withEnv({ BILLION_CONTEXT_PROXY: undefined }, async () => {
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-cache")!;
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

test("/acp-cache reports a proxy-side failure via notify error (#800)", async () => {
    const proxy = await startCacheReportProxy(undefined, "boom");
    try {
        const notes: Array<{ msg: string; type?: string }> = [];
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-cache")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-cache" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.type, "error");
        assert.match(notes[0]!.msg, /cache report failed/);
        assert.match(notes[0]!.msg, /boom/);
    } finally {
        await proxy.close();
    }
});

function startRuleProxy(result: string | undefined, error?: string): Promise<{ origin: string; calls: Array<{ conversationId: string; tool: string; args: Record<string, unknown> }>; close(): Promise<void> }> {
    const calls: Array<{ conversationId: string; tool: string; args: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId: string; tool: string; args?: Record<string, unknown> };
                calls.push({ conversationId: data.conversationId, tool: data.tool, args: data.args ?? {} });
                res.writeHead(200, { "content-type": "application/json" });
                if (error !== undefined) res.end(JSON.stringify({ ok: false, error }));
                else res.end(JSON.stringify({ ok: true, result }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
                calls,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

test("/acp-rule forwards acp_rule with empty args and persists the wrapped list via sendMessage (#1251)", async () => {
    const proxy = await startRuleProxy("rule1: always run typecheck");
    try {
        const sent: Array<{ customType: string; content: string; display: boolean }> = [];
        const notes: string[] = [];
        const pi = { ...makeFakePi(), sendMessage: (m: { customType: string; content: string; display: boolean }) => sent.push(m) };
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-rule");
        assert.ok(cmd, "acp-rule command should be registered");
        const ctx = {
            sessionManager: { getSessionId: () => "sess-rules" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string) => notes.push(msg) },
        };
        await cmd!.handler("", ctx);
        assert.deepEqual(proxy.calls, [{ conversationId: "sess-rules", tool: "acp_rule", args: {} }], "no-arg list forwards empty args");
        assert.equal(sent.length, 1, "one custom message sent");
        assert.equal(notes.length, 0, "notify must not fire when sendMessage is available");
        assert.equal(sent[0]!.customType, "bili-acp-rule");
        assert.equal(sent[0]!.display, true);
        assert.equal(sent[0]!.content, wrapRuleReport("rule1: always run typecheck"));
    } finally {
        await proxy.close();
    }
});

test("/acp-rule forwards the text as { rule } to record a rule (#1251)", async () => {
    const proxy = await startRuleProxy("Recorded rule2: prefer pnpm");
    try {
        const sent: Array<{ customType: string; content: string }> = [];
        const pi = { ...makeFakePi(), sendMessage: (m: { customType: string; content: string }) => sent.push(m) };
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-rule")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-rules-add" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (_msg: string) => {} },
        };
        await cmd.handler("  prefer pnpm  ", ctx);
        assert.deepEqual(proxy.calls, [{ conversationId: "sess-rules-add", tool: "acp_rule", args: { rule: "prefer pnpm" } }], "trimmed text forwarded as { rule }");
        assert.equal(sent[0]!.customType, "bili-acp-rule");
        assert.equal(sent[0]!.content, wrapRuleReport("Recorded rule2: prefer pnpm"));
    } finally {
        await proxy.close();
    }
});

test("/acp-rule falls back to raw-text notify when the host has no sendMessage (#1251)", async () => {
    const proxy = await startRuleProxy("No rules recorded.");
    try {
        const notes: string[] = [];
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-rule")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-rules-notify" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string) => notes.push(msg) },
        };
        await cmd.handler("", ctx);
        assert.equal(notes.length, 1, "notify fallback fires");
        assert.equal(notes[0], "No rules recorded.");
    } finally {
        await proxy.close();
    }
});

test("/acp-rule warns with an enablement hint when the proxy reports the feature disabled (#1251)", async () => {
    const proxy = await startRuleProxy("acp_rule is not enabled on this bili proxy (compress.rules.enabled is not true) — nothing was recorded.");
    try {
        const sent: Array<{ customType: string }> = [];
        const notes: Array<{ msg: string; type?: string }> = [];
        const pi = { ...makeFakePi(), sendMessage: (m: { customType: string }) => sent.push(m) };
        createBiliPlugin()(pi as never);
        const cmd = pi.commands.get("acp-rule")!;
        const ctx = {
            sessionManager: { getSessionId: () => "sess-rules-off" },
            model: { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
            ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) },
        };
        await cmd.handler("", ctx);
        assert.equal(sent.length, 0, "no transcript message when disabled");
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.type, "warning");
        assert.match(notes[0]!.msg, /compress\.rules\.enabled/);
    } finally {
        await proxy.close();
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
            await pi.events.get("before_provider_headers")!({ headers }, fakeCtx(undefined));
            assert.equal(headers["x-bili-plugin"], "omp");
        });
        await withEnv({ BILLION_CONTEXT_PLUGIN_AGENT: "omp", BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            const pi = makeFakePi();
            biliPlugin(pi as never);
            await pi.events.get("session_start")!({}, fakeCtx(undefined));
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            await pi.events.get("before_provider_headers")!({ headers }, fakeCtx(undefined));
            assert.equal(headers["x-bili-plugin"], "omp");
        });
        await withEnv({ BILLION_CONTEXT_PLUGIN_AGENT: undefined }, async () => {
            const pi = makeFakePi();
            createBiliPlugin("dsh")(pi as never);
            const ctx = { sessionManager: { getSessionId: () => "s" }, model: { baseUrl: `${proxy.origin}/bili/https://x` } };
            await pi.events.get("session_start")!({}, ctx);
            await waitForTools(pi, 2);
            const headers: Record<string, string> = {};
            await pi.events.get("before_provider_headers")!({ headers }, ctx);
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
    // #925 pi entry form: npm installs write the pi-managed npm spec
    // (auto-installed at pi startup, upgraded by `pi update`, survives node
    // prefix moves); dev/checkout installs keep the abs root.
    {
        const devRoot = "/home/x/projects/billion-context";
        assert.equal(piEntryFor(devRoot), devRoot);
        const npmRoot = "/home/x/.local/lib/node_modules/billion-context";
        assert.equal(piEntryFor(npmRoot), PI_NPM_ENTRY);
        assert.equal(PI_NPM_ENTRY, "npm:billion-context");
        assert.equal(isPiEntry(PI_NPM_ENTRY, devRoot), true);
        assert.equal(isPiEntry(PI_NPM_ENTRY, npmRoot), true);
        assert.equal(isPiEntry("npm:billion-context@0.1.40", devRoot), true);
    }
    await withEnv(hintEnv(home, piAgentDir), async () => {
        const root = selfPackageRoot();

        const freshInstall = pluginInstall("pi");
        assert.match(freshInstall, /installed/);
        assert.doesNotMatch(freshInstall, /replaced existing entries/);
        const piSettings = JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[] };
        assert.ok(piSettings.packages.includes(root));
        assert.match(pluginInstall("pi"), /already installed/);
        const firstRemove = pluginRemove("pi");
        assert.match(firstRemove, /removed/);
        assert.ok(firstRemove.includes(root), "remove reports the entry it dropped");
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
        const replaceMsg = pluginInstall("pi");
        assert.match(replaceMsg, /installed/);
        // #788: every dropped entry is named in the output — the
        // billion-context-pi removal in particular must not be silent.
        assert.ok(replaceMsg.includes("replaced existing entries:"));
        // #939: project-scope reminder mirrors the opencode LOCAL-scope note
        assert.match(replaceMsg, /<project>\/\.pi\/settings\.json/);
        for (const gone of [
            "npm:billion-context-pi",
            "npm:billion-context-pi@0.1.48",
            "npm:billion-context@0.1.40",
            "/home/x/projects/billion-context",
            "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\billion-context-pi",
        ]) {
            assert.ok(replaceMsg.includes(gone), `install output names removed entry ${gone}`);
        }
        assert.doesNotMatch(replaceMsg, /other-package/);
        const replaced = JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[]; theme: string };
        assert.deepEqual(replaced.packages, ["/home/x/other-package", root]);
        assert.equal(replaced.theme, "dark");
        const legacyRemove = pluginRemove("pi");
        assert.match(legacyRemove, /removed/);
        assert.ok(legacyRemove.includes(root), "remove reports the entry it dropped");
        assert.doesNotMatch(legacyRemove, /other-package/);
        assert.deepEqual((JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")) as { packages: string[] }).packages, ["/home/x/other-package"]);

        // omp install/status/remove verify the entry's target exists, so
        // materialize the (gitignored) dist artifact for this sub-test.
        const ompDistFile = path.join(root, "dist", "agent", "omp-native.js");
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
        assert.match(ompText, /extensions:\n  - \/some\/other\/ext\.js\n  - .*dist[\\/]agent[\\/]omp-native\.js\nfirstRunComplete: true\n/);
        assert.match(pluginInstall("omp"), /already installed/);
        assert.match(pluginRemove("omp"), /removed/);
        assert.equal(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), "extensions:\n  - /some/other/ext.js\nfirstRunComplete: true\n");

        const noExtYml = "firstRunComplete: true\n";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), noExtYml);
        pluginInstall("omp");
        assert.match(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), /firstRunComplete: true\nextensions:\n  - .*omp-native\.js\n/);
        pluginRemove("omp");

        const noNlYml = "extensions:";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), noNlYml);
        pluginInstall("omp");
        assert.match(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), /extensions:\n  - .*omp-native\.js\n/);
        pluginRemove("omp");

        const colZeroYml = "extensions:\n- /a.js\n- /b.js\nother: 1\n";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), colZeroYml);
        pluginInstall("omp");
        assert.match(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), /^extensions:\n- \/a\.js\n- \/b\.js\n- .*omp-native\.js\nother: 1\n$/);
        pluginRemove("omp");
        assert.equal(fs.readFileSync(path.join(home, ".omp/agent/config.yml"), "utf8"), colZeroYml);

        const flowYml = "extensions: [/a.js]\n";
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), flowYml);
        assert.throws(() => pluginInstall("omp"), /flow style|inline value/);
        const quotedYml = `extensions:\n  - "${path.join(root, "dist/agent/omp.js")}" # my ext\n`;
        fs.writeFileSync(path.join(home, ".omp/agent/config.yml"), quotedYml);
        assert.match(pluginInstall("omp"), /installed.*replaced/);
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

        // #638: a malformed block (args as string - legal TOML, invalid codex
        // schema) with a matching origin must NOT short-circuit to "already
        // installed"; reinstall must self-heal it to the canonical block.
        const selfRoot = path.dirname(path.dirname(path.resolve("src/plugin-install.ts")));
        const malformed = `[mcp_servers.other]\ncommand = "x"\n[mcp_servers.bili]\ncommand = "node"\nargs = '[\"${path.join(selfRoot, "dist", "mcp.js")}\"]'\nenv = { BILI_MCP_PROXY = "http://127.0.0.1:8787" }\n`;
        fs.writeFileSync(path.join(home, "config.toml"), malformed);
        const healedMsg = pluginInstall("codex");
        assert.match(healedMsg, /repaired args: was not an array/);
        const tomlHealed = fs.readFileSync(path.join(home, "config.toml"), "utf8");
        assert.match(tomlHealed, /args = \[/);
        assert.doesNotMatch(tomlHealed, /args = '\[/);
        assert.match(tomlHealed, /\[mcp_servers\.other\]\ncommand = "x"\n/);
        // A now-canonical block stays "already installed" on rerun.
        assert.match(pluginInstall("codex"), /already installed/);
        assert.match(pluginRemove("codex"), /removed/);

        // #820: pre-seed user settings — install must merge around them and remove must restore them.
        // #927: seed under whichever key this host's opencode generation uses, so the
        // round-trip assertions hold on both 1.x ("plugin") and 2.x ("plugins") machines.
        const ocKey = pickPluginKey(detectOpencodeMajor());
        const ocFile = path.join(home, ".config/opencode/opencode.json");
        fs.mkdirSync(path.dirname(ocFile), { recursive: true });
        fs.writeFileSync(ocFile, JSON.stringify({ $schema: "https://opencode.ai/config.json", compaction: { auto: true, buffer: 100 }, [ocKey]: ["some-other-plugin"] }));
        const ocPluginDir = path.join(home, ".config/opencode/plugins/billion-context");
        const ocInstallMsg = pluginInstall("opencode");
        assert.match(ocInstallMsg, /installed/);
        // #926: default install adds NO mcp.bili (native plugin provides the
        // tools); --with-mcp opts in and pins only via explicit BILI_MCP_PROXY.
        assert.match(ocInstallMsg, /mcp\.bili not written/);
        const ocWithMcp = pluginInstall("opencode", { withMcp: true });
        assert.match(ocWithMcp, /mcp\.bili written \(BILI_MCP_PROXY=http:\/\/127\.0\.0\.1:8787\)/);
        let oc = JSON.parse(fs.readFileSync(ocFile, "utf8")) as { mcp?: Record<string, { command: string[]; environment?: Record<string, string> }>; compaction?: Record<string, unknown>; $schema?: string } & Record<string, unknown>;
        assert.equal(oc.mcp?.bili.command[1]!.endsWith(path.join("dist", "mcp.js")), true);
        assert.equal(oc.mcp?.bili.environment?.BILI_MCP_PROXY, "http://127.0.0.1:8787");
        assert.deepEqual(oc[ocKey], ["some-other-plugin", ocPluginDir]);
        assert.match(fs.readFileSync(path.join(ocPluginDir, "index.js"), "utf8").replace(/\\+/g, "/"), /agent\/opencode-native\.js/);
        assert.deepEqual(oc.compaction, { auto: false, buffer: 100 });
        const ocAgain = pluginInstall("opencode", { withMcp: true });
        assert.match(ocAgain, /mcp\.bili present/);
        assert.match(ocAgain, new RegExp(`${ocKey} present`));
        assert.match(pluginRemove("opencode"), /removed/);
        oc = JSON.parse(fs.readFileSync(ocFile, "utf8")) as Record<string, unknown>;
        assert.equal(oc.mcp, undefined);
        // only the bili entry is dropped — the user's other plugin survives
        assert.deepEqual(oc[ocKey], ["some-other-plugin"]);
        assert.deepEqual(oc.compaction, { auto: true, buffer: 100 });
        assert.equal(oc.$schema, "https://opencode.ai/config.json");
        assert.equal(fs.existsSync(ocPluginDir), false);

        // #964 native posture: the managed settings block is written FIRST
        // (pure JSON, no CLI needed); the MCP face execs the claude CLI. With
        // the stub CLAUDE above the exec fails — install throws, but the
        // block IS in place, so remove has real work (and must not exec the
        // CLI when the MCP face never registered).
        assert.throws(() => pluginInstall("claude"), /claude: MCP registration failed .*managed settings block.*was written/);
        assert.equal(claudeNativeInstalled(), true);
        assert.match(pluginRemove("claude"), /managed block removed/);
        assert.match(pluginRemove("claude"), /not installed/);

        const rows = pluginStatusAll();
        assert.equal(rows.length, 9);
        assert.deepEqual(PLUGIN_AGENTS, ["pi", "omp", "claude", "codex", "opencode", "dsh", "kimi", "hermes", "zcode"]);
    });
    fs.rmSync(home, { recursive: true, force: true });
});

test("plugin install opencode without a live proxy: MCP shell skipped, native plugin still installed (#820)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-noproxy-"));
    const ocFile = path.join(home, ".config/opencode/opencode.json");
    try {
        await withEnv({ OPENCODE_CONFIG: ocFile, BILI_MCP_PROXY: undefined, XDG_STATE_HOME: path.join(home, "state") }, async () => {
            const ocKey = pickPluginKey(detectOpencodeMajor());
            const msg = pluginInstall("opencode");
            assert.match(msg, /installed/);
            // #926: no mcp.bili by default — with or without a live proxy
            assert.match(msg, /mcp\.bili not written/);
            assert.doesNotMatch(msg, /no bili proxy origin found/);
            const data = JSON.parse(fs.readFileSync(ocFile, "utf8")) as { mcp?: unknown; compaction?: Record<string, unknown> } & Record<string, unknown>;
            assert.equal(data.mcp, undefined);
            assert.deepEqual(data[ocKey], [path.join(home, ".config/opencode/plugins/billion-context")]);
            assert.deepEqual(data.compaction, { auto: false });
            assert.ok(fs.existsSync(path.join(home, ".config/opencode/plugins/billion-context/index.js")));
            assert.match(pluginRemove("opencode"), /removed/);
            const after = JSON.parse(fs.readFileSync(ocFile, "utf8")) as Record<string, unknown>;
            assert.equal(after.mcp, undefined);
            assert.equal(after[ocKey], undefined);
            assert.equal(after.compaction, undefined);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("plugin install opencode replaces legacy opencode-acp entries — array and object shapes (#918)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-acp-"));
    const ocFile = path.join(home, ".config/opencode/opencode.json");
    fs.mkdirSync(path.dirname(ocFile), { recursive: true });
    try {
        await withEnv({ OPENCODE_CONFIG: ocFile, BILI_MCP_PROXY: undefined, XDG_STATE_HOME: path.join(home, "state") }, async () => {
            const ocKey = pickPluginKey(detectOpencodeMajor());
            const otherKey = ocKey === "plugin" ? "plugins" : "plugin";
            const dir = path.join(home, ".config/opencode/plugins/billion-context");
            // array shape: bare name, npm: alias, path (incl. deep entry path), versioned
            fs.writeFileSync(ocFile, JSON.stringify({
                [ocKey]: ["opencode-acp", "npm:opencode-acp", "/opt/other-plugin", path.join(home, "ext/opencode-acp/index.js"), path.join(home, "ext2/opencode-acp/dist/index.js"), "opencode-acp@stable"],
            }));
            let msg = pluginInstall("opencode");
            assert.match(msg, /replaced opencode-acp plugin entries/);
            let data = JSON.parse(fs.readFileSync(ocFile, "utf8")) as Record<string, unknown>;
            assert.deepEqual(data[ocKey], ["/opt/other-plugin", dir]);
            assert.ok(fs.existsSync(`${ocFile}.bili-bak`));
            pluginRemove("opencode");

            // object shape: version-map form (#1002: preserved as a map now —
            // our key joins it, foreign values never collapse to bare keys)
            fs.writeFileSync(ocFile, JSON.stringify({ [ocKey]: { "opencode-acp": "stable", "other": "1.0" } }));
            msg = pluginInstall("opencode");
            assert.match(msg, /replaced opencode-acp plugin entries \(opencode-acp\)/);
            data = JSON.parse(fs.readFileSync(ocFile, "utf8"));
            // sibling map entries survive verbatim + our dir as a key
            assert.deepEqual(data[ocKey], { other: "1.0", [dir]: true });
            pluginRemove("opencode");

            // #927: legacy entries under the OTHER spelling are stripped too
            fs.writeFileSync(ocFile, JSON.stringify({ [otherKey]: ["npm:opencode-acp", "/opt/other-plugin"], [ocKey]: ["/opt/mine"] }));
            msg = pluginInstall("opencode");
            assert.match(msg, /replaced opencode-acp plugin entries \(npm:opencode-acp\)/);
            data = JSON.parse(fs.readFileSync(ocFile, "utf8"));
            assert.deepEqual(data[otherKey], ["/opt/other-plugin"]);
            assert.deepEqual(data[ocKey], ["/opt/mine", dir]);
            pluginRemove("opencode");

            // no legacy entries -> no note, plugin untouched
            fs.writeFileSync(ocFile, JSON.stringify({ [ocKey]: ["/opt/other-plugin"] }));
            msg = pluginInstall("opencode");
            assert.doesNotMatch(msg, /replaced opencode-acp/);
            assert.equal(msg.includes("other-plugin"), false);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("plugin install/remove/status survive a non-object mcp in opencode.json (#809/N4)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-badmcp-"));
    const ocFile = path.join(home, ".config/opencode/opencode.json");
    fs.mkdirSync(path.dirname(ocFile), { recursive: true });
    try {
        await withEnv({ OPENCODE_CONFIG: ocFile, BILI_MCP_PROXY: undefined, XDG_STATE_HOME: path.join(home, "state") }, async () => {
            const ocKey = pickPluginKey(detectOpencodeMajor());
            fs.writeFileSync(ocFile, JSON.stringify({ mcp: "totally-broken-string" }));
            const msg = pluginInstall("opencode");
            assert.match(msg, /installed/);
            let data = JSON.parse(fs.readFileSync(ocFile, "utf8")) as Record<string, unknown>;
            assert.deepEqual(data[ocKey], [path.join(home, ".config/opencode/plugins/billion-context")]);
            assert.deepEqual(data.compaction, { auto: false });
            assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")?.status, "installed");
            assert.doesNotThrow(() => pluginRemove("opencode"));
            data = JSON.parse(fs.readFileSync(ocFile, "utf8")) as Record<string, unknown>;
            assert.equal(data[ocKey], undefined);
            assert.equal(data.compaction, undefined);
            assert.ok(!fs.existsSync(path.join(home, ".config/opencode/plugins/billion-context/index.js")));
            assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")?.status, "not installed");
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("omp plugin: scoped matching, existence check, overlay redirect (issue #392)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-omp-"));
    const root = selfPackageRoot();
    const ompDistFile = path.join(root, "dist", "agent", "omp-native.js");
    const createdOmpDist = !fs.existsSync(ompDistFile);
    if (createdOmpDist) {
        fs.mkdirSync(path.dirname(ompDistFile), { recursive: true });
        fs.writeFileSync(ompDistFile, "// test stub\n");
    }
    try {
        const stale = "/does/not/exist/dist/agent/omp.js";

        // (a) a stale in-block entry migrates to the native form on install
        // (#957); a same-valued line OUTSIDE the extensions block is never touched
        {
            const agentDir = path.join(home, "a", ".omp", "agent");
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, "config.yml"),
                `extensions:\n  - ${stale}\nother:\n  - ${stale}\nfirstRunComplete: true\n`);
            await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
                assert.match(pluginInstall("omp"), /installed.*replaced/);
                assert.equal(pluginStatusAll().find((r) => r.agent === "omp")?.status, "installed");
            });
            assert.match(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"),
                /extensions:\n  - .*dist[\\/]agent[\\/]omp-native\.js\nother:\n  - \/does\/not\/exist\/dist\/agent\/omp\.js\nfirstRunComplete: true\n/);
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
                /extensions:\n  - .*dist[\\/]agent[\\/]omp-native\.js\n/);
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

// #836 (found in #809 N4): a non-object `mcp` (e.g. bare string) made
// `"bili" in mcp` throw — crashing remove (stranding a half-install) and
// surfacing "error:" from status. All three opencode sites must degrade
// gracefully instead of throwing.
test("plugin opencode survives a non-object mcp (issue #836 / #809 N4)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-home-"));
    const piAgentDir = path.join(home, ".pi/agent");
    await withEnv(hintEnv(home, piAgentDir), async () => {
        const ocDir = path.join(home, ".config/opencode");
        fs.mkdirSync(ocDir, { recursive: true });
        const ocFile = path.join(ocDir, "opencode.json");
        const malformed = JSON.stringify({ mcp: "bogus-string", other: 1 });
        fs.writeFileSync(ocFile, malformed);

        assert.doesNotThrow(() => pluginRemove("opencode"));
        assert.match(pluginRemove("opencode"), /not installed/);
        assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")!.status, "not installed");
        assert.equal(fs.readFileSync(ocFile, "utf8"), malformed);

        // New installer (#919/#927): a bogus mcp key skips ONLY the mcp shell
        // (#926: only reachable via --with-mcp now) — the native plugin entry
        // + compaction.auto still land, and sibling keys survive untouched.
        assert.doesNotThrow(() => pluginInstall("opencode"));
        assert.match(pluginInstall("opencode", { withMcp: true }), /skipped/i);
        assert.match(pluginInstall("opencode"), /mcp\.bili not written/);
        const data = JSON.parse(fs.readFileSync(ocFile, "utf8")) as Record<string, unknown>;
        assert.equal(data.mcp, "bogus-string");
        assert.equal(data.other, 1);
        const ocKey = pickPluginKey(detectOpencodeMajor());
        assert.deepEqual(data[ocKey], [path.join(ocDir, "plugins", "billion-context")]);
        assert.deepEqual(data.compaction, { auto: false });
    });
    fs.rmSync(home, { recursive: true, force: true });
});

// #839 (found while reviewing #837): same bug class as #836 on the claude side
// — a non-object `mcpServers` in .claude.json made `"bili" in mcpServers` throw
// in claudeStatus(), crashing remove (which calls status first) and surfacing
// "error:" from status.
test("plugin claude survives a non-object mcpServers (issue #839)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-home-"));
    const piAgentDir = path.join(home, ".pi/agent");
    await withEnv(hintEnv(home, piAgentDir), async () => {
        const cFile = path.join(home, ".claude.json");
        const malformed = JSON.stringify({ mcpServers: "bogus-string", other: 1 });
        fs.writeFileSync(cFile, malformed);

        assert.doesNotThrow(() => pluginRemove("claude"));
        assert.match(pluginRemove("claude"), /not installed/);
        assert.equal(pluginStatusAll().find((r) => r.agent === "claude")!.status, "not installed");
        assert.equal(fs.readFileSync(cFile, "utf8"), malformed);
    });
    fs.rmSync(home, { recursive: true, force: true });
});

test("plugin list survives a broken host config (per-row error, no crash)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugin-home-"));
    const piAgentDir = path.join(home, ".pi/agent");
    await withEnv(hintEnv(home, piAgentDir), async () => {
        fs.writeFileSync(path.join(home, ".claude.json"), "{ broken json");
        const rows = pluginStatusAll();
        assert.equal(rows.length, 9);
        // #964: claude status never throws — a broken .claude.json just means
        // "MCP face unreadable" (false); the managed block reads settings.json
        // separately, so the row degrades to not-installed instead of error.
        const claude = rows.find((r) => r.agent === "claude")!;
        assert.equal(claude.status, "not installed");
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

test("#1230: before_provider_request awaits identity registration — omp one-shot (-p) first dispatch claims plugin mode", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        ompPlugin(pi as never);
        // The -p shape: NO session_start prewarm — the one and only request
        // dispatches at boot. omp's runner awaits async handlers and sends the
        // resolved payload, so by the time the handler RESOLVES the identity
        // register must already have landed on the wire — the proxy binds the
        // dispatching session into plugin mode instead of an anonymous pfa.
        const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "m", messages: [{ role: "user", content: "hi" }] } }, fakeCtx(proxy, "omp-sess-oneshot"));
        assert.equal(pi.tools.length, 2, "tools registered before the request could leave");
        assert.deepEqual(proxy.registers, [{ conversationId: "omp-sess-oneshot", agent: "omp", identity: true }], "identity register landed BEFORE the handler resolved");
        assert.equal((out as Record<string, unknown>).prompt_cache_key, "omp-sess-oneshot", "payload still stamped with the omp session id");
        // Subsequent fires stay cached (no re-register, no re-fetch).
        const again = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "m", messages: [{ role: "user", content: "hi" }] } }, fakeCtx(proxy, "omp-sess-oneshot"));
        assert.deepEqual(proxy.registers, [{ conversationId: "omp-sess-oneshot", agent: "omp", identity: true }], "no duplicate register on the second fire");
        assert.equal((again as Record<string, unknown>).prompt_cache_key, "omp-sess-oneshot");
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

test("#1362: omp child sessions report parentConversationId in the identity register", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        createBiliPlugin("omp")(pi as never);
        // omp fork() records the parent's BARE SESSION ID in the header.
        const headerCtx = { ...fakeCtx(proxy, "omp-sess-child"), sessionManager: { getSessionId: () => "omp-sess-child", getHeader: () => ({ type: "session", id: "omp-sess-child", parentSession: "omp-parent-bare-id" }) } };
        await pi.events.get("session_start")!({}, headerCtx);
        await waitForTools(pi, 2);
        const deadline = Date.now() + 15000;
        while (proxy.registers.length < 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.deepEqual(proxy.registers, [{ conversationId: "omp-sess-child", agent: "omp", identity: true, parentConversationId: "omp-parent-bare-id" }], "bare-id parentSession reported verbatim");

        // A plain omp session (no parentSession) keeps today's exact payload shape.
        const pi2 = makeFakePi();
        createBiliPlugin("omp")(pi2 as never);
        await pi2.events.get("session_start")!({}, fakeCtx(proxy, "omp-sess-plain"));
        await waitForTools(pi2, 2);
        const deadline2 = Date.now() + 15000;
        while (proxy.registers.length < 2 && Date.now() < deadline2) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.deepEqual(proxy.registers[1], { conversationId: "omp-sess-plain", agent: "omp", identity: true }, "no parentConversationId key for root sessions");
    } finally {
        await proxy.close();
    }
});

// #266: omp's chat-completions payloads carry NO conversation signal, so the
// plugin stamps prompt_cache_key with the omp session id. #1403: pck is a
// bili-internal identity signal, so it is ONLY stamped when the destination
// will actually reach the proxy (/bili/-rewritten URL, BILLION_CONTEXT_PROXY
// origin, or BILI_MITM_HOSTS whitelist) — a strict-schema upstream behind a
// blind tunnel would reject the foreign field. The
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
    // #1230: the handler is async (it awaits tool registration); fakeCtx
    // (undefined) keeps registerTools a no-op, so awaiting stays pure. The
    // ctx carries a /bili/-rewritten baseUrl so the destination counts as
    // proxy-routed (#1403).
    const routedCtx = (): Record<string, unknown> => ({
        ...fakeCtx(undefined, sid),
        model: { contextWindow: 1000000, baseUrl: "http://127.0.0.1:8787/bili/https://api.example.com/v1" },
    });
    const handler = async (pi: FakePi, payload: unknown) =>
        pi.events.get("before_provider_request")!({ type: "before_provider_request", payload }, routedCtx());

    // chat payload (messages, no input, no max_tokens, no native pck) → stamped
    {
        const pi = mk();
        const payload = { model: "glm-4", messages: [{ role: "user", content: "hi" }] };
        const out = await handler(pi, payload) as Record<string, unknown>;
        assert.equal(out.prompt_cache_key, sid, "chat payload stamped with the omp session id");
        assert.deepEqual(out.messages, payload.messages, "rest of the payload preserved");
        assert.equal(payload.prompt_cache_key, undefined, "original payload not mutated");
    }
    // real-world chat-completions payload carries max_tokens (omp's openai-compat
    // providers use maxTokensField:"max_tokens") → stamped (#268)
    {
        const pi = mk();
        const out = await handler(pi, { model: "glm-4", messages: [{ role: "user", content: "hi" }], max_tokens: 4096, temperature: 0.7 }) as Record<string, unknown>;
        assert.equal(out.prompt_cache_key, sid, "chat-completions payload WITH max_tokens stamped");
        assert.equal(out.max_tokens, 4096, "max_tokens preserved");
    }
    // native prompt_cache_key already present → not overridden
    {
        const pi = mk();
        const out = await handler(pi, { messages: [{ role: "user", content: "hi" }], prompt_cache_key: "native-pck" });
        assert.equal(out, undefined, "native pck is not overridden");
    }
    // responses payload (input array) → untouched
    {
        const pi = mk();
        const out = await handler(pi, { input: [{ role: "user", content: "hi" }] });
        assert.equal(out, undefined, "responses payload (input) untouched");
    }
    // anthropic wire shape (messages + max_tokens) → stamped too when the
    // destination is proxy-visible: the plugin cannot tell the wires apart by
    // shape, and the proxy records the mapping from the body pck on the
    // anthropic path and strips the field before forwarding (#268/#1403)
    {
        const pi = mk();
        const out = await handler(pi, { messages: [{ role: "user", content: "hi" }], max_tokens: 1024, system: "s" }) as Record<string, unknown>;
        assert.equal(out.prompt_cache_key, sid, "anthropic wire shape stamped (proxy strips before forward)");
    }
    // no session id → untouched
    {
        const pi = mk();
        const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, fakeCtx(undefined, ""));
        assert.equal(out, undefined, "no session id → untouched");
    }
    // non-object payload → untouched
    {
        const pi = mk();
        assert.equal(await handler(pi, "not an object"), undefined, "non-object payload untouched");
        assert.equal(await handler(pi, null), undefined, "null payload untouched");
        assert.equal(await handler(pi, [1, 2, 3]), undefined, "array payload untouched");
    }
    // no messages array → untouched
    {
        const pi = mk();
        const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "m" } }, fakeCtx(undefined, sid));
        assert.equal(out, undefined, "no messages array → untouched");
    }

    // #1403: destination gating — pck only reaches the proxy when the traffic
    // actually flows through it; stamping for blind-tunnel destinations just
    // leaks a foreign top-level field into strict-schema upstreams.
    {
        const pi = mk();
        const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, fakeCtx(undefined, sid));
        assert.equal(out, undefined, "external host not routed through the proxy → not stamped (#1403)");
    }
    {
        const prev = process.env.BILI_MITM_HOSTS;
        process.env.BILI_MITM_HOSTS = "api.example.com";
        try {
            const pi = mk();
            const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, fakeCtx(undefined, sid)) as Record<string, unknown>;
            assert.equal(out.prompt_cache_key, sid, "MITM-whitelisted external host → stamped (#1403)");
        } finally {
            if (prev === undefined) delete process.env.BILI_MITM_HOSTS;
            else process.env.BILI_MITM_HOSTS = prev;
        }
    }
    {
        const prev = process.env.BILLION_CONTEXT_PROXY;
        process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
        try {
            const pi = mk();
            const ctx = { ...fakeCtx(undefined, sid), model: { contextWindow: 1000000, baseUrl: "http://127.0.0.1:8787/v1/messages" } };
            const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, ctx) as Record<string, unknown>;
            assert.equal(out.prompt_cache_key, sid, "BILLION_CONTEXT_PROXY-matched origin → stamped (#1403)");
        } finally {
            if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
            else process.env.BILLION_CONTEXT_PROXY = prev;
        }
    }
});

test("pi agent never stamps prompt_cache_key (it stamps headers instead)", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const out = await pi.events.get("before_provider_request")!({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "hi" }] } }, fakeCtx(undefined, "pi-uuid"));
    assert.equal(out, undefined, "pi agent never stamps the body");
});

async function waitForRuntimeInfoCount(proxy: FakeProxy, count: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (proxy.runtimeInfos.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} runtime-info reports; got ${proxy.runtimeInfos.length}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("#957: omp reports runtime-info via before_provider_request (omp has no header event)", async () => {
    const proxy = await startFakeProxy();
    try {
        const pi = makeFakePi();
        ompPlugin(pi as never);
        const baseModel = { baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` };
        const ctxA = { ...fakeCtx(proxy, "omp-rt-1"), model: { id: "omp-rt-model-a", contextWindow: 200000, maxTokens: 32768, ...baseModel } };
        const ctxB = { ...fakeCtx(proxy, "omp-rt-1"), model: { id: "omp-rt-model-b", contextWindow: 128000, maxTokens: 16384, ...baseModel } };
        await pi.events.get("session_start")!({}, ctxA);
        // #1230: the request handler awaits tool registration, so by the time
        // round 1's handler resolves the tools are ready and the report rides
        // the FIRST request (previously round 1 left before toolsReady flipped
        // and reported nothing — a race artifact, not a policy).
        await pi.events.get("before_provider_request")!({}, ctxA);
        await waitForRuntimeInfoCount(proxy, 1);
        assert.deepEqual(proxy.runtimeInfos[0], {
            agent: "omp",
            model: "omp-rt-model-a",
            contextWindow: 200000,
            maxOutput: 32768,
            baseURL: `${proxy.origin}/bili/https://api.example.com/v1`,
            source: "client-config",
        });
        // same model again → deduped, no second POST
        await pi.events.get("before_provider_request")!({}, ctxA);
        await flush();
        assert.equal(proxy.runtimeInfos.length, 1, "deduped per model switch");
        // model switch → exactly one more report with the new config
        await pi.events.get("before_provider_request")!({}, ctxB);
        await waitForRuntimeInfoCount(proxy, 2);
        assert.deepEqual(proxy.runtimeInfos[1], {
            agent: "omp",
            model: "omp-rt-model-b",
            contextWindow: 128000,
            maxOutput: 16384,
            baseURL: `${proxy.origin}/bili/https://api.example.com/v1`,
            source: "client-config",
        });
    } finally {
        await proxy.close();
    }
});
