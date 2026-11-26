import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { usageTotals } from "../src/util.ts";
import type { Session } from "../src/session.ts";

// An advisor reply bundles several model calls: the executor, the advisor,
// the executor again. Its top-level usage sums the executor calls, about twice
// the real context, and bili took that sum as the context size: 488,488 read
// as 122% of a 400K window when the context was about 241K, which fired an
// emergency nudge and a server-side fold. The per-call `iterations` list is
// exact; the context the next request carries is what the last executor call
// read. Numbers below are a real advisor reply (2026-11-14T16:31:35Z).

const LAST_CALL_CONTEXT = 2 + 182925 + 1156;
const BILLED = 4 + 362337 + 4669;
const ADVISOR_USAGE = {
    input_tokens: 4, cache_read_input_tokens: 362337, cache_creation_input_tokens: 4669, output_tokens: 270,
    iterations: [
        { type: "message", input_tokens: 2, cache_read_input_tokens: 179412, cache_creation_input_tokens: 3513, output_tokens: 86 },
        { type: "advisor_message", model: "claude-fable-5-2", input_tokens: 184943, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9936 },
        { type: "message", input_tokens: 2, cache_read_input_tokens: 182925, cache_creation_input_tokens: 1156, output_tokens: 184 },
    ],
};

const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = ev("message_start", {
    type: "message_start",
    message: { id: "msg_a", type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 2, cache_read_input_tokens: 179412, cache_creation_input_tokens: 3513 } },
});
const delta = (usage: unknown) => ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
const stop = ev("message_stop", { type: "message_stop" });

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.close(); },
    });
}

function makeSession(id: string): Session {
    return {
        id, meta: {}, metadata: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, contextTokens: 0, lastInputTokens: 0, compressCreditTokens: 0,
            rangeRestores: 0 },
        state: createInitialState(), createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
    } as unknown as Session;
}

function sinkRes(): import("node:http").ServerResponse {
    return { write: () => true, end() {}, once() {}, destroyed: false, writableEnded: false } as unknown as import("node:http").ServerResponse;
}

beforeEach(() => _setStoreForTest(new SessionStore({ enabled: false })));

test("plugin lane: an advisor reply sets the context to the last executor call, and bills the sum", async () => {
    const s = makeSession("advisor-plugin");
    await pipePluginChatWithStrip(streamOf([start, delta(ADVISOR_USAGE), stop]), sinkRes(), "anthropic", s);
    assert.equal(s.stats.lastInputTokens, LAST_CALL_CONTEXT);
    assert.equal(s.stats.contextTokens, LAST_CALL_CONTEXT);
    assert.equal(s.stats.inputTokens, BILLED, "the cumulative token counter keeps what was billed");
});

test("plugin lane: a one-call reply is unchanged", async () => {
    const s = makeSession("plain-plugin");
    const one = { input_tokens: 2, cache_read_input_tokens: 179412, cache_creation_input_tokens: 3513, output_tokens: 86,
        iterations: [{ type: "message", input_tokens: 2, cache_read_input_tokens: 179412, cache_creation_input_tokens: 3513, output_tokens: 86 }] };
    await pipePluginChatWithStrip(streamOf([start, delta(one), stop]), sinkRes(), "anthropic", s);
    assert.equal(s.stats.lastInputTokens, 2 + 179412 + 3513);
});

test("proxy loop: an advisor reply sets the context to the last executor call", async () => {
    const body = { model: "claude", messages: [], stream: true, max_tokens: 10 };
    const ctx = { core: createCore(), config: { modelContextLimit: 400000 } as Config, messages: [] as CoreMessage[], session: makeSession("advisor-loop"), log: () => {} };
    for await (const _ of runCompressLoop(streamOf([start, delta(ADVISOR_USAGE), stop]), ctx, body, { url: "http://mock", headers: {} }, createAnthropicAdapter(body), buildCompressSystemPrompt())) { /* drain */ }
    assert.equal(ctx.session.stats.lastInputTokens, LAST_CALL_CONTEXT);
    assert.equal(ctx.session.stats.inputTokens, BILLED);
});

test("non-streaming: usageTotals reports the last executor call as the context", () => {
    const t = usageTotals("anthropic", ADVISOR_USAGE);
    assert.equal(t.total, BILLED);
    assert.equal(t.context, LAST_CALL_CONTEXT);
    assert.equal(usageTotals("anthropic", { input_tokens: 5, cache_read_input_tokens: 10 }).context, undefined);
});
