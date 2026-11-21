import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
// The pi hook writes its outcome to the host log under HOME; keep it in a
// scratch home, and keep a live proxy from a bili-launched shell out of it.
const realHome = process.env.HOME;
const realProxyEnv = process.env.BILLION_CONTEXT_PROXY;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bc-6199-"));
delete process.env.BILLION_CONTEXT_PROXY;
process.on("exit", () => {
    try { fs.rmSync(process.env.HOME!, { recursive: true, force: true }); } catch { /* best effort */ }
    process.env.HOME = realHome;
    if (realProxyEnv !== undefined) process.env.BILLION_CONTEXT_PROXY = realProxyEnv;
});

import { AgentSession } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "acp-kernel";
import { createBiliPlugin } from "../src/agent/pi.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, listSessions } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// --- pi side: the hook asks the proxy to fold, then cancels pi's pass ---

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeFakePi(): { events: Map<string, Handler>; api: Record<string, unknown> } {
    const events = new Map<string, Handler>();
    const api: Record<string, unknown> = {
        on: (event: string, handler: Handler) => {
            const prev = events.get(event);
            events.set(event, prev ? (async (e, c) => { await prev(e, c); return handler(e, c); }) : handler);
        },
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerProvider: () => undefined,
        getAllTools: () => [],
        getActiveTools: () => [],
        setActiveTools: () => undefined,
    };
    return { events, api };
}

type FakeProxy = { origin: string; compressBodies: unknown[]; close: () => Promise<void> };

async function startFakeProxy(compress: (res: http.ServerResponse) => void, onCompress?: () => void): Promise<FakeProxy> {
    const compressBodies: unknown[] = [];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url === "/__bili/plugin/compress" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                compressBodies.push(JSON.parse(body));
                onCompress?.();
                compress(res);
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, compressBodies, close: () => { server.closeAllConnections?.(); return new Promise<void>((r) => server.close(() => r())); } };
}

const piCtx = (sid: string) => ({
    sessionManager: { getSessionId: () => sid },
    model: { contextWindow: 200000, baseUrl: "https://api.example.com/v1" },
    cwd: "/tmp",
});

async function withProxyEnv<T>(origin: string, fn: () => Promise<T>): Promise<T> {
    process.env.BILLION_CONTEXT_PROXY = origin;
    try {
        return await fn();
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY;
    }
}

function piEntries() {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const at = new Date().toISOString();
    const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string) => ({
        type: "message", id, parentId, timestamp: at,
        message: role === "user"
            ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
            : { role, content: [{ type: "text", text }], api: "openai-responses", provider: "p", model: "m", usage, stopReason: "stop", timestamp: Date.now() },
    });
    return [entry("a", null, "user", "one ".repeat(500)), entry("b", "a", "assistant", "two ".repeat(500)), entry("c", "b", "user", "three ".repeat(500)), entry("d", "c", "assistant", "four ".repeat(500))];
}

test("#6199: pi's own auto-compaction — compaction_start, then the proxy fold, then compaction_end (aborted)", async () => {
    const order: string[] = [];
    const proxy = await startFakeProxy((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(" " + JSON.stringify({ ok: true, conversationId: "sess-6199", folded: true }));
    }, () => order.push("proxy:/__bili/plugin/compress"));
    try {
        await withProxyEnv(proxy.origin, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi.api as never);
            const hook = pi.events.get("session_before_compact")!;
            const results: unknown[] = [];
            // Driven through pi's real AgentSession._runAutoCompaction: only the
            // collaborators it reads are stood in; the event order is pi's own.
            const host = {
                model: { id: "m" },
                agent: { streamFunction: () => undefined },
                settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }) },
                sessionManager: { getBranch: () => piEntries() },
                _getSummarizationRequestAuth: async () => ({}),
                _emit: (e: { type: string; aborted?: boolean }) => order.push(`pi:${e.type}${e.aborted === true ? " aborted" : ""}`),
                _extensionRunner: {
                    hasHandlers: (type: string) => type === "session_before_compact",
                    emit: async (e: unknown) => {
                        const r = await hook(e, piCtx("sess-6199"));
                        results.push(r);
                        return r;
                    },
                },
            };
            const ran = await (AgentSession.prototype as unknown as { _runAutoCompaction: (this: unknown, reason: string, willRetry: boolean) => Promise<boolean> })._runAutoCompaction.call(host, "threshold", false);
            assert.equal(ran, false);
            assert.deepEqual(order, ["pi:compaction_start", "proxy:/__bili/plugin/compress", "pi:compaction_end aborted"]);
            assert.deepEqual(results, [{ cancel: true }]);
            assert.deepEqual(proxy.compressBodies, [{ conversationId: "sess-6199" }]);
        });
    } finally {
        await proxy.close();
    }
});

test("#6199: the fold fails open — an error answer or pi's abort still cancels pi's pass", async () => {
    const failing = await startFakeProxy((res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "preflight threw" }));
    });
    try {
        await withProxyEnv(failing.origin, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi.api as never);
            const hook = pi.events.get("session_before_compact")!;
            assert.deepEqual(await hook({ reason: "overflow" }, piCtx("sess-err")), { cancel: true });
            assert.equal(failing.compressBodies.length, 1);
        });
    } finally {
        await failing.close();
    }
    const hanging = await startFakeProxy(() => { /* never answers */ });
    try {
        await withProxyEnv(hanging.origin, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi.api as never);
            const hook = pi.events.get("session_before_compact")!;
            const abort = new AbortController();
            const t0 = Date.now();
            setTimeout(() => abort.abort(), 50);
            assert.deepEqual(await hook({ reason: "threshold", signal: abort.signal }, piCtx("sess-esc")), { cancel: true });
            assert.ok(Date.now() - t0 < 5000, "pi's Escape ends the wait");
        });
    } finally {
        await hanging.close();
    }
});

test("#6199: manual /compact and an unowned conversation never ask the proxy to fold", async () => {
    const proxy = await startFakeProxy((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, folded: false }));
    });
    try {
        await withProxyEnv(proxy.origin, async () => {
            const pi = makeFakePi();
            createBiliPlugin("pi")(pi.api as never);
            const hook = pi.events.get("session_before_compact")!;
            assert.equal(await hook({ reason: "manual" }, piCtx("sess-manual")), undefined);
            const bridge = { sessionManager: { getSessionId: () => "sess-bridge" }, model: { contextWindow: 1000000, baseUrl: "claude-bridge" }, cwd: "/tmp" };
            assert.equal(await hook({ reason: "threshold" }, bridge), undefined);
            assert.equal(proxy.compressBodies.length, 0);
        });
    } finally {
        await proxy.close();
    }
});

// --- proxy side: POST /__bili/plugin/compress re-enters the last preflight ---

const LIMIT = 20_000;
const SUMMARY = "PRECOMPACT-SUMMARY: the earlier investigation is folded; the decisions stand.";
const RETAINED = "Bearer fake-retained-credential-6199";
type Body = { stream?: boolean; input?: unknown };

function history(count: number, totalChars: number) {
    return Array.from({ length: count }, (_, i) => ({
        type: "message", role: i % 2 === 0 ? "user" : "assistant",
        content: `History ${i}: ` + "recorded work ".repeat(Math.floor(totalChars / count / 14)),
    }));
}

async function withBili(reportedInput: number, run: (h: {
    calls: Body[];
    upstreamAuth: string[];
    turn: (conversation: string, plugin: boolean) => Promise<Response>;
    compress: (body: string) => Promise<{ status: number; text: string }>;
    get: (url: string) => Promise<string>;
}) => Promise<void>): Promise<void> {
    const calls: Body[] = [];
    const upstreamAuth: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
            calls.push(body);
            upstreamAuth.push(String(req.headers.authorization));
            if (!body.stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY }] }] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
            // The proxy reads the frame's type from its data, not the event line.
            res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
                id: "resp_done", status: "completed", output: [],
                usage: { input_tokens: reportedInput, output_tokens: 1, total_tokens: reportedInput + 1 },
            } })}\n\n`);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const previousPrompt = process.env.ACP_NO_COMPRESS_PROMPT;
    process.env.ACP_NO_COMPRESS_PROMPT = "1";
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetPluginStateForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [origin]: { models: { "gpt-resp": { context: LIMIT } } } },
        modelContextLimit: LIMIT, kernelConfig: defaultConfig(LIMIT),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null, autoUpdate: false,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: true, releaseNotesCheck: true,
        compat: { roles: {} }, streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
        await run({
            calls,
            upstreamAuth,
            turn: (conversation, plugin) => fetch(`${base}/bili/${origin}/v1/responses`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "user-agent": "pi-test/1.0",
                    authorization: RETAINED,
                    ...(plugin ? { "x-bili-plugin": "pi", "x-bili-plugin-conversation": conversation } : { "x-acp-session": conversation }),
                },
                body: JSON.stringify({ model: "gpt-resp", stream: true, input: history(10, 40_000) }),
            }),
            compress: async (body) => {
                const r = await fetch(`${base}/__bili/plugin/compress`, { method: "POST", headers: { "content-type": "application/json" }, body });
                return { status: r.status, text: await r.text() };
            },
            get: async (url) => (await fetch(`${base}${url}`)).text(),
        });
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        if (previousPrompt === undefined) delete process.env.ACP_NO_COMPRESS_PROMPT;
        else process.env.ACP_NO_COMPRESS_PROMPT = previousPrompt;
    }
}

// Which preflight gate a re-entered walk met: the trigger floors on the usage
// baseline, but the walk's own exit (#4288) judges the payload's estimate
// scaled by k̂, which a session publishes only after two agreeing usage
// samples. A failing assertion prints these so the declining gate is named.
function gates(): string {
    const s = listSessions()[0];
    if (s === undefined) return "no session";
    const st = s.stats;
    return JSON.stringify({ lastInputTokens: st.lastInputTokens, source: st.lastInputTokensSource, khat: st.calibratedEstimate ?? "unpublished", ring: st.calibrationRing?.values, pendingEstimate: st.lastLocalTextEstimate });
}

test("#6199: the route folds a plugin session whose answers outgrew its estimate", async () => {
    // Two turns of the same ~10k-token payload, each billed 24k: the second
    // answer publishes k̂ ≈ 2.4, so the retained request now measures over the
    // 20k window by the walk's own estimate. Neither turn folded by itself:
    // without k̂ the walk judged the raw estimate, which fits.
    await withBili(24_000, async ({ calls, upstreamAuth, turn, compress, get }) => {
        for (let i = 0; i < 2; i++) {
            const r = await turn("conv-full", true);
            assert.equal(r.status, 200, await r.text());
        }
        assert.equal(calls.filter((c) => !c.stream).length, 0, `the turns themselves forwarded unfolded; gates ${gates()}`);
        const answer = await compress(JSON.stringify({ conversationId: "conv-full" }));
        assert.equal(answer.status, 200, answer.text);
        assert.deepEqual(JSON.parse(answer.text), { ok: true, conversationId: "conv-full", folded: true }, `gates ${gates()}; summary rounds ${calls.filter((c) => !c.stream).length}`);
        const summaries = calls.filter((c) => !c.stream);
        assert.ok(summaries.length >= 1, "the fold ran its summary rounds upstream");
        assert.ok(upstreamAuth.every((a) => a === RETAINED), "the summary rounds carried the request's own credential");
        const status = await get("/__bili/plugin/status?conversationId=conv-full");
        for (const seen of [answer.text, status]) assert.ok(!seen.includes("fake-retained-credential"), "no retained header in an answer");
        const next = await turn("conv-full", true);
        assert.equal(next.status, 200, await next.text());
        const forwarded = calls.filter((c) => c.stream).at(-1)!;
        assert.match(JSON.stringify(forwarded.input), /PRECOMPACT-SUMMARY/, "the next turn ships the fold");
    });
});

test("#6199: the route leaves a fitting plugin session as it is", async () => {
    await withBili(9_000, async ({ calls, turn, compress }) => {
        for (let i = 0; i < 2; i++) assert.equal((await turn("conv-fits", true)).status, 200);
        const answer = await compress(JSON.stringify({ conversationId: "conv-fits" }));
        assert.deepEqual(JSON.parse(answer.text), { ok: true, conversationId: "conv-fits", folded: false }, `gates ${gates()}`);
        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summary round for a fitting session");
    });
});

test("#6199: the route's gates — bad body, unknown conversation, a session with no plugin request", async () => {
    await withBili(19_900, async ({ calls, turn, compress }) => {
        assert.equal((await compress("{")).status, 400);
        assert.equal((await compress(JSON.stringify({}))).status, 400);
        const unknown = await compress(JSON.stringify({ conversationId: "conv-never" }));
        assert.equal(unknown.status, 404, unknown.text);
        const wire = await turn("conv-wire", false);
        assert.equal(wire.status, 200, await wire.text());
        const [wireSession] = listSessions();
        assert.ok(wireSession, "the wire turn made a session");
        const wireAnswer = await compress(JSON.stringify({ conversationId: wireSession.id }));
        assert.deepEqual(JSON.parse(wireAnswer.text), { ok: true, conversationId: wireSession.id, skipped: "no-request" });
        assert.equal(calls.filter((c) => !c.stream).length, 0);
    });
});
