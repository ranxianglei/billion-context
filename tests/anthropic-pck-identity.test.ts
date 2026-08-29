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

// #268: the omp plugin cannot tell the anthropic wire apart from
// chat-completions by payload shape (both carry max_tokens), so its
// prompt_cache_key stamp lands on anthropic bodies too. The proxy must
// consume the field there deliberately: (a) bind the session identity to the
// pck, (b) record the conversation mapping so /acp finds the session, and
// (c) strip the field before the real Anthropic sees a field it doesn't know.

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(): string {
    return (
        anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" })
    );
}

interface Rig {
    proxyUrl: (path: string) => string;
    messagesUrl: () => string;
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
            res.end(anthropicStream());
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 100_000 } } } },
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
        messagesUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        upstreamBodies,
        closeAll: async () => {
            await closeOne(proxy);
            await closeOne(upstream);
        },
    };
}

function postMessages(rig: Rig, pck: string): Promise<Response> {
    return fetch(rig.messagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test" },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, messages: [{ role: "user", content: "hello" }], prompt_cache_key: pck }),
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

test("anthropic pck: the session is recorded by prompt_cache_key so /acp (status by pck) finds it", async () => {
    const rig = await startRig();
    try {
        await postMessages(rig, "omp-uuid-anthropic");
        const s = await status(rig, "omp-uuid-anthropic");
        assert.equal(s.ok, true, "session found by prompt_cache_key");
        assert.ok(typeof s.panel === "string" && s.panel.length > 0, "panel rendered, not the armed fallback");
    } finally {
        await rig.closeAll();
    }
});

test("anthropic pck: prompt_cache_key is stripped before forwarding to the real Anthropic", async () => {
    const rig = await startRig();
    try {
        await postMessages(rig, "omp-uuid-strip");
        assert.equal(rig.upstreamBodies.length, 1);
        const sent = JSON.parse(rig.upstreamBodies[0]!) as Record<string, unknown>;
        assert.equal("prompt_cache_key" in sent, false, "proxy-internal identity field stripped from the upstream body");
        assert.equal(sent.max_tokens, 1024, "rest of the body preserved");
    } finally {
        await rig.closeAll();
    }
});

test("anthropic pck: identity register + matching pck binds pluginMode (wire injection suppressed)", async () => {
    const rig = await startRig();
    try {
        // Control: an unregistered anthropic session rides wire mode — the
        // compress tool IS injected into the outgoing tools array.
        await postMessages(rig, "omp-uuid-wire");
        assert.ok(rig.upstreamBodies[0]!.includes('"compress"'), "unregistered anthropic session is wire mode (compress tool injected)");

        await register(rig, "omp-uuid-bind", "omp", true);
        await postMessages(rig, "omp-uuid-bind");
        assert.ok(!rig.upstreamBodies[1]!.includes('"compress"'), "wire tool injection suppressed after identity binding");
        const s = await status(rig, "omp-uuid-bind");
        assert.equal(s.ok, true, "bound conversation is found");
        assert.equal(s.pluginAgent, "omp", "pluginAgent recorded as omp");
    } finally {
        await rig.closeAll();
    }
});

test("anthropic: no pck, no header → anonymous prefix affinity (unchanged)", async () => {
    const rig = await startRig();
    try {
        const res = await fetch(rig.messagesUrl(), {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(res.status, 200, "anonymous anthropic request still served via prefix affinity");
        assert.equal(rig.upstreamBodies.length, 1);
    } finally {
        await rig.closeAll();
    }
});
