import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, failedCallSignature, MAX_LOOP_ROUNDS } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import type { CoreMessage } from "acp-kernel";

// #5220: a failed compress/decompress call must NEVER end the user's turn.
// Old contract (#156/#4186): ANY failed-only mutating round broke early with a
// fabricated "length" finish — cache-clean (#1548) but fatal: no client on any
// wire auto-continues "length" (OpenAI: no such convention; Anthropic: not even
// a legal stop reason), so one bad compress killed a running task mid-work
// (#5220 field report; #5179 is the same family's Anthropic symptom).
//
// New contract under test here (Responses wire):
//  1. first-time failure → ONE re-request carrying a plain assistant recovery
//     receipt whose bytes equal the ❌ marker already streamed to the client;
//     this round's ephemeral tool frames are stripped first, so they never
//     reach upstream (#1548/#4186 seam invariant preserved);
//  2. the model then DECIDES — this fixture ends the turn naturally;
//  3. resubmitting the identical failing call trips the restored #156
//     signature breaker (ping-pong → break); different args each round run to
//     MAX_LOOP_ROUNDS (the #3302 probe family keeps working, bounded);
//  4. fallback: requests with visibility markers OFF have no client-visible
//     bytes to anchor the receipt, so they keep the old contract (break with
//     no re-request) — otherwise the receipt would be server-invisible bytes
//     upstream, exactly the seam #4186 forbids.
//  5. failedCallSignature: argument order must not defeat repeat detection.
//  6. dedup edge: when #1029 marker dedup suppresses EVERY marker of a round
//     (a byte-identical failure already went out earlier in this request),
//     nothing client-visible anchors a receipt — no empty assistant text may
//     ride upstream; the loop re-requests the unchanged body instead and the
//     breaker + round limit still bound it.

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

function makeCtx(messages: CoreMessage[] = []): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    visibilityMarkers?: boolean;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "issue5220-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 , compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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
    };
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), SYS_PROMPT)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

// A round where the model answers plain text and completes naturally — what
// round 2 looks like once the recovery receipt has told the model what failed.
const NATURAL_END_ROUND = [
    sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
    sse("response.output_item.added", { item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] }, output_index: 0 }),
    sse("response.content_part.added", { item_id: "msg_2", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
    sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, content_index: 0, delta: "DONE-NATURAL-5220" }),
    sse("response.output_text.done", { item_id: "msg_2", output_index: 0, text: "DONE-NATURAL-5220" }),
    sse("response.output_item.done", { item: { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DONE-NATURAL-5220" }] }, output_index: 0 }),
    COMPLETED,
].join("");

// A failed-only compress round. seq=constant → every round resubmits the SAME
// failing call (T3, signature breaker); seq=round number → a fresh signature
// each round (T4, probe family). Invalid refs guarantee applyRanges FAILED.
function failingRound(seq: number): string {
    return [
        sse("response.created", { response: { id: `resp_${seq}`, status: "in_progress" } }),
        fcEvents(0, `call_seq${seq}`, "compress", JSON.stringify({ content: [{ startId: "b99", endId: "b99", summary: `${seq}${"x".repeat(50)}` }] })),
        COMPLETED,
    ].join("");
}

test("#5220 failedCallSignature: key order normalized, unknown names kept, raw fallback on bad JSON", () => {
    const a = failedCallSignature("compress", JSON.stringify({ startId: "m001", endId: "m002", summary: "s" }));
    const b = failedCallSignature("compress", JSON.stringify({ summary: "s", endId: "m002", startId: "m001" }));
    assert.equal(a, b, "argument key order does not defeat repeat detection");
    assert.notEqual(failedCallSignature("decompress", JSON.stringify({ x: 1 })), a, "tool name is part of the signature");
    const raw = "{not json";
    assert.equal(failedCallSignature("compress", raw), `compress:${raw}`, "unparseable arguments fall back to byte equality");
});

test("#5220 T1: first-time failed compress → exactly one recovery-receipt re-request; the model decides (natural end)", async () => {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(NATURAL_END_ROUND, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const ctx = withRefs(makeCtx([
            textMsg("u1", "user", "do the task"),
            textMsg("a1", "assistant", "working on it"),
        ]));
        // invalid refs → applyRanges returns FAILED, no block created
        const round1 = [
            sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
            fcEvents(0, "call_c5220", "compress", JSON.stringify({ content: [{ startId: "b99", endId: "b99", summary: "x".repeat(60) }] })),
            COMPLETED,
        ].join("");
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, 1, "first-time failure re-requests ONCE — no fabricated length end, no runaway loop");
        assert.ok(out.includes("❌"), "failure marker still streamed to the client");
        assert.ok(out.includes("DONE-NATURAL-5220"), "the MODEL's natural end-of-turn reached the client (the turn was NOT killed)");
        const body = bodies[0]!;
        assert.ok(body.includes("❌"), "retry body carries the recovery receipt as assistant text");
        assert.ok(!body.includes("function_call"), "this round's failed tool-call frame stays off the wire (#1548/#4186)");
        assert.ok(!body.includes("call_c5220"), "no call id from the stripped frames rides upstream");
        assert.ok(!body.includes("\"b99\""), "failing arguments ride upstream only inside the receiptless frame we stripped");
    } finally {
        globalThis.fetch = orig;
    }
});

test("#5220 T3: identical failing call resubmitted → #156 signature breaker stops at round 2", async () => {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n++;
        return new Response(failingRound(0), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const ctx = withRefs(makeCtx([textMsg("u1", "user", "task")]));
        const out = await drain(
            new Response(failingRound(0), { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, 1, "round 2 repeats the EXACT failing signature → breaker ends the turn after one re-request");
        assert.ok(/event: response\.completed/.test(out), "graceful completion (not degenerate empty)");
        assert.ok(out.includes("❌"), "receipt surfaced");
    } finally {
        globalThis.fetch = orig;
    }
});

test("#5220 T4: DIFFERENT failing args every round → no breaker, runs to MAX_LOOP_ROUNDS (probe family survives, bounded)", async () => {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n++;
        return new Response(failingRound(n), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const ctx = withRefs(makeCtx([textMsg("u1", "user", "task")]));
        const out = await drain(
            new Response(failingRound(0), { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, MAX_LOOP_ROUNDS - 1, "every round carries a first-seen signature; only the round limit bounds the turn");
        assert.ok(/event: response\.completed/.test(out), "graceful completion at the limit (not degenerate empty)");
    } finally {
        globalThis.fetch = orig;
    }
});

// Valid-shape compress against a nonexistent ref: kernel-level failure whose
// text does NOT embed the ref — byte-identical across distinct refs, so #1029
// marker dedup suppresses every marker after round 1 while each round carries
// a fresh signature (never stuck). The probe family (#3302) shape.
function unknownRefRound(ref: string): string {
    return [
        sse("response.created", { response: { id: `resp_${ref}`, status: "in_progress" } }),
        fcEvents(0, `call_${ref}`, "compress", JSON.stringify({ content: [{ startId: ref, endId: ref, summary: "s" }] })),
        COMPLETED,
    ].join("");
}

test("#5220 T6 dedup edge: every marker suppressed → no receipt pushed, no empty assistant text rides upstream; loop stays bounded", async () => {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(unknownRefRound(`m${900 + n}`), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const ctx = withRefs(makeCtx([textMsg("u1", "user", "task")]));
        const out = await drain(
            new Response(unknownRefRound("m900"), { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, MAX_LOOP_ROUNDS - 1, "fresh signature every round → only the round limit bounds the turn");
        assert.ok(/event: response\.completed/.test(out), "graceful completion at the limit (not degenerate empty)");
        for (const b of bodies) {
            const parsed = JSON.parse(b) as { input?: Array<{ role?: string; content?: unknown }> };
            for (const item of parsed.input ?? []) {
                const c = item.content;
                if (typeof c === "string") {
                    assert.ok(item.role !== "assistant" || c.length > 0, "no empty assistant message rides upstream (an unanchored receipt would be a #4186 seam + illegal on strict wires)");
                    continue;
                }
                if (!Array.isArray(c)) continue;
                for (const part of c) {
                    const p = part as { type?: string; text?: string };
                    assert.ok(p.type !== "output_text" || (p.text ?? "").length > 0, "no empty output_text rides upstream (an unanchored receipt would be a #4186 seam + illegal on strict wires)");
                }
            }
        }
    } finally {
        globalThis.fetch = orig;
    }
});

test("#5220 T5 fallback: visibilityMarkers=false keeps the old contract — break, zero re-requests (no client-visible bytes to anchor the receipt)", async () => {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { n++; return new Response(COMPLETED, { status: 200, headers: { "content-type": "text/event-stream" } }); }) as typeof fetch;
    try {
        const ctx = withRefs(makeCtx([textMsg("u1", "user", "task")]));
        ctx.visibilityMarkers = false;
        const out = await drain(
            new Response(failingRound(0), { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, 0, "markers off → the receipt would be server-invisible bytes upstream (#4186 seam) → old break contract");
        assert.ok(!out.includes("❌"), "no marker was ever surfaced in this mode");
        assert.ok(/event: response\.completed/.test(out), "graceful completion present");
    } finally {
        globalThis.fetch = orig;
    }
});
