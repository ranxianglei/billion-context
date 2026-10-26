import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #2171: an upstream that accepts a request, returns 200 + text/event-stream
// headers, and then never emits a single data frame (observed 5× on a relay
// lane: cut at +180s by the gateway's no-first-byte timeout) used to surface
// the #721 in-band truncation error. When the client has received NOTHING
// visible (only SSE keep-alive comments, which are protocol-invisible), the
// pipe now re-issues the identical request once and pipes the retry instead.

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
const ERROR_SENTINEL = "upstream_stream_truncated";

test("chat pipe: zero-data-frame EOF re-issues once and the client sees the full retry turn (#2171)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ role: "assistant", content: "healed" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    await pipePluginChatWithStrip(streamOf([]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1);
    assert.ok(body.includes("healed"), "retry content must reach the client");
    assert.ok(body.includes("[DONE]"));
    assert.ok(!body.includes(ERROR_SENTINEL), "no in-band truncation error after a successful retry");
    assert.ok(logs.some((l) => l.includes("#2171")), "the retry is logged");
});

test("chat pipe: a retry that also dies at zero frames falls back to the #721 in-band error, exactly one re-issue (#2171)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    await pipePluginChatWithStrip(streamOf([]), makeRes(out), "openai", makeSession(), undefined, refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "the re-issue budget is one");
    assert.ok(body.includes(ERROR_SENTINEL), "second failure surfaces the truncation signal");
    assert.ok(body.includes("upstream stream ended before a completion event"));
});

test("chat pipe: partial content then EOF is NOT retried — the cut keeps today's behavior (#2171)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "dup" }), DONE]));
    };
    // A content delta landed, then the stream died without a terminal.
    await pipePluginChatWithStrip(streamOf([chatChunk({ role: "assistant", content: "partial" })]), makeRes(out), "openai", makeSession(), undefined, refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 0, "never regenerate after client-visible bytes");
    assert.ok(body.includes("partial"), "partial content is preserved");
    assert.ok(body.includes(ERROR_SENTINEL), "truncation signal still raised");
});

test("chat pipe: no refetch available keeps the plain #721 error (#2171)", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf([]), makeRes(out), "openai", makeSession(), undefined, undefined, "http://up");
    assert.ok(out.join("").includes(ERROR_SENTINEL));
});

test("responses pipe: zero-data-frame EOF re-issues once and the retry lifecycle reaches the client intact (#2171)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const sse = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
            sse("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
            sse("response.content_part.added", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "" } }),
            sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "healed" }),
            sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "healed" }),
            sse("response.content_part.done", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "healed" } }),
            sse("response.output_item.done", { output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "healed" }] } }),
            sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
        ]));
    };
    await pipePluginResponsesWithStrip(streamOf([]), makeRes(out), makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1);
    assert.ok(body.includes("healed"));
    assert.ok(body.includes("response.completed"), "full lifecycle including the terminal");
    assert.ok(!body.includes(ERROR_SENTINEL));
    assert.ok(logs.some((l) => l.includes("#2171")));
});

test("responses pipe: retry that also dies at zero frames falls back to the #721 error, one re-issue (#2171)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([]));
    };
    await pipePluginResponsesWithStrip(streamOf([]), makeRes(out), makeSession(), undefined, refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1);
    assert.ok(body.includes(ERROR_SENTINEL));
});

// A complete render tag is stripped whole by the tag filter (clean === ""),
// which is what makes a healed turn degenerate: nothing visible, terminal reached.
const ECHO_TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";

test("chat pipe: a healed stream that completes degenerate cannot spend a second re-issue (#2171 shared budget)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ role: "assistant", content: ECHO_TAG }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    await pipePluginChatWithStrip(streamOf([]), makeRes(out), "openai", makeSession(), undefined, refetch, "http://up");
    assert.equal(refetches, 1, "truncation retry and degenerate-turn retry share ONE re-issue per request");
    assert.ok(!out.join("").includes(ERROR_SENTINEL), "the degenerate completion passes through as today when the budget is spent");
});

test("responses pipe: a healed stream that completes degenerate cannot spend a second re-issue (#2171 shared budget)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const sse = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
            sse("response.output_item.added", { output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", content: [] } }),
            sse("response.content_part.added", { item_id: "msg_2", output_index: 0, part: { type: "output_text", text: "" } }),
            sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: ECHO_TAG }),
            sse("response.output_text.done", { item_id: "msg_2", output_index: 0, text: "" }),
            sse("response.content_part.done", { item_id: "msg_2", output_index: 0, part: { type: "output_text", text: "" } }),
            sse("response.output_item.done", { output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [] } }),
            sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
        ]));
    };
    await pipePluginResponsesWithStrip(streamOf([]), makeRes(out), makeSession(), undefined, refetch, "http://up");
    assert.equal(refetches, 1, "truncation retry and degenerate-turn retry share ONE re-issue per request");
    assert.ok(out.join("").includes("response.completed"), "the degenerate completion passes through as today when the budget is spent");
});

test("chat pipe: a comment-only upstream stream (keep-alive pings, zero data frames) still retries (#2171)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ role: "assistant", content: "healed" }), chatFinish("stop"), DONE]));
    };
    await pipePluginChatWithStrip(
        streamOf([": ping\n\n", ": ping\n\n"]),
        makeRes(out), "openai", makeSession(), undefined, refetch, "http://up",
    );
    assert.equal(refetches, 1, "SSE comments carry no protocol events — the zero-visible predicate must hold");
    assert.ok(out.join("").includes("healed"));
    assert.ok(!out.join("").includes(ERROR_SENTINEL));
});

test("responses pipe: a comment-only upstream stream (keep-alive pings, zero data frames) still retries (#2171)", async () => {
    const out: string[] = [];
    let refetches = 0;
    const sse = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
            sse("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
            sse("response.content_part.added", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "" } }),
            sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "healed" }),
            sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "healed" }),
            sse("response.content_part.done", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "healed" } }),
            sse("response.output_item.done", { output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "healed" }] } }),
            sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
        ]));
    };
    await pipePluginResponsesWithStrip(
        streamOf([": ping\n\n", ": ping\n\n"]),
        makeRes(out), makeSession(), undefined, refetch, "http://up",
    );
    assert.equal(refetches, 1, "SSE comments carry no protocol events — the zero-visible predicate must hold");
    assert.ok(out.join("").includes("healed"));
    assert.ok(!out.join("").includes(ERROR_SENTINEL));
});
