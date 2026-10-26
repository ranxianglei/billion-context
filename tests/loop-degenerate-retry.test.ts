import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { getCacheLedger } from "../src/cache-ledger.ts";

// #732: invisible single-retry for a degenerate terminal turn (reasoning-only
// completion, zero visible text, zero tool calls) that reached the client with
// nothing forwarded yet — the post-compress "model wraps up into a silent
// thought" stall. Completes the auto-retry groundwork of #673/#674.

function sse(event: string, obj: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...obj })}\n\n`;
}

function makeCtx(id: string, protocol: "responses" | "openai" = "responses") {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
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
        } as unknown as Session,
        log: () => {},
        protocol,
    };
}

// Round 1: a proxy tool call (acp_status) so the loop performs a re-request —
// the degenerate turn can only surface on a round>1 re-request where the
// Responses framing is suppressed (nothing forwarded → invisible retry).
const ROUND1_TOOL = [
    sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
    sse("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "acp_status", arguments: "" } }),
    sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: "{}" }),
    sse("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: "{}" }),
    sse("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "acp_status", arguments: "{}" } }),
    sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
].join("");

// Reasoning-only terminal turn: no message item, no output text, no tool call.
const ROUND_DEGENERATE = [
    sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
    sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, delta: "the context is small now, I believe we are finished here" }),
    sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
].join("");

const ROUND_GOOD = [
    sse("response.created", { response: { id: "resp_3", status: "in_progress" } }),
    sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_retry_ok", role: "assistant", content: [] } }),
    sse("response.content_part.added", { item_id: "msg_retry_ok", output_index: 0, part: { type: "output_text", text: "" } }),
    sse("response.output_text.delta", { item_id: "msg_retry_ok", output_index: 0, delta: "continued after nudge" }),
    sse("response.output_text.done", { item_id: "msg_retry_ok", output_index: 0, text: "continued after nudge" }),
    sse("response.content_part.done", { item_id: "msg_retry_ok", output_index: 0, part: { type: "output_text", text: "continued after nudge" } }),
    sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_retry_ok", role: "assistant", content: [{ type: "output_text", text: "continued after nudge" }] } }),
    sse("response.completed", { response: { id: "resp_3", status: "completed", output: [] } }),
].join("");

async function drain(retries: string[], id: string): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const body = retries[fetchCalls - 1] ?? "";
        return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx(id);
        for await (const chunk of runCompressLoop(
            new Response(ROUND1_TOOL, { status: 200 }).body!,
            ctx,
            { model: "gpt-5", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies };
}

test("#732 D1: degenerate post-compress turn → one invisible retry with a continuation nudge", async () => {
    // fetch #1 = re-request (degenerate); fetch #2 = the auto-retry (good turn).
    const { out, fetchCalls, bodies } = await drain([ROUND_DEGENERATE, ROUND_GOOD], "deg-d1");
    assert.equal(fetchCalls, 2, "re-request + exactly one degenerate auto-retry");
    assert.ok(bodies.length >= 2, "both requests observed");
    assert.ok(
        bodies[1].includes("ended without a tool call"),
        "the retry body carries the ephemeral continuation nudge",
    );
    assert.ok(out.includes("continued after nudge"), "the retried turn's content was delivered to the client");
});

test("#732 D2: one-shot bound — a degenerate RETRY is not retried again", async () => {
    // Both the re-request and the retry come back degenerate: only ONE retry may
    // fire. Without the bound this would loop until MAX_LOOP_ROUNDS.
    const { fetchCalls } = await drain([ROUND_DEGENERATE, ROUND_DEGENERATE], "deg-d2");
    assert.equal(fetchCalls, 2, "re-request + one retry; the degenerate retry must not trigger a second retry");
});

// #821: round-1 thinking-only terminal turn on the OpenAI wire. reasoning_content
// deltas stream verbatim to the client before done (forwardedAny=true), which made
// the #732 retry unreachable there; the gate is now !forwardedVisible, so the retry
// appends its content to the SAME stream after the already-forwarded thinking prefix.

function openaiSse(frames: Array<Record<string, unknown>>): string {
    return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

const OPENAI_THINKING_ONLY = openaiSse([
    { id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { reasoning_content: "the context looks small, I think we are done here" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

const OPENAI_EMPTY_NO_THINKING = openaiSse([
    { id: "chatcmpl_3", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

const OPENAI_GOOD = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "continued after nudge" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

async function drainOpenai(first: string, retries: string[], id: string): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const body = retries[fetchCalls - 1] ?? "";
        return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx(id, "openai");
        for await (const chunk of runCompressLoop(
            new Response(first, { status: 200 }).body!,
            ctx,
            { model: "deepseek-chat", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "deepseek-chat", stream: true }),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies };
}

test("#821 O1: openai-wire round-1 thinking-only turn → one auto-retry appended to the same stream", async () => {
    const { out, fetchCalls, bodies } = await drainOpenai(OPENAI_THINKING_ONLY, [OPENAI_GOOD], "deg-o1");
    assert.equal(fetchCalls, 1, "exactly one degenerate auto-retry fired");
    assert.ok(
        bodies[0].includes("ended without a tool call"),
        "the retry body carries the ephemeral continuation nudge",
    );
    assert.ok(out.includes("the context looks small"), "the thinking prefix was streamed to the client");
    assert.ok(out.includes("continued after nudge"), "the retried turn's content was delivered on the same stream");
    assert.ok(
        out.indexOf("the context looks small") < out.indexOf("continued after nudge"),
        "the thinking prefix precedes the retried content",
    );
});

test("#821 O2: genuinely empty (no-reasoning) terminal turn is NOT retried", async () => {
    const { fetchCalls } = await drainOpenai(OPENAI_EMPTY_NO_THINKING, [OPENAI_GOOD], "deg-o2");
    assert.equal(fetchCalls, 0, "sawThinking=false → the empty turn passes through untouched");
});

// #1862: the degenerate-retry boundary on the Responses wire misfired in two ways.
// A: a completed reasoning+custom_tool_call turn carries executable output, but the
// adapter counted zero tool calls, so the gate treated it as degenerate and re-issued
// it. B: recordUsage ran once per outer round, after the inner retry loop reset usage,
// so a successful retry silently dropped the replaced attempt's measured usage.

async function drainResp(
    first: string,
    retries: Array<string | (() => Response)>,
    id: string,
): Promise<{ out: string; fetchCalls: number; bodies: string[]; session: Session }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const r = retries[fetchCalls - 1] ?? "";
        return typeof r === "string" ? new Response(r, { status: 200 }) : r();
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    const ctx = makeCtx(id);
    try {
        for await (const chunk of runCompressLoop(
            new Response(first, { status: 200 }).body!,
            ctx,
            { model: "gpt-5", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies, session: ctx.session };
}

const ROUND_CUSTOM_TOOL = [
    sse("response.created", { response: { id: "resp_ct", status: "in_progress" } }),
    sse("response.reasoning_summary_text.delta", { item_id: "rs_ct", output_index: 0, delta: "let me check with the custom tool first" }),
    sse("response.output_item.added", { output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_ct_1", name: "lookup_weather", input: "" } }),
    sse("response.custom_tool_call_input.delta", { item_id: "ctc_1", output_index: 0, delta: "{\"city\": \"Paris\"}" }),
    sse("response.custom_tool_call_input.done", { item_id: "ctc_1", output_index: 0, input: "{\"city\": \"Paris\"}" }),
    sse("response.output_item.done", { output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_ct_1", name: "lookup_weather", input: "{\"city\": \"Paris\"}" } }),
    sse("response.completed", { response: { id: "resp_ct", status: "completed", output: [] } }),
].join("");

test("#1862 A1: reasoning + custom_tool_call turn is NOT degenerate-retried (executable output already forwarded)", async () => {
    const { out, fetchCalls } = await drainResp(ROUND_CUSTOM_TOOL, [], "a1");
    assert.equal(fetchCalls, 0, "no degenerate retry — the custom tool call counts as tool output");
    assert.ok(out.includes("lookup_weather"), "the custom tool call was forwarded verbatim to the client");
    assert.ok(out.includes("call_ct_1"), "the custom tool call id was forwarded verbatim");
    assert.ok(out.includes("Paris"), "the custom tool input payload was forwarded verbatim");
    assert.ok(!out.includes("fc-proxy-"), "the custom tool call was not re-synthesized via the function_call emitter");
    assert.equal((out.match(/event: response\.output_item\.done/g) ?? []).length, 1, "exactly one output_item.done frame — no duplicated tool item");
});

const DEGENERATE_USAGE = [
    sse("response.created", { response: { id: "resp_du", status: "in_progress" } }),
    sse("response.reasoning_summary_text.delta", { item_id: "rs_du", output_index: 0, delta: "hmm, nothing to say yet" }),
    sse("response.completed", { response: { id: "resp_du", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
].join("");

const GOOD_USAGE = [
    sse("response.created", { response: { id: "resp_gu", status: "in_progress" } }),
    sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_gu", role: "assistant", content: [] } }),
    sse("response.content_part.added", { item_id: "msg_gu", output_index: 0, part: { type: "output_text", text: "" } }),
    sse("response.output_text.delta", { item_id: "msg_gu", output_index: 0, delta: "here is the answer" }),
    sse("response.output_text.done", { item_id: "msg_gu", output_index: 0, text: "here is the answer" }),
    sse("response.content_part.done", { item_id: "msg_gu", output_index: 0, part: { type: "output_text", text: "here is the answer" } }),
    sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_gu", role: "assistant", content: [{ type: "output_text", text: "here is the answer" }] } }),
    sse("response.completed", { response: { id: "resp_gu", status: "completed", output: [], usage: { input_tokens: 110, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } } } }),
].join("");

test("#1862 B1: both attempts' usage settled exactly once (replaced attempt no longer dropped)", async () => {
    const { out, fetchCalls, session } = await drainResp(DEGENERATE_USAGE, [GOOD_USAGE], "b1");
    assert.equal(fetchCalls, 1, "exactly one degenerate auto-retry fired");
    assert.ok(out.includes("here is the answer"), "the retried turn's content was delivered to the client");
    assert.equal(session.stats.inputTokens, 210, "inputTokens = 100 (attempt 1) + 110 (retry)");
    assert.equal(session.stats.outputTokens, 12, "outputTokens = 5 (attempt 1) + 7 (retry)");
    assert.equal(getCacheLedger(session).lines.length, 2, "one ledger sample per attempt — neither dropped nor double-counted");
});

test("#1862 B2: failed degenerate-retry fetch settles the original attempt exactly once, fabricates nothing", async () => {
    const prevMax = process.env.BILI_REPLAY_RETRY_MAX;
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    try {
        const { fetchCalls, session } = await drainResp(DEGENERATE_USAGE, [() => new Response("upstream exploded", { status: 500 })], "b2");
        assert.equal(fetchCalls, 1, "the degenerate retry fetched once and failed");
        assert.equal(session.stats.inputTokens, 100, "original attempt's input settled exactly once (not double-counted on failure)");
        assert.equal(session.stats.outputTokens, 5, "original attempt's output settled exactly once");
        assert.equal(getCacheLedger(session).lines.length, 1, "exactly one ledger sample — no fabricated usage for the failed fetch");
    } finally {
        if (prevMax === undefined) delete process.env.BILI_REPLAY_RETRY_MAX;
        else process.env.BILI_REPLAY_RETRY_MAX = prevMax;
    }
});
