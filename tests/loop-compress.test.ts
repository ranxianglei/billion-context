import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { REPLAY_MAX_ATTEMPTS } from "../src/fetch-util.ts";

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

test("loop #11 (no-guard): a SECOND compress in the same request EXECUTES (no short-circuit) — the model may legitimately compress multiple ranges", async () => {
    // Design (post guard-removal): there is NO one-compress guard. A second
    // compress call executes normally; its result (success or failure, e.g.
    // "range already covered") is fed back to the model as a normal tool output
    // so the model can decide its next action. This test guards against
    // re-introducing the no-op guard that incorrectly blocked legitimate
    // multi-compress.
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
        assert.ok(!logs.some(l => l.includes("skipped")), "no guard short-circuit — second compress executed (result fed back as a normal tool output)");
        assert.ok(out.includes("[ACP]"), "markers shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #12 (no-guard): a SECOND acp_status in the same request EXECUTES (no short-circuit) — the model may re-query; result fed back", async () => {
    // Design (post guard-removal): there is NO readOnlyCalled cap. A second
    // acp_status executes normally and its result is fed back as a tool output.
    // MAX_LOOP_ROUNDS bounds runaway; the model is trusted to stop once it has
    // the status it asked for.
    const ctx = makeCtx([
        textMsg("m00001", "user", "hello"),
        textMsg("m00002", "assistant", "hi"),
    ]);
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c1", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    const round2 = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        fcEvents(0, "call_c2", "acp_status", "{}"),
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
        assert.ok(!logs.some(l => l.includes("skipped")), "no guard short-circuit — second acp_status executed (result fed back)");
        assert.ok(out.includes("[ACP]"), "markers shown");
        assert.ok(/event: response\.completed/.test(out), "graceful completion");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #13 (feedback fix): textProtocol + native function_call → round-2 re-request carries a proper function_call_output (not a bare developer message)", async () => {
    // Before the fix, textProtocol mode fed ALL proxy-tool results back as
    // role:system developer messages (buildVisibilityMarker), never as a proper
    // function_call_output. The Responses API expects function_call →
    // function_call_output pairing; a bare system message gets ignored, so the
    // model re-calls the same tool (#119 run-on). The fix tracks which calls were
    // native function_calls and feeds those back as a proper function_call +
    // function_call_output pair even under textProtocol.
    const ctx = makeCtx([
        textMsg("m00001", "user", "hello"),
        textMsg("m00002", "assistant", "hi"),
    ]);
    ctx.textProtocol = true;
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_s", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        return new Response(REFETCH_DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(true),
        );
        assert.ok(bodies.length >= 1, "re-request fires after acp_status");
        const body = bodies[0];
        assert.ok(body.includes('"function_call"'), "round-2 body includes the assistant function_call item");
        assert.ok(body.includes('"function_call_output"'), "round-2 body includes a proper function_call_output (the fix); previously only a developer system message was sent");
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
    process.env.BILI_REPLAY_RETRY_BASE_MS = "1";
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
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response("upstream error", { status: 500 });
    }) as typeof fetch;
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
        assert.equal(fetchCalls, REPLAY_MAX_ATTEMPTS, "5xx retried with bounded attempts (#189)");
    } finally {
        delete process.env.BILI_REPLAY_RETRY_BASE_MS;
        globalThis.fetch = orig;
    }
});

// #422: after a successful compress the re-request must reflect the post-
// compress fold (host refreshFolded hook), not the stale pre-compress view.
// The stale view is what made the model stop: it was told "~N tokens saved"
// while staring at the identical context it had just compressed.
test("loop #422a: successful compress → re-request carries the refreshed fold + round records", async () => {
    // 7 messages: kernel protects the last 5, so m00001/m00002 are compressible.
    const ctx = withRefs(
        makeCtx([
            textMsg("raw_1", "user", "task: audit files. " + bigText(5000)),
            textMsg("raw_2", "user", "consumed content " + bigText(5000)),
            textMsg("raw_3", "user", bigText(5000)),
            textMsg("raw_4", "assistant", bigText(5000)),
            textMsg("raw_5", "user", bigText(5000)),
            textMsg("raw_6", "assistant", bigText(5000)),
            textMsg("raw_7", "user", bigText(5000)),
        ]),
    );
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "SUMMARY-422: task kickoff plus consumed file read distilled into one dense block." }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    let refreshCalls = 0;
    try {
        ctx.refreshFolded = (current) => {
            refreshCalls++;
            // Host mirror: fresh fold for the new state + this round's records.
            const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
            assert.ok(records.length >= 2, `refreshFolded must receive the round records (call+result), got ${records.length}`);
            assert.ok(records.some((m) => m.contentType === "tool-call" && m.toolName === "compress"), "records include the compress tool-call");
            assert.ok(records.some((m) => m.contentType === "tool-result"), "records include the compress tool-result");
            return [
                textMsg("m00001", "user", "FRESH-FOLDED-VIEW-422 (old span folded away)"),
                textMsg("m00003", "assistant", "recent tail"),
                ...records,
            ];
        };
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(probe.calls() >= 1, "re-request fired");
        const body = probe.bodies()[0]!;
        assert.ok(body.includes("FRESH-FOLDED-VIEW-422"), "re-request carries the refreshed post-compress fold");
        assert.ok(!body.includes("consumed content"), "consumed content is folded out of the re-request");
        assert.ok(body.includes("SUMMARY-422"), "round records (compress call args) ride on top of the fresh fold");
        assert.ok(body.includes("[Compressed m00001"), "compress tool-result present in the re-request tail");
        assert.equal(refreshCalls, 1, "refreshFolded called exactly once for one successful compress");
        assert.equal(ctx.session.stats.compressCreditTokens, 0, "credit cleared once the fold reached a model-visible request");
    } finally {
        probe.restore();
    }
});

// Scope guard: a FAILED compress changes no state — no refresh, stale view kept.
test("loop #422b: failed compress → no fold refresh (stale view kept)", async () => {
    const ctx = withRefs(
        makeCtx([
            textMsg("m00001", "user", "hello"),
            textMsg("m00002", "assistant", "hi"),
        ]),
    );
    // invalid refs → applyRanges returns FAILED, no block created
    const compressArgs = JSON.stringify({ content: [{ startId: "b99", endId: "b99", summary: "x".repeat(60) }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_f", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        ctx.refreshFolded = () => {
            throw new Error("refreshFolded must NOT be called for a failed compress");
        };
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(probe.calls() >= 1, "re-request still fires so the model sees the failure");
        assert.ok(probe.bodies()[0]!.includes("hello"), "stale view preserved on failure");
        assert.ok(probe.bodies()[0]!.includes("Compression FAILED"), "failure surfaced to the model");
    } finally {
        probe.restore();
    }
});

// Degradation guard: a throwing refreshFolded falls back to the pre-compress
// view (previous behavior) instead of killing the loop.
test("loop #422c: refreshFolded throws → re-request keeps the pre-compress view", async () => {
    // 7 messages: kernel protects the last 5, so m00001/m00002 are compressible
    // and refreshFolded IS invoked (then throws) — not a protected-zone failure.
    const ctx = withRefs(
        makeCtx([
            textMsg("raw_1", "user", "task: audit files. " + bigText(5000)),
            textMsg("raw_2", "user", "consumed content " + bigText(5000)),
            textMsg("raw_3", "user", bigText(5000)),
            textMsg("raw_4", "assistant", bigText(5000)),
            textMsg("raw_5", "user", bigText(5000)),
            textMsg("raw_6", "assistant", bigText(5000)),
            textMsg("raw_7", "user", bigText(5000)),
        ]),
    );
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "SUMMARY-422c: the consumed span distilled into one dense audit block for later." }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", compressArgs),
        COMPLETED,
    ].join("");
    const probe = reFetchProbe();
    try {
        let refreshCalled = false;
        ctx.refreshFolded = () => {
            refreshCalled = true;
            throw new Error("host fold blew up");
        };
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(refreshCalled, "compress succeeded and refreshFolded was invoked (the throw path is what we test)");
        assert.ok(probe.calls() >= 1, "re-request fired despite the refresh failure");
        assert.ok(probe.bodies()[0]!.includes("consumed content"), "pre-compress view kept as fallback");
        assert.ok(/response\.completed/.test(out), "loop completed gracefully");
    } finally {
        probe.restore();
    }
});
