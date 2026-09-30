import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #1470: continuation-nudge recovery on the anthropic wire. An upstream
// truncation AFTER visible text reached the client used to fall through both
// retry gates (the blind retry needs zero visible output; the nudge gate was
// hard-coded openai-only) straight to the error exit, while the same shape on
// openai self-healed by continuing the partial answer. Post-#1464 the adapter
// safety nets (state-keyed message_start suppression, close-at-resume of the
// dead attempt's dangling blocks, monotonically increasing block indices) make
// the nudge re-fetch safe on anthropic too. Pinned here: (A) the truncated
// visible-text round recovers with one nudge re-fetch whose output stitches
// onto the forwarded prefix; (B) the one-shot budget holds — a second visible
// cut terminates on the protocol-native error channel with all blocks closed.

const ANTHROPIC_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };

function makeCtx(id: string): {
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
            blockContents: new Map<string, string>(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session,
        log: () => {},
    };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(c) {
            c.enqueue(enc.encode(text));
            c.close();
        },
    });
}

function ev(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START = ev("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude", usage: { input_tokens: 5 } },
});
const textStart = (i: number) => ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
const textDelta = (i: number, t: string) => ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } });
const blockStop = (i: number) => ev("content_block_stop", { type: "content_block_stop", index: i });
const toolUseBlock = (i: number, id: string, name: string, input: string) =>
    ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id, name } }) +
    ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: input } }) +
    blockStop(i);
const MESSAGE_DELTA = ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

// Round 1 completes with a proxy tool call → forces the in-loop re-request
// where the truncation happens (round 2).
const ROUND1_PROXY_TOOL = [MESSAGE_START, toolUseBlock(0, "toolu_1", "acp_status", "{}"), MESSAGE_DELTA, MESSAGE_STOP].join("");
// Re-request stream: visible text forwarded, then EOF — no completion event.
const TEXT_THEN_EOF = MESSAGE_START + textStart(0) + textDelta(0, "The answer starts here ");
// Nudge-retry stream: continues the answer, well-formed terminal. Its own
// message_start must be suppressed (already forwarded by the dead attempt).
const GOOD_ROUND2 = [MESSAGE_START, textStart(0), textDelta(0, "and continues after the cut."), blockStop(0), MESSAGE_DELTA, MESSAGE_STOP].join("");

async function drainAnthropic(
    first: string,
    attempts: string[],
    id: string,
): Promise<{ out: string; calls: number; bodies: Record<string, unknown>[] }> {
    const ctx = makeCtx(id);
    (ctx as unknown as Record<string, unknown>).protocol = "anthropic";
    let n = 0;
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        n += 1;
        if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(attempts[n - 1], { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            streamOf(first),
            ctx,
            ANTHROPIC_BODY,
            { url: "http://mock", headers: {} },
            createAnthropicAdapter(ANTHROPIC_BODY),
            buildCompressSystemPrompt(),
        )) chunks.push(chunk);
        return { out: Buffer.concat(chunks).toString("utf8"), calls: n, bodies };
    } finally {
        globalThis.fetch = realFetch;
    }
}

const sseBlocks = (s: string): string[] => s.split("\n\n").map((b) => b.trim()).filter(Boolean);

test("#1470 A: anthropic truncation after visible text recovers via the continuation nudge", async () => {
    const { out, calls, bodies } = await drainAnthropic(ROUND1_PROXY_TOOL, [TEXT_THEN_EOF, GOOD_ROUND2], "s1470a");
    assert.equal(calls, 2, "re-request + one nudge re-fetch");
    assert.ok(out.includes("The answer starts here"), "forwarded prefix survives");
    assert.ok(out.includes("and continues after the cut."), "retry output stitches on");
    // Exactly one response-identity frame across the dead attempt + retry.
    assert.equal((out.match(/event: message_start/g) ?? []).length, 1, "single message_start");
    // Three blocks on the wire: idx0 = the re-injected proxy-tool result,
    // idx1 = the dead attempt's text, idx2 = the retry's continuation. All
    // closed; the dead attempt's dangling block (idx1) is closed BEFORE the
    // retry's block opens at the next higher index.
    const starts = sseBlocks(out).filter((b) => b.startsWith("event: content_block_start"));
    const stops = sseBlocks(out).filter((b) => b.startsWith("event: content_block_stop"));
    assert.equal(starts.length, 3);
    assert.equal(stops.length, 3);
    assert.ok(starts[0].includes('"index":0'));
    assert.ok(starts[1].includes('"index":1'));
    assert.ok(starts[2].includes('"index":2'), "retry block continues at a higher index");
    assert.ok(stops[1].includes('"index":1'));
    const blocks = sseBlocks(out);
    assert.ok(blocks.indexOf(stops[1]) < blocks.indexOf(starts[2]), "dangling block closed before the retry resumes");
    // The recovery really is the nudge: the retry request quotes the tail.
    assert.equal(bodies.length, 2);
    assert.ok(!JSON.stringify(bodies[0]).includes("cut off mid-transmission"));
    const retryMsgs = JSON.stringify(bodies[1]);
    assert.ok(retryMsgs.includes("cut off mid-transmission"), "nudge present in retry body");
    assert.ok(retryMsgs.includes("The answer starts here"), "forwarded tail quoted in nudge");
});

test("#1470 B: exhausted anthropic nudge retries terminate on the protocol-native error channel", async () => {
    const { out, calls } = await drainAnthropic(ROUND1_PROXY_TOOL, [TEXT_THEN_EOF, TEXT_THEN_EOF], "s1470b");
    assert.equal(calls, 2, "continuation budget is one-shot");
    const blocks = sseBlocks(out);
    assert.ok(blocks[blocks.length - 1].startsWith("event: error"), "last block is the native error");
    assert.ok(blocks[blocks.length - 1].includes("upstream_error"));
    assert.doesNotMatch(out, /event: message_(stop|delta)/, "no synthesized completion frames");
    const starts = blocks.filter((b) => b.startsWith("event: content_block_start"));
    const stops = blocks.filter((b) => b.startsWith("event: content_block_stop"));
    assert.equal(starts.length, stops.length, "every opened block is closed");
});
