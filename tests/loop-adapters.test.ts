import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { responsesToCore } from "acp-kernel/wire";
import type { ResponsesRequestBody } from "acp-kernel/wire";

function makeCtx(id: string, messages: CoreMessage[] = []): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages,
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
        log: () => {},
    };
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    adapter: ReturnType<typeof createOpenaiAdapter> | ReturnType<typeof createAnthropicAdapter>,
    requestBody: Record<string, unknown>,
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("openai adapter: plain text round-trips live + [DONE] termination", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await drain(
        new Response(round1, { status: 200 }).body!,
        makeCtx("openai-text"),
        createOpenaiAdapter({ model: "gpt" }),
        { model: "gpt", messages: [], stream: true },
    );
    assert.ok(out.includes("Hello"), "round-1 text streamed live");
    assert.ok(out.includes("[DONE]"), "[DONE] terminator present");
    assert.ok(/finish_reason/.test(out), "finish chunk present");
});

test("openai adapter: separated usage chunk (choices:[] + usage) captured → lastInputTokens set", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 30 } } })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const ctx = makeCtx("openai-usage-sep");
    await drain(
        new Response(round1, { status: 200 }).body!,
        ctx,
        createOpenaiAdapter({ model: "gpt" }),
        { model: "gpt", messages: [], stream: true },
    );
    assert.ok((ctx.session.stats.lastInputTokens ?? 0) > 0, "usage from choices:[] chunk captured (lastInputTokens > 0)");
});

test("openai adapter: acp_status-only round → marker + re-request, no crash", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "acp_status", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const round2 = [
        `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 2, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx("openai-status"),
            createOpenaiAdapter({ model: "gpt" }),
            { model: "gpt", messages: [], stream: true },
        );
        assert.ok(out.includes("[ACP]"), "acp_status marker surfaced");
        assert.ok(out.includes("[DONE]"), "graceful completion ([DONE])");
        assert.equal(fetchCalls, 1, "re-request after acp_status (avoids tool_calls-no-body hang)");
    } finally {
        globalThis.fetch = orig;
    }
});

test("anthropic adapter: plain text round-trips live + message_delta/message_stop termination", async () => {
    const round1 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const out = await drain(
        new Response(round1, { status: 200 }).body!,
        makeCtx("anthropic-text"),
        createAnthropicAdapter({ model: "claude" }),
        { model: "claude", messages: [], stream: true, max_tokens: 10 },
    );
    assert.ok(out.includes("Hello"), "round-1 text streamed live");
    assert.ok(out.includes("message_delta"), "message_delta terminal present");
    assert.ok(out.includes("message_stop"), "message_stop terminal present");
});

test("anthropic adapter: relay-echoed message_delta with input_tokens: 0 must NOT overwrite message_start usage", async () => {
    // Some relays echo a schema-shaped `usage` in message_delta where
    // `input_tokens` is present but 0 (the spec field is normally absent).
    // The input context is fixed within a turn — message_start is
    // authoritative — so a 0 in message_delta must be ignored, not merged
    // (it used to zero roundInput → lastInputTokens = cached-only → the nudge
    // denominator collapsed and compression never fired on cached sessions).
    const round1 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 55, cache_read_input_tokens: 11 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const ctx = { ...makeCtx("anthropic-delta-zero"), protocol: "anthropic" };
    await drain(
        new Response(round1, { status: 200 }).body!,
        ctx,
        createAnthropicAdapter({ model: "claude" }),
        { model: "claude", messages: [], stream: true, max_tokens: 10 },
    );
    assert.equal(ctx.session.stats.lastInputTokens, 66, "total = input_tokens(55) + cache_read(11); the 0 in message_delta is ignored");
    assert.equal(ctx.session.stats.cachedTokens, 11, "cached portion from message_start preserved");
});

test("anthropic adapter (#299): stitched stream — terminal's complete usage adopts atomically, no double-count", async () => {
    // After a compress re-request, the stream handed to a downstream bili is
    // two rounds stitched: round1's message_start (pre-compress cache_read) +
    // the final synthetic terminal (post-compress input, cache_read
    // legitimately 0). The terminal carries a COMPLETE usage object
    // (input_tokens > 0 AND cache_read_input_tokens present), so it must be
    // adopted atomically — the 0 overwrites the stale cache_read, else the
    // total double-counts (142543 + 118663 = 261206 instead of 142543 →
    // false 131% EMERGENCY nudge + preflight compression).
    const stitched = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 50000, cache_read_input_tokens: 118663 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 142543, cache_read_input_tokens: 0, output_tokens: 7 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const ctx = { ...makeCtx("anthropic-stitched"), protocol: "anthropic" };
    await drain(
        new Response(stitched, { status: 200 }).body!,
        ctx,
        createAnthropicAdapter({ model: "claude" }),
        { model: "claude", messages: [], stream: true, max_tokens: 10 },
    );
    assert.equal(ctx.session.stats.lastInputTokens, 142543, "total = terminal input(142543) + terminal cache(0); stale message_start cache_read(118663) NOT double-counted");
    assert.equal(ctx.session.stats.cachedTokens, 0, "cached portion = terminal's 0 (atomically adopted)");
});

test("anthropic adapter (#299): stitched terminal after proxy-tool re-request carries complete authoritative usage", async () => {
    // Generation-side contract: the synthetic terminal emitted after a
    // compress/proxy-tool re-request must carry BOTH input_tokens and
    // cache_read_input_tokens with the final round's true values (0 included)
    // so a downstream parser can adopt the usage atomically.
    const round1 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 50000, cache_read_input_tokens: 118663 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_s", name: "acp_status", input: {} } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const round2 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 142543, cache_read_input_tokens: 0 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx("anthropic-stitched-terminal"),
            createAnthropicAdapter({ model: "claude" }),
            { model: "claude", messages: [], stream: true, max_tokens: 10 },
        );
        assert.equal(fetchCalls, 1, "re-request after proxy tool");
        const terminalLines = out
            .split("\n")
            .filter((l) => l.startsWith("data: ") && l.includes('"message_delta"'))
            .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
        assert.equal(terminalLines.length, 1, "exactly one (synthetic) message_delta in the stitched output");
        const usage = (terminalLines[0]?.usage ?? {}) as Record<string, unknown>;
        assert.equal(usage.input_tokens, 142543, "terminal carries final round's input_tokens");
        assert.equal(usage.cache_read_input_tokens, 0, "terminal carries final round's cache_read (explicit 0, so downstream can adopt atomically)");
        assert.equal(usage.output_tokens, 3, "terminal carries final round's output_tokens");
    } finally {
        globalThis.fetch = orig;
    }
});

test("anthropic adapter: acp_status-only round → marker + re-request, no crash", async () => {
    const round1 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_s", name: "acp_status", input: {} } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const round2 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 3 } } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx("anthropic-status"),
            createAnthropicAdapter({ model: "claude" }),
            { model: "claude", messages: [], stream: true, max_tokens: 10 },
        );
        assert.ok(out.includes("[ACP]"), "acp_status marker surfaced");
        assert.ok(out.includes("message_stop"), "graceful completion (message_stop)");
        assert.equal(fetchCalls, 1, "re-request after acp_status (avoids tool_use-no-body hang)");
    } finally {
        globalThis.fetch = orig;
    }
});

test("openai adapter (S1): a single finish_reason chunk is forwarded exactly once (not double-emitted)", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await drain(
        new Response(round1, { status: 200 }).body!,
        makeCtx("openai-single-finish"),
        createOpenaiAdapter({ model: "gpt" }),
        { model: "gpt", messages: [], stream: true },
    );
    const finishCount = (out.match(/"finish_reason":"stop"/g) || []).length;
    assert.equal(finishCount, 1, "finish_reason:\"stop\" emitted exactly once (S1: original finish chunk not passthrough'd + emitCompletion)");
});

test("ACP_LOOP_V2 smoke: import + runCompressLoop round-trips (responses) without crashing", async () => {
    const mod = await import("../src/loop/index.ts");
    assert.equal(typeof mod.runCompressLoop, "function", "runCompressLoop exported");
    assert.equal(typeof mod.pickAdapter, "function", "pickAdapter exported");
    const adapter = mod.pickAdapter("responses", { model: "gpt" });
    assert.equal(typeof adapter.parseStream, "function", "responses adapter has parseStream");
    const openaiA = mod.pickAdapter("openai", { model: "gpt" });
    assert.equal(typeof openaiA.emitCompletion, "function", "openai adapter has emitCompletion");
    const anthA = mod.pickAdapter("anthropic", { model: "claude" });
    assert.equal(typeof anthA.emitText, "function", "anthropic adapter has emitText");
});

function mockStream(...chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const enc = new TextEncoder();
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
}

function erroringStream(firstChunk: string): ReadableStream<Uint8Array> {
    let calls = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            calls++;
            if (calls === 1) {
                controller.enqueue(new TextEncoder().encode(firstChunk));
                return;
            }
            throw new Error("simulated network drop on second read");
        },
    });
}

function sseLf(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseCrlf(type: string, data: unknown): string {
    return `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

async function collectParseEvents(
    adapter: ReturnType<typeof createResponsesAdapter> | ReturnType<typeof createOpenaiAdapter> | ReturnType<typeof createAnthropicAdapter>,
    stream: ReadableStream<Uint8Array>,
    round: number,
): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, round)) events.push(ev);
    return events;
}

test("F1 (CRLF): responses adapter yields text delta from \\r\\n-separated SSE (not silently swallowed)", async () => {
    const crlf = sseCrlf("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "m1",
        output_index: 0,
        delta: "HiCRLF",
    });
    const events = await collectParseEvents(createResponsesAdapter(), mockStream(crlf), 1);
    const textEv = events.find((e) => e.kind === "text");
    assert.ok(textEv, "text delta yielded — CRLF (0D0A0D0A) normalized so indexOf(\\n\\n) matches");
    if (textEv && textEv.kind === "text") {
        assert.equal(textEv.delta, "HiCRLF", "delta content intact");
    }
});

test("F1 (CRLF): openai adapter yields text delta from \\r\\n-separated SSE (not silently swallowed)", async () => {
    const crlf = `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt",
        choices: [{ index: 0, delta: { content: "HiCRLF" }, finish_reason: null }],
    })}\r\n\r\n`;
    const events = await collectParseEvents(createOpenaiAdapter({ model: "gpt" }), mockStream(crlf), 1);
    const textEv = events.find((e) => e.kind === "text");
    assert.ok(textEv, "text delta yielded — CRLF (0D0A0D0A) normalized so indexOf(\\n\\n) matches");
    if (textEv && textEv.kind === "text") {
        assert.equal(textEv.delta, "HiCRLF", "delta content intact");
    }
});

test("F1 (CRLF): anthropic adapter yields text delta from \\r\\n-separated SSE (not silently swallowed)", async () => {
    const crlf = sseCrlf("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "HiCRLF" },
    });
    const events = await collectParseEvents(createAnthropicAdapter({ model: "claude" }), mockStream(crlf), 1);
    const textEv = events.find((e) => e.kind === "text");
    assert.ok(textEv, "text delta yielded — CRLF (0D0A0D0A) normalized so indexOf(\\n\\n) matches");
    if (textEv && textEv.kind === "text") {
        assert.equal(textEv.delta, "HiCRLF", "delta content intact");
    }
});

test("F2: responses custom_tool_call meta events have firstRoundOnly=false (passthrough survives round 2+)", async () => {
    const stream = mockStream(
        sseLf("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_x", name: "code_mode_tool", arguments: "" },
        }),
        sseLf("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_x", name: "code_mode_tool", arguments: "{}" },
        }),
    );
    const events = await collectParseEvents(createResponsesAdapter(), stream, 2);
    const metas = events.filter((e) => e.kind === "meta");
    assert.ok(metas.length >= 2, "both custom_tool_call events (added+done) yielded in round 2");
    for (const m of metas) {
        if (m.kind === "meta") {
            assert.equal(
                m.firstRoundOnly,
                false,
                "custom_tool_call passthrough has firstRoundOnly=false (not the generic else branch firstRoundOnly:true)",
            );
        }
    }
});

test("F3: anthropic remaps forwarded block indices to be strictly sequential when tool_use is suppressed", async () => {
    const stream = mockStream(
        sseLf("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } }),
        sseLf("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sseLf("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
        sseLf("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseLf("content_block_start", {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
        }),
        sseLf("content_block_delta", {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' },
        }),
        sseLf("content_block_stop", { type: "content_block_stop", index: 1 }),
        sseLf("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }),
        sseLf("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "World" } }),
        sseLf("content_block_stop", { type: "content_block_stop", index: 2 }),
        sseLf("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
        sseLf("message_stop", { type: "message_stop" }),
    );
    const adapter = createAnthropicAdapter({ model: "claude" });
    const forwardedBlockIndices: number[] = [];
    const toolCallEvents: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) {
        if (ev.kind === "tool_call") {
            toolCallEvents.push(ev);
            continue;
        }
        const buf = ev.kind === "text" ? ev.raw : ev.kind === "meta" ? ev.chunk : undefined;
        if (!buf) continue;
        for (const line of buf.toString("utf8").split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
                const obj = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
                if (
                    typeof obj.index === "number" &&
                    typeof obj.type === "string" &&
                    obj.type.startsWith("content_block_")
                ) {
                    forwardedBlockIndices.push(obj.index);
                }
            } catch {
            }
        }
    }

    assert.equal(toolCallEvents.length, 1, "suppressed tool_use@1 emitted as a tool_call event");
    const tc = toolCallEvents[0];
    if (tc && tc.kind === "tool_call") {
        assert.equal(tc.name, "get_weather", "tool_call name from content_block_start");
        assert.equal(tc.callId, "toolu_1", "tool_call id from content_block_start");
        assert.ok(
            tc.arguments.includes('"city":"SF"'),
            "tool_call arguments accumulated from input_json_delta",
        );
    }

    const distinct = [...new Set(forwardedBlockIndices)].sort((a, b) => a - b);
    const expected = Array.from({ length: distinct.length }, (_, i) => i);
    assert.deepEqual(
        distinct,
        expected,
        `forwarded content_block indices STRICTLY SEQUENTIAL (0,1,...) with no gaps/dupes; got ${JSON.stringify(distinct)}`,
    );
    assert.ok(
        distinct.includes(1),
        "text@2 (upstream) remapped to client index 1 because tool_use@1 was suppressed (fills the gap)",
    );
});

test("F4 (network drop): responses parseStream completes normally when upstream read() throws", async () => {
    const firstChunk = sseLf("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "m1",
        output_index: 0,
        delta: "before-drop",
    });
    const events = await collectParseEvents(createResponsesAdapter(), erroringStream(firstChunk), 1);
    const textEv = events.find((e) => e.kind === "text");
    assert.ok(textEv, "pre-drop text yielded; iterator completed normally without rethrowing the read() error");
});

test("F4 (network drop): openai parseStream completes normally when upstream read() throws", async () => {
    const firstChunk = `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt",
        choices: [{ index: 0, delta: { content: "before-drop" }, finish_reason: null }],
    })}\n\n`;
    const events = await collectParseEvents(createOpenaiAdapter({ model: "gpt" }), erroringStream(firstChunk), 1);
    const textEv = events.find((e) => e.kind === "text");
    assert.ok(textEv, "pre-drop text yielded; iterator completed normally without rethrowing the read() error");
});

test("F4 (network drop): anthropic parseStream completes normally when upstream read() throws", async () => {
    const firstChunk = sseLf("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before-drop" },
    });
    const events = await collectParseEvents(createAnthropicAdapter({ model: "claude" }), erroringStream(firstChunk), 1);
    const textEv = events.find((e) => e.kind === "text");
    assert.ok(textEv, "pre-drop text yielded; iterator completed normally without rethrowing the read() error");
});

test("F5: responses empty upstream → emitCompletion produces response.failed (not fabricated completed)", async () => {
    const adapter = createResponsesAdapter();
    let doneFinishReason: string | undefined;
    for await (const ev of adapter.parseStream(mockStream(), 1)) {
        if (ev.kind === "done") doneFinishReason = ev.finishReason;
    }
    assert.equal(doneFinishReason, "failed", "empty upstream yields done.finishReason=failed (not undefined)");

    const out = adapter.emitCompletion({ finishReason: doneFinishReason }).toString("utf8");
    assert.ok(out.includes("event: response.failed"), "emitCompletion emits response.failed event");
    assert.ok(out.includes('"status":"failed"'), "response object carries status:failed");
    assert.ok(
        !out.includes("event: response.completed"),
        "emitCompletion does NOT fabricate response.completed on empty upstream",
    );
});

test("F6: responses buildRequest preserves instructions + additional_tools prefix (codex prefix-cache fix)", () => {
    const body = {
        instructions: "AGENTS_MD_RULES",
        input: [
            { type: "additional_tools", name: "shell", tools: [{ type: "function", name: "shell", parameters: {} }] },
            { type: "message", role: "user", content: "hello codex" },
        ],
        stream: true,
    } as unknown as ResponsesRequestBody;
    const projection = responsesToCore(body);
    assert.ok(projection.systemParts.includes("AGENTS_MD_RULES"), "instructions lifted into systemParts");
    assert.ok(projection.preamble.some((i) => i.type === "additional_tools"), "additional_tools captured as preamble");

    const systemPrompt = buildCompressSystemPrompt();
    const adapter = createResponsesAdapter(false, projection);
    const rebuilt = adapter.buildRequest(projection.msgs, systemPrompt, body) as Record<string, unknown>;
    const input = rebuilt.input as Array<Record<string, unknown>>;

    assert.equal(!("instructions" in rebuilt), true, "top-level instructions stripped (responses_lite contract)");
    assert.equal(!("previous_response_id" in rebuilt), true, "previous_response_id stripped");

    assert.equal(input[0]?.type, "additional_tools", "additional_tools stays at input[0] (preamble preserved)");
    const dev = input.find((i) => i.role === "developer");
    assert.ok(dev, "developer message present");
    assert.ok(typeof dev?.content === "string" && dev.content.includes("AGENTS_MD_RULES"), "developer includes original instructions (systemParts) — matches round-1 prefix");
    assert.ok(typeof dev?.content === "string" && dev.content.includes(systemPrompt), "developer includes compress prompt");
});

test("F7: anthropic buildRequest preserves client system + cache_control + merges compress prompt (prefix-cache fix)", () => {
    const clientSystem = [{ type: "text", text: "YOU_ARE_CLAUDE", cache_control: { type: "ephemeral" } }];
    const systemPrompt = buildCompressSystemPrompt();
    const adapter = createAnthropicAdapter({ model: "claude" }, clientSystem);
    const rebuilt = adapter.buildRequest([], systemPrompt, { model: "claude", messages: [] }) as Record<string, unknown>;
    const system = rebuilt.system;
    assert.ok(Array.isArray(system), "system preserved as structured array (buildSystem keeps array form when original was array)");
    const text = Array.isArray(system)
        ? (system as Array<Record<string, unknown>>).map((b) => b.text as string).join("\n\n")
        : (system as string);
    assert.ok(text.includes("YOU_ARE_CLAUDE"), "client system text preserved (not lost in round-2) — matches round-1 prefix");
    assert.ok(text.includes(systemPrompt), "compress prompt merged into system");
    const hasCc = Array.isArray(system) && (system as Array<Record<string, unknown>>).some((b) => b.cache_control);
    assert.ok(hasCc, "cache_control marker preserved on system block (Anthropic prefix-cache anchor)");
});

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
}

function splitAfterLeadByte(full: Uint8Array, ch: string): [Uint8Array, Uint8Array] {
    const needle = new TextEncoder().encode(ch);
    let off = -1;
    for (let i = 0; i + needle.length <= full.length && off < 0; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
            if (full[i + j] !== needle[j]) { match = false; break; }
        }
        if (match) off = i;
    }
    assert.ok(off >= 0, `bytes of ${ch} found in payload`);
    return [full.slice(0, off + 1), full.slice(off + 1)];
}

async function cjkChunkSplitRoundTrip(
    name: string,
    adapter: ReturnType<typeof createResponsesAdapter> | ReturnType<typeof createOpenaiAdapter> | ReturnType<typeof createAnthropicAdapter>,
    payload: string,
): Promise<void> {
    const [c1, c2] = splitAfterLeadByte(new TextEncoder().encode(payload), "留");
    const events = await collectParseEvents(adapter, byteStream([c1, c2]), 1);
    let text = "";
    for (const ev of events) {
        if (ev.kind === "text") text += ev.delta;
    }
    assert.equal(text, "残留", `${name}: multi-byte CJK split across chunk boundary round-trips intact`);
    assert.ok(!text.includes("\uFFFD"), `${name}: no U+FFFD replacement characters`);
}

test("F8 (#541): responses adapter — CJK char split across SSE chunk boundary decodes intact (no U+FFFD)", async () => {
    const payload = sseLf("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "m1",
        output_index: 0,
        delta: "残留",
    });
    await cjkChunkSplitRoundTrip("responses", createResponsesAdapter(), payload);
});

test("F8 (#541): openai adapter — CJK char split across SSE chunk boundary decodes intact (no U+FFFD)", async () => {
    const payload =
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "残留" }, finish_reason: null }] })}\n\n` +
        `data: [DONE]\n\n`;
    await cjkChunkSplitRoundTrip("openai", createOpenaiAdapter({ model: "gpt" }), payload);
});

test("F8 (#541): anthropic adapter — CJK char split across SSE chunk boundary decodes intact (no U+FFFD)", async () => {
    const payload = sseLf("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "残留" },
    });
    await cjkChunkSplitRoundTrip("anthropic", createAnthropicAdapter({ model: "claude" }), payload);
});

test("openai emitCompletion: usage with absent token counts still serializes complete numeric fields (#dsh)", () => {
    const adapter = createOpenaiAdapter({ model: "deepseek-v4-flash" });
    const out = adapter.emitCompletion({ finishReason: "stop", usage: { inputTokens: undefined, outputTokens: undefined } }).toString("utf8");
    const finishLine = out.split("\n").find((l) => l.startsWith("data: ") && l.includes("finish_reason"));
    assert.ok(finishLine, "finish chunk present");
    const parsed = JSON.parse(finishLine.slice("data: ".length)) as { usage?: Record<string, unknown> };
    assert.ok(parsed.usage, "usage object present");
    assert.equal(parsed.usage!.prompt_tokens, 0, "prompt_tokens defaults to 0 (never dropped)");
    assert.equal(parsed.usage!.completion_tokens, 0, "completion_tokens defaults to 0 (never dropped)");
    assert.equal(parsed.usage!.total_tokens, 0);
    const real = adapter.emitCompletion({ finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3 } }).toString("utf8");
    const realLine = real.split("\n").find((l) => l.startsWith("data: ") && l.includes("finish_reason"));
    const realParsed = JSON.parse(realLine!.slice("data: ".length)) as { usage?: Record<string, unknown> };
    assert.deepEqual({ p: realParsed.usage!.prompt_tokens, c: realParsed.usage!.completion_tokens, t: realParsed.usage!.total_tokens }, { p: 7, c: 3, t: 10 });
});
