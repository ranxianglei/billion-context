import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #2483 follow-up: route-scoped render tags (`providers[<url>].renderNone`).
// A stateful claude-code relay (magpie) keyed to one upstream URL needs tags off
// while every other lane keeps them. These tests pin the forwarded bytes:
// the matching route decides, a non-matching route falls back to the global
// diagnostics flag, and ACP_RENDER_NONE still wins over both.
// (Harness copied from issue2483-render-strategy.test.ts.)
//
// Original header — #2483: the effective render strategy had two consistency holes:
//   (a) the processTurn diag line hardcoded renderTags=text-only even when
//       renderNone was active (misleading log);
//   (b) the Google lane ignored renderNone entirely — hardcoded "text-only" in
//       processTurn / Prepared / countTokens and no knob check on the #1881
//       tagsOnly gate, so ACP_RENDER_NONE was dead config on /v1beta.
// These e2e tests pin the WIRE bytes on both lanes: the default still tags
// assistant/model text (no behavior drift), and under ACP_RENDER_NONE=1 the
// forwarded assistant/model text is byte-identical to the client's and the
// NEVER-echo prompt section disappears (the tagsOnly gate follows the strategy).

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function upstreamServer(onBody: (path: string, body: unknown) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
            const url = req.url ?? "";
            onBody(url, parsed);
            res.writeHead(200, { "content-type": "application/json" });
            if (url.includes(":generateContent")) {
                res.end(JSON.stringify({
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 0, model: "test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness { port: number; stop: () => Promise<void>; cleanup: () => void }

async function startProxy(upstream: http.Server, fileConfig: (upstreamUrl: string) => unknown): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2483-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    delete process.env.ACP_RENDER_NONE;
    delete process.env.ACP_NO_COMPRESS_PROMPT;
    const upstreamPort = (upstream.address() as { port: number }).port;
    writeFileSync(biliConfig, JSON.stringify(fileConfig(`http://127.0.0.1:${upstreamPort}`)), "utf8");
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
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
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        passthroughSource: null,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            delete process.env.ACP_RENDER_NONE;
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

const CHAT_BODY = JSON.stringify({
    model: "test",
    max_tokens: 1000,
    messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "what did we say?" },
    ],
});


type Msg = { role?: string; content?: unknown };

function chatAssistantText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Msg[] | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const a = msgs.find((m) => m.role === "assistant");
    assert.ok(a, "the assistant message reaches the upstream");
    return typeof a.content === "string" ? a.content : JSON.stringify(a.content);
}

function chatSystemText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Msg[] | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const sys = msgs.find((m) => m.role === "system");
    assert.ok(sys, "a system message reaches the upstream");
    return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
}

async function sendChat(upstreamOf: (p: string, b: unknown) => void, cfg: (u: string) => unknown, sid: string, env?: string): Promise<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((p, body) => { upstreamOf(p, body); seen.push(body as Record<string, unknown>); });
    const harness = await startProxy(upstream, cfg);
    if (env !== undefined) process.env.ACP_RENDER_NONE = env;
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": sid },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        return seen[0]!;
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
}

const noop = () => {};

test("#2483 route renderNone=true: matching route forwards assistant text untagged", async () => {
    const fwd = await sendChat(noop, (u) => ({ providers: { [u]: { renderNone: true } } }), "route-render-none-on");
    assert.equal(chatAssistantText(fwd), "hi there", "assistant text is byte-identical to the client's");
    assert.ok(!chatSystemText(fwd).includes("NEVER echo"), "tags-only prohibition follows the route strategy");
});

test("#2483 route renderNone=false overrides a global diagnostics.renderNone=true", async () => {
    const fwd = await sendChat(noop, (u) => ({ diagnostics: { renderNone: true }, providers: { [u]: { renderNone: false } } }), "route-render-none-off");
    assert.ok(chatAssistantText(fwd).startsWith("<acp tokens="), "route forces tags back on");
});

test("#2483 a non-matching route leaves the default (tags on)", async () => {
    const fwd = await sendChat(noop, (u) => ({ providers: { [`${u}/other-lane`]: { renderNone: true } } }), "route-render-none-other");
    assert.ok(chatAssistantText(fwd).startsWith("<acp tokens="), "other lanes keep render tags");
});

test("#2483 ACP_RENDER_NONE still wins over a route renderNone=false", async () => {
    const fwd = await sendChat(noop, (u) => ({ providers: { [u]: { renderNone: false } } }), "route-render-none-env", "1");
    assert.equal(chatAssistantText(fwd), "hi there", "env switch outranks the route");
});
