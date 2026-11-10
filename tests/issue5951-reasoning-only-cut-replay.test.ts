import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #5951: a cut that lands after reasoning and nothing else used to be a dead
// turn. The client has a thinking fragment, no answer and no tool call, so the
// pipe replayes the request once instead of handing the host a truncation
// signal. Anything the host can act on (answer text, a tool call, a partial
// argument stream) still keeps the #721 in-band error: regenerating real output
// would corrupt the turn.

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

function eventsStream(events: string[]): ReadableStream<Uint8Array> {
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

function failedStream(events: string[], error: unknown): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
                return;
            }
            controller.error(error);
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

/** The `meta` object riding the in-band truncation frame, or undefined when the
 *  turn completed without one. */
function truncationMeta(body: string): Record<string, unknown> | undefined {
    for (const frame of body.split("\n\n")) {
        if (!frame.includes(ERROR_SENTINEL)) continue;
        const payload = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
        const parsed = JSON.parse(payload) as { error?: { meta?: Record<string, unknown> } };
        return parsed.error?.meta;
    }
    return undefined;
}

function healedTurn(): ReadableStream<Uint8Array> {
    return eventsStream([
        chatChunk({ role: "assistant", reasoning_content: "reasoning-b" }),
        chatChunk({ content: "healed answer" }),
        chatFinish("stop"),
        DONE,
    ]);
}

test("chat pipe: a read error after reasoning-only output re-issues once (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(healedTurn());
    };
    const first = failedStream([chatChunk({ role: "assistant", reasoning_content: "reasoning-a" })], new Error("upstream socket reset mid-stream"));

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");

    const body = out.join("");
    assert.equal(refetches, 1, "the cut is re-issued exactly once");
    assert.ok(body.includes("healed answer"), "the client sees the retry's answer");
    assert.ok(!body.includes(ERROR_SENTINEL), "a healed turn carries no truncation signal");
    assert.ok(logs.some((line) => line.includes("#5951")), "the replay is logged under the issue number");
    // The trade-off is explicit: the reasoning fragment the client already holds
    // is re-delivered by the retry instead of being stitched across attempts.
    assert.equal(body.split("reasoning-a").length - 1, 1, "the first attempt's reasoning reached the client");
    assert.equal(body.split("reasoning-b").length - 1, 1, "the retry's reasoning follows it");
});

test("chat pipe: an EOF after reasoning-only output replays as well (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(healedTurn());
    };
    const first = eventsStream([chatChunk({ role: "assistant", reasoning_content: "reasoning-a" })]);

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");

    const body = out.join("");
    assert.equal(refetches, 1);
    assert.ok(body.includes("healed answer"));
    assert.ok(!body.includes(ERROR_SENTINEL));
    assert.ok(logs.some((line) => line.includes("#5951")));
});

test("chat pipe: a dangling partial event does not block the reasoning-only replay (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(healedTurn());
    };
    // The cut lands mid-event: `buf` holds bytes that were never written.
    const first = failedStream(
        [chatChunk({ role: "assistant", reasoning_content: "reasoning-a" }), 'data: {"id":"chatcmpl-1","cho'],
        new Error("socket hang up"),
    );

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");

    const body = out.join("");
    assert.equal(refetches, 1);
    assert.ok(body.includes("healed answer"));
    assert.ok(!body.includes(ERROR_SENTINEL));
    assert.ok(!body.includes('{"id":"chatcmpl-1","cho'), "the dangling partial event is never forwarded");
});

test("chat pipe: answer text after reasoning keeps the truncation signal (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(healedTurn());
    };
    const first = failedStream(
        [chatChunk({ role: "assistant", reasoning_content: "reasoning-a" }), chatChunk({ content: "partial answer" })],
        new Error("upstream socket reset mid-stream"),
    );

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");

    const body = out.join("");
    assert.equal(refetches, 0, "delivered answer text is never regenerated");
    assert.ok(body.includes(ERROR_SENTINEL), "the client is told the turn was cut");
    assert.ok(body.includes("partial answer"), "the partial answer is preserved, not dropped");
    assert.ok(!body.includes("healed answer"));
});

test("chat pipe: a tool call after reasoning keeps the truncation signal (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(healedTurn());
    };
    const first = failedStream(
        [
            chatChunk({ role: "assistant", reasoning_content: "reasoning-a" }),
            chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }),
        ],
        new Error("upstream socket reset mid-stream"),
    );

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");

    const body = out.join("");
    assert.equal(refetches, 0, "a started tool call is never regenerated");
    assert.ok(body.includes(ERROR_SENTINEL));
    assert.ok(body.includes("read_file"));
});

test("chat pipe: the reasoning-only replay shares the single re-issue budget (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        // The retry is cut in the same place: the budget is already spent, so the
        // host gets the truncation signal rather than a second re-issue.
        return Promise.resolve(failedStream([chatChunk({ role: "assistant", reasoning_content: "reasoning-c" })], new Error("upstream socket reset mid-stream")));
    };
    const first = failedStream([chatChunk({ role: "assistant", reasoning_content: "reasoning-a" })], new Error("upstream socket reset mid-stream"));

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");

    const body = out.join("");
    assert.equal(refetches, 1, "one re-issue per request, shared with the zero-byte path");
    assert.ok(body.includes(ERROR_SENTINEL));
    assert.equal(truncationMeta(body)?.["retryZeroByteCutSpent"], true);
});

test("chat pipe: a cut that is not replayed names the read error in the diag (#5951)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const first = failedStream(
        [chatChunk({ role: "assistant", reasoning_content: "reasoning-a" }), chatChunk({ content: "partial answer" })],
        new Error("upstream socket reset mid-stream"),
    );

    await pipePluginChatWithStrip(first, makeRes(out), "openai", makeSession(), (m) => logs.push(m), undefined, "http://up");

    const meta = truncationMeta(out.join(""));
    assert.ok(meta, "the truncation frame carries a diag");
    assert.equal(meta["cause"], "read-error");
    assert.equal(meta["readError"], "Error: upstream socket reset mid-stream");
});
