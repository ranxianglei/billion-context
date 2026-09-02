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

async function startHarness(compress: { injectTool: boolean; injectNudge: boolean }, scripts: string[][], json: boolean): Promise<Harness> {
    let call = 0;
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": json ? "application/json" : "text/event-stream" });
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
            promptCache: { routing: "auto" },
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

function responsesSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunkText(text: string, step: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
    return out;
}

function cleanResponsesDeltaText(raw: string): string {
    let out = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
            const obj = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: string };
            out += obj?.type === "response.output_text.delta" ? obj.delta ?? "" : "";
        } catch {}
    }
    return out;
}

function tagEchoResponsesScript(): string[] {
    const full = `压缩前 ${TAG("m00155")}${TAG("m00156", 33)}后 5 « 6 成立`;
    const chunk = chunkText(full, 7);
    let item = "item_ninj_r1";
    return [
        responsesSse("response.created", { type: "response.created", response: { id: "resp_ninj_r1", status: "in_progress", output: [] } }),
        responsesSse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } }),
        responsesSse("response.content_part.added", { type: "response.content_part.added", item_id: item, output_index: 0, part: { type: "output_text", text: "" } }),
        ...chunk.map((p) => responsesSse("response.output_text.delta", { type: "response.output_text.delta", item_id: item, output_index: 0, delta: p })),
        responsesSse("response.output_text.done", { type: "response.output_text.done", item_id: item, output_index: 0, text: full }),
        responsesSse("response.content_part.done", { type: "response.content_part.done", item_id: item, output_index: 0, part: { type: "output_text", text: full } }),
        responsesSse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: full }] } }),
        responsesSse("response.completed", { type: "response.completed", response: { id: "resp_ninj_r1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: full }] }], usage: { input_tokens: 30, output_tokens: 9, total_tokens: 39 } } }),
    ];
}

function cleanResponsesScript(): string[] {
    const text = "plain prose 5 < 6 holds";
    return [
        responsesSse("response.created", { type: "response.created", response: { id: "resp_ninj_r2", status: "in_progress", output: [] } }),
        responsesSse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } }),
        responsesSse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_ninj_r2", output_index: 0, delta: "plain " }),
        responsesSse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_ninj_r2", output_index: 0, delta: "prose 5 < 6 holds" }),
        responsesSse("response.output_text.done", { type: "response.output_text.done", item_id: "item_ninj_r2", output_index: 0, text }),
        responsesSse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }),
        responsesSse("response.completed", { type: "response.completed", response: { id: "resp_ninj_r2", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 28, output_tokens: 5, total_tokens: 33 } } }),
    ];
}

test("#460 residual: native Responses compaction (resetAfterSuccess) SSE — echoed render tags stripped, response.completed intact", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true }, [tagEchoResponsesScript()]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-resp-compact" },
            body: JSON.stringify({ model: "gpt-test", stream: true, session_id: "noinject-resp-compact", instructions: "You are a test agent.", input: [{ type: "message", role: "user", content: "hello" }, { type: "compaction_trigger" }] }),
        });
        assert.equal(resp.status, 200, "native compact request must still forward to upstream");
        let raw = "";
        for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "client stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "client stream leaked a render close tag");
        assert.equal(cleanResponsesDeltaText(raw), "压缩前 后 5 « 6 成立", `unexpected client text: ${JSON.stringify(cleanResponsesDeltaText(raw))}`);
        assert.ok(raw.includes("response.completed"), "terminal event missing");
    } finally {
        await h.close();
    }
});

test("#460 residual: tag-free Responses compaction SSE — byte-identical passthrough", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true }, [cleanResponsesScript()]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-resp-clean" },
            body: JSON.stringify({ model: "gpt-test", stream: true, session_id: "noinject-resp-clean", instructions: "s", input: [{ type: "message", role: "user", content: "hello" }, { type: "compaction_trigger" }] }),
        });
        assert.equal(resp.status, 200);
        let raw = "";
        for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw, cleanResponsesScript().join(""), "tag-free compact stream must pass through byte-identical");
    } finally {
        await h.close();
    }
});

test("#460 residual: non-injected NON-STREAMING openai JSON — echoed render tags stripped, body stays valid JSON", async () => {
    const full = `title: ${TAG("m00009", 12)}summary ok`;
    const completion = { id: "chatcmpl_ninj_json", object: "chat.completion", created: 1, model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }] };
    const h = await startHarness({ injectTool: true, injectNudge: true }, [[JSON.stringify(completion)]], true);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-openai-json" },
            body: JSON.stringify({ model: "gpt-test", max_tokens: 100, stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let bodyText = "";
        for await (const chunk of resp.body) bodyText += Buffer.from(chunk).toString("utf8");
        try {
            const parsed = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
            assert.equal(parsed.choices?.[0]?.message?.content, "title: summary ok", `unexpected content: ${JSON.stringify(bodyText)}`);
        } catch {
            assert.ok(false, "client body is not valid JSON");
        }
        assert.equal(bodyText.includes(OPEN_MARK), false, "client body leaked a render open tag");
        assert.equal(bodyText.includes(CLOSE_MARK), false, "client body leaked a render close tag");
    } finally {
        await h.close();
    }
});

test("#460 residual: non-injected NON-STREAMING responses JSON — echoed render tags stripped from output items", async () => {
    const full = `title: ${TAG("m00009", 12)}summary ok`;
    const response = { id: "resp_ninj_json", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: full }] }] };
    const h = await startHarness({ injectTool: true, injectNudge: true }, [[JSON.stringify(response)]], true);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-resp-json" },
            body: JSON.stringify({ model: "gpt-test", stream: false, session_id: "noinject-resp-json", input: [{ type: "message", role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let bodyText = "";
        for await (const chunk of resp.body) bodyText += Buffer.from(chunk).toString("utf8");
        assert.equal(bodyText.includes(OPEN_MARK), false, "client body leaked a render open tag");
        let text: string | undefined;
        try {
            const parsed = JSON.parse(bodyText) as { output?: Array<{ content?: Array<{ text: string }> }> };
            text = parsed.output?.[0]?.content?.[0]?.text;
        } catch {}
        assert.equal(text, "title: summary ok", `unexpected body: ${JSON.stringify(bodyText)}`);
    } finally {
        await h.close();
    }
});

test("#460 residual: tag-free NON-STREAMING JSON — byte-identical passthrough", async () => {
    const completion = { id: "chatcmpl_ninj_clean", object: "chat.completion", created: 1, model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "plain 5 < 6 summary" }, finish_reason: "stop" }] };
    const h = await startHarness({ injectTool: true, injectNudge: true }, [[JSON.stringify(completion)]], true);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-openai-clean" },
            body: JSON.stringify({ model: "gpt-test", max_tokens: 100, stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let bodyText = "";
        for await (const chunk of resp.body) bodyText += Buffer.from(chunk).toString("utf8");
        assert.equal(bodyText, JSON.stringify(completion), "tag-free JSON body must pass through byte-identical");
    } finally {
        await h.close();
    }
});

function tagEchoOpenAiSplitScript(): string[] {
    const full = `title: ${TAG("m00009", 12)}summary ok`;
    const chunk = chunkText(full, 5);
    const base = { id: "chatcmpl_split", object: "chat.completion.chunk", created: 1, model: "gpt-test" };
    return [
        openaiChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
        ...chunk.map((p) => openaiChunk({ ...base, choices: [{ index: 0, delta: { content: p } }] })),
        openaiChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
    ];
}

test("#460: openai SSE with the render OPEN tag split across chunks — stripped, not echoed", async () => {
    const h = await startHarness({ injectTool: false, injectNudge: false }, [tagEchoOpenAiSplitScript()]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "noinject-openai-split" },
            body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        let raw = "";
        for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "client stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "client stream leaked a render close tag");
        assert.equal(cleanOpenAiContent(raw), "title: summary ok", `unexpected content: ${JSON.stringify(cleanOpenAiContent(raw))}`);
        assert.ok(raw.includes("[DONE]"), "[DONE] missing");
    } finally {
        await h.close();
    }
});
