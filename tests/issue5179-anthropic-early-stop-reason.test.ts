import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter, MAX_LOOP_ROUNDS } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #5179: early turn-ends emit finishReason "length" (OpenAI's word); the
// Anthropic wire has no such stop reason, and Claude Code reads an unknown one
// as a plain end of turn, stopping the task mid-flight. The adapter must
// translate to "max_tokens", which Claude Code auto-resumes.

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeSession(): Session {
    return {
        id: "anthropic-early-stop-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        pendingRetrievals: [],
        persisted: false,
    };
}

function toolRound(name: string, input: unknown): string {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_r", usage: { input_tokens: 100 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${name}`, name, input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");
}

async function runAnthropicLoop(round: string): Promise<{ out: string; reRequests: number }> {
    const body = { model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "go on" }] };
    let reRequests = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        reRequests++;
        return new Response(round, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let out = "";
    try {
        const ctx = {
            core: createCore(),
            config: { modelContextLimit: 200000 } as Config,
            messages: [],
            session: makeSession(),
            log: () => {},
        };
        for await (const c of runCompressLoop(new Response(round, { status: 200 }).body!, ctx, body, { url: "http://mock", headers: {} }, createAnthropicAdapter(body), buildCompressSystemPrompt())) {
            out += c.toString("utf8");
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out, reRequests };
}

function stopReasons(out: string): unknown[] {
    return out
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as { type?: string; delta?: { stop_reason?: unknown } })
        .filter((e) => e.type === "message_delta")
        .map((e) => e.delta?.stop_reason);
}

// #5220 contract: the FIRST failed-only compress round feeds the model a
// recovery receipt and re-requests; this fixture resubmits the identical
// failing call on round 2, where the restored #156 signature breaker ends the
// turn — and whatever the reason, it arrives as "max_tokens", never "length".
test("a failed-only compress round that resubmits its failure ends the Anthropic turn with stop_reason max_tokens, so Claude Code resumes", async () => {
    const { out, reRequests } = await runAnthropicLoop(
        toolRound("compress", { content: [{ startId: "m00001", endId: "m00002", summary: "s" }] }),
    );
    assert.equal(reRequests, 1, "first-time failure re-requests once (recovery receipt, #5220); the identical round-2 resubmit trips the #156 signature breaker");
    assert.ok(out.includes("❌"), "the failure receipt still reaches the client");
    assert.deepEqual(stopReasons(out), ["max_tokens"]);
});

test("the round limit ends the Anthropic turn with stop_reason max_tokens", async () => {
    const { out, reRequests } = await runAnthropicLoop(toolRound("acp_status", {}));
    assert.equal(reRequests, MAX_LOOP_ROUNDS - 1, "ran to the loop limit");
    assert.deepEqual(stopReasons(out), ["max_tokens"]);
});

// #5220 guard-branch: on a threads-continue turn the server-side thread delta
// structurally excludes visibility markers (client-side noise, #2701), so a
// receipt could never ride it — such turns keep the old break contract, and
// the break still arrives as max_tokens.
test("a failed-only compress round on a threads-continue turn breaks WITHOUT re-requesting, ending max_tokens", async () => {
    const body = { model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "go on" }], thread: { type: "continue" } };
    let reRequests = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { reRequests++; return new Response(toolRound("compress", {}), { status: 200, headers: { "content-type": "text/event-stream" } }); }) as typeof fetch;
    let out = "";
    try {
        const ctx = {
            core: createCore(),
            config: { modelContextLimit: 200000 } as Config,
            messages: [],
            session: makeSession(),
            log: () => {},
            protocol: "anthropic" as const,
        };
        const round = toolRound("compress", { content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
        for await (const c of runCompressLoop(new Response(round, { status: 200 }).body!, ctx, body, { url: "http://mock", headers: {} }, createAnthropicAdapter(body), buildCompressSystemPrompt())) {
            out += c.toString("utf8");
        }
    } finally {
        globalThis.fetch = orig;
    }
    assert.equal(reRequests, 0, "threads-delta cannot carry the receipt → old break contract, zero re-requests");
    assert.ok(out.includes("❌"), "the failure receipt still reaches the client");
    assert.deepEqual(stopReasons(out), ["max_tokens"]);
});

test("upstream's own stop reasons reach the client unchanged", () => {
    for (const reason of ["end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal", "model_context_window_exceeded", "a_future_reason"]) {
        const frame = createAnthropicAdapter({ model: "claude-opus-5-5" }).emitCompletion({ finishReason: reason }).toString("utf8");
        assert.deepEqual(stopReasons(frame), [reason], reason);
    }
    const none = createAnthropicAdapter({ model: "claude-opus-5-5" }).emitCompletion().toString("utf8");
    assert.deepEqual(stopReasons(none), ["end_turn"], "no reason given reads as a normal end");
});
