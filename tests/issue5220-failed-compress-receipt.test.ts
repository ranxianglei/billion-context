import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, createAnthropicAdapter, failedCallSignature, MAX_LOOP_ROUNDS } from "../src/loop/index.ts";
import type { WireProtocol } from "../src/util.ts";
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
//  6. deduped-marker edge: when EVERY failure marker of a failed-only round was
//     already streamed in an earlier round (identical failure text, different
//     args), the receipt would be a zero-byte assistant message — strict wires
//     reject empty text blocks, so the re-request goes out WITHOUT a receipt
//     instead (still cache-clean; bounded by breaker / MAX_LOOP_ROUNDS).

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

function makeCtx(messages: CoreMessage[] = [], protocol?: WireProtocol): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    visibilityMarkers?: boolean;
    protocol?: WireProtocol;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        protocol,
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
    adapter: ReturnType<typeof createResponsesAdapter> = createResponsesAdapter(),
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, adapter, SYS_PROMPT)) {
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

function partText(p: unknown): string {
    if (typeof p === "object" && p !== null && "text" in p) {
        const t = (p as { text: unknown }).text;
        return typeof t === "string" ? t : "";
    }
    return "";
}

function assistantTexts(body: string): string[] {
    const parsed = JSON.parse(body) as { input?: Array<{ type?: string; role?: string; content?: unknown }> };
    return (parsed.input ?? [])
        .filter((it) => it.type === "message" && it.role === "assistant")
        .map((it) => {
            const c = it.content;
            if (Array.isArray(c)) return c.map(partText).join("");
            return typeof c === "string" ? c : "";
        });
}

// m00001 ("task") and m00003 ("done") are both 4 chars, so compressing either
// alone fails with byte-identical text ("Total compressible content too small
// (4 chars across 1 range(s)…)") while carrying DIFFERENT signatures (different
// refs + summaries). Round 2's marker is therefore deduped against round 1's —
// exactly the shape where the receipt would be empty.
test("#5220 T6: deduped markers → re-request WITHOUT an empty assistant frame (strict wires reject zero-byte turns)", async () => {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    // round 2: same-size single-ref range (m00003), different summary → fresh
    // signature, byte-identical failure text → marker deduped, receipt empty.
    const round2 = [
        sse("response.created", { response: { id: "resp_2f", status: "in_progress" } }),
        fcEvents(0, "call_r2", "compress", JSON.stringify({ content: [{ startId: "m00003", endId: "m00003", summary: "2".padEnd(51, "x") }] })),
        COMPLETED,
    ].join("");
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(n === 1 ? round2 : NATURAL_END_ROUND, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const ctx = withRefs(makeCtx([
            textMsg("u1", "user", "task"),
            textMsg("a1", "assistant", "ok working"),
            textMsg("u2", "user", "done"),
        ]));
        const round1 = [
            sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
            fcEvents(0, "call_r1", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00001", summary: "1".padEnd(51, "x") }] })),
            COMPLETED,
        ].join("");
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, 2, "round 2's failure has a fresh signature → not stuck → re-requested again; round 3 ends naturally");
        assert.ok(out.includes("DONE-NATURAL-5220"), "the turn survived the deduped-failure round");
        const r1Texts = assistantTexts(bodies[0]!);
        assert.ok(r1Texts.some((t) => t.includes("❌")), "round 1's receipt still rides upstream (stable prefix)");
        for (let i = 0; i < bodies.length; i++) {
            const texts = assistantTexts(bodies[i]!);
            assert.ok(!texts.some((t) => t.trim().length === 0), `re-request ${i + 1}: no zero-byte assistant frame rides upstream (empty text blocks are illegal on strict wires)`);
        }
    } finally {
        globalThis.fetch = orig;
    }
});

// #5604: the recovery receipt is assistant-role by design (#5220 cache invariant —
// the client echoes the streamed markers back as assistant content), so a failed-only
// round's re-request ENDED ON AN ASSISTANT TURN. Anthropic rejects that shape outright
// ("final assistant content cannot end with trailing whitespace" / "assistant message
// prefill not supported"), the client gets a 400 and a subagent dies with "Agent
// terminated early due to an API error". The fix caps the re-request with a thin user
// nudge so it always ends on a user turn. This test pins the final-message role — the
// existing T1/T6 only asserted the ❌ bytes ride upstream, never which role ends the body.
test("#5604: failed-only re-request ENDS ON A USER TURN (no assistant prefill)", async () => {
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
            fcEvents(0, "call_c5604", "compress", JSON.stringify({ content: [{ startId: "b99", endId: "b99", summary: "x".repeat(60) }] })),
            COMPLETED,
        ].join("");
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(n, 1, "first-time failure re-requests once");
        const parsed = JSON.parse(bodies[0]!) as { input: Array<{ type?: string; role?: string }> };
        const msgs = parsed.input.filter((it) => it.type === "message");
        assert.ok(msgs.length >= 2, `re-request carries the base history plus the cap, got ${msgs.length} message(s)`);
        assert.equal(msgs[msgs.length - 1]!.role, "user", "the re-request ENDS on a user turn — never an assistant prefill (#5604)");
        assert.ok(assistantTexts(bodies[0]!).some((t) => t.includes("❌")), "the assistant receipt still carries the streamed marker bytes (#5220 cache invariant intact)");
    } finally {
        globalThis.fetch = orig;
    }
});

// #5604 on the ANTHROPIC wire (where the 400 actually fires), with a SIGNED THINKING
// block: buildVisibilityMarker appends "\n", so the receipt merged into that assistant
// turn ends in trailing whitespace → "final assistant content cannot end with trailing
// whitespace" / "assistant message prefill not supported". The Responses pin above never
// reaches this shape; this one does.
function anthropicFailedRound(): string {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Fold old ranges." } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ content: [{ startId: "b99", endId: "b99", summary: "x".repeat(60) }] }) } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");
}

function anthropicNaturalEndRound(): string {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 20 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE-ANTHROPIC-5604" } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");
}

test("#5604 anthropic wire (+signed thinking): failed-only re-request ENDS ON A USER TURN", async () => {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(anthropicNaturalEndRound(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const reqBody = { model: "claude-test", stream: true, thinking: { type: "enabled", budget_tokens: 2048 }, messages: [] };
        const ctx = withRefs(makeCtx([
            textMsg("u1", "user", "do the task"),
            textMsg("a1", "assistant", "working on it"),
            textMsg("u2", "user", "go on"),
        ], "anthropic"));
        const out = await drain(
            new Response(anthropicFailedRound(), { status: 200 }).body!,
            ctx,
            reqBody,
            { url: "http://mock", headers: {} },
            createAnthropicAdapter(reqBody),
        );
        assert.equal(n, 1, "first-time failure re-requests once");
        assert.ok(out.includes("❌"), "failure marker streamed to the client");
        assert.ok(out.includes("DONE-ANTHROPIC-5604"), "natural end-of-turn reached the client (turn survived)");
        const msgs = (JSON.parse(bodies[0]!) as { messages: Array<{ role: string; content: unknown }> }).messages;
        const last = msgs[msgs.length - 1]!;
        if (last.role === "assistant") {
            const c = last.content;
            const lastText = typeof c === "string" ? c : (c as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").pop() ?? "";
            assert.equal(lastText, lastText.trimEnd(), "final assistant content must not end with whitespace (Anthropic 400)");
        }
        assert.equal(last.role, "user", "re-request ENDS on a user turn — never an assistant prefill (#5604)");
    } finally {
        globalThis.fetch = orig;
    }
});
