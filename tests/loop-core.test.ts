import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import type { WireProtocol } from "../src/util.ts";
import { isTransientUpstreamError, REPLAY_MAX_ATTEMPTS, replayBackoffMs, replayMaxAttempts } from "../src/fetch-util.ts";

function makeCtx(messages: CoreMessage[] = [], protocol?: WireProtocol): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
    protocol?: WireProtocol;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages,
        session: {
            id: "loop-core-test",
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
        protocol,
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
    systemPrompt = buildCompressSystemPrompt(),
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), systemPrompt)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });

test("loop #1: acp_status-only round → marker surfaced + re-request (avoids tool_calls-no-body hang)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_status", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    const round2 = COMPLETED;
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "acp_status visibility marker surfaced to client");
        assert.ok(/response\.completed/.test(out), "graceful completion present (no 炸锅)");
        assert.equal(fetchCalls, 1, "re-request after acp_status so model can continue (not finish_reason=tool_calls with no body)");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #2: search_context-only round → marker surfaced + re-request", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_search", "search_context", JSON.stringify({ query: "auth", limit: 3 })),
        COMPLETED,
    ].join("");
    const round2 = COMPLETED;
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round2, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "search_context marker surfaced");
        assert.ok(/response\.completed/.test(out), "graceful completion present");
        assert.equal(fetchCalls, 1, "re-request after search_context so model can use results");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #8: real-tool passthrough → emitted to client, loop ends (no re-request)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_bash", "bash", JSON.stringify({ command: "ls" })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("\"name\":\"bash\""), "real tool call emitted to client");
        assert.ok(/response\.completed/.test(out), "completion present (loop ended)");
        assert.equal(fetchCalls, 0, "NO re-request: real tool ends the loop");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #9: mixed compress + real tool → forwarded (no re-request), compress executed, marker shown", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_compress", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        fcEvents(1, "call_bash", "bash", JSON.stringify({ command: "echo hi" })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "compress marker shown");
        assert.ok(out.includes("\"name\":\"bash\""), "real tool forwarded to client");
        assert.equal(fetchCalls, 0, "NO re-request: real tool present alongside mutating proxy tool");
        assert.ok(/response\.completed/.test(out), "completion present");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #5: limit-hit graceful — 10 mutating rounds never degenerate empty, no crash", async () => {
    const mutatingRound = [
        sse("response.created", { response: { id: "resp_m", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(mutatingRound, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(mutatingRound, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(/response\.completed/.test(out), "graceful completion at limit (NOT degenerate empty)");
        assert.ok(!/^data: \[\]\n\n$/.test(out), "no degenerate empty payload");
        const completedCount = (out.match(/event: response\.completed/g) || []).length;
        assert.equal(completedCount, 1, "exactly one completion event (one SSE event line)");
    } finally {
        globalThis.fetch = orig;
    }
});

// Regression guard: the server's runCompressLoop caller used to build LoopCtx
// WITHOUT `protocol`, so recordUsage treated every protocol as Anthropic-style
// (prompt + cached) and double-counted cached tokens for OpenAI/Responses
// streams. The responses adapter reports input_tokens as the TOTAL (cached
// already included) — assert both the fixed path (protocol set) and the
// documented default (protocol unset → legacy additive behavior).
const USAGE_COMPLETED = sse("response.completed", {
    response: {
        id: "resp_usage",
        status: "completed",
        output: [],
        usage: {
            input_tokens: 1000,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 900 },
        },
    },
});

test("loop usage: protocol='responses' → cached NOT double-counted (input_tokens is the total)", async () => {
    const ctx = makeCtx([], "responses");
    await drain(
        new Response(USAGE_COMPLETED, { status: 200 }).body!,
        ctx,
        { model: "gpt-4o", input: [], stream: true },
        { url: "http://mock", headers: {} },
    );
    assert.equal(ctx.session.stats.inputTokens, 1000, "total = input_tokens (1000), NOT 1900");
    assert.equal(ctx.session.stats.lastInputTokens, 1000);
    assert.equal(ctx.session.stats.cachedTokens, 900);
    assert.equal(ctx.session.stats.cacheSamples, 1);
});

test("loop usage: protocol unset → legacy additive behavior (prompt + cached)", async () => {
    const ctx = makeCtx();
    await drain(
        new Response(USAGE_COMPLETED, { status: 200 }).body!,
        ctx,
        { model: "gpt-4o", input: [], stream: true },
        { url: "http://mock", headers: {} },
    );
    assert.equal(ctx.session.stats.inputTokens, 1900, "no protocol → prompt + cached (1000 + 900)");
    assert.equal(ctx.session.stats.cachedTokens, 900);
});

// Regression guard for #189: after a compress, the acp-loop replay request can
// be rejected by provider risk-control (GLM Coding Plan returns 400
// {"code":3007,"msg":"captcha verify failed"} ~1s after a big context rewrite).
// The replay must auto-retry with backoff instead of surfacing the error into
// the agent session.
const CAPTCHA_400_BODY = '{"code":3007,"msg":"captcha verify failed"}';

function compressRound(): string {
    return [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
}

test("replay retry: transient 400 (captcha) then success → retried, no error surfaced", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "1";
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        if (fetchCalls === 1) return new Response(CAPTCHA_400_BODY, { status: 400 });
        return new Response(COMPLETED, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(compressRound(), { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 2, "replay retried once after transient 400");
        assert.ok(!out.includes("upstream error"), "no upstream error surfaced to client");
        assert.ok(/response\.completed/.test(out), "graceful completion after retry");
    } finally {
        delete process.env.BILI_REPLAY_RETRY_BASE_MS;
        globalThis.fetch = orig;
    }
});

test("replay retry: persistent captcha 400 → bounded retries, error names attempt count", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "1";
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(CAPTCHA_400_BODY, { status: 400 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(compressRound(), { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, REPLAY_MAX_ATTEMPTS, "retries are bounded");
        assert.ok(out.includes("upstream error 400"), "error surfaced to client");
        assert.ok(out.includes(`after ${REPLAY_MAX_ATTEMPTS} attempt(s)`), "attempt count in error message");
    } finally {
        delete process.env.BILI_REPLAY_RETRY_BASE_MS;
        globalThis.fetch = orig;
    }
});

test("replay retry: fatal 400 (invalid model) → NO retry, fail fast", async () => {
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response('{"error":{"message":"Invalid model"}}', { status: 400 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(compressRound(), { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 1, "non-transient 4xx is not retried");
        assert.ok(out.includes("upstream error 400"), "error surfaced to client");
        assert.ok(!out.includes("attempt(s)"), "no attempt-count suffix on single-attempt failure");
    } finally {
        globalThis.fetch = orig;
    }
});

test("replay retry: 429 then success → retried", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "1";
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        if (fetchCalls === 1) return new Response('{"error":"rate limited"}', { status: 429 });
        return new Response(COMPLETED, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(compressRound(), { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 2, "429 retried");
        assert.ok(!out.includes("upstream error"), "no upstream error surfaced to client");
    } finally {
        delete process.env.BILI_REPLAY_RETRY_BASE_MS;
        globalThis.fetch = orig;
    }
});

test("isTransientUpstreamError: classifier matrix", () => {
    assert.equal(isTransientUpstreamError(400, CAPTCHA_400_BODY), true, "captcha 400 is transient");
    assert.equal(isTransientUpstreamError(400, '{"error":{"message":"Invalid model"}}'), false, "plain 400 is not");
    assert.equal(isTransientUpstreamError(401, ""), false, "401 never retried");
    assert.equal(isTransientUpstreamError(429, ""), true, "429 always retried");
    assert.equal(isTransientUpstreamError(500, ""), true, "5xx always retried");
    assert.equal(isTransientUpstreamError(503, "service unavailable"), true);
    assert.equal(isTransientUpstreamError(200, "captcha"), false, "2xx never classified");
    assert.equal(REPLAY_MAX_ATTEMPTS, 3);
});

test("replayBackoffMs: exponential from env-tunable base", () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "100";
    try {
        assert.equal(replayBackoffMs(1), 100);
        assert.equal(replayBackoffMs(2), 200);
        assert.equal(replayBackoffMs(3), 400);
    } finally {
        delete process.env.BILI_REPLAY_RETRY_BASE_MS;
    }
    assert.equal(replayBackoffMs(1), 1500, "default base is 1500ms");
});

test("replayMaxAttempts: env-tunable total attempts (1 = legacy no-retry)", () => {
    for (const [value, expected] of [["1", 1], ["5", 5], ["0", REPLAY_MAX_ATTEMPTS], ["abc", REPLAY_MAX_ATTEMPTS], ["-2", REPLAY_MAX_ATTEMPTS]] as const) {
        if (value === "abc") delete process.env.BILI_REPLAY_RETRY_MAX;
        else process.env.BILI_REPLAY_RETRY_MAX = value;
        try {
            assert.equal(replayMaxAttempts(), expected, `BILI_REPLAY_RETRY_MAX=${value}`);
        } finally {
            delete process.env.BILI_REPLAY_RETRY_MAX;
        }
    }
    assert.equal(replayMaxAttempts(), REPLAY_MAX_ATTEMPTS, "default is 3");
});

test("replay retry: BILI_REPLAY_RETRY_MAX=1 → legacy fail-fast (no retry)", async () => {
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(CAPTCHA_400_BODY, { status: 400 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(compressRound(), { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 1, "MAX=1 disables retries (legacy behavior)");
        assert.ok(out.includes("upstream error 400"), "error surfaced to client");
        assert.ok(!out.includes("attempt(s)"), "no attempt-count suffix on single attempt");
    } finally {
        delete process.env.BILI_REPLAY_RETRY_MAX;
        globalThis.fetch = orig;
    }
});
