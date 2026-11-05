// #3661: the model emits compress with non-JSON arguments (malformed or
// stream-truncated). bili correctly rejects the compression, but the loop's
// re-request replayed the model's ORIGINAL argument bytes into
// assistant.tool_calls — strict chat-template gateways crash server-side
// rendering of non-JSON arguments and 400 the whole continuation request, so
// the round dies before the model sees the rejection receipt and every
// recovery mechanism (breaker / nudge gating) strands behind a dead round.
// The re-request must carry guaranteed-valid JSON for proxy-tool calls:
// byte-exact when parseable, a self-describing placeholder otherwise.
// #4186: unsalvageable failures now end the turn BEFORE any re-request (the
// ephemeral failure frame never rides upstream — pinned in
// tests/issue1502-raw-args-salvage.test.ts), so the substitution below is
// exercised on salvage-SUCCESSFUL rounds: strict JSON.parse still fails on the
// raw bytes, but the kernel's lenient ladder recovers a real fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import type { Config, CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createOpenaiAdapter, runCompressLoop } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import type { WireProtocol } from "../src/util.ts";

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

function makeLoopCtx(): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (message: string) => void;
    protocol?: WireProtocol;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [],
        session: {
            id: "issue3661-loop",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            pendingRetrievals: [],
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

// Salvage-success geometry: refs m00001-m00012, target m00001-m00006 compressible,
// tail heavy enough to clear the protected recent zone (same shape as the gate
// negative below).
function salvageCtx(): ReturnType<typeof makeLoopCtx> {
    const ctx = makeLoopCtx();
    ctx.messages = Array.from({ length: 12 }, (_, i): CoreMessage => ({
        id: `a${i + 1}`,
        role: i % 2 === 0 ? "user" : "assistant",
        contentType: "text",
        text: `msg-${i + 1}-` + "x".repeat(6000),
    }));
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

// One round whose only output is a proxy compress call carrying `args`.
function compressCallStream(callId: string, args: string): ReadableStream<Uint8Array> {
    return mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "compress", arguments: "" } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { name: "", arguments: args } }] }, "tool_calls"),
    );
}

// Captures every re-request body (parsed) and answers with a clean stop so
// round 2 terminates.
function reFetchProbe(): { calls: () => number; bodies: () => Array<{ messages?: Array<Record<string, unknown>> }>; restore: () => void } {
    let n = 0;
    const bodies: Array<{ messages?: Array<Record<string, unknown>> }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return new Response(
            `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { status: 200 },
        );
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

function assistantToolArgs(body: { messages?: Array<Record<string, unknown>> }): string[] {
    return (body.messages ?? []).flatMap((m) => {
        if (m.role !== "assistant") return [];
        const tcs = m.tool_calls as Array<{ function?: { arguments?: string } }> | undefined;
        return (tcs ?? []).map((tc) => tc.function?.arguments ?? "");
    });
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeLoopCtx>): Promise<void> {
    for await (const _chunk of runCompressLoop(
        stream,
        ctx,
        { model: "gpt", stream: true },
        { url: "http://mock", headers: {} },
        createOpenaiAdapter({ model: "gpt" }),
        buildCompressSystemPrompt(),
    )) { /* client-bound chunks not under test */ }
}

test("#3661 form 1: malformed compress args are NOT echoed verbatim — re-request replays a valid-JSON placeholder", async () => {
    // Trailing comma: strict JSON.parse fails (premise) but the kernel's lenient
    // ladder salvages a real fold, so the round succeeds and the re-request still
    // fires — the only shape that can exercise the substitution under #4186.
    const malformed = '{"content":[{"startId":"m00001","endId":"m00006","summary":"' + "salvaged-range-summary-long-enough-for-the-kernel-min-length-check" + '"}],}';
    assert.throws(() => JSON.parse(malformed), "premise: strict JSON.parse really fails");
    const probe = reFetchProbe();
    try {
        await drain(compressCallStream("call_c", malformed), salvageCtx());
        assert.equal(probe.calls(), 1, "one re-request after the salvaged compress executed");
        const body = probe.bodies()[0]!;
        const args = assistantToolArgs(body);
        assert.equal(args.length, 1, "the compress tool-call rides the re-request");
        assert.ok(args[0]!.includes("non-JSON tool-call arguments"), "placeholder explains the substitution to the model");
        for (const a of args) JSON.parse(a);
        // The summary TEXT legitimately rides the wire (block carrier + receipt
        // head/tail) — the invariant is that the RAW MALFORMED SKELETON (the
        // trailing-comma byte sequence) does not.
        assert.ok(!JSON.stringify(body).includes('"],}'), "raw malformed bytes do not reach the wire");
        const receipts = (body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
        assert.ok(receipts.some((r) => /Compressed m00001/.test(r)), "the successful compression result reaches the model");
    } finally {
        probe.restore();
    }
});

test("#3661 form 2: stream-truncated compress args (unclosed JSON) are replaced the same way", async () => {
    // Stream cut landing right after the range item's closing brace: the outer
    // containers stay unclosed so strict JSON.parse fails, but the item is
    // complete and the kernel's truncated ladder salvages it (an unterminated
    // value or un-closed item is rejected as unrecoverable by design) — same
    // substitution surface as form 1, via the salvage-success path under #4186.
    const truncated = '{"content":[{"startId":"m00001","endId":"m00006","summary":"' + "y".repeat(300) + '"}';
    assert.throws(() => JSON.parse(truncated), "premise: strict JSON.parse really fails");
    const probe = reFetchProbe();
    try {
        await drain(compressCallStream("call_t", truncated), salvageCtx());
        assert.equal(probe.calls(), 1, "one re-request after the salvaged compress executed");
        const body = probe.bodies()[0]!;
        const args = assistantToolArgs(body);
        assert.equal(args.length, 1, "the compress tool-call rides the re-request");
        assert.ok(args[0]!.includes("non-JSON tool-call arguments"), "placeholder replaces the truncated bytes");
        for (const a of args) JSON.parse(a);
        // Summary TEXT legitimately rides the wire (block carrier + receipt
        // head/tail) — the invariant is that the RAW MALFORMED SKELETON does not.
        assert.ok(!JSON.stringify(body).includes('{"content":[{"startId":"m00001"'), "truncated raw payload does not reach the wire");
        const receipts = (body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
        assert.ok(receipts.some((r) => /Compressed m00001/.test(r)), "the successful compression result reaches the model");
    } finally {
        probe.restore();
    }
});

// Gate negative (#3617 discipline): well-formed arguments must ride back
// byte-exact — the substitution must NOT fire for valid JSON (wire fidelity).
test("#3661 gate negative: well-formed compress args replay byte-exact (no placeholder)", async () => {
    const ctx = salvageCtx();
    const legal = JSON.stringify({ content: [{ startId: "m00001", endId: "m00006", summary: "The early setup exchanges distilled into one block." }] });
    const probe = reFetchProbe();
    try {
        await drain(compressCallStream("call_ok", legal), ctx);
        assert.equal(probe.calls(), 1, "one re-request after the successful compress");
        const body = probe.bodies()[0]!;
        const args = assistantToolArgs(body);
        assert.equal(args.length, 1, "the compress tool-call rides the re-request");
        assert.equal(args[0], legal, "valid JSON arguments ride back byte-exact");
        assert.ok(!JSON.stringify(body).includes("non-JSON tool-call arguments"), "placeholder must not fire for valid args");
        assert.match(JSON.stringify(body), /Compressed m00001/, "the successful compression result is what the model continues from");
    } finally {
        probe.restore();
    }
});
