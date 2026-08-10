import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
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
        config: { modelContextLimit: 200000 } as Config,
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
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), SYS_PROMPT)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

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

test("loop #7: hideConsumed per round — consumed compress records not re-forwarded verbatim in round 2", async () => {
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "SECRET-SUMMARY-PAYLOAD" }] });
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
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(forwardedBody, "round-2 body captured");
        assert.ok(
            !forwardedBody!.includes("SECRET-SUMMARY-PAYLOAD"),
            "consumed compress summary payload not re-forwarded verbatim (hideConsumed ran and rewrote/hid it)",
        );
    } finally {
        globalThis.fetch = orig;
    }
});
