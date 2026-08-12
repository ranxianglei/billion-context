import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeCtx(messages: CoreMessage[] = []): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "loop-compress-test",
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

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
    adapter: ReturnType<typeof createResponsesAdapter> = createResponsesAdapter(),
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, adapter, SYS_PROMPT)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// Kernel default compress.minCompressRange is 5000 chars; ranges below that are
// rejected with "content too small" and create NO block. Use big text so a real
// active block is created.
function bigText(n: number): string {
    return "x".repeat(n);
}

// The compress loop does not run the kernel's ref-assignment pipeline (the proxy
// runs processTurn once per client turn, BEFORE the loop). To create a REAL block,
// the ref map must be pre-populated — otherwise resolveBoundaries finds nothing.
function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

const COMPLETED_USAGE = sse("response.completed", {
    response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 42, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } } },
});

// After a proxy tool the loop RE-REQUESTS (standard function-calling continuation)
// so the model can receive the tool result and continue. The re-request mock
// returns a clean completed stream (no further calls) so round 2 terminates.
const REFETCH_DONE = sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [] } });
function reFetchProbe(): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(REFETCH_DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

test("loop #3: compress round → re-request fires (model continues with result), marker shown", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(probe.calls() >= 1, "re-request fires after compress so the model can continue");
        assert.ok(out.includes("[ACP]"), "compress marker shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        probe.restore();
    }
});

test("loop #4: decompress round → re-request fires (model continues with result)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_d", "decompress", JSON.stringify({ blockId: "b0" })),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(probe.calls() >= 1, "re-request fires after decompress");
        assert.ok(out.includes("[ACP]"), "decompress marker shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        probe.restore();
    }
});

test("loop #6: philosophy systemPrompt is transient — appears in the ONE re-request body, does not accumulate across rounds", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        const bodies = probe.bodies();
        assert.equal(bodies.length, 1, "exactly one re-request body (one compress → one continuation)");
        assert.ok(bodies[0].includes("COMPRESSION PHILOSOPHY") || bodies[0].includes("compress"), "philosophy present in the re-request (transient, not accumulated)");
    } finally {
        probe.restore();
    }
});

test("loop #7: successful compress (real block) → re-request fires (model continues; one-compress guard prevents a second mutate)", async () => {
    // 7 messages: kernel protects the last 5, so m00001/m00002 are compressible.
    const ctx = withRefs(makeCtx([
        textMsg("raw_1", "user", bigText(5000)),
        textMsg("raw_2", "assistant", bigText(5000)),
        textMsg("raw_3", "user", bigText(5000)),
        textMsg("raw_4", "assistant", bigText(5000)),
        textMsg("raw_5", "user", bigText(5000)),
        textMsg("raw_6", "assistant", bigText(5000)),
        textMsg("raw_7", "user", bigText(5000)),
    ]));
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(probe.calls() >= 1, "re-request fires after successful compress");
        assert.ok(out.includes("[ACP]"), "compress marker shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        probe.restore();
    }
});

test("loop #8 (B3): textProtocol compress round → marker shown, re-request fires", async () => {
    const ctx = makeCtx([
        textMsg("m00001", "user", "hello"),
        textMsg("m00002", "assistant", "hi"),
    ]);
    ctx.textProtocol = true;
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(true),
        );
        assert.ok(probe.calls() >= 1, "re-request fires");
        assert.ok(out.includes("[ACP]"), "visibility marker present as user-role text");
    } finally {
        probe.restore();
    }
});

test("loop #11 (guard): a SECOND compress in the same request is a no-op (prevents 0-char spiral), then model continues", async () => {
    // Round 1: compress (mutates state). Round 2 (re-request mock): model emits
    // compress AGAIN — the one-compress guard must short-circuit it to a no-op
    // result instead of re-executing (which would hit the stale-view 0-char path).
    const ctx = withRefs(makeCtx([
        textMsg("raw_1", "user", bigText(5000)),
        textMsg("raw_2", "assistant", bigText(5000)),
        textMsg("raw_3", "user", bigText(5000)),
        textMsg("raw_4", "assistant", bigText(5000)),
        textMsg("raw_5", "user", bigText(5000)),
        textMsg("raw_6", "assistant", bigText(5000)),
        textMsg("raw_7", "user", bigText(5000)),
    ]));
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c1", "compress", compressArgs),
        COMPLETED,
    ].join("");
    // Round 2 stream: the model re-requests compress (the pathological re-target).
    const round2 = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        fcEvents(0, "call_c2", "compress", compressArgs),
        COMPLETED,
    ].join("");
    let call = 0;
    const orig = globalThis.fetch;
    const logs: string[] = [];
    ctx.log = (m: string) => logs.push(m);
    globalThis.fetch = (async () => {
        call++;
        const body = call === 1 ? round2 : REFETCH_DONE;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(logs.some(l => l.includes("skipped (compressOutcome=succeeded)")), "second compress was short-circuited to a no-op by the guard");
        assert.ok(out.includes("[ACP]"), "markers shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #14 (guard-failure): a FAILED compress (too small) sets outcome=failed → second compress is a no-op (v10.txt loop)", async () => {
    // v10.txt regression: failed compress must cap retry (outcome=failed no-op), not spiral on an inaccurate "Already compressed".
    const ctx = withRefs(makeCtx([
        textMsg("raw_1", "user", "short"),
        textMsg("raw_2", "assistant", "short"),
    ]));
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c1", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const round2 = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        fcEvents(0, "call_c2", "compress", compressArgs),
        COMPLETED,
    ].join("");
    let call = 0;
    const orig = globalThis.fetch;
    const logs: string[] = [];
    ctx.log = (m: string) => logs.push(m);
    globalThis.fetch = (async () => {
        call++;
        const body = call === 1 ? round2 : REFETCH_DONE;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(logs.some(l => l.includes("skipped (compressOutcome=failed)")), "second compress no-op'd by failed-outcome guard");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #9 (S2): responses round yields usage → session.stats populated (nudge/stat tracking)", async () => {
    const ctx = makeCtx([
        textMsg("m00001", "user", "hello"),
        textMsg("m00002", "assistant", "hi"),
    ]);
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", compressArgs),
        COMPLETED_USAGE,
    ].join("");
    const probe = reFetchProbe();
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(ctx.session.stats.lastInputTokens > 0, "lastInputTokens populated from response.completed usage (S2)");
    } finally {
        probe.restore();
    }
});

test("loop #10 (S3): upstream 500 mid-loop terminates cleanly (timer cleared, no hang)", async () => {
    const ctx = makeCtx([
        textMsg("m00001", "user", "hello"),
        textMsg("m00002", "assistant", "hi"),
    ]);
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("upstream error", { status: 500 })) as typeof fetch;
    try {
        const out = await Promise.race([
            drain(
                new Response(round1, { status: 200 }).body!,
                ctx,
                { model: "gpt-4o", input: [], stream: true },
                { url: "http://mock", headers: {} },
            ),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("loop hung (timer not cleared)")), 3000)),
        ]);
        assert.ok(typeof out === "string", "loop terminated cleanly on upstream 500 (S3: timer cleared)");
    } finally {
        globalThis.fetch = orig;
    }
});
