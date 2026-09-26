import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import type { Config, CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createOpenaiAdapter, runCompressLoop } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

const enc = new TextEncoder();
const sseChunk = (delta: Record<string, unknown>, finishReason?: string) =>
    enc.encode(
        `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt",
            choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
        })}\n\n`,
    );

const mockStream = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.enqueue(enc.encode(`data: [DONE]\n\n`));
            controller.close();
        },
    });

const collect = async (stream: ReadableStream<Uint8Array>) => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);
    return events;
};

function makeLoopCtx(): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (message: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [],
        session: {
            id: "openai-in-band-error-loop",
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
        protocol: "openai",
    };
}

// 1. An in-band error frame must not be ignored as a choices-less usage frame.
test("openai adapter: in-band error is surfaced and does not become empty stop", async () => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { code: "server_is_overloaded", message: "busy" } })}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    const events = await collect(stream);
    assert.deepEqual(events, [{ kind: "error", message: "server_is_overloaded: busy" }]);
});

// The adapter-level test above proves parsing; this loop-level test proves the
// error cannot become a synthetic successful completion at the client boundary.
test("openai loop: in-band error emits protocol error without completion", async () => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { code: "server_is_overloaded", message: "busy" } })}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    const originalFetch = globalThis.fetch;
    let retryFetches = 0;
    globalThis.fetch = (async () => {
        retryFetches++;
        return new Response(`data: ${JSON.stringify({ error: { code: "server_is_overloaded", message: "busy" } })}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            stream,
            makeLoopCtx(),
            { model: "gpt", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "gpt" }),
            buildCompressSystemPrompt(),
        )) chunks.push(chunk);
        const output = Buffer.concat(chunks).toString("utf8");
        assert.equal(retryFetches, 1, "zero-byte in-band errors get the existing single invisible retry");
        assert.match(output, /server_is_overloaded: busy/);
        assert.match(output, /\[acp-proxy: upstream stream truncated/);
        assert.match(output, /\[DONE\]/);
        assert.doesNotMatch(output, /no completion event/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// 2. Non-compliant upstream: tool_calls + finish_reason="stop" → passthrough
//    (real tool_call chunks are forwarded verbatim as meta; finish_reason kept as-is).
test("openai adapter: real tool_calls passed through verbatim (meta)", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
            ],
        }),
        sseChunk({}, "stop"),
    );
    const events = await collect(stream);
    const metas = events.filter((e) => e.kind === "meta");
    assert.ok(metas.length >= 2, "tool_call + finish_reason chunks passed through as meta");
    const toolCallMetas = metas.filter((m) => m.kind === "meta" && m.chunk.toString().includes("get_weather"));
    assert.ok(toolCallMetas.length >= 1, "the raw tool_call chunk itself is replayed verbatim");
    const passthrough = events.find((e) => e.kind === "tool_call");
    assert.ok(passthrough?.kind === "tool_call" && passthrough.name === "get_weather" && passthrough.passthrough === true, "structured passthrough event so the loop counts it as a real call");
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "done event present");
    assert.equal(done!.finishReason, "stop", "finish_reason preserved as-is from upstream");
    assert.equal(done!.suppressCompletion, true, "no regenerated completion after the verbatim replay");
});

// 3. Compliant upstream: tool_calls + finish_reason="tool_calls" → unchanged.
test("openai adapter: compliant finish_reason=tool_calls left unchanged", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
            ],
        }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
});

// 4. No tool_calls + finish_reason="stop" → unchanged (normal text completion).
test("openai adapter: text-only finish_reason=stop left unchanged", async () => {
    const stream = mockStream(sseChunk({ role: "assistant" }), sseChunk({ content: "hello" }), sseChunk({}, "stop"));
    const events = await collect(stream);
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "stop");
});

// 5. REGRESSION (SGLang/vLLM name-splitting): the tool NAME arrives in the
//    first delta and continuation deltas carry EMPTY names. A proxy tool
//    (compress) split this way must be accumulated and handed to the compress
//    loop as a structured event — the client must never see an empty-name
//    fragment (hermes: "Unknown tool ''" → retry loop → partial stop).
test("openai adapter: name-split proxy tool never leaks to the client", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: "" } },
            ],
        }),
        sseChunk({
            tool_calls: [
                { index: 0, function: { name: "", arguments: '{"content":[{"startId":"m2"' } },
            ],
        }),
        sseChunk({
            tool_calls: [
                { index: 0, function: { name: "", arguments: ',"endId":"m9"}]}' } },
            ],
        }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    assert.equal(structured.length, 1, "exactly one structured tool_call for the compress loop");
    const tc = structured[0];
    assert.ok(tc?.kind === "tool_call");
    assert.equal(tc.name, "compress", "name accumulated across the split deltas");
    assert.equal(tc.callId, "call_c");
    assert.equal(tc.arguments, '{"content":[{"startId":"m2","endId":"m9"}]}', "arguments concatenated");
    const leaked = events.filter((e) => e.kind === "meta" && e.chunk.toString().includes("compress"));
    assert.equal(leaked.length, 0, "no raw fragment carrying the proxy tool leaks to the client");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
    assert.notEqual(done?.kind === "done" && done.suppressCompletion, true, "proxy round: completion NOT suppressed (loop re-requests)");
});

// 6. Name-split REAL tool: fragments must accumulate and replay with the
//    original chunk order/ids, exactly like the single-fragment case.
test("openai adapter: name-split real tool accumulates and replays verbatim", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "get_wea", arguments: "" } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { name: "ther", arguments: "{}" } }] }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    const tc = structured[0];
    assert.ok(tc?.kind === "tool_call");
    assert.equal(tc.name, "get_weather", "name fragments concatenated");
    assert.equal(tc.passthrough, true);
    const replay = events.filter((e) => e.kind === "meta" && e.chunk.toString().includes("tool_calls"));
    assert.ok(replay.length >= 2, "both raw fragments replayed to the client");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
});

// 7. Mixed round (compress + real bash in the same turn): the replay must
//    contain ONLY the real call's fragments; the compress call goes to the
//    loop as a structured event for server-side execution.
test("openai adapter: mixed proxy+real round strips proxy fragments from the replay", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: "{}" } }] }),
        sseChunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "bash", arguments: "{\"c\":\"ls\"}" } }] }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    assert.equal(structured.length, 2);
    const byName = new Map(structured.map((e) => (e.kind === "tool_call" ? [e.name, e] : ["", e])));
    const compress = byName.get("compress");
    const bash = byName.get("bash");
    assert.ok(compress?.kind === "tool_call" && compress.passthrough !== true, "compress handled server-side (no passthrough)");
    assert.ok(bash?.kind === "tool_call" && bash.passthrough === true, "bash forwarded to the client");
    const replayText = events
        .filter((e) => e.kind === "meta")
        .map((e) => (e.kind === "meta" ? e.chunk.toString() : ""))
        .join("");
    assert.ok(replayText.includes("bash"), "bash fragment replayed");
    assert.ok(!replayText.includes("compress"), "compress fragment stripped from the replay");
});

// 8. REGRESSION (#1306): the FINAL arguments fragment arrives in the SAME chunk
//    as finish_reason. Pre-fix, the finish settle ran before this frame's
//    fragment was absorbed: the proxy call flushed with truncated/empty
//    arguments, pending was cleared, the post-finish fallthrough re-buffered
//    the fragment as a nameless orphan, and the [DONE] settle dropped it —
//    compress executed with {} → missing-content → #156 identical-failure
//    early break. The settle must see the complete accumulated state.
test("openai adapter: proxy tool args sharing the finish_reason chunk are not lost (#1306)", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: "" } },
            ],
        }),
        sseChunk(
            {
                tool_calls: [
                    { index: 0, function: { name: "", arguments: '{"content":[{"startId":"m2","endId":"m9"}]}' } },
                ],
            },
            "tool_calls",
        ),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    assert.equal(structured.length, 1, "exactly one structured tool_call for the compress loop");
    const tc = structured[0];
    assert.ok(tc?.kind === "tool_call");
    assert.equal(tc.name, "compress");
    assert.equal(tc.callId, "call_c");
    assert.equal(tc.arguments, '{"content":[{"startId":"m2","endId":"m9"}]}', "same-frame arguments reach the settle intact");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
});

// 9. Same-frame shape for a REAL tool: the passthrough bookkeeping event must
//    carry complete arguments AND the frame's raw chunk must replay exactly
//    once (absorbing before the settle must not duplicate the replay).
test("openai adapter: real tool args sharing the finish_reason chunk — complete args, single replay (#1306)", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "get_weather", arguments: "" } }] }),
        sseChunk(
            { tool_calls: [{ index: 0, function: { name: "", arguments: '{"city":"SF"}' } }] },
            "tool_calls",
        ),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    assert.equal(structured.length, 1);
    const tc = structured[0];
    assert.ok(tc?.kind === "tool_call");
    assert.equal(tc.arguments, '{"city":"SF"}', "passthrough bookkeeping sees complete arguments");
    assert.equal(tc.passthrough, true);
    const replay = events
        .filter((e) => e.kind === "meta")
        .map((e) => (e.kind === "meta" ? e.chunk.toString() : ""));
    const sameFrame = replay.filter((s) => s.includes("SF"));
    assert.equal(sameFrame.length, 1, "the same-frame fragment replays exactly once");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
});

// 10. Loop-level (#1306): a same-frame upstream turn reaches the proxy
//     compress tool with FULL arguments and actually compresses — the visible
//     symptom was kind=missing-content (args parsed to {}) followed by the
//     repeated-identical-failure early break.
test("openai loop: same-frame compress args execute, not missing-content (#1306)", async () => {
    const ctx = makeLoopCtx();
    ctx.messages = Array.from({ length: 12 }, (_, i): CoreMessage => ({
        id: `a${i + 1}`,
        role: i % 2 === 0 ? "user" : "assistant",
        contentType: "text",
        text: `msg-${i + 1}-` + "x".repeat(6000),
    }));
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;

    const round1 = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: "" } }] }),
        sseChunk(
            { tool_calls: [{ index: 0, function: { name: "", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00006", summary: "The user and assistant worked through the initial setup steps and early exchanges in detail." }] }) } }] },
            "tool_calls",
        ),
    );
    const originalFetch = globalThis.fetch;
    let refetches = 0;
    globalThis.fetch = (async () => {
        refetches++;
        return new Response(
            `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { status: 200 },
        );
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            round1,
            ctx,
            { model: "gpt", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "gpt" }),
            buildCompressSystemPrompt(),
        )) chunks.push(chunk);
        const output = Buffer.concat(chunks).toString("utf8");
        assert.match(output, /Compressed m00001/, "same-frame compress actually compressed");
        assert.doesNotMatch(output, /missing-content/);
        assert.equal(refetches, 1, "one re-request after the proxy tool executed");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
