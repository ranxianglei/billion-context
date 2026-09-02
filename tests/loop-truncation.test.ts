import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { log as loggerLog, setLogCapture } from "../src/logger.ts";

// #413: upstream truncation (200 + early SSE EOF) — zero-side-effect retry,
// well-formed Anthropic error stream (message_start before content blocks,
// all blocks closed), single-point logging.

const ANTHROPIC_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };

function makeCtx(id: string, logSink?: string[], wireThroughLogger = false): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: (m: string) => {
            logSink?.push(m);
            if (wireThroughLogger) loggerLog("info", `[${id}] ${m}`);
        },
    };
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeCtx>): Promise<string> {
    const adapter = createAnthropicAdapter(ANTHROPIC_BODY);
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, ANTHROPIC_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function mockFetch(handler: (call: number) => Response): { calls: () => number; restore: () => void } {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n++;
        return handler(n);
    }) as typeof fetch;
    return { calls: () => n, restore: () => { globalThis.fetch = orig; } };
}

const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const MESSAGE_START = ev("message_start", {
    type: "message_start",
    message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const textStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const textBlock = (index: number, text: string) => textStart(index) + textDelta(index, text) + blockStop(index);
const thinkingStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
const thinkingDelta = (index: number, thinking: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const toolUseBlock = (index: number, id: string, name: string, input: string) =>
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }) +
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input } }) +
    blockStop(index);
const MESSAGE_DELTA = (stopReason = "end_turn") => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

interface SseEvent { type: string; data: Record<string, unknown>; }

function parseSse(s: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (const block of s.split("\n\n")) {
        if (!block.trim()) continue;
        let type = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!type) continue;
        const jsonStr = dataLines.join("\n").trim();
        out.push({ type, data: jsonStr ? (JSON.parse(jsonStr) as Record<string, unknown>) : {} });
    }
    return out;
}

// Anthropic stream protocol invariants: message_start first, every
// content_block_start matched by a stop before the terminal, message_stop last.
function assertAnthropicStreamSchema(s: string): void {
    const events = parseSse(s);
    assert.ok(events.length > 0, "stream non-empty");
    assert.equal(events[0].type, "message_start", `first event must be message_start (got ${events[0].type})`);
    const open = new Map<number, string>();
    let sawTerminal = false;
    for (const e of events) {
        if (e.type === "content_block_start") {
            const idx = e.data.index as number;
            const cb = (e.data.content_block ?? {}) as Record<string, unknown>;
            assert.ok(!open.has(idx), `block ${idx} started twice`);
            open.set(idx, String(cb.type));
        } else if (e.type === "content_block_stop") {
            const idx = e.data.index as number;
            assert.ok(open.has(idx), `content_block_stop for never-started block ${idx}`);
            open.delete(idx);
        } else if (e.type === "message_delta" || e.type === "message_stop") {
            assert.equal(open.size, 0, `all blocks closed before ${e.type} (still open: ${[...open.entries()].map(([i, t]) => `${i}:${t}`).join(", ")})`);
            sawTerminal = true;
        }
    }
    assert.ok(sawTerminal, "stream has message_delta/message_stop terminal");
    assert.equal(events[events.length - 1].type, "message_stop", "last event is message_stop");
}

test("#413 T1: 0-event EOF → retried once; failed retry → well-formed error stream, single log line", async () => {
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const logSink: string[] = [];
    const ctx = makeCtx("trunc-t1", logSink, true);
    const mock = mockFetch(() => new Response('{"error":"boom"}', { status: 500, headers: { "content-type": "application/json" } }));
    try {
        const out = await drain(new Response("", { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 1, "zero-side-effect truncation retried exactly once");
        assertAnthropicStreamSchema(out);
        assert.ok(out.includes("upstream stream truncated"), "truncation surfaced to client");
        const truncCaptured = captured.filter((l) => l.msg.includes("upstream stream truncated"));
        assert.equal(truncCaptured.length, 1, `truncation logged exactly once (got ${truncCaptured.length}): ${JSON.stringify(truncCaptured)}`);
        assert.equal(truncCaptured[0].level, "info", "the single line is the ctx.log info line — no global error duplicate");
        assert.equal(logSink.filter((l) => l.includes("upstream stream truncated")).length, 1, "ctx.log called once for the truncation event");
    } finally {
        mock.restore();
        setLogCapture(null);
        delete process.env.BILI_REPLAY_RETRY_MAX;
    }
});

test("#413 T2: 0-event EOF → retry succeeds → one clean stream, no error surfaced", async () => {
    const round2 = [MESSAGE_START, textBlock(0, "Hello retry"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const mock = mockFetch(() => new Response(round2, { status: 200 }));
    const ctx = makeCtx("trunc-t2");
    try {
        const out = await drain(new Response("", { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 1, "retried once");
        assertAnthropicStreamSchema(out);
        assert.ok(out.includes("Hello retry"), "retried round's content delivered");
        assert.ok(!out.includes("upstream stream truncated"), "no error surfaced on successful retry");
    } finally {
        mock.restore();
    }
});

test("#413 T3: truncation with open thinking block → block closed, no retry (content already forwarded)", async () => {
    const round1 = [MESSAGE_START, thinkingStart(0), thinkingDelta(0, "let me think")].join("");
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    const ctx = makeCtx("trunc-t3");
    try {
        const out = await drain(new Response(round1, { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 0, "no retry when content already reached the client");
        assertAnthropicStreamSchema(out);
        assert.ok(out.includes("upstream stream truncated"), "truncation surfaced to client");
    } finally {
        mock.restore();
    }
});

test("#413 T4: truncation with open text block → block closed before error block", async () => {
    const round1 = [MESSAGE_START, textStart(0), textDelta(0, "partial")].join("");
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    const ctx = makeCtx("trunc-t4");
    try {
        const out = await drain(new Response(round1, { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 0, "no retry when content already reached the client");
        assertAnthropicStreamSchema(out);
        assert.ok(out.includes("partial"), "already-forwarded text preserved");
        assert.ok(out.includes("upstream stream truncated"), "truncation surfaced to client");
    } finally {
        mock.restore();
    }
});

test("#413 T5: retry itself truncated → no second retry (one per request)", async () => {
    const mock = mockFetch(() => new Response("", { status: 200 }));
    const ctx = makeCtx("trunc-t5");
    try {
        const out = await drain(new Response("", { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 1, "exactly one retry per request");
        assertAnthropicStreamSchema(out);
        assert.ok(out.includes("upstream stream truncated"), "truncation surfaced after exhausted retry");
    } finally {
        mock.restore();
    }
});

test("#413 T6: round-2 truncation (after proxy tool) retries with the round-2 body", async () => {
    const round1 = [MESSAGE_START, toolUseBlock(0, "toolu_1", "acp_status", "{}"), MESSAGE_DELTA("tool_use"), MESSAGE_STOP].join("");
    const round2 = [MESSAGE_START, textBlock(0, "after retry"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const mock = mockFetch((call) =>
        call === 1 ? new Response("", { status: 200 }) : new Response(round2, { status: 200 }),
    );
    const ctx = makeCtx("trunc-t6");
    try {
        const out = await drain(new Response(round1, { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 2, "re-request + one truncation retry");
        assert.ok(out.includes("[ACP]"), "proxy tool marker surfaced to client");
        assert.ok(out.includes("after retry"), "retried round-2 content delivered");
        assertAnthropicStreamSchema(out);
    } finally {
        mock.restore();
    }
});
