import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #4913: when the one-shot continuation retry (#732/#821) also ends with zero
// usable output, the chat pipe emits the #870 in-band error. The fatal log
// line must name the signals that qualified (sawThinking/sawStrippedEcho/
// releasedMarkupChars/draftTail) plus the retry's own finish reason, so
// "again after the retry" is attributable instead of an opaque verdict.

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

test("chat pipe: double-degenerate turn keeps the #870 error and names its qualifying signals (#4913)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    // Pass 2 has the same thinking-only shape as pass 1: nothing usable again.
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ role: "assistant", reasoning_content: "second attempt: still only thinking" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", reasoning_content: "first attempt: thinking only" }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "the one-shot continuation retry fires on the first degenerate pass");
    assert.ok(body.includes("the turn degenerated again after the continuation nudge"), "the #870 in-band error still reaches the client");
    const fatal = logs.find((l) => l.includes("again after the retry"));
    assert.ok(fatal, "the fatal outcome is logged");
    assert.ok(fatal!.includes("sawThinking=true"), "the qualifying signal is named (thinking present on this wire)");
    assert.ok(fatal!.includes("sawStrippedEcho=false"), "the echo flag rides the line");
    assert.ok(fatal!.includes("releasedMarkupChars=0"), "the markup counter rides the line");
    assert.ok(fatal!.includes("draftTail=false"), "the draft-tail flag rides the line");
    assert.ok(fatal!.includes("finishReason=stop"), "the retry's own finish reason rides the line");
});

test("chat pipe: released-markup first pass names a non-zero markup counter on the fatal line (#4913)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ role: "assistant", reasoning_content: "retry: thinking only" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    // Pass 1 delivers only a render-tag interior ("pre" held back by an unclosed
    // <acp> open, whitespace folded): released markup, no answer prose — the
    // #2769 item-3 shape that qualifies the retry via releasedMarkupChars.
    await pipePluginChatWithStrip(streamOf([
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { role: "assistant", content: `pre\x3cacp\x3e    ` }, finish_reason: "stop" }] })}\n\n`,
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    assert.equal(refetches, 1, "the released-markup shape spends the one-shot retry");
    const fatal = logs.find((l) => l.includes("again after the retry"));
    assert.ok(fatal, "the fatal outcome is logged");
    const m = /releasedMarkupChars=(\d+)/.exec(fatal!);
    assert.ok(m && Number(m[1]) > 0, "the first pass's released markup is attributed on the fatal line");
    assert.ok(fatal!.includes("sawThinking=true"), "the retry's own thinking is visible in the cumulative signal");
});
