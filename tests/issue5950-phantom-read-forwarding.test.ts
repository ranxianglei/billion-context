// #5950: pins the faithful-forwarding contract for the incident shape —
// a server-side acp_status continuation followed by a model-emitted call.
// A mock upstream replays the turn: round 1 carries reasoning plus the
// acp_status call, round 2 either answers in text or emits the Read call
// for the nonexistent path from the report. Both directions:
//   (a) the proxy never fabricates a tool call — a text-only round 2
//       reaches the client with no tool_call frame at all;
//   (b) the proxy never suppresses or rewrites one — a model-emitted
//       Read reaches the client byte-exact (same id, name, arguments).
// The round-2 request body is asserted in both cases: the continuation
// replays the acp_status call/result pair with matching ids and the
// round-1 reasoning intact. Related to #5950; this test documents and
// locks in the correct behavior, it does not fix the model-side
// hallucination behind the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createOpenaiAdapter, runCompressLoop } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

const READ_PATH = "/Users/eee/.zcode/workspace/default/86f5c4b2cf708f31ec94f98b78e5f47c/test_user.py";
const READ_ARGS = JSON.stringify({ path: READ_PATH });

function makeCtx(id: string) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session,
        log: () => {},
        protocol: "openai" as const,
    };
}

function openaiSse(frames: Array<Record<string, unknown>>): string {
    return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

// Round 1 of the incident turn: the model reasons, then calls acp_status
// (proxy-owned, executed server-side). The call carries a normal upstream id.
const ROUND1 = openaiSse([
    { id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { reasoning_content: "present this concisely in Chinese" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_5950_r1", type: "function", function: { name: "acp_status", arguments: "{}" } }] }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]);

// Round 2, variant A: the model answers in text only.
const ROUND2_TEXT = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "status summarized" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

// Round 2, variant B: the model itself emits the phantom Read for the
// nonexistent path from #5950.
const ROUND2_READ = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "Read", arguments: READ_ARGS } }] }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]);

async function drainOpenai(first: string, retries: string[], id: string): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const body = retries[fetchCalls - 1] ?? "";
        return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx(id);
        for await (const chunk of runCompressLoop(
            new Response(first, { status: 200 }).body!,
            ctx,
            { model: "deepseek-chat", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "deepseek-chat", stream: true }),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies };
}

// The continuation request the proxy sends for round 2: history plus the
// round-1 acp_status call/result pair (matching ids, upstream id kept
// byte-exact) and the round-1 reasoning replayed intact.
function assertContinuationBody(rawBody: string): void {
    const body = JSON.parse(rawBody) as { messages: Array<Record<string, unknown>> };
    const asst = body.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.ok(asst, `round-2 body must replay the acp_status call, got: ${rawBody.slice(0, 500)}`);
    const tc = (asst!.tool_calls as Array<Record<string, unknown>>)[0]!;
    assert.equal((tc.function as Record<string, unknown>).name, "acp_status");
    assert.equal(tc.id, "call_5950_r1", "the upstream call id is kept byte-exact in the continuation");
    const toolMsg = body.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "round-2 body must carry the acp_status tool result");
    assert.equal(toolMsg!.tool_call_id, "call_5950_r1", "tool result pairs with the assistant call on the same id");
    assert.ok(rawBody.includes("present this concisely in Chinese"), "round-1 reasoning is replayed into the continuation");
}

test("#5950: text-only round 2 — the proxy fabricates no tool call", async () => {
    const { out, fetchCalls, bodies } = await drainOpenai(ROUND1, [ROUND2_TEXT], "s5950-f1");
    assert.equal(fetchCalls, 1, "the proxy call continues server-side exactly once");
    assert.equal(bodies.length, 1, "one re-request body observed");
    assertContinuationBody(bodies[0]!);
    assert.ok(out.includes("[ACP] acp_status result:"), "the acp_status marker reaches the client");
    assert.ok(out.includes("status summarized"), "the round-2 text reaches the client");
    assert.ok(!out.includes("tool_calls"), `no tool_call frame may appear when the model answered in text, got: ${out.slice(0, 500)}`);
    assert.ok(!out.includes("test_user.py"), "no phantom path may appear when the model answered in text");
});

test("#5950: model-emitted Read in round 2 — the proxy forwards it byte-exact", async () => {
    const { out, fetchCalls, bodies } = await drainOpenai(ROUND1, [ROUND2_READ], "s5950-f2");
    assert.equal(fetchCalls, 1, "the proxy call continues server-side exactly once");
    assert.equal(bodies.length, 1, "one re-request body observed");
    assertContinuationBody(bodies[0]!);
    assert.ok(out.includes("[ACP] acp_status result:"), "the acp_status marker reaches the client");
    assert.ok(out.includes(READ_PATH), "the model-emitted Read path reaches the client verbatim");
    assert.ok(out.includes("call_read_1"), "the model-emitted call id reaches the client verbatim");
    assert.ok(out.includes(JSON.stringify(READ_ARGS)), "the model-emitted call arguments reach the client verbatim (as the wire-escaped arguments string)");
    assert.equal((out.match(/test_user\.py/g) || []).length, 1, "the Read frame is forwarded once, never duplicated or rewritten");
});
