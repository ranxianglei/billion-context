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
import { listSessions } from "../src/session.ts";

// #473: the #371 fake-completion detect+retry (opt-in via
// BILI_FAKE_COMPLETION_RETRIES) sat AFTER the plugin-mode early return, so
// plugin-mode clients (pi / omp — the original #361/#371 reporters) never got
// the backstop. These tests drive a plugin session through the gate.

const FAKE_MARK = "FAKE-COMPLETION-MARKER";
// antml-style tool-call XML written as TEXT (hex escapes; never a real block)
const FAKE_XML = `\x3cinvoke name="get_weather"\x3e\x3cparameter name="city"\x3eSF\x3c/parameter\x3e\x3c/invoke\x3e`;
const HINT_MARK = "[billion-context]";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => void 0);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function openaiSse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Proto = "openai" | "anthropic";

interface Rig {
    proxyPort: number;
    proxyUrl: (path: string) => string;
    modelUrl: () => string;
    requests: { body: string }[];
    closeAll(): Promise<void>;
}

function upstreamResponse(proto: Proto, fake: boolean, res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (proto === "openai") {
        const base = { id: "chatcmpl-473", object: "chat.completion.chunk", created: 1755678900, model: "i473-model" };
        if (fake) {
            res.write(openaiSse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `${FAKE_MARK} ${FAKE_XML}` } }] }));
            res.write(openaiSse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        } else {
            res.write(openaiSse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null } }] }));
            res.write(openaiSse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "real_tool_ok", arguments: "{}" } }] } }] }));
            res.write(openaiSse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        }
        res.write(openaiSse({ ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
    }
    res.write(anthropicSse("message_start", { type: "message_start", message: { id: "m473", role: "assistant", usage: { input_tokens: 77 } } }));
    if (fake) {
        res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${FAKE_MARK} ${FAKE_XML}` } }));
        res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
    } else {
        res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "real_tool_ok", input: {} } }));
        res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
    }
    res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }));
    res.write(anthropicSse("message_stop", { type: "message_stop" }));
    res.end();
}

async function startRig(proto: Proto): Promise<Rig> {
    const requests: { body: string }[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            requests.push({ body });
            upstreamResponse(proto, !body.includes(HINT_MARK), res);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "i473-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: true,
        logFile: "/dev/null",
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const path = proto === "openai" ? "/v1/chat/completions" : "/v1/messages";
    return {
        proxyPort,
        proxyUrl: (p) => `http://127.0.0.1:${proxyPort}${p}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}`,
        requests,
        closeAll: async () => {
            await close(proxy);
            await close(upstream);
        },
    };
}

async function register(rig: Rig, conversationId: string): Promise<void> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: "mcp" }),
    });
    assert.equal(res.status, 200, "register accepted");
}

async function readAll(res: Response): Promise<string> {
    const buf = await res.arrayBuffer();
    return new TextDecoder().decode(buf);
}

test("#473 plugin openai chat: fake completion triggers the hinted retry and the client sees the recovered tool block", async () => {
    process.env.BILI_FAKE_COMPLETION_RETRIES = "1";
    const rig = await startRig("openai");
    try {
        await register(rig, "i473-openai");
        const res = await fetch(rig.modelUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "i473-model", stream: true, messages: [{ role: "user", content: "call the weather tool" }] }),
        });
        assert.equal(res.status, 200);
        const text = await readAll(res);
        assert.equal(rig.requests.length, 2, `expected original + retry, got ${rig.requests.length}`);
        const retryBody = JSON.parse(rig.requests[1].body) as { messages: { role: string; content: string }[] };
        const last = retryBody.messages[retryBody.messages.length - 1];
        assert.equal(last.role, "user");
        assert.ok(last.content.includes(HINT_MARK), "hint merged into the last user message of the retry");
        assert.ok(text.includes("real_tool_ok"), "client received the recovered tool block");
        assert.ok(!text.includes(FAKE_MARK), "fake completion never reached the client");
        assert.ok(listSessions().some((s) => (s.metadata.fakeCompletionStreak as number | undefined) === 0), "session streak reset after the clean retry");
    } finally {
        delete process.env.BILI_FAKE_COMPLETION_RETRIES;
        await rig.closeAll();
    }
});

test("#473 default (retries=0): plugin mode stays verbatim passthrough — one upstream request, fake text unchanged", async () => {
    const rig = await startRig("openai");
    try {
        await register(rig, "i473-default-off");
        const res = await fetch(rig.modelUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "i473-model", stream: true, messages: [{ role: "user", content: "call the weather tool" }] }),
        });
        assert.equal(res.status, 200);
        const text = await readAll(res);
        assert.equal(rig.requests.length, 1, "no retry when the backstop is disabled");
        assert.ok(text.includes(FAKE_MARK), "fake completion passes through verbatim");
    } finally {
        await rig.closeAll();
    }
});

test("#473 plugin anthropic: fake completion retried with the hint merged; recovered tool_use reaches the client", async () => {
    process.env.BILI_FAKE_COMPLETION_RETRIES = "1";
    const rig = await startRig("anthropic");
    try {
        await register(rig, "i473-anthropic");
        const res = await fetch(rig.modelUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "i473-model", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "call the weather tool" }] }),
        });
        assert.equal(res.status, 200);
        const text = await readAll(res);
        assert.equal(rig.requests.length, 2, `expected original + retry, got ${rig.requests.length}`);
        const retryBody = JSON.parse(rig.requests[1].body) as { messages: { role: string; content: unknown }[] };
        const last = retryBody.messages[retryBody.messages.length - 1];
        assert.equal(last.role, "user");
        // anthropic wire normalizes content to a block array — the hint lands
        // as an appended {type:"text"} block
        assert.ok(JSON.stringify(last.content).includes(HINT_MARK), "hint merged into the last anthropic user message");
        assert.ok(text.includes("real_tool_ok"), "client received the recovered tool_use block");
        assert.ok(!text.includes(FAKE_MARK), "fake completion never reached the client");
    } finally {
        delete process.env.BILI_FAKE_COMPLETION_RETRIES;
        await rig.closeAll();
    }
});
