import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #2756: the degenerate-turn gate asked "did the model emit visible text?" but
// two upstream shapes answer YES while delivering NO answer the host can act
// on, so the one-shot continuation retry never fired and the session stalled:
//   1. Responses upstreams that inline thinking into item.content[] or emit
//      reasoning-text events (vLLM / llama.cpp reasoning_text shape): the
//      reasoning counts as visible output, the turn has no real prose.
//   2. A degenerate stop whose only content delta is whitespace ("\n\n" —
//      observed live: 3461 chars of thinking streamed, text was exactly
//      "\n\n", stopReason stop, zero tool calls; the host showed the frozen
//      tail of the thinking and never got an answer).
// The gate now asks "did the host receive ANSWER text?" — reasoning surface
// and whitespace-only prose do not count; real prose keeps refusing the retry
// byte-for-byte, so a delivered answer is never regenerated.

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

function chatFinish(reason = "stop"): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";
const sse = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

test("chat pipe: thinking + whitespace-only content is degenerate — the continuation retry fires (#2756)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ role: "assistant", content: "recovered answer" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    // The observed degenerate stop: full reasoning, content is exactly "\n\n".
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", reasoning_content: "I should check the count first. If the count comes back as 1, then the answer is..." }),
        chatChunk({ content: "\n\n" }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "whitespace-only prose must retry like the empty/tag-echo shapes");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(logs.some((l) => l.includes("#732/#821") || l.includes("degenerate")), "the retry is logged");
});

test("chat pipe: real content never retries — a delivered answer is never regenerated (#2756)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "dup" }), chatFinish("stop"), DONE]));
    };
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", reasoning_content: "thinking..." }),
        chatChunk({ content: "real answer" }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), undefined, refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 0, "non-whitespace prose refuses the retry, byte-for-byte with the old gate");
    assert.ok(body.includes("real answer"));
});

test("chat pipe: whitespace-only turn with an unclean finish logs why it was not retried (#2756)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "dup" }), chatFinish("stop"), DONE]));
    };
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", reasoning_content: "thinking..." }),
        chatChunk({ content: " \n " }),
        chatFinish("length"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    assert.equal(refetches, 0, "finish=length is not a clean stop — never re-send those");
    assert.ok(logs.some((l) => l.includes("not retried") && l.includes("not a clean stop")), "the refusal reason is observable");
});

test("responses pipe: vLLM reasoning-in-content shape with no answer prose retries once (#2756)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
            sse("response.output_item.added", { output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", content: [] } }),
            sse("response.content_part.added", { item_id: "msg_2", output_index: 0, part: { type: "output_text", text: "" } }),
            sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "recovered answer" }),
            sse("response.output_text.done", { item_id: "msg_2", output_index: 0, text: "recovered answer" }),
            sse("response.content_part.done", { item_id: "msg_2", output_index: 0, part: { type: "output_text", text: "recovered answer" } }),
            sse("response.output_item.done", { output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "recovered answer" }] } }),
            sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
        ]));
    };
    // vLLM/llama.cpp Responses shape: the thinking rides reasoning events and
    // the reasoning item's own content[]; the message's only text is "\n\n".
    await pipePluginResponsesWithStrip(streamOf([
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
        sse("response.reasoning_text.delta", { item_id: "rs_1", output_index: 0, delta: "deep thought" }),
        sse("response.reasoning_text.done", { item_id: "rs_1", output_index: 0, text: "deep thought" }),
        sse("response.output_item.done", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "deep thought" }] } }),
        sse("response.output_item.added", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
        sse("response.content_part.added", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "" } }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 1, text: "\n\n" }),
        sse("response.content_part.done", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "\n\n" } }),
        sse("response.output_item.done", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "\n\n" }] } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ]), makeRes(out), makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "reasoning surface must not read as an answer — the bare turn retries");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(body.includes("response.completed"), "the retry lifecycle completes");
    assert.ok(logs.some((l) => l.includes("#732/#821") || l.includes("degenerate")), "the retry is logged");
});

test("responses pipe: OpenAI shape — reasoning events plus real output_text never retries (#2756)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    await pipePluginResponsesWithStrip(streamOf([
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
        sse("response.reasoning_summary_part.added", { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
        sse("response.reasoning_summary_part.done", { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "thinking hard" } }),
        sse("response.output_item.added", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
        sse("response.content_part.added", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, delta: "actual answer" }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 1, text: "actual answer" }),
        sse("response.content_part.done", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "actual answer" } }),
        sse("response.output_item.done", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "actual answer" }] } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ]), makeRes(out), makeSession(), undefined, refetch, "http://up");
    assert.equal(refetches, 0, "a turn that delivered real answer prose must not be regenerated");
    assert.ok(out.join("").includes("actual answer"));
});

test("responses pipe: answer text held only in done events still refuses the retry (#2756)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    // No output_text deltas at all: the answer surfaces only on the held done
    // events. The answer-only accounting must still see it and refuse.
    await pipePluginResponsesWithStrip(streamOf([
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
        sse("response.reasoning_text.done", { item_id: "rs_1", output_index: 0, text: "deep thought" }),
        sse("response.output_item.done", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "deep thought" }] } }),
        sse("response.output_item.added", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
        sse("response.content_part.added", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "" } }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 1, text: "held answer" }),
        sse("response.content_part.done", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "held answer" } }),
        sse("response.output_item.done", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "held answer" }] } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ]), makeRes(out), makeSession(), undefined, refetch, "http://up");
    assert.equal(refetches, 0, "held-but-real answer prose refuses the retry, byte-for-byte with the old gate");
    assert.ok(out.join("").includes("held answer"), "the held events are flushed to the client");
});

test("responses pipe: a function_call turn is a converged turn — no retry (#2756)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    await pipePluginResponsesWithStrip(streamOf([
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "fc_1", type: "function_call", name: "get_weather", arguments: "" } }),
        sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: "{\"city\":" }),
        sse("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: "{\"city\":\"SF\"}" }),
        sse("response.output_item.done", { output_index: 0, item: { id: "fc_1", type: "function_call", name: "get_weather", arguments: "{\"city\":\"SF\"}" } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ]), makeRes(out), makeSession(), undefined, refetch, "http://up");
    assert.equal(refetches, 0, "a tool call is a usable turn — never retried");
    assert.ok(out.join("").includes("get_weather"));
});

test("chat pipe (gemini wire): thought part plus real prose is a converged turn (#2756 review)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    // Gemini wire: prose AND reasoning live in parts; a thought:true part is
    // the thinking. A delivered real answer must refuse the retry and must not
    // log a degenerate-turn refusal — the answer gate must see the fast-path
    // prose on this lane like on the others (#2756 review fix).
    await pipePluginChatWithStrip(streamOf([
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: "thinking hard", thought: true }] }, finishReason: "" }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: "real answer" }] }, finishReason: "" }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [] }, finishReason: "STOP" }] })}\n\n`,
    ]), makeRes(out), "google", makeSession(), (m) => logs.push(m), refetch, "http://up");
    assert.equal(refetches, 0, "a gemini turn that delivered real answer prose must not be regenerated");
    assert.ok(out.join("").includes("real answer"), "the delivered answer reaches the client");
    assert.ok(!logs.some((l) => l.includes("degenerate terminal turn not retried")), "no degenerate-turn refusal may be logged for a healthy gemini turn");
});

// #2769 item 1: the chat-pipe retry gate never reached the Gemini wire — no
// google branch in the terminal detection, and Gemini's terminal reason is
// UPPERCASE "STOP" vs the lowercase clean-stop set. The tests below prove both
// directions now that the gate reaches this lane.
function gChunk(parts: Record<string, unknown>[], finishReason = ""): string {
    return `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts }, finishReason }] })}\n\n`;
}

test("chat pipe (gemini wire): a thinking-only turn on STOP retries exactly once (#2769)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            gChunk([{ text: "recovered answer" }]),
            gChunk([], "STOP"),
        ]));
    };
    // The gemini degenerate shape: a thought part, then the terminal chunk with
    // no text part at all.
    await pipePluginChatWithStrip(streamOf([
        gChunk([{ thought: true, text: "thinking hard" }]),
        gChunk([], "STOP"),
    ]), makeRes(out), "google", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "a gemini thinking-only turn on STOP must retry exactly once");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.equal(body.split('"finishReason":"STOP"').length - 1, 1, "the first attempt's terminal chunk is dropped when the retry takes over");
    assert.ok(logs.some((l) => l.includes("#732/#821")), "the retry is logged");
});

test("chat pipe (gemini wire): thought part plus whitespace-only text is degenerate — retries once (#2769)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            gChunk([{ text: "recovered answer" }]),
            gChunk([], "STOP"),
        ]));
    };
    // The #2756 B-accident shape on the gemini wire: real thinking, and the only
    // text part is exactly "\n\n".
    await pipePluginChatWithStrip(streamOf([
        gChunk([{ thought: true, text: "deep reasoning about the count" }]),
        gChunk([{ text: "\n\n" }]),
        gChunk([], "STOP"),
    ]), makeRes(out), "google", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "whitespace-only prose is not an answer — the retry fires");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(logs.some((l) => l.includes("#732/#821") || l.includes("degenerate")), "the retry is logged");
});

test("chat pipe (gemini wire): MAX_TOKENS is not a clean stop — refused and logged (#2769)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    await pipePluginChatWithStrip(streamOf([
        gChunk([{ thought: true, text: "thinking" }]),
        gChunk([], "MAX_TOKENS"),
    ]), makeRes(out), "google", makeSession(), (m) => logs.push(m), refetch, "http://up");
    assert.equal(refetches, 0, "a truncated turn is never re-sent");
    assert.ok(logs.some((l) => l.includes("not retried") && l.includes("not a clean stop")), "the refusal reason is observable");
});

test("chat pipe: tag-interior accounting must not chop a folded tail (#2769 item 3)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ content: "recovered answer" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    // One terminal frame: "pre" + a bare render-tag open whose swallowed
    // remainder is whitespace. The released "pre" is the tag's own interior
    // (markup, excluded from the answer); the folded tail "    " is whitespace
    // (counts zero) — so the turn delivered NO answer. The old slice-subtraction
    // kept the markup prefix and read the turn as answered, stalling it.
    await pipePluginChatWithStrip(streamOf([
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { role: "assistant", content: `pre\x3cacp\x3e    ` }, finish_reason: "stop" }] })}\n\n`,
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "markup interior + whitespace tail is no answer — the retry must fire");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(logs.some((l) => l.includes("#732/#821")), "the retry is logged");
});
