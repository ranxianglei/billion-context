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

// #2483: the effective render strategy had two consistency holes:
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

async function startProxy(upstream: http.Server, injectTool: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2483-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, `{"providers":{}}`, "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    delete process.env.ACP_RENDER_NONE;
    delete process.env.ACP_NO_COMPRESS_PROMPT;
    const upstreamPort = (upstream.address() as { port: number }).port;
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
        compress: { injectTool, injectNudge: false },
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

const GOOGLE_BODY = JSON.stringify({
    systemInstruction: "You are helpful.",
    contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi there" }] },
        { role: "user", parts: [{ text: "what did we say?" }] },
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

interface GPart { text?: string }
interface GContent { role?: string; parts?: GPart[] }

function googleModelText(fwd: Record<string, unknown>): string {
    const contents = fwd.contents as GContent[] | undefined;
    assert.ok(Array.isArray(contents), "forwarded body carries contents");
    const model = contents.find((c) => c.role === "model");
    assert.ok(model, "the model turn reaches the upstream");
    const texts = (model.parts ?? []).map((p) => p.text ?? "");
    return texts.join("");
}

function googleSystemText(fwd: Record<string, unknown>): string {
    const si = fwd.systemInstruction;
    if (typeof si === "string") return si;
    const parts = (si as { parts?: GPart[] })?.parts;
    assert.ok(Array.isArray(parts), "object-form systemInstruction carries parts");
    return parts.map((p) => p.text ?? "").join("\n\n");
}

test("#2483 openai lane default: assistant text is tagged (behavior unchanged)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, false);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue2483-openai-default" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const a = chatAssistantText(seen[0]!);
        assert.ok(a.startsWith("<acp tokens="), `default strategy tags assistant text, got: ${JSON.stringify(a.slice(0, 40))}`);
        assert.ok(a.includes("hi there"), "original text survives after the tag");
        assert.ok(chatSystemText(seen[0]!).includes("NEVER echo"), "tags-only prohibition rides along by default");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("#2483 openai lane renderNone: assistant text byte-identical, no NEVER-echo section", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, false);
    process.env.ACP_RENDER_NONE = "1";
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue2483-openai-none" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(chatAssistantText(seen[0]!), "hi there", "renderNone forwards the assistant text untouched");
        assert.ok(!chatSystemText(seen[0]!).includes("NEVER echo"), "tags-only prompt follows the rendered tags");
    } finally {
        delete process.env.ACP_RENDER_NONE;
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("#2483 google lane default: model text is tagged (behavior unchanged)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, false);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1beta/models/test:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue2483-google-default" },
            body: GOOGLE_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const t = googleModelText(seen[0]!);
        assert.ok(t.startsWith("<acp tokens="), `default strategy tags model text, got: ${JSON.stringify(t.slice(0, 40))}`);
        assert.ok(t.includes("hi there"), "original text survives after the tag");
        assert.ok(googleSystemText(seen[0]!).includes("NEVER echo"), "tags-only prohibition rides along by default");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("#2483 google lane renderNone: knob honored (was dead config), model text byte-identical", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, false);
    process.env.ACP_RENDER_NONE = "1";
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1beta/models/test:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue2483-google-none" },
            body: GOOGLE_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(googleModelText(seen[0]!), "hi there", "renderNone forwards the model text untouched");
        assert.ok(!googleSystemText(seen[0]!).includes("NEVER echo"), "tags-only prompt follows the rendered tags");
    } finally {
        delete process.env.ACP_RENDER_NONE;
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
