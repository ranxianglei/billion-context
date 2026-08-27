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

// #266 proxy-side half: omp's chat-completions payloads carry NO conversation
// signal, so the omp plugin stamps prompt_cache_key with the omp session id.
// The proxy's openai path must mirror the responses pck promotion: (a) bind
// pluginMode when an identity register matches the pck (wire injection
// suppressed), and (b) record the session by pck so /acp (status?conversationId
// = the client session id) finds it instead of 404-ing to the armed fallback.

function openaiSse(): string {
    const chunk = (choices: unknown): string =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices })}\n\n`;
    return (
        chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]) +
        chunk([{ index: 0, delta: { content: "ok" }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
        "data: [DONE]\n\n"
    );
}

interface Rig {
    proxyUrl: (path: string) => string;
    chatUrl: () => string;
    upstreamBodies: string[];
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(openaiSse());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "glm-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const closeOne = (s: http.Server): Promise<void> =>
        new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    return {
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        chatUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        upstreamBodies,
        closeAll: async () => {
            await closeOne(proxy);
            await closeOne(upstream);
        },
    };
}

function postChat(rig: Rig, pck: string): Promise<Response> {
    return fetch(rig.chatUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-test", messages: [{ role: "user", content: "hello" }], prompt_cache_key: pck }),
    });
}

function postChatRaw(rig: Rig, body: Record<string, unknown>): Promise<Response> {
    return fetch(rig.chatUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-test", messages: [{ role: "user", content: "hello" }], ...body }),
    });
}

async function register(rig: Rig, conversationId: string, agent: string, identity: boolean): Promise<void> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent, identity }),
    });
    assert.equal(res.status, 200, "register accepted");
}

async function status(rig: Rig, conversationId: string): Promise<{ ok: boolean; pluginAgent?: string | null; panel?: string }> {
    const res = await fetch(rig.proxyUrl(`/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`));
    return (await res.json()) as { ok: boolean; pluginAgent?: string | null; panel?: string };
}

test("openai pck: the session is recorded by prompt_cache_key so /acp (status by pck) finds it — the /acp panel fix", async () => {
    const rig = await startRig();
    try {
        // No register at all — just an openai chat request carrying the pck the
        // omp plugin stamped. Before the fix openai sessions were never
        // recorded (recordPluginSession lived only in the responses branch), so
        // status?conversationId=<pck> 404'd and /acp showed the armed fallback
        // forever.
        await postChat(rig, "omp-uuid-record");
        const s = await status(rig, "omp-uuid-record");
        assert.equal(s.ok, true, "session found by prompt_cache_key");
        assert.ok(typeof s.panel === "string" && s.panel.length > 0, "panel rendered, not the armed fallback");
    } finally {
        await rig.closeAll();
    }
});

test("openai pck: identity register + matching pck binds pluginMode (wire injection suppressed)", async () => {
    const rig = await startRig();
    try {
        // Control: an unregistered openai session rides wire mode — the
        // compress tool IS injected into the outgoing tools array.
        await postChat(rig, "omp-uuid-wire");
        assert.ok(rig.upstreamBodies[0]!.includes('"compress"'), "unregistered openai session is wire mode (compress tool injected)");

        // The omp plugin identity-registers its session uuid; the next request
        // carrying that uuid as prompt_cache_key must bind pluginMode.
        await register(rig, "omp-uuid-bind", "omp", true);
        await postChat(rig, "omp-uuid-bind");
        assert.ok(!rig.upstreamBodies[1]!.includes('"compress"'), "wire tool injection suppressed after identity binding");
        const s = await status(rig, "omp-uuid-bind");
        assert.equal(s.ok, true, "bound conversation is found");
        assert.equal(s.pluginAgent, "omp", "pluginAgent recorded as omp");
    } finally {
        await rig.closeAll();
    }
});

test("openai: prompt_cache_retention stripped, prompt_cache_key forwarded (dsh PI_CACHE_RETENTION=long)", async () => {
    const rig = await startRig();
    try {
        await postChatRaw(rig, { prompt_cache_key: "dsh-session-uuid", prompt_cache_retention: "24h" });
        assert.equal(rig.upstreamBodies.length, 1);
        const sent = JSON.parse(rig.upstreamBodies[0]!) as Record<string, unknown>;
        assert.equal(sent.prompt_cache_key, "dsh-session-uuid", "session id passes through");
        assert.equal("prompt_cache_retention" in sent, false, "OpenAI-host-only cache directive stripped");
    } finally {
        await rig.closeAll();
    }
});
