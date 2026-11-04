import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// sglang (and other OpenAI-compatible servers) emit explicit nulls for every
// delta field, including "tool_calls": null on plain-text deltas:
//   {"delta":{"role":null,"content":"\n\n","reasoning_content":null,"tool_calls":null}}
// The pipe's sawToolUse check treated a present-but-null tool_calls as a tool
// call, so retryEmptyTurn (#732/#821) silently skipped the degenerate empty
// stop (thinking + stripped render tag + EOS) — the host saw the turn end
// cleanly with no output ("thinking stopped by itself", 5+ sessions, 2 days).
// Captured live (ring capture, 2026-10-31 09:08:56): the whole visible answer
// was "\n\n" + <acp tokens="886" type="text">m03692</acp> split across six
// content deltas, each carrying tool_calls: null.

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

function sglangChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen3.8-27b", choices: [{ index: 0, delta, logprobs: null, finish_reason: null, matched_stop: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function sglangStop(): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen3.8-27b", choices: [{ index: 0, delta: { reasoning_content: null }, logprobs: null, finish_reason: "stop", matched_stop: 248046 }] })}\n\n`;
}

/** Byte-for-byte replay of the live-captured degenerate turn: 411 reasoning
 *  tokens (trimmed here), then "\n\n", then the render tag split across six
 *  deltas — every content delta carries the sglang null field set. */
function capturedDegenerateTurn(): string[] {
    return [
        sglangChunk({ role: "assistant", content: null, reasoning_content: "I should keep the answer concise.", tool_calls: null }),
        sglangChunk({ role: null, content: "\n\n", reasoning_content: null, tool_calls: null }, { usage: null }),
        sglangChunk({ role: null, content: '<acp tokens="8', reasoning_content: null, tool_calls: null }),
        sglangChunk({ role: null, content: "8", reasoning_content: null, tool_calls: null }),
        sglangChunk({ role: null, content: "6", reasoning_content: null, tool_calls: null }),
        sglangChunk({ role: null, content: '" type="text">m', reasoning_content: null, tool_calls: null }),
        sglangChunk({ role: null, content: "0369", reasoning_content: null, tool_calls: null }),
        sglangChunk({ role: null, content: "2</acp>", reasoning_content: null, tool_calls: null }),
        sglangStop(),
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen3.8-27b", choices: [], usage: { prompt_tokens: 64132, total_tokens: 64568, completion_tokens: 436 } })}\n\n`,
        DONE,
    ];
}

async function runPipe(events: string[], refetch: (() => Promise<ReadableStream<Uint8Array> | null>) | undefined, chunks: string[]) {
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf(events) as ReadableStream<Uint8Array>,
        makeRes(chunks) as unknown as import("node:http").ServerResponse,
        "openai",
        makeSession(),
        (msg: string) => logs.push(msg),
        refetch,
    );
    return logs;
}

test("tool_calls:null deltas must not poison sawToolUse: degenerate stop retries (live-captured shape)", async () => {
    let refetchCalls = 0;
    const chunks: string[] = [];
    const logs = await runPipe(capturedDegenerateTurn(), async () => {
        refetchCalls += 1;
        return streamOf([
            sglangChunk({ role: "assistant", content: "the real answer" }),
            sglangStop(),
            DONE,
        ]);
    }, chunks);
    assert.equal(refetchCalls, 1, "the continuation nudge must re-issue the request once");
    assert.ok(logs.some((l) => l.includes("retrying once with a continuation nudge")), `expected the retry log, got: ${logs.join(" | ")}`);
    const out = chunks.join("");
    assert.ok(out.includes("the real answer"), "client must receive the retried answer");
    assert.ok(!out.includes('<acp tokens="8'), "the echoed render tag must stay stripped");
});

test("a real tool_calls delta still refuses the retry (null fix must not over-trigger)", async () => {
    let refetchCalls = 0;
    const chunks: string[] = [];
    const logs = await runPipe([
        sglangChunk({ role: "assistant", content: null, reasoning_content: "thinking", tool_calls: null }),
        sglangChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }),
        sglangStop(),
        DONE,
    ], async () => {
        refetchCalls += 1;
        return streamOf([sglangChunk({ content: "x" }), sglangStop(), DONE]);
    }, chunks);
    assert.equal(refetchCalls, 0, "a turn with a real tool call is not degenerate");
    assert.ok(!logs.some((l) => l.includes("retrying once")));
});
