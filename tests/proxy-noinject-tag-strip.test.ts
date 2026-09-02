import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Render-tag pieces are assembled from hex escapes so no literal tag sequence
// appears in this file's source.
const LT = "\x3c";
const GT = "\x3e";
const TAG = (id: string, tokens = 177) => `${LT}acp tokens="${tokens}" type="text"${GT}${id}${LT}/acp${GT}`;
const OPEN_MARK = `${LT}acp `;
const CLOSE_MARK = `${LT}/acp${GT}`;

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openaiChunk(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

async function startHarness(compress: { injectTool: boolean; injectNudge: boolean }, scripts: string[][]): Promise<Harness> {
    let call = 0;
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            for (const line of script) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    return (async () => {
        await once(upstream, "listening");
        const upstreamPort = upstream.address().port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const proxy = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 }, "gpt-test": { context: 400_000 } } } },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress,
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        const proxyPort = proxy.address().port;
        return {
            proxyPort,
            upstreamPort,
            close: async () => {
                proxy.close();
                await once(proxy, "close");
                upstream.close();
                await once(upstream, "close");
            },
        };
    })();
}

function tagEchoAnthropicScript(): string[] {
    const full = `好的，总结如下 ${TAG("m00155")}${TAG("m00155", 44)}${TAG("m00156", 33)}另外 5 « 6 成立${TAG("m00157")}完毕`;
    const splitAt = [7, 20, 26, 41, 48, 60];
    const parts: string[] = [];
    let prev = 0;
    for (const s of splitAt) {
        parts.push(full.slice(prev, s));
        prev = s;
    }
    parts.push(full.slice(prev));
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_ninj_1", role: "assistant", usage: { input_tokens: 20 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ...parts.map((p) => anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

function tagEchoOpenAiScript(): string[] {
    const full = `title: ${TAG("m00009", 12)}summary ok`;
    const parts = [full.slice(0, 6), full.slice(6, 22), full.slice(22)];
    const base = { id: "chatcmpl_ninj", object: "chat.completion.chunk", created: 1, model: "gpt-test" };
    return [
        openaiChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
        ...parts.map((p) => openaiChunk({ ...base, choices: [{ index: 0, delta: { content: p } }] })),
        openaiChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
    ];
}

function cleanAnthropicText(raw: string): string {
    return [...raw.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => JSON.parse(`"${m[1]}"`) as string)
        .join("");
}

function cleanOpenAiContent(raw: string): string {
    let out = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
        try {
            const obj = JSON.parse(line.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
            out += obj.choices?.[0]?.delta?.content ?? "";
        } catch {}
    }
    return out;
}

test("#460: non-injected anthropic SSE — echoed render tags stripped, prose intact", async () => {
    const h = await startHarness({ injectTool: false, injectNudge: false }, [tagEchoAnthropicScript()]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-anth" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let raw = "";
        for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "client stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "client stream leaked a render close tag");
        assert.ok(cleanAnthropicText(raw).endsWith("好的，总结如下 另外 5 « 6 成立完毕"), `unexpected client text: ${JSON.stringify(cleanAnthropicText(raw))}`);
        assert.ok(raw.includes("message_stop"), "terminal event missing");
    } finally {
        await h.close();
    }
});

test("#460: non-injected anthropic SSE without tags — byte-identical passthrough", async () => {
    const script = [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_ninj_2", role: "assistant", usage: { input_tokens: 20 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain " } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "prose" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
    const h = await startHarness({ injectTool: false, injectNudge: false }, [script]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-anth-clean" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "s", messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let raw = "";
        for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw, script.join(""), "tag-free stream must pass through byte-identical");
    } finally {
        await h.close();
    }
});

test("#460: openai title-gen (max_tokens<=200) SSE — echoed render tags stripped, [DONE] intact", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true }, [tagEchoOpenAiScript()]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-openai-title" },
            body: JSON.stringify({ model: "gpt-test", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let raw = "";
        for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "client stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "client stream leaked a render close tag");
        assert.equal(cleanOpenAiContent(raw), "title: summary ok", `unexpected content: ${JSON.stringify(cleanOpenAiContent(raw))}`);
        assert.ok(raw.includes("[DONE]"), "[DONE] missing");
        assert.ok(raw.includes('"finish_reason":"stop"'), "finish_reason chunk missing");
    } finally {
        await h.close();
    }
});
