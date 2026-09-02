import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginJson } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

test("plugin chat passthrough strips render tags from delta.content", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: `leading ${TAG_OPEN}m00042${TAG_CLOSE} trailing` }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "render tag content must not pass through");
    assert.ok(text.includes("leading  trailing"), "non-tag prose survives");
    assert.ok(text.includes("[DONE]"), "[DONE] forwarded");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 100, "usage still sampled from final chunk");
});

test("plugin chat passthrough strips tags split across deltas and flushes tail before [DONE]", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        chatChunk({ content: `ok ${TAG_OPEN}m0` }),
        chatChunk({ content: `0042${TAG_CLOSE} tail` }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "split tag fully swallowed");
    assert.ok(text.includes("ok "), "first delta prose passes");
    assert.ok(text.includes("tail"), "post-tag tail flushed");
    const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
    const flushIdx = blocks.findIndex((b) => b.includes("tail"));
    const doneIdx = blocks.findIndex((b) => b.includes("[DONE]"));
    assert.ok(flushIdx !== -1 && doneIdx !== -1 && flushIdx < doneIdx, "flushed tail delta must precede [DONE]");
});

test("plugin chat passthrough strips echo from reasoning_content too", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        chatChunk({ reasoning_content: `think ${TAG_OPEN}m00007${TAG_CLOSE} done` }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00007"), "reasoning echo stripped");
    assert.ok(text.includes("think  done"), "reasoning prose survives");
});

test("plugin chat passthrough drops a chunk whose delta stripped to empty", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        chatChunk({ content: "real answer" }),
        chatChunk({ content: `${TAG_OPEN}m1${TAG_CLOSE}${TAG_OPEN}m2${TAG_CLOSE}` }),
        chatChunk({ content: "more" }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m1") && !text.includes("m2"), "echo-only chunk stripped");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).filter((l) => !l.includes("[DONE]"));
    assert.equal(dataLines.length, 2, "echo-only chunk dropped; 'real answer' and 'more' forwarded");
    for (const l of dataLines) {
        assert.doesNotThrow(() => JSON.parse(l.slice(5).trim()), "every data line stays valid JSON");
    }
});

test("plugin chat passthrough keeps sibling text when one field is a pure tag echo (#462)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        chatChunk({ content: "real answer", reasoning_content: `${TAG_OPEN}m00044${TAG_CLOSE}` }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00044"), "echo-only sibling field stripped");
    assert.ok(text.includes("real answer"), "sibling field with real content must survive");
});

test("plugin chat passthrough still drops a chunk where every managed field is a pure tag echo (#462)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        chatChunk({ content: `${TAG_OPEN}m1${TAG_CLOSE}`, reasoning_content: `${TAG_OPEN}m2${TAG_CLOSE}` }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m1") && !text.includes("m2"), "echoes stripped");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).filter((l) => !l.includes("[DONE]"));
    assert.equal(dataLines.length, 0, "all-echo chunk dropped");
});

test("plugin chat passthrough keeps tool_calls deltas byte-identical", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const toolChunk = chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] });
    const plain = chatChunk({ content: "plain text no tags" });
    const events = [plain, toolChunk, chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }), DONE];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(text.includes(toolChunk.trim()), "tool_calls delta untouched");
    assert.ok(text.includes(plain.trim()), "clean delta untouched");
});

test("plugin chat passthrough resolves held tail at stream end without [DONE]", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [chatChunk({ content: `prose ${TAG_OPEN}m0` })];
    await pipePluginChatWithStrip(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(text.includes("prose "), "clean prefix passes");
    assert.ok(!text.includes("m0"), "unclosed tag content dropped at stream end");
});

test("plugin anthropic passthrough strips render tags from text_delta and thinking_delta", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 42 } } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `hmm ${TAG_OPEN}m00009${TAG_CLOSE}` } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `hi ${TAG_OPEN}m00010${TAG_CLOSE} bye` } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "anthropic");
    const text = out.join("");
    assert.ok(!text.includes("m00009") && !text.includes("m00010"), "render tags stripped from both delta types");
    assert.ok(text.includes("hi  bye"), "text prose survives");
    assert.ok(text.includes("hmm "), "thinking prose survives");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 42, "usage sampled from message_start");
});

test("plugin anthropic passthrough strips tags split across deltas and flushes before message_delta", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `ok ${TAG_OPEN}m0` } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `0042${TAG_CLOSE} tail` } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, session, "anthropic");
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "split tag swallowed");
    assert.ok(text.includes("tail"), "tail flushed before message_delta");
    const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
    const flushIdx = blocks.findIndex((b) => b.includes("tail"));
    const msgDeltaIdx = blocks.findIndex((b) => b.includes("message_delta"));
    assert.ok(flushIdx !== -1 && msgDeltaIdx !== -1 && flushIdx < msgDeltaIdx, "flushed tail precedes message_delta");
    const flushBlock = blocks[flushIdx] ?? "";
    assert.ok(flushBlock.includes("text_delta"), "synthetic flush event is a text_delta");
});

test("plugin JSON passthrough strips render tags for openai protocol", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const body = JSON.stringify({ choices: [{ message: { content: `x ${TAG_OPEN}m00005${TAG_CLOSE}` } }], usage: { prompt_tokens: 2 } });
    await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "openai");
    const text = out.join("");
    const parsed = JSON.parse(text) as { choices: Array<{ message: { content: string } }> };
    assert.ok(!text.includes("m00005"), "tag stripped from non-streaming chat body");
    assert.equal(parsed.choices[0]?.message.content, "x ", "prose survives");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 2, "usage still sampled");
});

test("plugin JSON passthrough strips render tags for anthropic protocol", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const body = JSON.stringify({ content: [{ type: "text", text: `y ${TAG_OPEN}m00006${TAG_CLOSE}` }], usage: { input_tokens: 3 } });
    await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "anthropic");
    const text = out.join("");
    const parsed = JSON.parse(text) as { content: Array<{ text: string }> };
    assert.ok(!text.includes("m00006"), "tag stripped from non-streaming anthropic body");
    assert.equal(parsed.content[0]?.text, "y ", "prose survives");
});

test("plugin JSON passthrough stays byte-identical for tag-free bodies", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const body = JSON.stringify({ choices: [{ message: { content: "clean" } }], usage: { prompt_tokens: 2 } });
    await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "openai");
    assert.equal(out.join(""), body, "tag-free chat body byte-identical");
});
