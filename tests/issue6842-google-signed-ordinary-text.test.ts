import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createSession } from "../src/session.ts";
import { runCompressLoop, createGoogleAdapter } from "../src/loop/index.ts";
import type { CompressLoopAdapter, ParsedStreamEvent } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { rewriteGoogleJsonResponseAsync } from "../src/stream-google.ts";
import type { RewriteCtx } from "../src/stream.ts";

// #6842: Gemini attaches thoughtSignature to ORDINARY text parts (no
// thought: true). The signature is verified byte-for-byte over the part's
// text on replay (KDD#10), so a signed ordinary text part is a
// signature-verified block: (1) the SSE adapter and the non-streaming JSON
// rewriter must not prose-filter it — only thought: true was exempt, so
// marker-like text inside a signed part was rewritten before the client saw
// it; (2) the streaming tool loop must carry the signature through
// accumulation and the proxy-tool rebuild — it recorded ordinary text as a
// merged string and dropped the signature from the re-request, even when the
// text contained no markers at all. These tests pin both directions: signed
// parts stay byte-exact, unsigned prose is still filtered, and the
// re-request carries each signature onto its own text part.

const renderTag = '<acp tokens="177" type="text">m00155</acp>';

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

/** Decode the forwarded wire bytes into the parts the client received. */
function forwardedParts(fwd: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const line of fwd.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("data: ")) continue;
        const f = JSON.parse(l.slice(6)) as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> };
        const parts = f.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) for (const p of parts) if (p && typeof p === "object") out.push(p);
    }
    return out;
}

// ---- adapter level: SSE + JSON-array transport ----------------------------

test("#6842 a: signed ordinary text with marker-like text is forwarded byte-exact (SSE)", async () => {
    const body = [
        sse(candidateFrame([{ text: `before ${renderTag} after`, thoughtSignature: "sig-a" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const fwd = forwardedOf(await collect(makeAdapter(), body));
    const parts = forwardedParts(fwd);
    const signed = parts.find((p) => p.thoughtSignature === "sig-a");
    assert.ok(signed, "signed part reached the client");
    assert.equal(signed?.text, `before ${renderTag} after`, "render tag inside a signed part is NOT stripped");
    assert.equal(count(fwd, "sig-a"), 1, "signature forwarded exactly once");
    assert.ok(!fwd.includes("finishReason"), "terminal frame not forwarded early");
});

test("#6842 b: signed ordinary text with marker-like text is forwarded byte-exact (JSON-array form)", async () => {
    const frames = [
        candidateFrame([{ text: `before ${renderTag} after`, thoughtSignature: "sig-b" }]),
        candidateFrame([], { finishReason: "STOP" }),
    ];
    const fwd = forwardedOf(await collect(makeAdapter(), JSON.stringify(frames)));
    const parts = forwardedParts(fwd);
    const signed = parts.find((p) => p.thoughtSignature === "sig-b");
    assert.ok(signed, "signed part reached the client");
    assert.equal(signed?.text, `before ${renderTag} after`, "render tag inside a signed part is NOT stripped");
    assert.equal(count(fwd, "sig-b"), 1, "signature forwarded exactly once");
    assert.ok(!fwd.includes("finishReason"), "terminal frame not forwarded early");
});

test("#6842 c: signed ordinary text WITHOUT markers is forwarded byte-exact (baseline)", async () => {
    const body = [
        sse(candidateFrame([{ text: "plain signed prose", thoughtSignature: "sig-c" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const fwd = forwardedOf(await collect(makeAdapter(), body));
    const parts = forwardedParts(fwd);
    const signed = parts.find((p) => p.thoughtSignature === "sig-c");
    assert.equal(signed?.text, "plain signed prose", "text intact");
    assert.equal(count(fwd, "sig-c"), 1, "signature forwarded exactly once");
});

test("#6842 d (gate): UNSIGNED ordinary text with marker-like text is still filtered", async () => {
    const body = [
        sse(candidateFrame([{ text: `before ${renderTag} after` }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const parts = forwardedParts(forwardedOf(await collect(makeAdapter(), body)));
    const text = parts.find((p) => typeof p.text === "string");
    assert.ok(text, "text part reached the client");
    assert.ok(!String(text?.text).includes("acp"), "render tag in unsigned prose is stripped");
    assert.ok(String(text?.text).includes("before") && String(text?.text).includes("after"), "surrounding prose survives");
});

test("#6842 e (gate): thought parts and standalone signatures keep their existing behavior", async () => {
    const body = [
        sse(candidateFrame([{ thought: true, text: `thinking ${renderTag}`, thoughtSignature: "sig-e" }])),
        sse(candidateFrame([{ thoughtSignature: "sig-e2" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const events = await collect(makeAdapter(), body);
    const fwd = forwardedOf(events);
    const parts = forwardedParts(fwd);
    const thought = parts.find((p) => p.thought === true);
    assert.equal(thought?.text, `thinking ${renderTag}`, "signed thought text stays verbatim");
    assert.equal(thought?.thoughtSignature, "sig-e");
    assert.ok(parts.some((p) => p.thoughtSignature === "sig-e2"), "standalone signature still forwarded");
    assert.ok(events.some((ev) => ev.kind === "standalone_signature"), "standalone_signature event still emitted");
});

// ---- loop level: proxy-tool rebuild ---------------------------------------

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

function modelContentOf(body: string): { parts: Array<Record<string, unknown>> } {
    const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> };
    const model = parsed.contents.find((c) => c.role === "model" && Array.isArray(c.parts) && c.parts.some((p) => typeof p.text === "string"));
    assert.ok(model, `re-request carries a model content with text parts (got ${body.slice(0, 300)})`);
    return model as { parts: Array<Record<string, unknown>> };
}

test("#6842 f: the issue's repro — two adjacent signed text parts keep both signatures AND their part boundary on the re-request", async () => {
    const round1 = [
        sse(candidateFrame([{ text: "part one", thoughtSignature: "sig-f1" }])),
        sse(candidateFrame([{ functionCall: { id: "call_f", name: "acp_status", args: {} } }])),
        sse(candidateFrame([{ text: "part two", thoughtSignature: "sig-f2" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const round2 = [
        sse(candidateFrame([{ text: "loop answer f" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const { out, calls, bodies } = await drainGoogle(round1, [round2], "i6842-f");
    assert.equal(calls, 1, "one re-request after the proxy tool");
    const model = modelContentOf(bodies[0]!);
    const textParts = model.parts.filter((p) => typeof p.text === "string");
    assert.deepEqual(
        textParts.map((p) => ({ text: p.text, sig: p.thoughtSignature })),
        [
            { text: "part one", sig: "sig-f1" },
            { text: "part two", sig: "sig-f2" },
        ],
        "each signed part keeps its own text and signature — no merge, no loss",
    );
    assert.equal(count(out, "sig-f1"), 1, "first signature reached the client exactly once");
    assert.equal(count(out, "sig-f2"), 1, "second signature reached the client exactly once");
    assert.ok(out.includes("loop answer f"), "round-2 answer reached the client");
});

test("#6842 g: multi-chunk signed part — text deltas merge, the signature (last chunk) lands on the merged part", async () => {
    const round1 = [
        sse(candidateFrame([{ text: "hello " }])),
        sse(candidateFrame([{ text: "world", thoughtSignature: "sig-g" }])),
        sse(candidateFrame([{ functionCall: { id: "call_g", name: "acp_status", args: {} } }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const round2 = [
        sse(candidateFrame([{ text: "loop answer g" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const { calls, bodies } = await drainGoogle(round1, [round2], "i6842-g");
    assert.equal(calls, 1, "one re-request after the proxy tool");
    const model = modelContentOf(bodies[0]!);
    const textParts = model.parts.filter((p) => typeof p.text === "string");
    assert.deepEqual(
        textParts.map((p) => ({ text: p.text, sig: p.thoughtSignature })),
        [{ text: "hello world", sig: "sig-g" }],
        "the two deltas of one part merge under its signature",
    );
});

test("#6842 h (gate): unsigned text in a proxy-tool round gets NO fabricated signature on the re-request", async () => {
    const round1 = [
        sse(candidateFrame([{ text: "unsigned prose" }])),
        sse(candidateFrame([{ functionCall: { id: "call_h", name: "acp_status", args: {} } }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const round2 = [
        sse(candidateFrame([{ text: "loop answer h" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const { calls, bodies } = await drainGoogle(round1, [round2], "i6842-h");
    assert.equal(calls, 1, "one re-request after the proxy tool");
    const model = modelContentOf(bodies[0]!);
    const textParts = model.parts.filter((p) => typeof p.text === "string");
    assert.deepEqual(
        textParts.map((p) => ({ text: p.text, sig: p.thoughtSignature })),
        [{ text: "unsigned prose", sig: undefined }],
        "no signature invented for unsigned text",
    );
});

// ---- non-streaming JSON rewriter ------------------------------------------

function jsonCtx(): RewriteCtx {
    const config = defaultConfig(200_000);
    const messages: CoreMessage[] = [{ id: "request", role: "user", contentType: "text", text: "Answer normally" }];
    return { core: createCore(), config, messages, session: createSession("issue6842-json"), log: () => {} };
}

test("#6842 i: JSON rewriter — signed ordinary text with marker-like text is NOT rewritten", async () => {
    const ctx = jsonCtx();
    const body = { candidates: [{ content: { role: "model", parts: [{ text: `before ${renderTag} after`, thoughtSignature: "sig-i" }] }, finishReason: "STOP" }] };
    const expected = structuredClone(body);
    assert.deepEqual(await rewriteGoogleJsonResponseAsync(body, ctx), expected, "signed part text and signature untouched");
});

test("#6842 j (gate): JSON rewriter — UNSIGNED ordinary text with marker-like text is still stripped", async () => {
    const ctx = jsonCtx();
    const body = { candidates: [{ content: { role: "model", parts: [{ text: `before ${renderTag} after` }] }, finishReason: "STOP" }] };
    assert.deepEqual(await rewriteGoogleJsonResponseAsync(body, ctx), { candidates: [{ content: { role: "model", parts: [{ text: "before  after" }] }, finishReason: "STOP" }] });
});

test("#6842 k (gate): JSON rewriter — signed thought parts and signed real functionCalls keep their existing behavior", async () => {
    const ctx = jsonCtx();
    const body = {
        candidates: [{
            content: {
                role: "model",
                parts: [
                    { thought: true, text: `thinking ${renderTag}`, thoughtSignature: "sig-k1" },
                    { functionCall: { name: "write_file", args: { path: "a.ts" } }, thoughtSignature: "sig-k2" },
                    { text: renderTag },
                ],
            },
            finishReason: "STOP",
        }],
    };
    assert.deepEqual(await rewriteGoogleJsonResponseAsync(body, ctx), {
        candidates: [{
            content: {
                role: "model",
                parts: [
                    { thought: true, text: `thinking ${renderTag}`, thoughtSignature: "sig-k1" },
                    { functionCall: { name: "write_file", args: { path: "a.ts" } }, thoughtSignature: "sig-k2" },
                    { text: "" },
                ],
            },
            finishReason: "STOP",
        }],
    }, "thought verbatim, real call untouched, unsigned prose still stripped");
});
