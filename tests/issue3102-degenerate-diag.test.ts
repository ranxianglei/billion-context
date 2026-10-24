import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";
import { _resetConcurrentForwardsForTest, beginForward, endForward, otherForwardsInFlight } from "../src/concurrent-forwards.ts";

// #3102: two normal-budget first turns returned finish=length with zero visible
// chars, both concurrent with the dsh title-gen sidecar (#2503). The audit ruled
// out stream interleaving structurally (one socket per concurrent request), so
// the remaining suspects — budget burned in reasoning before any prose vs an
// upstream co-occurrence effect — were NOT observable from logs: the #2756
// refusal line reported only char counters. These tests pin the extended
// diagnostics: the line now carries the sniffed output/reasoning token split,
// the thinking flag, elapsed time, and the same-session in-flight forward count.

function makeSession(id = "testsess"): Session {
    return {
        id,
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

test("#3102 counter: per-session in-flight accounting excludes the caller's own forward", () => {
    _resetConcurrentForwardsForTest();
    assert.equal(otherForwardsInFlight("s1"), 0);
    beginForward("s1");
    assert.equal(otherForwardsInFlight("s1"), 0, "a single in-flight forward sees zero others");
    beginForward("s1");
    assert.equal(otherForwardsInFlight("s1"), 1, "a second same-session forward is visible");
    assert.equal(otherForwardsInFlight("s2"), 0, "other sessions are unaffected");
    endForward("s1");
    assert.equal(otherForwardsInFlight("s1"), 0);
    endForward("s1");
    assert.equal(otherForwardsInFlight("s1"), 0, "underflow clamps at zero instead of going negative");
});

test("#3102: a length-finish zero-visible turn reports token split, thinking flag, elapsed time, and sidecar concurrency", async () => {
    _resetConcurrentForwardsForTest();
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "dup" }), chatFinish("stop"), DONE]));
    };
    // Production shape: the relay wrapper counts the MAIN forward, the title-gen
    // sidecar adds a second entry while it is in flight.
    beginForward("testsess");
    beginForward("testsess");
    try {
        await pipePluginChatWithStrip(streamOf([
            chatChunk({ role: "assistant", reasoning_content: "planning the whole answer before writing any prose..." }),
            chatChunk({}, { usage: { prompt_tokens: 100, completion_tokens: 32768, completion_tokens_details: { reasoning_tokens: 32768 } } }),
            chatFinish("length"),
            DONE,
        ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    } finally {
        endForward("testsess");
        endForward("testsess");
    }
    assert.equal(refetches, 0, "finish=length is not a clean stop — never re-send those");
    const diag = logs.find((l) => l.includes("not retried") && l.includes("not a clean stop"));
    assert.ok(diag, "the refusal line exists");
    assert.ok(diag!.includes("outputTokens=32768"), `sniffed output tokens reported: ${diag}`);
    assert.ok(diag!.includes("reasoningTokens=32768"), `reasoning split reported (budget burned in thinking): ${diag}`);
    assert.ok(diag!.includes("sawThinking=true"), `thinking flag reported: ${diag}`);
    assert.ok(/elapsedMs=\d+/.test(diag!), `elapsed time reported: ${diag}`);
    assert.ok(diag!.includes("sessConcurrentForwards=1"), `concurrent same-session forward reported: ${diag}`);
});

test("#3102: with no other forward in flight the concurrency field reads zero", async () => {
    _resetConcurrentForwardsForTest();
    const out: string[] = [];
    const logs: string[] = [];
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => Promise.resolve(null);
    // The main forward counts itself; with no sidecar nothing else is in flight.
    beginForward("testsess");
    try {
        await pipePluginChatWithStrip(streamOf([
            chatChunk({ role: "assistant", content: "" }),
            chatFinish("length"),
            DONE,
        ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    } finally {
        endForward("testsess");
    }
    const diag = logs.find((l) => l.includes("not retried") && l.includes("not a clean stop"));
    assert.ok(diag, "the refusal line exists");
    assert.ok(diag!.includes("sessConcurrentForwards=0"), `no concurrency: ${diag}`);
    assert.ok(diag!.includes("reasoningTokens=?"), `absent usage field reports '?': ${diag}`);
});

test("#3102: anthropic message_delta thinking_tokens is captured as the reasoning split", async () => {
    _resetConcurrentForwardsForTest();
    const out: string[] = [];
    const logs: string[] = [];
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => Promise.resolve(null);
    const sse = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    await pipePluginChatWithStrip(streamOf([
        sse("message_start", { message: { id: "msg_1", role: "assistant", usage: { input_tokens: 100 } } }),
        sse("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32768, thinking_tokens: 32768 } }),
        sse("message_stop", {}),
    ]), makeRes(out), "anthropic", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const diag = logs.find((l) => l.includes("not retried") && l.includes("not a clean stop"));
    assert.ok(diag, "max_tokens is not a clean stop — the refusal line fires on the anthropic lane too");
    assert.ok(diag!.includes("outputTokens=32768"), `anthropic output tokens reported: ${diag}`);
    assert.ok(diag!.includes("reasoningTokens=32768"), `thinking split reported: ${diag}`);
});
