import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #156: a small model (2B, Codex+Responses) retried the SAME failed compress
// range with the SAME validation error for all 10 loop rounds — every retry a
// real upstream call. The loop now short-circuits after two consecutive
// IDENTICAL failures (same refs + same error class) and completes gracefully.

interface CtxFixture {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
}

function makeCtx(messages: CoreMessage[] = []): CtxFixture {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "compress-shortcircuit-test",
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

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });
const SYS_PROMPT = buildCompressSystemPrompt();

/** A round whose only call is a compress that deterministically FAILS:
 * makeCtx() has no ref map, so the kernel resolves 0 blocks for any refs. */
function failingCompressRound(callId: string, startId: string, endId: string): string {
    return [
        sse("response.created", { response: { id: `resp_${callId}`, status: "in_progress" } }),
        fcEvents(0, callId, "compress", JSON.stringify({ content: [{ startId, endId, summary: "s" }] })),
        COMPLETED,
    ].join("");
}

/** Mock the loop's re-request fetch: each call plays back streams[i] in order. */
function reFetchScript(streams: string[]): { calls: () => number; restore: () => void } {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        const body = streams[Math.min(n, streams.length - 1)];
        n++;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { calls: () => n, restore: () => { globalThis.fetch = orig; } };
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: CtxFixture): Promise<string> {
    const chunks: Buffer[] = [];
    const gen = runCompressLoop(
        stream,
        ctx,
        { model: "gpt-4o", input: [], stream: true },
        { url: "http://mock", headers: {} },
        createResponsesAdapter(),
        SYS_PROMPT,
    );
    for await (const chunk of gen) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

test("#156: identical compress failure twice → short-circuit, no third re-request", async () => {
    // Round 1 (initial stream) fails on m00001..m00002; re-fetch round 2 fails
    // IDENTICALLY (same refs, same error — numbers may differ, e.g. char counts).
    const round2 = failingCompressRound("refetch_1", "m00001", "m00002").replace("resp_refetch_1", "resp_refetch_2");
    const probe = reFetchScript([round2]);
    try {
        const out = await drain(new Response(failingCompressRound("round1", "m00001", "m00002"), { status: 200 }).body!, makeCtx());
        assert.equal(probe.calls(), 1, "exactly ONE re-request: the second identical failure completes the loop");
        assert.ok(out.includes("[ACP]"), "failure markers still surfaced to the client");
        assert.match(out, /event: response\.completed/, "graceful completion, not an error");
    } finally {
        probe.restore();
    }
});

test("#156: DIFFERENT failure signature → loop keeps going (no premature short-circuit)", async () => {
    // Round 1 fails on m00001..m00002, round 2 fails on m00003..m00004 (the
    // model varied its range — still trying), round 3 completes cleanly.
    const probe = reFetchScript([
        failingCompressRound("refetch_1", "m00003", "m00004"),
        sse("response.created", { response: { id: "resp_clean", status: "in_progress" } }) + COMPLETED,
    ]);
    try {
        const out = await drain(new Response(failingCompressRound("round1", "m00001", "m00002"), { status: 200 }).body!, makeCtx());
        assert.equal(probe.calls(), 2, "two re-requests: distinct failures keep the loop alive until a clean round");
        assert.match(out, /event: response\.completed/, "graceful completion");
    } finally {
        probe.restore();
    }
});

test("#156: 0-ranges failure carries actionable guidance (acp_status pointer)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        // content is a non-JSON string → parseCompressInput yields 0 ranges
        fcEvents(0, "call_g", "compress", JSON.stringify({ content: "not json" })),
        COMPLETED,
    ].join("");
    const probe = reFetchScript([sse("response.created", { response: { id: "resp_clean", status: "in_progress" } }) + COMPLETED]);
    try {
        const out = await drain(new Response(round1, { status: 200 }).body!, makeCtx());
        assert.ok(out.includes("no valid ranges"), "0-ranges failure surfaced");
        assert.ok(out.includes("acp_status"), "failure tells the model how to recover (run acp_status)");
        assert.match(out, /event: response\.completed/, "graceful completion");
    } finally {
        probe.restore();
    }
});
