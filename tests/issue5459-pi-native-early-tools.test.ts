import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

// Ambient bili state would leak into these tests exactly as documented in
// plugin-agent.test.ts (a shell launched THROUGH bili exports
// BILLION_CONTEXT_PROXY; an isolated HOME keeps delegate config inert).
const realHome = process.env.HOME;
const realProxyEnv = process.env.BILLION_CONTEXT_PROXY;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bc-issue5459-"));
delete process.env.BILLION_CONTEXT_PROXY;
process.on("exit", () => {
    try { fs.rmSync(process.env.HOME!, { recursive: true, force: true }); } catch { /* best effort */ }
    process.env.HOME = realHome;
    if (realProxyEnv !== undefined) process.env.BILLION_CONTEXT_PROXY = realProxyEnv;
});

import { setNativeOriginWaiter } from "../src/agent/native-bootstrap.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";

type TextBlock = { type: "text"; text: string };
type RecordedTool = { name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: Record<string, unknown>) => Promise<{ content: TextBlock[]; isError?: boolean }> };

type FakePi = {
    events: Map<string, (event: unknown, ctx: unknown) => unknown>;
    tools: RecordedTool[];
    readonly registerCalls: number;
    on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
    registerTool: (tool: RecordedTool) => void;
    getAllTools?: () => Array<{ name: string }>;
    activeTools: string[];
    getActiveTools?: () => string[];
    setActiveTools?: (toolNames: string[]) => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: RecordedTool[] = [];
    const activeTools: string[] = [];
    let registerCallCount = 0;
    return {
        events,
        tools,
        activeTools,
        get registerCalls() { return registerCallCount; },
        // Real pi chains ALL handlers per event; a single-slot map would let
        // the last registration shadow the rest (the factory registers two
        // session_start handlers).
        on: (event, handler) => {
            const h = handler as (event: unknown, ctx: unknown) => unknown;
            const prev = events.get(event);
            events.set(event, prev ? ((e, c) => { prev(e, c); return h(e, c); }) : h);
        },
        registerTool: (tool) => {
            registerCallCount++;
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
        getAllTools: () => tools.map((t) => ({ name: t.name })),
        getActiveTools: () => [...activeTools],
        setActiveTools: (toolNames) => {
            activeTools.splice(0, activeTools.length, ...new Set(toolNames));
        },
    };
}

type FakeProxy = { origin: string; registers: number; close(): Promise<void> };

const MANIFEST_TOOL_NAMES = ["compress", "decompress", "acp_status"];

async function startManifestProxy(): Promise<FakeProxy> {
    let registers = 0;
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools: { anthropic: MANIFEST_TOOL_NAMES.map((name) => ({ name, description: name, input_schema: { type: "object", properties: {} } })) } }));
            return;
        }
        if (url === "/__bili/plugin/register" && req.method === "POST") {
            registers++;
            req.resume();
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let closed = false;
    return { origin, close: () => new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        server.close(() => resolve());
    }), get registers() { return registers; } };
}

function fakeCtx(proxyOrigin: string | undefined, sessionId = "sess-42"): Record<string, unknown> {
    return {
        sessionManager: { getSessionId: () => sessionId },
        model: { contextWindow: 1000000, baseUrl: proxyOrigin ? `${proxyOrigin}/bili/https://api.example.com/v1` : "https://api.example.com/v1" },
        cwd: "/tmp",
    };
}

// Windows CI runners can take seconds on a cold loopback connect, so poll for
// registration instead of using a fixed flush (plugin-agent.test.ts pattern).
async function waitForTools(pi: FakePi, count: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pi.tools.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} registered tools; got ${pi.tools.length}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

function settle(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

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

// #5459: pi snapshots each round's payload (tools + system prompt) BEFORE its
// provider hooks run. Registration that only starts inside round 1's awaited
// hooks therefore lands after the snapshot: request 1 goes out without bili's
// tools while already stamped x-bili-plugin (plugin mode suppresses wire-side
// injection), and request 2's gained tools break the provider prefix cache
// for the whole session. The fix registers as soon as the manifest source
// exists — at load in launcher mode, at origin publication in native mode —
// so round 1's natural snapshot already carries the full tool table. These
// tests pin that registration happens with NO request event fired at all.
test("#5459: native mode — origin resolution alone registers the tools before any request", async () => {
    const proxy = await startManifestProxy();
    try {
        const pi = makeFakePi();
        const origin = deferred<string>();
        setNativeOriginWaiter({ wait: () => origin.promise });
        createBiliPlugin()(pi as never);
        // Bootstrap completes shortly after load — no event fires below.
        setTimeout(() => origin.resolve(proxy.origin), 30);
        await waitForTools(pi, MANIFEST_TOOL_NAMES.length);
        assert.deepEqual(pi.tools.map((t) => t.name), MANIFEST_TOOL_NAMES);
        assert.equal(proxy.registers, 0, "plain pi eager registration must not POST identity");
        // A late session_start must not re-register (dedupe guard).
        await pi.events.get("session_start")!({}, fakeCtx(undefined));
        await settle(100);
        assert.equal(pi.registerCalls, MANIFEST_TOOL_NAMES.length, "each tool registered exactly once across early + session_start paths");
    } finally {
        await proxy.close();
    }
});

test("#5459: launcher mode — load-time manifest prime registers before any event", async () => {
    const proxy = await startManifestProxy();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            const pi = makeFakePi();
            createBiliPlugin()(pi as never);
            await waitForTools(pi, MANIFEST_TOOL_NAMES.length);
            assert.deepEqual(pi.tools.map((t) => t.name), MANIFEST_TOOL_NAMES);
            assert.equal(proxy.registers, 0, "plain pi eager registration must not POST identity");
            assert.equal(pi.registerCalls, MANIFEST_TOOL_NAMES.length);
        });
    } finally {
        await proxy.close();
    }
});

test("#5459: fast first request wins the race — early registration never re-registers or clobbers the real sid", async () => {
    const proxy = await startManifestProxy();
    try {
        const pi = makeFakePi();
        const origin = deferred<string>();
        setNativeOriginWaiter({ wait: () => origin.promise });
        createBiliPlugin()(pi as never);
        // Round 1 of a one-shot (-p) lands while bootstrap is still finishing:
        // fire the header event immediately; it awaits the same origin.
        const headers: Record<string, string> = {};
        const headerEvent = (async () => pi.events.get("before_provider_headers")!({ headers }, fakeCtx(undefined)))();
        setTimeout(() => origin.resolve(proxy.origin), 30);
        await headerEvent;
        await waitForTools(pi, MANIFEST_TOOL_NAMES.length);
        assert.equal(pi.registerCalls, MANIFEST_TOOL_NAMES.length, "early + request paths must share one registration loop (pending dedupe / toolsFor guard)");
        assert.equal(headers["x-bili-plugin"], "pi", "ownership claimed once tools are ready");
        assert.equal(headers["x-bili-plugin-conversation"], "sess-42");
        // Whichever entry claimed the loop, a later request re-enters cleanly.
        const again: Record<string, string> = {};
        await pi.events.get("before_provider_headers")!({ headers: again }, fakeCtx(undefined));
        assert.equal(again["x-bili-plugin"], "pi");
    } finally {
        await proxy.close();
    }
});

// #3617 negative direction: when the bootstrap gives up (origin resolves
// undefined) nothing may register, crash, or leak an unhandled rejection.
test("#5459: give-up origin resolves undefined — no registration, no crash", async () => {
    const rejected: unknown[] = [];
    const onRejected = (reason: unknown): void => { rejected.push(reason); };
    process.on("unhandledRejection", onRejected);
    try {
        setNativeOriginWaiter({ wait: () => new Promise<string | undefined>((r) => setTimeout(() => r(undefined), 30)) });
        const pi = makeFakePi();
        createBiliPlugin()(pi as never);
        await settle(250);
        assert.equal(pi.tools.length, 0, "give-up must leave the tool table untouched");
        assert.deepEqual(rejected, []);
    } finally {
        process.off("unhandledRejection", onRejected);
    }
});
