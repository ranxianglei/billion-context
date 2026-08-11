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
const PROMPT_NEEDLE = "COMPRESSION";

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
// active block is created and hideConsumed has something to keep.
function bigText(n: number): string {
    return "x".repeat(n);
}

// The compress loop does not run the kernel's ref-assignment pipeline (the proxy
// runs processTurn once per client turn, BEFORE the loop). To create a REAL block
// (so hideConsumed has an active compressCallId to keep), the ref map must be
// pre-populated — otherwise resolveBoundaries finds nothing and no block is created.
function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

const COMPLETED_USAGE = sse("response.completed", {
    response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 42, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } } },
});

test("loop #3: compress round → re-request happens, result fed back, marker shown", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    const round2 = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Compressed." }),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(round2, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 1, "exactly one re-request after mutating compress");
        assert.ok(out.includes("[ACP]"), "compress marker shown");
        assert.ok(out.includes("Compressed."), "round 2 content (result fed back) reached client");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #4: decompress round → re-request happens", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_d", "decompress", JSON.stringify({ blockId: "b0" })),
        COMPLETED,
    ].join("");
    const round2 = [
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Done." }),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(round2, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 1, "exactly one re-request after mutating decompress");
        assert.ok(out.includes("[ACP]"), "decompress marker shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #6: philosophy systemPrompt is transient — appears exactly once per round body (not accumulated)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    const round2 = [
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Done." }),
        COMPLETED,
    ].join("");
    const forwardedBodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        forwardedBodies.push(String(init?.body));
        return new Response(round2, { status: 200 });
    }) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(forwardedBodies.length, 1, "one re-request body captured");
        const body = forwardedBodies[0];
        const occurrences = (body.match(new RegExp(PROMPT_NEEDLE, "g")) || []).length;
        const promptOcc = (body.match(/COMPRESSION PHILOSOPHY|context management serves/gi) || []).length;
        assert.ok(promptOcc >= 1 || occurrences >= 1, "philosophy prompt present in round-2 body");
        const needleCount = (body.match(/PRIORITY/g) || []).length;
        const sysMarkerCount = (body.match(/"role":"developer"/g) || []).length;
        assert.equal(sysMarkerCount, 1, "philosophy injected as exactly ONE developer message (transient, not accumulated)");
        assert.ok(needleCount < 50, "philosophy not duplicated excessively");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #7: successful compress KEEPS the active record in round 2 (B2: compressCallId threading prevents re-compress loop)", async () => {
    // Real messages with IDs => applyCompression creates an ACTIVE block whose
    // compressCallId matches the live call => hideConsumed keeps the record.
    // Without B2 the block's compressCallId is undefined, the record is hidden,
    // and the model re-compresses (the 炸锅 loop class).
    // 7 messages: kernel protects the last 5, so m00001/m00002 (the oldest pair)
    // are compressible; a 2-message corpus would be entirely protected.
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
    const round2 = [
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Done." }),
        COMPLETED,
    ].join("");
    let forwardedBody: string | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        forwardedBody = String(init?.body);
        return new Response(round2, { status: 200 });
    }) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(forwardedBody, "round-2 body captured");
        assert.ok(
            /"name"\s*:\s*"compress"/.test(forwardedBody!),
            "active compress function_call KEPT in round-2 body (B2: compressCallId threading)",
        );
        assert.ok(
            forwardedBody!.includes("PAIR-SUMMARY-PAYLOAD"),
            "compress arguments preserved in round-2 body (B1: tool-call args not dropped)",
        );
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #8 (B3): textProtocol compress round → round-2 body has NO function_call items (marker user message instead)", async () => {
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
    const round2 = [
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Done." }),
        COMPLETED,
    ].join("");
    let forwardedBody: string | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        forwardedBody = String(init?.body);
        return new Response(round2, { status: 200 });
    }) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(true),
        );
        assert.ok(forwardedBody, "round-2 body captured");
        assert.ok(
            !/"type"\s*:\s*"function_call"/.test(forwardedBody!),
            "NO function_call items in textProtocol round-2 body (B3: code_mode compatibility)",
        );
        assert.ok(forwardedBody!.includes("[ACP]"), "visibility marker present as user-role text");
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
    const round2 = [
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Done." }),
        COMPLETED_USAGE,
    ].join("");
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(round2, { status: 200 })) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(ctx.session.stats.lastInputTokens > 0, "lastInputTokens populated from response.completed usage (S2)");
    } finally {
        globalThis.fetch = orig;
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

test("loop #11: textProtocol compress WITH text → no re-request (silent compress, prevents task interruption)", async () => {
    const ctx = makeCtx([
        textMsg("m00001", "user", "hello"),
        textMsg("m00002", "assistant", "hi"),
    ]);
    ctx.textProtocol = true;
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    const trigger = `\x3cacp_compress\x3e${compressArgs}\x3c/acp_compress\x3e`;
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "Here is your result." }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: trigger }),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(COMPLETED, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(true),
        );
        assert.equal(fetchCalls, 0, "NO upstream re-request for textProtocol compress-with-text");
        assert.ok(out.includes("Here is your result."), "model text delivered to client (trigger stripped)");
    } finally {
        globalThis.fetch = orig;
    }
});
