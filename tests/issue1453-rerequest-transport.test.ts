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
            id: "issue1453-test",
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
    signal?: AbortSignal,
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), SYS_PROMPT, signal)) {
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

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function netError(code: string, message: string): Error {
    const err = new Error(message);
    (err as Error & { code?: string }).code = code;
    return err;
}

test("#1453: re-request connect-timeout after successful compress → in-band exit with committed note, no throw", async () => {
    // 7 x 5000-char messages (same layout as tests/loop-compress.test.ts loop #7):
    // the kernel's preserveRecentMessages(5) + preserveRecentTokens(5000) then
    // protect only m00003–m00007, leaving m00001–m00002 compressible.
    const messages = [
        textMsg("u1", "user", bigText(5000)),
        textMsg("a1", "assistant", bigText(5000)),
        textMsg("u2", "user", bigText(5000)),
        textMsg("a2", "assistant", bigText(5000)),
        textMsg("u3", "user", bigText(5000)),
        textMsg("a3", "assistant", bigText(5000)),
        textMsg("u4", "user", bigText(5000)),
    ];
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "S".repeat(80) }] })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        throw new TypeError("fetch failed", { cause: netError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error") });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            withRefs(makeCtx(messages)),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, REPLAY_MAX_ATTEMPTS, "connect timeout retried within the replay budget");
        assert.ok(out.includes("compression committed"), "user told compression landed");
        assert.ok(/tokens saved/.test(out), "committed token count surfaced");
        assert.ok(out.includes("connect timed out"), "failure kind surfaced");
        assert.ok(out.includes("resend your last message"), "recovery hint present");
        assert.ok(/event: response\.failed/.test(out), "well-formed terminal stream instead of a bare throw");
        assert.ok(!out.includes("fetch failed"), "raw transport error text never reaches the client stream");
    } finally {
        globalThis.fetch = orig;
    }
});

test("#1453: re-request socket reset without committed work → in-band failure note, no throw", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_status", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        throw new TypeError("fetch failed", { cause: netError("ECONNRESET", "read ECONNRESET") });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, REPLAY_MAX_ATTEMPTS, "socket reset retried within the replay budget");
        assert.ok(!out.includes("compression committed"), "no committed-work claim for an acp_status-only round");
        assert.ok(out.includes("connection reset by the upstream"), "direct-connection reset attributed to the upstream");
        assert.ok(out.includes("resend your last message"), "recovery hint present");
        assert.ok(/event: response\.failed/.test(out), "well-formed terminal stream instead of a bare throw");
    } finally {
        globalThis.fetch = orig;
    }
});

test("#1453: client abort during re-request keeps the throwing path (old behavior)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_status", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    const controller = new AbortController();
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        await new Promise((r) => setTimeout(r, 10));
        controller.abort();
        throw new TypeError("fetch failed", { cause: netError("ECONNRESET", "read ECONNRESET") });
    }) as typeof fetch;
    try {
        await assert.rejects(
            drain(
                new Response(round1, { status: 200 }).body!,
                makeCtx(),
                { model: "gpt-4o", input: [], stream: true },
                { url: "http://mock", headers: {} },
                controller.signal,
            ),
            (err: unknown) => err instanceof TypeError && err.name === "TypeError" && (err as Error & { cause?: Error & { code?: string } }).cause?.code === "ECONNRESET",
        );
    } finally {
        globalThis.fetch = orig;
    }
});
