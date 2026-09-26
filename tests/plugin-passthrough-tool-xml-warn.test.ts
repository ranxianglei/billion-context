import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

// #1366 shape: the model drafts a tool call as literal text inside its prose.
const LT = "\x3c";
const GT = "\x3e";
const FRAG = `${LT}invoke name="compress"${GT}call it${LT}/invoke${GT}`;
const ESC_FRAG = "\\u003cinvoke\\u003e\\u003c/invoke\\u003e";
const WARN = "tool-call XML fragment";

function makeSession(id: string, protocol: string): Session {
    return {
        id,
        protocol,
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

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
}

// Decode what the client would actually assemble - raw SSE bytes carry JSON
// escaping (\" etc.) so byte-level includes() cannot prove verbatim forwarding.
function dataLines(raw: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const d = line.slice(6);
        if (d === "[DONE]") continue;
        out.push(JSON.parse(d) as Record<string, unknown>);
    }
    return out;
}

function openaiContent(raw: string): string {
    let s = "";
    for (const ev of dataLines(raw)) {
        const choices = ev["choices"];
        if (!Array.isArray(choices)) continue;
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta && typeof delta["content"] === "string") s += delta["content"];
    }
    return s;
}

function anthropicText(raw: string): string {
    let s = "";
    for (const ev of dataLines(raw)) {
        const delta = ev["delta"] as Record<string, unknown> | undefined;
        if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") s += delta["text"];
    }
    return s;
}

function responsesDeltaText(raw: string): string {
    let s = "";
    for (const ev of dataLines(raw)) {
        if (ev["type"] === "response.output_text.delta" && typeof ev["delta"] === "string") s += ev["delta"];
    }
    return s;
}

test("plugin openai passthrough warns once on tool-call-shaped XML in prose and forwards it verbatim (#1368)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ content: `draft ${FRAG} end` }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-1368", "openai"));
    } finally {
        setLogCapture(null);
    }
    assert.equal(openaiContent(out.join("")), `draft ${FRAG} end`, "decoded prose forwarded verbatim - never stripped");
    const warns = logs.filter((l) => l.includes(WARN));
    assert.equal(warns.length, 1, `expected exactly one warn, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[tag-echo]"), warns[0]);
    assert.ok(warns[0].includes("[sess-1368]"), warns[0]);
});

test("plugin openai passthrough warns on JSON-escaped tool-call XML in prose (#1368)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            chatChunk({ content: `see ${ESC_FRAG} here` }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-1368e", "openai"));
    } finally {
        setLogCapture(null);
    }
    assert.equal(openaiContent(out.join("")), `see ${ESC_FRAG} here`, "escaped-form prose forwarded verbatim");
    assert.equal(logs.filter((l) => l.includes(WARN)).length, 1, `expected exactly one warn, got: ${logs.join(" | ")}`);
});

test("plugin anthropic passthrough warns once on tool-call-shaped XML in text_delta (#1368)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `hi ${FRAG} bye` } })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "anthropic", makeSession("sess-a1368", "anthropic"));
    } finally {
        setLogCapture(null);
    }
    assert.equal(anthropicText(out.join("")), `hi ${FRAG} bye`, "decoded text_delta forwarded verbatim");
    const warns = logs.filter((l) => l.includes(WARN));
    assert.equal(warns.length, 1, `expected exactly one warn, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[sess-a1368]"), warns[0]);
});

test("plugin responses passthrough warns once on tool-call-shaped XML in output_text.delta (#1368)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            sse({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
            sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `draft ${FRAG} end` }),
            sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: `draft ${FRAG} end` }),
            sse({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5 } } }),
        ];
        await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession("sess-r1368", "responses"));
    } finally {
        setLogCapture(null);
    }
    assert.equal(responsesDeltaText(out.join("")), `draft ${FRAG} end`, "decoded output text forwarded verbatim");
    const warns = logs.filter((l) => l.includes(WARN));
    assert.equal(warns.length, 1, `expected exactly one warn, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[sess-r1368]"), warns[0]);
});

test("plugin responses passthrough warns on tool-call-shaped XML in reasoning summary deltas alone (#1368)", async () => {
    // Stream ends after the delta - no done-family or completion frame - so the
    // delta's own accounting is the ONLY prose source: this pins the fast-path
    // accumulation the done-family path cannot cover.
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            sse({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
            sse({ type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } }),
            sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: `draft ${FRAG} end` }),
        ];
        await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession("sess-rs1368", "responses"));
    } finally {
        setLogCapture(null);
    }
    let deltaText = "";
    for (const ev of dataLines(out.join(""))) {
        if (ev["type"] === "response.reasoning_summary_text.delta" && typeof ev["delta"] === "string") deltaText += ev["delta"];
    }
    assert.equal(deltaText, `draft ${FRAG} end`, "decoded reasoning summary forwarded verbatim");
    const warns = logs.filter((l) => l.includes(WARN));
    assert.equal(warns.length, 1, `expected exactly one warn, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[sess-rs1368]"), warns[0]);
});

test("plugin passthrough does not warn on plain prose (#1368)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ content: "just words, no markup at all" }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-clean", "openai"));
    } finally {
        setLogCapture(null);
    }
    assert.ok(!logs.some((l) => l.includes(WARN)), `no tool-call XML warn expected, got: ${logs.join(" | ")}`);
});
