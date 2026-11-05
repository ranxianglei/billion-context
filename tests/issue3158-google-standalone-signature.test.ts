import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createGoogleAdapter } from "../src/loop/index.ts";
import type { CompressLoopAdapter, ParsedStreamEvent } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #3158: Gemini streams sign reasoning blocks — a thoughtSignature can ride
// its own part with no text (a late association for an earlier block, or the
// whole block's signature when the text arrived unsigned). The Google loop
// adapter modeled only text/thought/functionCall parts, so a signature-only
// part fell through every branch and vanished from the client's wire; the
// loop's proxy-tool rebuild had no record of it either. These tests pin:
// every shape forwards the signature byte-exactly exactly once, the terminal
// finish reason is never leaked early, and a rebuilt re-request carries the
// signature back onto the wire.

const SIG_A = "synthetic-not-a-real-secret";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

async function collect(adapter: CompressLoopAdapter, body: string): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(new Response(body, { status: 200 }).body!, 1)) events.push(ev);
    return events;
}

function forwardedOf(events: ParsedStreamEvent[]): string {
    let out = "";
    for (const e of events) {
        if ("raw" in e && Buffer.isBuffer(e.raw)) out += e.raw.toString("utf8");
        if ("chunk" in e && Buffer.isBuffer(e.chunk)) out += e.chunk.toString("utf8");
    }
    return out;
}

const count = (s: string, sub: string): number => s.split(sub).length - 1;

function makeAdapter(): CompressLoopAdapter {
    return createGoogleAdapter(
        { contents: [{ role: "user", parts: [{ text: "original" }] }], model: "gemini-3-pro-preview", stream: true },
        undefined,
        undefined,
        "gemini-3-pro-preview",
    );
}

const candidateFrame = (parts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    candidates: [{ content: { role: "model", parts }, index: 0, ...extra }],
});

test("#3158 a: the issue's exact four-frame repro — standalone signature survives, once, finish never leaks", async () => {
    const body = [
        sse(candidateFrame([{ thought: true, text: "synthetic summary" }])),
        sse(candidateFrame([{ text: "66" }])),
        sse(candidateFrame([{ thoughtSignature: SIG_A }])),
        sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2, totalTokenCount: 102 } }),
    ].join("");
    const events = await collect(makeAdapter(), body);
    const fwd = forwardedOf(events);

    assert.equal(count(fwd, SIG_A), 1, "signature forwarded exactly once");
    assert.equal(count(fwd, "synthetic summary"), 1, "thought text intact");
    assert.equal(count(fwd, '"text":"66"'), 1, "answer text intact");
    assert.ok(!fwd.includes("finishReason"), "terminal frame not forwarded early — the completion stays the sole finish carrier");
    const usage = events.find((e) => e.kind === "usage");
    assert.ok(usage, "usage event present");
    if (usage.kind === "usage") {
        assert.equal(usage.inputTokens, 100);
        assert.equal(usage.outputTokens, 2);
    }
    const done = events.find((e) => e.kind === "done");
    assert.ok(done, "done event present");
    if (done.kind === "done") assert.equal(done.finishReason, "STOP");
    assert.ok(events.some((e) => e.kind === "standalone_signature"), "loop-visible standalone_signature event emitted");
});

test("#3158 b: empty-text part carrying a signature is forwarded", async () => {
    const body = sse(candidateFrame([{ text: "", thoughtSignature: "sig-b" }])) + sse(candidateFrame([], { finishReason: "STOP" }));
    const fwd = forwardedOf(await collect(makeAdapter(), body));
    assert.equal(count(fwd, "sig-b"), 1, "signature on an empty-text part forwarded once");
    assert.ok(!fwd.includes("finishReason"), "no early finish leak");
});

test("#3158 c: mixed text+signature chunk still forwards the signature exactly once (whole-frame raw path)", async () => {
    const body = sse(candidateFrame([{ text: "hello" }, { thoughtSignature: "sig-c" }])) + sse(candidateFrame([], { finishReason: "STOP" }));
    const fwd = forwardedOf(await collect(makeAdapter(), body));
    assert.equal(count(fwd, "sig-c"), 1, "signature rides the whole-frame raw exactly once");
    assert.equal(count(fwd, '"text":"hello"'), 1, "text exactly once — no duplication from the new wrapper path");
});

test("#3158 d: terminal thought chunk carrying a signature — finish dropped, signature kept", async () => {
    const body = sse(candidateFrame([{ thought: true, text: "t-d" }, { thoughtSignature: "sig-d" }], { finishReason: "STOP" }));
    const events = await collect(makeAdapter(), body);
    const fwd = forwardedOf(events);
    assert.equal(count(fwd, "sig-d"), 1, "signature kept on the drop-finish replay");
    assert.equal(count(fwd, "t-d"), 1, "thought text kept");
    assert.ok(!fwd.includes("finishReason"), "finish stripped from the replayed frame");
    const done = events.find((e) => e.kind === "done");
    assert.ok(done, "done event present");
    if (done.kind === "done") assert.equal(done.finishReason, "STOP");
});

test("#3158 e: terminal signature-only chunk — wrapper drops the finish, keeps the signature", async () => {
    const body = sse(candidateFrame([{ thoughtSignature: "sig-e" }], { finishReason: "STOP" }));
    const events = await collect(makeAdapter(), body);
    const fwd = forwardedOf(events);
    assert.equal(count(fwd, "sig-e"), 1, "signature forwarded once via the wrapper");
    assert.ok(!fwd.includes("finishReason"), "early finish must not leak ahead of the completion");
    const done = events.find((e) => e.kind === "done");
    assert.ok(done, "done event present");
    if (done.kind === "done") assert.equal(done.finishReason, "STOP");
});

test("#3158 f: real-call chunk with a signature sibling — verbatim replay keeps both", async () => {
    const body = sse(candidateFrame([
        { functionCall: { id: "call_f", name: "mytool", args: {} } },
        { thoughtSignature: "sig-f" },
    ])) + sse(candidateFrame([], { finishReason: "STOP" }));
    const events = await collect(makeAdapter(), body);
    const fwd = forwardedOf(events);
    assert.equal(count(fwd, "sig-f"), 1, "signature sibling survives the verbatim replay");
    assert.ok(fwd.includes("mytool"), "real call forwarded");
    const tc = events.find((e) => e.kind === "tool_call");
    assert.ok(tc, "tool_call event present");
    if (tc.kind === "tool_call") {
        assert.equal(tc.name, "mytool");
        assert.equal(tc.passthrough, true, "real call is passthrough");
    }
});

test("#3158 g: proxy-call chunk with a signature sibling — the resynthesized prose keeps the signature", async () => {
    const body = sse(candidateFrame([
        { functionCall: { id: "call_g", name: "compress", args: {} } },
        { thoughtSignature: "sig-g" },
    ])) + sse(candidateFrame([], { finishReason: "STOP" }));
    const events = await collect(makeAdapter(), body);
    const fwd = forwardedOf(events);
    assert.equal(count(fwd, "sig-g"), 1, "signature sibling survives the drop-path resynthesis");
    const tc = events.find((e) => e.kind === "tool_call");
    assert.ok(tc, "structured tool_call event present");
    if (tc.kind === "tool_call") {
        assert.equal(tc.name, "compress");
        assert.notEqual(tc.passthrough, true, "proxy call is structured, not passthrough");
    }
});

test("#3158 h: JSON-array transport form — same guarantee as SSE", async () => {
    const frames = [
        candidateFrame([{ thought: true, text: "summary-h" }]),
        candidateFrame([{ text: "42" }]),
        candidateFrame([{ thoughtSignature: "sig-h" }]),
        candidateFrame([], { finishReason: "STOP" }),
    ];
    const fwd = forwardedOf(await collect(makeAdapter(), JSON.stringify(frames)));
    assert.equal(count(fwd, "sig-h"), 1, "signature forwarded exactly once in array form");
    assert.equal(count(fwd, '"text":"42"'), 1);
    assert.ok(!fwd.includes("finishReason"));
});

// ---- loop-level: rebuild + retry gates ------------------------------------

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
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

const GOOGLE_BODY: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: "orig" }] }],
    tools: [{ functionDeclarations: [{ name: "acp_status", description: "status" }] }],
    generationConfig: { maxOutputTokens: 8192 },
};

async function drainGoogle(first: string, attempts: string[], id: string): Promise<{ out: string; calls: number; bodies: string[] }> {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        n += 1;
        if (typeof init?.body === "string") bodies.push(init.body);
        return new Response(attempts[n - 1] ?? "", { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    const ctx = makeCtx(id);
    (ctx as Record<string, unknown>).protocol = "google";
    try {
        for await (const c of runCompressLoop(
            streamOf(first),
            ctx,
            GOOGLE_BODY,
            { url: "http://mock", headers: {} },
            createGoogleAdapter(GOOGLE_BODY, undefined, undefined, "gemini-3-pro-preview"),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(c);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), calls: n, bodies };
}

test("#3158 i: proxy-tool round with a standalone signature — the re-request carries it back onto the wire", async () => {
    const round1 = [
        sse(candidateFrame([{ thoughtSignature: "loop-sig-i" }])),
        sse(candidateFrame([{ functionCall: { id: "call_i", name: "acp_status", args: {} } }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const round2 = [
        sse(candidateFrame([{ text: "loop answer i" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const { out, calls, bodies } = await drainGoogle(round1, [round2], "i3158-i");
    assert.equal(calls, 1, "one re-request after the proxy tool");
    assert.ok(bodies[0]?.includes("loop-sig-i"), `re-request body carries the signature (got ${bodies[0]?.slice(0, 200)})`);
    assert.ok(out.includes("loop answer i"), "round-2 answer reached the client");
});

test("#3158 k: signature sibling inside the call chunk — settle path records it for the rebuild", async () => {
    const round1 = [
        sse(candidateFrame([
            { functionCall: { id: "call_k", name: "acp_status", args: {} } },
            { thoughtSignature: "loop-sig-k" },
        ])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const round2 = [
        sse(candidateFrame([{ text: "loop answer k" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const { out, calls, bodies } = await drainGoogle(round1, [round2], "i3158-k");
    assert.equal(calls, 1, "one re-request after the proxy tool");
    assert.ok(bodies[0]?.includes("loop-sig-k"), `re-request body carries the sibling signature (got ${bodies[0]?.slice(0, 200)})`);
    assert.ok(out.includes("loop answer k"), "round-2 answer reached the client");
});

test("#3158 l: signature sharing a frame with forwarded text — recorded for the rebuild too", async () => {
    const round1 = [
        sse(candidateFrame([{ text: "mixed l" }, { thoughtSignature: "loop-sig-l" }])),
        sse(candidateFrame([{ functionCall: { id: "call_l", name: "acp_status", args: {} } }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const round2 = [
        sse(candidateFrame([{ text: "loop answer l" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const { out, calls, bodies } = await drainGoogle(round1, [round2], "i3158-l");
    assert.equal(calls, 1, "one re-request after the proxy tool");
    assert.ok(bodies[0]?.includes("loop-sig-l"), `re-request body carries the same-frame signature (got ${bodies[0]?.slice(0, 200)})`);
    assert.equal(count(out, "loop-sig-l"), 1, "signature reached the client exactly once via the whole-frame raw");
    assert.ok(out.includes("mixed l"), "same-frame text reached the client");
});

test("#3158 j: truncated round whose only output was a forwarded signature chunk — no blind zero-side-effect refetch", async () => {
    const round1 = [
        sse(candidateFrame([{ thoughtSignature: "loop-sig-j" }])),
        sse(candidateFrame([], { finishReason: "MAX_TOKENS" })),
    ].join("");
    const { out, calls } = await drainGoogle(round1, [sse(candidateFrame([{ text: "should not appear" }]))], "i3158-j");
    assert.equal(calls, 0, "signature bytes already reached the client — the blind refetch is barred instead of duplicating them");
    assert.ok(out.includes("MAX_TOKENS"), "truncation surfaced through the completion");
    assert.ok(!out.includes("should not appear"), "no retried round reached the client");
});
