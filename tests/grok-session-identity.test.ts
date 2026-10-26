import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// grok-shell (xAI's CLI) stamps a per-session UUID on every model request as
// x-grok-session-id (x-grok-conv-id carries the same value). Before the
// whitelist knew them the request was anonymous, and prefix-affinity forked a
// fresh session every turn because grok-shell reorders its replayed history
// head between turns — compression state never accumulated. These tests pin
// the header -> verbatim session binding.

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
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
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
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const closeOne = (s: http.Server): Promise<void> =>
        new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    return {
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        messagesUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        closeAll: async () => {
            await closeOne(proxy);
            await closeOne(upstream);
        },
    };
}

function postMessages(rig: Rig, headers: Record<string, string>): Promise<Response> {
    return fetch(rig.messagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test", ...headers },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
    });
}

async function status(rig: Rig, conversationId: string): Promise<{ ok: boolean }> {
    const res = await fetch(rig.proxyUrl(`/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`));
    return (await res.json()) as { ok: boolean };
}

test("grok header: x-grok-session-id binds the session verbatim (no anonymous fork)", async () => {
    const rig = await startRig();
    try {
        const sid = "01a0bdaf-9378-7102-9306-6271c4224e0e";
        const res = await postMessages(rig, { "x-grok-session-id": sid });
        assert.equal(res.status, 200, "request forwarded");
        const s = await status(rig, sid);
        assert.equal(s.ok, true, "session exists under the grok session id, not a pfa- anonymous id");
    } finally {
        await rig.closeAll();
    }
});

test("grok header: two different session ids stay two sessions (per-terminal isolation)", async () => {
    const rig = await startRig();
    try {
        const a = "aaaaaaaa-0000-0000-0000-000000000001";
        const b = "bbbbbbbb-0000-0000-0000-000000000002";
        await postMessages(rig, { "x-grok-session-id": a });
        await postMessages(rig, { "x-grok-session-id": b });
        assert.equal((await status(rig, a)).ok, true, "session A exists");
        assert.equal((await status(rig, b)).ok, true, "session B exists");
    } finally {
        await rig.closeAll();
    }
});

test("grok header: x-grok-conv-id is the fallback when session-id is absent", async () => {
    const rig = await startRig();
    try {
        const cid = "cccccccc-0000-0000-0000-000000000003";
        await postMessages(rig, { "x-grok-conv-id": cid });
        const s = await status(rig, cid);
        assert.equal(s.ok, true, "session exists under the conv id");
    } finally {
        await rig.closeAll();
    }
});
