import { test } from "node:test";
import assert from "node:assert/strict";
import {
    anthropicToCore,
    coreToAnthropic,
    conversationSignalAnthropic,
    type AnthropicRequestBody,
} from "../src/anthropic.js";
import {
    COMPRESS_TOOL,
    COMPRESS_TOOL_NAME,
    COMPRESS_TOOL_OPENAI,
    parseCompressInput,
    buildCompressSystemPrompt,
} from "../src/compress-tool.js";
import {
    openaiToCore,
    coreToOpenai,
    injectOpenaiSystem,
    conversationSignalOpenai,
    type OpenAIRequestBody,
} from "../src/openai.js";

function bigToolResult(text: string): AnthropicRequestBody {
    return {
        model: "claude-test",
        messages: [
            { role: "user" as const, content: "run the thing" },
            { role: "assistant" as const, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
            { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
            { role: "assistant" as const, content: [{ type: "text", text: "done" }] },
        ],
    };
}

test("anthropicToCore + coreToAnthropic round-trips tool_use and tool_result", () => {
    const body = bigToolResult("hello");
    const { msgs } = anthropicToCore(body);
    assert.equal(msgs.length, 4);
    const toolCall = msgs[1];
    assert.equal(toolCall?.contentType, "tool-call");
    assert.equal(toolCall?.toolName, "Bash");
    const rebuilt = coreToAnthropic(msgs);
    assert.equal(rebuilt.length, 4);
    assert.equal(rebuilt[0]?.role, "user");
    assert.equal(rebuilt[1]?.role, "assistant");
    const tu = (rebuilt[1]?.content as unknown[])[0] as { type: string; name: string };
    assert.equal(tu.type, "tool_use");
    assert.equal(tu.name, "Bash");
    const tr = (rebuilt[2]?.content as unknown[])[0] as { type: string; tool_use_id: string };
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.tool_use_id, "t1");
});

test("cache_control survives the anthropicToCore → coreToAnthropic round-trip", () => {
    const body: AnthropicRequestBody = {
        messages: [
            { role: "user" as const, content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
            { role: "assistant" as const, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" }, cache_control: { type: "ephemeral" } }] },
            { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", cache_control: { type: "ephemeral" } }] },
        ],
    };
    const { msgs, cacheControls } = anthropicToCore(body);
    assert.equal(cacheControls.size, 3);
    for (const m of msgs) {
        assert.ok(cacheControls.has(m.id), `message ${m.id} should have cache_control`);
    }
    const rebuilt = coreToAnthropic(msgs, cacheControls);
    const textBlock = (rebuilt[0]!.content as unknown[])[0] as { cache_control?: unknown };
    assert.deepEqual(textBlock.cache_control, { type: "ephemeral" });
    const tuBlock = (rebuilt[1]!.content as unknown[])[0] as { cache_control?: unknown };
    assert.deepEqual(tuBlock.cache_control, { type: "ephemeral" });
    const trBlock = (rebuilt[2]!.content as unknown[])[0] as { cache_control?: unknown };
    assert.deepEqual(trBlock.cache_control, { type: "ephemeral" });
});

test("coreToAnthropic without cacheControls produces no cache_control", () => {
    const body: AnthropicRequestBody = {
        messages: [{ role: "user" as const, content: [{ type: "text", text: "hi" }] }],
    };
    const { msgs } = anthropicToCore(body);
    const rebuilt = coreToAnthropic(msgs);
    const block = (rebuilt[0]!.content as unknown[])[0] as { cache_control?: unknown };
    assert.equal(block.cache_control, undefined);
});

test("conversationSignalAnthropic is stable for same first message, differs otherwise", () => {
    const body = bigToolResult("hello");
    const a = conversationSignalAnthropic(body);
    const b = conversationSignalAnthropic(body);
    assert.equal(a, b);
    const other = { ...body, messages: [{ role: "user" as const, content: "different" }] };
    assert.notEqual(a, conversationSignalAnthropic(other));
});

test("conversationSignalAnthropic prefers explicit header", () => {
    const body = bigToolResult("hello");
    const fromHeader = conversationSignalAnthropic(body, "my-session-id");
    assert.equal(fromHeader, "my-session-id");
});

test("anthropicToCore assigns h_* ids that never collide with kernel mNNNNN refs", () => {
    const { msgs } = anthropicToCore(bigToolResult("hello"));
    for (const m of msgs) {
        assert.ok(m.id.startsWith("h_"), `id "${m.id}" should be h_* (not m-prefixed)`);
        assert.ok(!/^m\d{5}$/.test(m.id), `id "${m.id}" must not look like a kernel ref`);
    }
});

test("COMPRESS_TOOL is well-formed and named compress", () => {
    assert.equal(COMPRESS_TOOL.name, COMPRESS_TOOL_NAME);
    assert.equal(COMPRESS_TOOL_NAME, "compress");
    assert.ok(COMPRESS_TOOL.input_schema.properties.content, "schema must accept content[]");
});

test("parseCompressInput handles batch {content:[...]} form", () => {
    const parsed = parseCompressInput({
        content: [
            { startId: "m00001", endId: "m00010", summary: "first batch", topic: "intro" },
            { startId: "m00020", endId: "m00030", summary: "second batch" },
        ],
    });
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.startRef, "m00001");
    assert.equal(parsed[0]?.endRef, "m00010");
    assert.equal(parsed[0]?.summary, "first batch");
    assert.equal(parsed[0]?.topic, "intro");
    assert.equal(parsed[1]?.topic, undefined);
});

test("parseCompressInput handles single {startId,endId,summary} form", () => {
    const parsed = parseCompressInput({ startId: "m00005", endId: "m00008", summary: "solo" });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.startRef, "m00005");
    assert.equal(parsed[0]?.endRef, "m00008");
    assert.equal(parsed[0]?.summary, "solo");
});

test("parseCompressInput returns empty for malformed input", () => {
    assert.deepEqual(parseCompressInput(null), []);
    assert.deepEqual(parseCompressInput("nope"), []);
    assert.deepEqual(parseCompressInput({ content: "not-an-array" }), []);
    assert.deepEqual(parseCompressInput({ content: [{ startId: "m1" }] }), []);
});

test("buildCompressSystemPrompt includes compression philosophy", () => {
    const prompt = buildCompressSystemPrompt();
    assert.ok(prompt.length > 100, "prompt should be substantial");
    assert.ok(/compress/i.test(prompt), "prompt should mention compress");
});

function openaiBody(): OpenAIRequestBody {
    return {
        model: "glm-5.2-test",
        messages: [
            { role: "system" as const, content: "you are helpful" },
            { role: "user" as const, content: "read the file" },
            { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/x" }) } }] },
            { role: "tool" as const, tool_call_id: "c1", content: "X".repeat(5000) },
            { role: "assistant" as const, content: "all done" },
            { role: "user" as const, content: "thanks" },
        ],
    };
}

test("openaiToCore assigns h_* ids distinct from mNNNNN refs", () => {
    const { msgs } = openaiToCore(openaiBody());
    assert.ok(msgs.length >= 5);
    for (const m of msgs) {
        assert.ok(m.id.startsWith("h_"), `id "${m.id}" must be h_*`);
    }
    const toolResult = msgs.find((m) => m.contentType === "tool-result");
    assert.ok(toolResult, "should have a tool-result node");
    assert.equal(toolResult?.role, "tool");
    assert.equal(toolResult?.toolCallId, "c1");
});

test("coreToOpenai regroups assistant text + tool_calls into one message", () => {
    const { msgs } = openaiToCore(openaiBody());
    const rebuilt = coreToOpenai(msgs);
    const assistantIdx = rebuilt.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.ok(assistantIdx >= 0, "should produce an assistant message with tool_calls");
    const asst = rebuilt[assistantIdx];
    assert.equal(asst?.tool_calls?.[0]?.function?.name, "read");
    assert.equal(asst?.tool_calls?.[0]?.id, "c1");
});

test("openaiToCore + coreToOpenai round-trips tool_result content", () => {
    const body = openaiBody();
    const { msgs } = openaiToCore(body);
    const rebuilt = coreToOpenai(msgs);
    const toolMsg = rebuilt.find((m) => m.role === "tool");
    assert.equal(toolMsg?.tool_call_id, "c1");
    assert.equal(toolMsg?.content, "X".repeat(5000));
});

test("injectOpenaiSystem prepends a system message when none exists", () => {
    const out = injectOpenaiSystem([{ role: "user" as const, content: "hi" }], ["extra rules"]);
    assert.equal(out[0]?.role, "system");
    assert.equal(out[0]?.content, "extra rules");
    assert.equal(out[1]?.role, "user");
});

test("injectOpenaiSystem appends to existing system message", () => {
    const out = injectOpenaiSystem([{ role: "system" as const, content: "base" }], ["extra"]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, "base\n\n---\n\nextra");
});

test("injectOpenaiSystem is a no-op with empty parts", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    assert.deepEqual(injectOpenaiSystem(msgs, []), msgs);
});

test("COMPRESS_TOOL_OPENAI is function-wrapped and named compress", () => {
    assert.equal(COMPRESS_TOOL_OPENAI.type, "function");
    assert.equal(COMPRESS_TOOL_OPENAI.function.name, COMPRESS_TOOL_NAME);
    assert.ok(COMPRESS_TOOL_OPENAI.function.parameters, "must have parameters schema");
});

test("conversationSignalOpenai prefers explicit header", () => {
    const id = conversationSignalOpenai(openaiBody(), "my-session");
    assert.equal(id, "my-session");
});

test("conversationSignalOpenai is stable for same first-user content", () => {
    const a = conversationSignalOpenai(openaiBody());
    const b = conversationSignalOpenai(openaiBody());
    assert.equal(a, b);
    assert.ok(a.length > 0);
});

test("OpenAI SSE rewriter passes through real tool calls when no compress detected", async () => {
    const { rewriteOpenaiSseStream } = await import("../src/stream-openai.js");
    const { createCore, createInitialState, defaultConfig } = await import("acp-kernel");
    const core = createCore();
    const state = createInitialState();
    const config = defaultConfig(200000);
    const ctx = { core, config, messages: [], session: { id: "s1", state }, log: () => {} };

    // Simulate a provider that sends the LAST tool_call arguments fragment
    // in the SAME chunk as finish_reason (common in GLM/OpenAI-compatible APIs).
    // Before the fix, the rewriter suppressed this entire chunk, dropping the
    // last arguments fragment → opencode got SchemaError(Missing key at ["command"]).
    const sse = [
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" as const, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"" } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "echo test\"}" } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
        },
    });
    const chunks: string[] = [];
    for await (const buf of rewriteOpenaiSseStream(upstream, ctx as never)) {
        chunks.push(buf.toString("utf8"));
    }
    const combined = chunks.join("");
    assert.ok(combined.includes('"bash"'), "tool name must pass through");
    assert.ok(combined.includes("echo test"), "tool arguments must pass through");
    assert.ok(combined.includes("tool_calls"), "finish_reason tool_calls must be present");
    assert.ok(combined.includes("[DONE]"), "[DONE] marker must be present");
    assert.ok(!combined.includes("acp-proxy:"), "no compress note expected");
});

test("OpenAI SSE rewriter suppresses compress tool call and injects note", async () => {
    const { rewriteOpenaiSseStream } = await import("../src/stream-openai.js");
    const { createCore, createInitialState, defaultConfig } = await import("acp-kernel");
    const core = createCore();
    const config = defaultConfig(200000);
    const state = createInitialState();
    const ctx = { core, config, messages: [], session: { id: "s1", state }, log: () => {} };

    const sse = [
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: '{"content":[{"startId":"m00001","endId":"m00001","summary":"test"}]}' } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
        },
    });
    const chunks: string[] = [];
    for await (const buf of rewriteOpenaiSseStream(upstream, ctx as never)) {
        chunks.push(buf.toString("utf8"));
    }
    const combined = chunks.join("");
    assert.ok(!combined.includes('"compress"'), "compress tool name must be suppressed");
    assert.ok(combined.includes('"stop"'), "finish_reason should be stop");
    assert.ok(combined.includes("[DONE]"), "[DONE] must be present");
});


test("ACP tag regex strips tag prefix from tool-call arguments", () => {
    const ACP_TAG_RE = /^\x3cacp [^>]*\x3e[^\x3c]*\x3c\/acp\x3e\n?/;
    const tagged = '\x3cacp tokens="50" type="bash"\x3em00005\x3c/acp\x3e\n{"command":"echo hello"}';
    const stripped = tagged.replace(ACP_TAG_RE, "");
    assert.equal(stripped, '{"command":"echo hello"}');
});

test("processTurn adds ACP tags but tool-call args can be restored", async () => {
    const { createCore, createInitialState, defaultConfig } = await import("acp-kernel");
    const core = createCore();
    const config = defaultConfig(200000);
    const state = createInitialState();
    const args = '{"command":"echo hello"}';
    const msgs = [
        { id: "raw-0", role: "user" as const, contentType: "text" as const, text: "run echo" },
        { id: "raw-1", role: "assistant" as const, contentType: "tool-call" as const, text: args, toolName: "bash", toolCallId: "tc1" },
        { id: "raw-2", role: "tool" as const, contentType: "tool-result" as const, text: "hello", toolName: "bash", toolCallId: "tc1" },
    ];
    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 100 });
    const tc = turn.messages.find(m => m.contentType === "tool-call")!;
    assert.ok(tc.text!.includes("\x3cacp"), "processTurn should add ACP tag");
    const ACP_TAG_RE = /^\x3cacp [^>]*\x3e[^\x3c]*\x3c\/acp\x3e\n?/;
    const restored = tc.text!.replace(ACP_TAG_RE, "");
    assert.equal(restored, args, "stripping should restore original args");
});
